/**
 * Owned, protocol-independent language snapshot for one exact compiler input.
 * Hosts provide project-expanded source and map generated binding origins back
 * to their documents. Browser workers and local protocol adapters share this
 * service; it never writes documents, saves a project or changes a running game.
 */
import { assembleLogic, AssemblerError } from "./assembler.ts";
import { commandReference } from "./commandReference.ts";
import { quoteLogicString } from "./disassembler.ts";
import { analyzeLogicSyntax, scanLogicTokens, type Token } from "./syntax.ts";
import { collectLogicResourceUses } from "./resourceUses.ts";
import { collectLogicOperands, numberedOperandKind, BINDING_KINDS } from "./languageOperands.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import { numberedLabel, numberedSlot, type NumberedLabelContext } from "./numberedLabels.ts";
import { systemBindings, type SystemBinding } from "./systemNames.ts";

interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export function createLogicLanguageSnapshot(input: {
  readonly source: string;
  readonly builtins?: Readonly<Record<string, SystemBinding>>;
  readonly profile: AgiProfile;
  readonly dictionary: ReadonlyMap<string, number>;
  readonly objects?: readonly string[];
  readonly bindings?: NumberedLabelContext["bindings"];
  readonly resources?: readonly string[];
  readonly logic?: number;
}) {
  const source = input.source;
  const profile = { ...input.profile };
  const dictionary = new Map(input.dictionary);
  const builtins = input.builtins ?? systemBindings();
  const syntax = analyzeLogicSyntax(source, builtins);
  const commands = commandReference(profile);
  const operands = collectLogicOperands(syntax, commands, profile, builtins);
  const byName = new Map(commands.map((command) => [command.name, command]));
  const diagnostics = syntax.diagnostics.map((entry) => {
    const kind = operandKindAt(entry.start);
    return {
      ...entry,
      message: entry.message.replace(
        "Nothing is named",
        kind === "f"
          ? "No flag is named"
          : kind === "v"
            ? "No variable is named"
            : "Nothing is named",
      ),
      severity: "error" as "error" | "warning",
    };
  });
  let payload: Uint8Array | undefined;
  if (!diagnostics.length) {
    try {
      const compiled = assembleLogic(source, { profile, dictionary, builtins });
      payload = compiled.payload;
      diagnostics.push(
        ...compiled.diagnostics.map((entry) => ({ ...entry, severity: "warning" as const })),
      );
    } catch (error) {
      if (!(error instanceof AssemblerError)) throw error;
      const token = syntax.tokens.find(
        (entry) => entry.line === error.line && entry.col === error.col,
      );
      let start = token?.start;
      if (start === undefined) {
        start = 0;
        for (let line = 1; line < error.line; line++) start = source.indexOf("\n", start) + 1;
        start = Math.min(source.length, start + error.col - 1);
      }
      diagnostics.push({
        message: error.message,
        line: error.line,
        col: error.col,
        start,
        end: token?.end ?? Math.min(source.length, start + 1),
        severity: "error",
      });
    }
  }

  function checkOffset(offset: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset > source.length)
      throw new RangeError("Cursor offset must be within the source in UTF-16 code units.");
  }

  function tokenAt(offset: number): Token | undefined {
    return syntax.tokens.find((token) => token.start <= offset && token.end > offset);
  }

  function contextAt(offset: number) {
    const frames: { name: string; parameter: number }[] = [];
    let previous: Token | undefined;
    for (const token of syntax.tokens) {
      if (token.start >= offset) break;
      if (token.type === "punct" && token.text === "(")
        frames.push({ name: previous?.type === "ident" ? previous.text : "", parameter: 0 });
      else if (token.type === "punct" && token.text === ")") frames.pop();
      else if (token.type === "punct" && token.text === "," && frames.length)
        frames[frames.length - 1]!.parameter++;
      else if (
        token.type === "directive" ||
        (token.type === "punct" && [";", "{", "}"].includes(token.text))
      )
        frames.length = 0;
      previous = token;
    }
    return { frames, call: [...frames].reverse().find((frame) => byName.has(frame.name)) };
  }

  function operandKindAt(offset: number) {
    checkOffset(offset);
    const context = contextAt(offset);
    if (context.call)
      return numberedOperandKind(byName.get(context.call.name)!, context.call.parameter);
    const index = syntax.tokens.findIndex((token) => token.start <= offset && token.end > offset);
    const next = syntax.tokens[index + 1];
    if (next && ["=", "==", "!=", "<", ">", "<=", ">="].includes(next.text)) return "v";
    return undefined;
  }

  function completeAt(offset: number) {
    checkOffset(offset);
    const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
    const linePrefix = source.slice(lineStart, offset).trimStart();
    if (linePrefix.startsWith("#") && !/\s/.test(linePrefix))
      return ["#define", "#message"]
        .filter((name) => name.startsWith(linePrefix))
        .map((name) => ({
          label: name,
          detail: name === "#define" ? "Define a numeric name" : "Declare a message",
          start: offset - linePrefix.length,
          end: offset,
          text: name,
        }));
    const under = tokenAt(offset);
    const endsAtCaret = syntax.tokens.find(
      (token) =>
        token.end === offset &&
        (token.type === "ident" ||
          token.type === "number" ||
          token.type === "string" ||
          (token.type === "invalid" && source[token.start] === '"')),
    );
    const at = under !== undefined && under.type !== "punct" ? under : endsAtCaret;
    const previous = syntax.tokens
      .filter((token) => token.end <= offset && token.type !== "eof")
      .at(-1);
    const gap = source.slice(Math.max(previous?.end ?? 0, lineStart), offset);
    if ((!at || at.type === "eof") && (gap.includes("//") || gap.trimStart().startsWith("#")))
      return [];
    const context = contextAt(offset);
    if (context.call?.name === "said") {
      if (at && !["string", "invalid", "ident", "eof"].includes(at.type)) return [];
      const start = at && at.type !== "eof" ? at.start : offset;
      const end = at && at.type !== "eof" ? at.end : offset;
      const fragment = source.slice(start, offset);
      let prefix = fragment;
      if (fragment.startsWith('"')) {
        try {
          prefix = scanLogicTokens(fragment + '"')[0]?.text ?? "";
        } catch {
          return [];
        }
      }
      return [...dictionary.keys()]
        .filter((word) => word.startsWith(prefix.toLowerCase()))
        .sort()
        .map((word) => ({
          label: word,
          detail: numberedSlot("word", dictionary.get(word)!),
          start,
          end,
          text: quoteLogicString(word),
        }));
    }
    if (at?.type === "string" || at?.type === "invalid") return [];
    const start = at?.type === "ident" || at?.type === "number" ? at.start : offset;
    const end = at?.type === "ident" || at?.type === "number" ? at.end : offset;
    const prefix = source.slice(start, offset);
    if (context.call) {
      const command = byName.get(context.call.name)!;
      const kind = numberedOperandKind(command, context.call.parameter);
      if (context.call.parameter >= command.operands.length) return [];
      const canonical = kind ? BINDING_KINDS[kind] : undefined;
      const definitions = syntax.definitions.flatMap((entry) => {
        if (entry.kind !== "define" || entry.start >= offset) return [];
        const index = syntax.tokens.findIndex((token) => token.start === entry.start);
        const value = syntax.tokens[index + 1]?.text ?? "";
        const match = /^([vf]?)(\d+)$/.exec(value);
        if (!match) return [];
        const binding = input.bindings?.[entry.name];
        const declaredKind =
          match[1] === "f" ? "flag" : match[1] === "v" ? "variable" : binding?.kind;
        if (declaredKind && declaredKind !== canonical) return [];
        if (binding?.logic !== undefined && binding.logic !== input.logic) return [];
        return [{ name: entry.name, num: Number(match[2]), kind: declaredKind }];
      });
      const candidates: { label: string; detail: string; text: string; num: number }[] = [];
      const resource = command.resourceOperand;
      if (resource && !resource.variable && resource.operand === context.call.parameter) {
        for (const num of [
          ...new Set(
            (input.resources ?? []).flatMap((key) => {
              const match = /^(logic|picture|view|sound):(\d+)$/.exec(key);
              return match?.[1] === resource.kind && Number(match[2]) <= 255
                ? [Number(match[2])]
                : [];
            }),
          ),
        ]) {
          const name = definitions
            .filter((entry) => entry.num === num)
            .map((entry) => entry.name)
            .sort()[0];
          candidates.push({
            label: numberedLabel(resource.kind, num, { name: name ?? "" }, "row"),
            detail: numberedSlot(resource.kind, num),
            text: name ?? String(num),
            num,
          });
        }
      } else {
        for (const [name, binding] of Object.entries(builtins)) {
          if (
            binding.kind !== kind ||
            syntax.definitions.some((entry) => entry.name === name && entry.start < offset)
          )
            continue;
          candidates.push({
            label: name,
            detail: `${numberedSlot(binding.kind, binding.num)} · built-in`,
            text: name,
            num: binding.num,
          });
        }
        for (const entry of definitions)
          candidates.push({
            label: entry.name,
            detail: canonical ? numberedSlot(canonical, entry.num) : "Local definition",
            text: entry.name,
            num: entry.num,
          });
        if (kind === "i") {
          const inventory = input.objects ?? [];
          // Inventory names are display text; named bindings remain source identifiers.
          for (const num of inventory.keys()) {
            const bound = definitions.find((entry) => entry.num === num);
            if (!bound)
              candidates.push({
                label: numberedLabel("inventory", num, { inventory }),
                detail: numberedSlot("inventory", num),
                text: `o${num}`,
                num,
              });
          }
          for (let index = candidates.length - 1; index >= 0; index--)
            if (candidates[index]!.num >= inventory.length) candidates.splice(index, 1);
        }
        if (kind === "m") {
          const messages = syntax.tokens.flatMap((token, index) =>
            token.text === "#message" &&
            syntax.tokens[index + 1]?.type === "number" &&
            syntax.tokens[index + 2]?.type === "string"
              ? [Number(syntax.tokens[index + 1]!.text)]
              : [],
          );
          for (let index = candidates.length - 1; index >= 0; index--)
            if (!messages.includes(candidates[index]!.num)) candidates.splice(index, 1);
          for (const num of messages)
            if (!candidates.some((entry) => entry.num === num))
              candidates.push({
                label: numberedSlot("message", num),
                detail: numberedSlot("message", num),
                text: `m${num}`,
                num,
              });
        }
      }
      return candidates
        .filter(
          (entry) =>
            entry.text.startsWith(prefix) ||
            entry.label.toLowerCase().startsWith(prefix.toLowerCase()) ||
            String(entry.num).startsWith(prefix),
        )
        .sort((a, b) => a.num - b.num || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
        .map(({ num: _num, ...entry }) => ({ ...entry, start, end }));
    }

    const kind = context.frames.some((frame) => frame.name === "if") ? "condition" : "action";
    const control: Record<string, string> = {
      if: "Conditional block",
      goto: "Jump to a label",
      return: "Return from this logic",
    };
    const keywords =
      kind === "action"
        ? Object.entries(control)
            .filter(([name]) => name.startsWith(prefix))
            .map(([name, detail]) => ({ label: name, detail, start, end, text: name }))
        : [];
    const names = new Map(
      Object.entries(builtins).map(([name, binding]) => [
        name,
        `${numberedSlot(binding.kind, binding.num)} · built-in`,
      ]),
    );
    for (const definition of syntax.definitions)
      if (definition.kind === "define" && definition.start < offset)
        names.set(definition.name, "Local definition");
    return [
      ...[...names]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, detail]) => ({ label: name, detail, start, end, text: name })),
      ...keywords,
      ...commands
        .filter((command) => command.kind === kind && command.name.startsWith(prefix))
        .map((command) => ({
          label: command.name,
          detail: command.signature,
          start,
          end,
          text: command.name,
        })),
    ];
  }

  function signatureAt(offset: number) {
    checkOffset(offset);
    const call = contextAt(offset).call;
    if (!call) return null;
    const command = byName.get(call.name)!;
    return {
      label: command.signature,
      activeParameter: call.parameter,
      documentation: command.help ?? "",
    };
  }

  function hoverAt(offset: number) {
    checkOffset(offset);
    const token = tokenAt(offset);
    const operand = operandAt(offset);
    if (operand && !operand.name) {
      const names = [
        ...new Set(
          operands
            .filter(
              (entry) => entry.kind === operand.kind && entry.num === operand.num && entry.name,
            )
            .map((entry) => entry.name),
        ),
      ];
      const count = operands.filter(
        (entry) => entry.kind === operand.kind && entry.num === operand.num && !entry.declaration,
      ).length;
      return {
        start: operand.start,
        end: operand.end,
        text: `${numberedLabel(operand.kind, operand.num, { bindings: input.bindings ?? {}, name: names[0] ?? "", inventory: input.objects ?? [], words: [...dictionary] }, "row")}\n\n${count} ${count === 1 ? "use" : "uses"} in this LOGIC.`,
      };
    }
    if (operand?.name && builtins[operand.name] && !definitionAt(offset))
      return {
        start: operand.start,
        end: operand.end,
        text: numberedLabel(
          operand.kind,
          operand.num,
          { bindings: input.bindings ?? {}, name: operand.name },
          "row",
        ),
      };
    if (token?.type !== "ident") return null;
    const definition = definitionAt(offset);
    if (definition) {
      const value = syntax.tokens.find((entry) => entry.start >= definition.end)?.text ?? "";
      return {
        start: token.start,
        end: token.end,
        text:
          definition.kind === "label"
            ? `Label ${definition.name}`
            : `#define ${definition.name} ${value}`,
      };
    }
    const command = byName.get(token.text);
    return command
      ? {
          start: token.start,
          end: token.end,
          text: `${command.signature}\n\n${command.help ?? ""}`,
        }
      : null;
  }

  function definitionAt(offset: number) {
    checkOffset(offset);
    const operand = operandAt(offset);
    if (operand?.kind === "m" && !operand.name) {
      const message = operands.find(
        (entry) =>
          entry.kind === "m" && entry.num === operand.num && entry.declaration && !entry.name,
      );
      if (message)
        return {
          kind: "message" as const,
          name: `m${message.num}`,
          start: message.start,
          end: message.end,
        };
    }
    const declaration = syntax.definitions.find(
      (entry) => entry.start <= offset && entry.end > offset,
    );
    if (declaration) return { ...declaration };
    const reference = syntax.references.find(
      (entry) => entry.start <= offset && entry.end > offset,
    );
    const definition =
      reference?.definitionStart === undefined
        ? undefined
        : syntax.definitions.find((entry) => entry.start === reference.definitionStart);
    return definition ? { ...definition } : null;
  }

  function referencesAt(offset: number) {
    const identities = operands.filter((entry) => entry.start <= offset && entry.end > offset);
    const seen = new Set<number>();
    if (identities.length)
      return operands
        .filter((entry) =>
          identities.some((identity) => entry.kind === identity.kind && entry.num === identity.num),
        )
        .filter((entry) => {
          if (seen.has(entry.start)) return false;
          seen.add(entry.start);
          return true;
        })
        .map(({ start, end }) => ({ start, end }));
    const definition = definitionAt(offset);
    if (!definition) return [];
    return [
      { start: definition.start, end: definition.end },
      ...syntax.references
        .filter((entry) => entry.definitionStart === definition.start)
        .map(({ start, end }) => ({ start, end })),
    ].sort((left, right) => left.start - right.start);
  }

  function renameAt(offset: number, name: string): readonly TextEdit[] {
    if (operandAt(offset) && !operandAt(offset)?.name)
      throw new Error(
        "Numbered operands have fixed identities. Rename a named binding or #define instead.",
      );
    const definition = definitionAt(offset);
    if (!definition) throw new Error("Rename needs a resolved local definition.");
    if (!payload)
      throw new Error(
        "Rename requires a valid compiled source; fix incomplete or invalid code first.",
      );
    let tokens: Token[];
    try {
      tokens = scanLogicTokens(name);
    } catch (error) {
      if (!(error instanceof AssemblerError)) throw error;
      throw new Error("The new name is not a safe source identifier.", { cause: error });
    }
    if (
      tokens.length !== 2 ||
      tokens[0]!.type !== "ident" ||
      tokens[0]!.start !== 0 ||
      tokens[0]!.end !== name.length ||
      (definition.kind === "define" && /^[vfomsiwc]\d+$/.test(name))
    )
      throw new Error("The new name is not a safe source identifier.");
    if (
      syntax.definitions.some(
        (entry) =>
          entry.kind === definition.kind && entry.name === name && entry.start !== definition.start,
      )
    )
      throw new Error(`The name '${name}' already has a definition.`);
    const edits = [
      definition,
      ...syntax.references.filter((entry) => entry.definitionStart === definition.start),
    ]
      .sort((a, b) => a.start - b.start)
      .map(({ start, end }) => ({ start, end, text: name }));
    let changed = source;
    for (const edit of [...edits].reverse())
      changed = changed.slice(0, edit.start) + edit.text + changed.slice(edit.end);
    const renamed = assembleLogic(changed, { profile, dictionary }).payload;
    if (renamed.length !== payload.length || renamed.some((byte, index) => byte !== payload[index]))
      throw new Error("Rename would change compiled game behavior.");
    return edits;
  }

  return {
    source,
    operands,
    resourceUses: collectLogicResourceUses(source, profile, syntax),
    operandAt,
    operandKindAt,
    diagnostics: Object.freeze(diagnostics.map((entry) => Object.freeze(entry))),
    completeAt,
    signatureAt,
    hoverAt,
    definitionAt,
    referencesAt,
    renameAt,
  };

  function operandAt(offset: number) {
    checkOffset(offset);
    return operands.find((entry) => entry.start <= offset && entry.end > offset);
  }
}
