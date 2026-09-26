/**
 * Room Studio logic document: a room's logic source whose rules are
 * structured comments, so annotations never change the compiled bytes.
 *
 *   // @rule <id> "<label>" <exit|region> [item=<picture item id>]   opens a rule
 *   // @end                                                          closes it
 *
 * `item=` ties the rule to a Room Studio picture item (`# @item` in the
 * room's picture document): when the item moves, the rule's box moves with
 * it (ruleBinding.ts).
 * Rules are flat and cover consecutive source lines; the lines between the
 * directives are the rule's fragment. Lines outside rules are native source.
 * A malformed directive is reported and otherwise read as a plain comment, as
 * is the `@end` of a rejected `@rule`.
 */
import {
  PICTURE_ITEM_ID,
  type StudioDiagnostic,
  type StudioDiagnosticCode,
} from "../pictureDocument.ts";

export type LogicRuleKind = "exit" | "region";

export const LOGIC_RULE_KINDS: readonly LogicRuleKind[] = ["exit", "region"];

/** Rule ids follow the picture item id rule. */
export const LOGIC_RULE_ID = PICTURE_ITEM_ID;

export interface LogicRuleFragment {
  readonly id: string;
  readonly label: string;
  readonly kind: LogicRuleKind;
  /** The picture item the rule's box follows, or null. */
  readonly item: string | null;
  /** 1-based line of the `@rule` directive. */
  readonly openLine: number;
  /** 1-based line of the `@end`; one past the last line when unterminated. */
  readonly closeLine: number;
  /** False when the rule has no `@end`; such a rule is never edited. */
  readonly terminated: boolean;
}

export interface LogicDocument {
  /** The source lines verbatim (split on "\n"; a "\r" stays on its line). */
  readonly lines: readonly string[];
  readonly rules: readonly LogicRuleFragment[];
}

const DIRECTIVE = /^\/\/\s*@(rule|end)(?=\s|$)(.*)$/;
const LABEL = /^"(?:[^"\\]|\\.)*"/;

type Directive =
  | { type: "end"; error?: string }
  | { type: "rule"; id: string; label: string; kind: LogicRuleKind; item: string | null }
  | { type: "rule"; error: string; code: StudioDiagnostic["code"] };

/** Parse a directive line, or undefined for a line that is not one. */
function readDirective(line: string): Directive | undefined {
  const match = DIRECTIVE.exec(line.trim());
  if (!match) return undefined;
  const rest = match[2]!.trim();
  if (match[1] === "end") {
    return rest.length === 0 ? { type: "end" } : { type: "end", error: `unexpected '${rest}'` };
  }
  const [id = ""] = rest.split(/\s+/);
  if (!LOGIC_RULE_ID.test(id)) {
    return {
      type: "rule",
      code: "bad-id",
      error: `rule id '${id}' must match ${LOGIC_RULE_ID.source}`,
    };
  }
  const tail = rest.slice(id.length).trimStart();
  const quoted = LABEL.exec(tail);
  let label: unknown;
  try {
    label = quoted ? JSON.parse(quoted[0]) : undefined;
  } catch {
    label = undefined;
  }
  if (typeof label !== "string" || label.trim().length === 0) {
    return {
      type: "rule",
      code: "bad-label",
      error: `rule '${id}' needs a non-empty double-quoted label`,
    };
  }
  const [kind = "", binding, ...extra] = tail.slice(quoted![0].length).trim().split(/\s+/);
  if (!(LOGIC_RULE_KINDS as readonly string[]).includes(kind)) {
    return {
      type: "rule",
      code: "bad-directive",
      error: `rule '${id}': kind '${kind}' must be one of ${LOGIC_RULE_KINDS.join("|")}`,
    };
  }
  const item = binding === undefined ? null : /^item=(.*)$/.exec(binding)?.[1];
  if (item === undefined || (item !== null && !PICTURE_ITEM_ID.test(item)) || extra.length > 0) {
    return {
      type: "rule",
      code: "bad-directive",
      error: `rule '${id}': unexpected '${[binding, ...extra].join(" ")}' (expected item=<picture item id>)`,
    };
  }
  return { type: "rule", id, label, kind: kind as LogicRuleKind, item };
}

/**
 * Diagnostics under which no rule edit is safe: the parsed rules no longer
 * stand for the source (a duplicate id hides a rule as dead text, a nested
 * directive is silently ignored, an unterminated rule runs to the file's
 * end). Every other diagnostic leaves the rules' line spans exact.
 */
export const RULE_EDIT_BLOCKERS: readonly StudioDiagnosticCode[] = [
  "duplicate-id",
  "nested-item",
  "unterminated-item",
];

/** The `@rule` directive line for a rule, at the given indentation. */
export function ruleDirective(
  rule: Pick<LogicRuleFragment, "id" | "label" | "kind" | "item">,
  indent = "",
): string {
  const item = rule.item === null ? "" : ` item=${rule.item}`;
  return `${indent}// @rule ${rule.id} ${JSON.stringify(rule.label)} ${rule.kind}${item}`;
}

/** Parse logic source into its rules. Never throws; bad directives become diagnostics. */
export function parseLogicDocument(source: string): {
  document: LogicDocument;
  diagnostics: StudioDiagnostic[];
} {
  const lines = source.split("\n");
  const rules: LogicRuleFragment[] = [];
  const diagnostics: StudioDiagnostic[] = [];
  const seen = new Set<string>();
  let open: Omit<LogicRuleFragment, "closeLine" | "terminated"> | null = null;
  /** A rejected `@rule` swallows the next `@end` so one mistake gives one diagnostic. */
  let rejectedOpen = false;
  const report = (
    line: number,
    code: StudioDiagnostic["code"],
    message: string,
    id?: string,
  ): void => {
    diagnostics.push(id === undefined ? { line, code, message } : { line, code, message, id });
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const directive = readDirective(lines[i]!);
    if (directive?.type === "rule") {
      if (open !== null) {
        report(lineNo, "nested-item", `rules do not nest; '${open.id}' is still open`, open.id);
      } else if ("error" in directive) {
        report(lineNo, directive.code, directive.error);
        rejectedOpen = true;
      } else if (seen.has(directive.id)) {
        report(lineNo, "duplicate-id", `rule id '${directive.id}' is already used`, directive.id);
        rejectedOpen = true;
      } else {
        seen.add(directive.id);
        const { id, label, kind, item } = directive;
        open = { id, label, kind, item, openLine: lineNo };
        rejectedOpen = false;
      }
    } else if (directive?.type === "end") {
      if (directive.error !== undefined) {
        report(lineNo, "bad-directive", `@end: ${directive.error}`);
      } else if (open !== null) {
        rules.push({ ...open, closeLine: lineNo, terminated: true });
        open = null;
      } else if (rejectedOpen) {
        rejectedOpen = false;
      } else {
        report(lineNo, "unmatched-end", "@end without an open rule");
      }
    }
  }
  if (open !== null) {
    report(
      open.openLine,
      "unterminated-item",
      `rule '${open.id}' has no @end; it closes at the end of the file`,
      open.id,
    );
    rules.push({ ...open, closeLine: lines.length + 1, terminated: false });
  }
  return { document: { lines, rules }, diagnostics };
}

/** The document's source text; the exact original text when nothing was edited. */
export function serializeLogicDocument(document: LogicDocument): string {
  return document.lines.join("\n");
}

/** The fragment text strictly between a rule's directives. */
export function ruleFragmentText(document: LogicDocument, rule: LogicRuleFragment): string {
  return document.lines.slice(rule.openLine, rule.closeLine - 1).join("\n");
}
