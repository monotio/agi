/**
 * Room Studio rule edits: add, update, remove or re-box one annotated rule in
 * a room's logic document and prove the result still assembles.
 *
 * Sections follow the room logic convention write_room and the tutorial use:
 * one `if (isset(f5)) { … }` init block that runs on the room's first cycle,
 * then per-cycle statements, then a final `return;`. Both rule kinds are
 * per-cycle, top-level statements:
 *   - region → after the last top-level region rule, or else straight after
 *     the init block, or else before the first statement;
 *   - exit (edge or door) → after the last top-level exit rule, or else
 *     before the final top-level `return;`, or else at the end.
 *
 * Allocation reuses the authoring tools: a flag name without a binding is
 * reserved through reserve_binding (kind flag, lowest free id from 32), and
 * message text is an inline print string the assembler numbers after the
 * logic's highest #message. Native fragments — any rule parseRule does not
 * recognise — are never touched; they change only through an explicit text
 * edit. Nothing here mutates the session: the caller commits the returned
 * source, bytes and bindings together.
 */
import { assembleAuthoredLogic, type AgentSessionState } from "../../agent/agentState.ts";
import { executeAuthoringTool } from "../../agent/authoringTools.ts";
import { validateAuthoringState, type BindingKind } from "../../agent/authoringState.ts";
import { normalizeAuthoredLogic } from "../../agent/logicText.ts";
import { AssemblerError } from "../../logic/assembler.ts";
import { PICTURE_ITEM_ID } from "../pictureDocument.ts";
import {
  LOGIC_RULE_ID,
  parseLogicDocument,
  RULE_EDIT_BLOCKERS,
  ruleDirective,
  serializeLogicDocument,
  type LogicDocument,
  type LogicRuleFragment,
} from "./logicDocument.ts";
import {
  emitRule,
  readRules,
  ruleBox,
  ruleModelProblem,
  type FlagRef,
  type RuleBox,
  type RuleModel,
} from "./ruleModel.ts";

export type RuleEditOp =
  | {
      readonly op: "addRule";
      readonly id: string;
      readonly label: string;
      readonly model: RuleModel;
      /** Bind the rule's box to a picture item (door exits and regions). */
      readonly item?: string | null;
    }
  | {
      readonly op: "updateRule";
      readonly id: string;
      readonly model: RuleModel;
      readonly label?: string;
      /** A new picture item binding; null unbinds; omitted keeps it. */
      readonly item?: string | null;
    }
  | { readonly op: "removeRule"; readonly id: string }
  /** Replace the box of a region or door exit, keeping everything else. */
  | { readonly op: "moveRegionBox"; readonly id: string; readonly box: RuleBox };

export type RuleEditResult =
  | {
      readonly ok: true;
      readonly document: LogicDocument;
      readonly source: string;
      /** The assembled logic resource for `source`. */
      readonly bytes: Uint8Array;
      /** Named bindings the edit reserved; the caller adds them to authoring state. */
      readonly newBindings: Readonly<Record<string, { kind: BindingKind; num: number }>>;
      /** Typographic conversions and warnings from the authored-text normalizer. */
      readonly adjustments: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

/** What an edit reads from the session: dictionary, bindings, profile and the game's logics. */
export type RuleSession = Pick<
  AgentSessionState,
  "authoring" | "sources" | "container" | "profile"
>;

function refuse(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function assemblyError(error: unknown): string {
  if (error instanceof AssemblerError) {
    const detail = error.message.slice(`${error.line}:${error.col}: `.length);
    return `The room's logic would not assemble: ${detail} (line ${error.line}).`;
  }
  return `The room's logic would not assemble: ${error instanceof Error ? error.message : String(error)}`;
}

// ---------- Structure scan ----------

interface Structure {
  /** Brace depth at the start of each 0-based line. */
  readonly depth: readonly number[];
  /** 0-based line of the init block's closing brace. */
  readonly initClose: number | null;
  /** 0-based line of the last top-level `return`. */
  readonly finalReturn: number | null;
  /** 0-based line of the first top-level statement. */
  readonly firstStatement: number | null;
}

/** Top-level structure from a comment- and string-aware brace scan. */
function scanStructure(lines: readonly string[]): Structure {
  const tokens: { text: string; line: number; depth: number }[] = [];
  const depth: number[] = [];
  let level = 0;
  for (let line = 0; line < lines.length; line++) {
    depth.push(level);
    const text = lines[line]!;
    if (text.trimStart().startsWith("#")) continue;
    for (let i = 0; i < text.length;) {
      const ch = text[i]!;
      if (text.startsWith("//", i)) break;
      if (ch === '"') {
        for (i++; i < text.length && text[i] !== '"'; i += text[i] === "\\" ? 2 : 1);
        i++;
        tokens.push({ text: '"', line, depth: level });
        continue;
      }
      const word = /^[A-Za-z0-9_.]+/.exec(text.slice(i));
      if (word) {
        tokens.push({ text: word[0], line, depth: level });
        i += word[0].length;
        continue;
      }
      if (ch === "}") level--;
      if (!/\s/.test(ch)) tokens.push({ text: ch, line, depth: level });
      if (ch === "{") level++;
      i++;
    }
  }
  let initClose: number | null = null;
  let finalReturn: number | null = null;
  let firstStatement: number | null = null;
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!;
    if (token.depth !== 0) continue;
    firstStatement ??= token.line;
    if (token.text === "return") finalReturn = token.line;
    const head = tokens
      .slice(at, at + 8)
      .map((t) => t.text)
      .join(" ");
    if (initClose === null && head === "if ( isset ( f5 ) ) {")
      initClose = tokens.slice(at + 8).find((t) => t.text === "}" && t.depth === 0)?.line ?? null;
  }
  return { depth, initClose, finalReturn, firstStatement };
}

/** Where a new rule of this kind goes: the 0-based line to insert before, or a refusal. */
function placeRule(
  lines: readonly string[],
  structure: Structure,
  lastOfKind: LogicRuleFragment | undefined,
  kind: RuleModel["kind"],
): number | string {
  const end = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (lastOfKind) return lastOfKind.closeLine;
  if (kind === "exit") {
    const at = structure.finalReturn;
    return at !== null && lines[at]!.trimStart().startsWith("return") ? at : end;
  }
  const close = structure.initClose;
  if (close === null) return structure.firstStatement ?? end;
  if (lines[close]!.trim() !== "}")
    return "The init block's closing brace shares a line with other code; put it on its own line first.";
  return close + 1;
}

/** Flag names the model uses (numbers need no binding). */
function flagNames(model: RuleModel): string[] {
  const flags: (FlagRef | null)[] =
    model.kind === "exit" ? [model.requiresFlag] : [model.flag, ...model.when.map((c) => c.flag)];
  return [...new Set(flags.filter((flag): flag is string => typeof flag === "string"))];
}

/**
 * Apply one rule edit and assemble the result against the session's
 * dictionary, bindings and profile. Returns the new document and bytes, or an
 * error in plain words; the session is never mutated.
 */
export function applyRuleEdit(
  document: LogicDocument,
  op: RuleEditOp,
  session: RuleSession,
): RuleEditResult {
  const broken = parseLogicDocument(serializeLogicDocument(document)).diagnostics.find((entry) =>
    RULE_EDIT_BLOCKERS.includes(entry.code),
  );
  if (broken)
    return refuse(
      `The room's rule annotations are broken: ${broken.message} (line ${broken.line}). Fix them as text before editing rules.`,
    );
  const staged = { ...session, authoring: validateAuthoringState(session.authoring) };
  const compile = (source: string) => assembleAuthoredLogic(staged, source);

  let messages: readonly (string | null)[];
  try {
    messages = compile(serializeLogicDocument(document)).messages;
  } catch (error) {
    return refuse(`${assemblyError(error)} Fix it as text before editing rules.`);
  }
  const rules = readRules(document, { messages, bindings: staged.authoring.bindings });
  const lines = [...document.lines];
  // New lines follow the document's line endings; the "\r" stays on each line.
  const eol = lines.some((line) => line.endsWith("\r")) ? "\r" : "";
  let adjustments: readonly string[] = [];
  /** Another edge exit rule already leaving by this model's edge. */
  const clashOf = (model: RuleModel): string | null => {
    if (model.kind !== "exit" || model.edge === null) return null;
    const clash = rules.find(
      ({ rule, model: other }) =>
        rule.id !== op.id &&
        other !== "native" &&
        other.kind === "exit" &&
        other.edge === model.edge,
    );
    return clash ? `Rule '${clash.rule.id}' already leaves by the ${model.edge} edge.` : null;
  };

  /** Validate, bind flag names and emit; the fragment text or a refusal. */
  const fragmentFor = (model: RuleModel, item: string | null): string | { error: string } => {
    const problem = ruleModelProblem(model);
    if (problem) return { error: problem };
    if (item !== null && !PICTURE_ITEM_ID.test(item))
      return { error: `'${item}' is not a picture item id.` };
    if (item !== null && ruleBox(model) === null)
      return { error: "Only a door exit or a region has a box that can follow a picture item." };
    for (const name of flagNames(model)) {
      const binding = staged.authoring.bindings[name];
      if (binding?.kind === "flag") continue;
      if (binding)
        return { error: `'${name}' already names ${binding.kind} ${binding.num}, not a flag.` };
      const reserved = executeAuthoringTool(staged as AgentSessionState, "reserve_binding", {
        bindings: null,
        name,
        kind: "flag",
        id: null,
      });
      if (!reserved?.success)
        return { error: reserved?.error ?? `Could not reserve a flag for '${name}'.` };
    }
    const normalized = normalizeAuthoredLogic(emitRule(model));
    adjustments = normalized.adjustments;
    const wide = /[\u0100-\uffff]/.exec(normalized.source);
    if (wide) return { error: `Message text has a character AGI cannot show: '${wide[0]}'.` };
    return normalized.source;
  };
  const labelProblem = (label: unknown): string | null =>
    typeof label !== "string" || label.trim() === "" || label.length > 80 || /[\r\n]/.test(label)
      ? "A rule needs a one-line label of 1 to 80 characters."
      : null;
  const ruleLines = (
    rule: Pick<LogicRuleFragment, "id" | "label" | "kind" | "item">,
    fragment: string,
    indent: string,
  ): string[] =>
    [
      ruleDirective(rule, indent),
      ...fragment.split("\n").map((line) => indent + line),
      `${indent}// @end`,
    ].map((line) => line + eol);

  if (op.op === "addRule") {
    if (!LOGIC_RULE_ID.test(op.id))
      return refuse(
        `Rule id '${op.id}' must be lowercase letters, digits, '-' or '_', starting with a letter.`,
      );
    if (document.rules.some((rule) => rule.id === op.id))
      return refuse(`This room already has a rule '${op.id}'.`);
    const bad = labelProblem(op.label);
    if (bad) return refuse(bad);
    const { model } = op;
    const clash = clashOf(model);
    if (clash) return refuse(clash);
    const item = op.item ?? null;
    const fragment = fragmentFor(model, item);
    if (typeof fragment !== "string") return refuse(fragment.error);
    const structure = scanStructure(lines);
    const lastOfKind = rules
      .filter(
        (entry) =>
          entry.model !== "native" &&
          entry.model.kind === model.kind &&
          structure.depth[entry.rule.openLine - 1] === 0,
      )
      .at(-1)?.rule;
    const at = placeRule(lines, structure, lastOfKind, model.kind);
    if (typeof at === "string") return refuse(at);
    lines.splice(
      at,
      0,
      ...ruleLines({ id: op.id, label: op.label, kind: model.kind, item }, fragment, ""),
    );
  } else {
    const existing = rules.find((entry) => entry.rule.id === op.id);
    if (!existing) return refuse(`This room has no rule '${op.id}'.`);
    const { rule, model: current } = existing;
    if (current === "native")
      return refuse(
        `Rule '${op.id}' is native logic the rule editor cannot read. Change it as text with an explicit edit.`,
      );
    const span = rule.closeLine - rule.openLine + 1;
    if (op.op === "removeRule") {
      lines.splice(rule.openLine - 1, span);
    } else {
      let model: RuleModel;
      if (op.op === "moveRegionBox") {
        if (ruleBox(current) === null) return refuse(`Rule '${op.id}' has no box to move.`);
        model = { ...current, box: op.box } as RuleModel;
      } else {
        model = op.model;
        const clash = clashOf(model);
        if (clash) return refuse(clash);
        if (model.kind !== current.kind)
          return refuse(
            `Rule '${op.id}' is ${current.kind === "exit" ? "an exit" : "a region"}, not ${model.kind === "exit" ? "an exit" : "a region"}; remove it and add a new rule instead.`,
          );
      }
      const label = op.op === "updateRule" && op.label !== undefined ? op.label : rule.label;
      const bad = labelProblem(label);
      if (bad) return refuse(bad);
      const item = op.op === "updateRule" && op.item !== undefined ? op.item : rule.item;
      const fragment = fragmentFor(model, item);
      if (typeof fragment !== "string") return refuse(fragment.error);
      const indent = /^\s*/.exec(lines[rule.openLine - 1]!)![0];
      lines.splice(
        rule.openLine - 1,
        span,
        ...ruleLines({ ...rule, label, item }, fragment, indent),
      );
    }
  }

  const source = lines.join("\n");
  const reparsed = parseLogicDocument(source).document;
  if (op.op !== "removeRule") {
    // The edit must read back as the rule it wrote, or the UI would lose it.
    const back = readRules(reparsed, { bindings: staged.authoring.bindings }).find(
      (entry) => entry.rule.id === op.id,
    )?.model;
    if (back === undefined || back === "native")
      return refuse(`Rule '${op.id}' did not read back after the edit; nothing was changed.`);
  }
  let bytes: Uint8Array;
  try {
    bytes = compile(source).payload;
  } catch (error) {
    return refuse(assemblyError(error));
  }
  const newBindings = Object.fromEntries(
    Object.entries(staged.authoring.bindings).filter(
      ([name]) => !Object.hasOwn(session.authoring.bindings, name),
    ),
  );
  return { ok: true, document: reparsed, source, bytes, newBindings, adjustments };
}
