import { numberedKindTitle } from "./numberedLabels.ts";
/** Numbered symbols retain the argument kind, including numeric source operands. */
import type { CommandReference } from "./commandReference.ts";
import type { analyzeLogicSyntax, Token } from "./syntax.ts";
import { resourceReferenceOperand } from "../authoring/projectReferences.ts";
import type { AgiProfile } from "../runtime/profile.ts";

export type NumberedKind =
  "v" | "f" | "o" | "i" | "s" | "w" | "m" | "c" | "logic" | "picture" | "view" | "sound";
export interface NumberedOperand {
  readonly kind: NumberedKind;
  readonly num: number;
  readonly start: number;
  readonly end: number;
  readonly declaration: boolean;
  readonly name?: string;
  readonly definitionStart?: number;
}
export const OPERAND_NAMES = Object.fromEntries(
  ["v", "f", "o", "i", "s", "w", "m", "c", "logic", "picture", "view", "sound"].map((kind) => [
    kind,
    numberedKindTitle(kind),
  ]),
) as Record<NumberedKind, string>;
export const BINDING_KINDS: Record<NumberedKind, string> = {
  v: "variable",
  f: "flag",
  o: "object",
  i: "inventory",
  m: "message",
  s: "string",
  w: "word",
  c: "controller",
  logic: "logic",
  picture: "picture",
  view: "view",
  sound: "sound",
};
const ARGUMENT_KINDS: Record<string, NumberedKind> = {
  var: "v",
  flag: "f",
  object: "o",
  item: "i",
  string: "s",
  message: "m",
  controller: "c",
};

export function collectLogicOperands(
  syntax: ReturnType<typeof analyzeLogicSyntax>,
  commands: readonly Pick<CommandReference, "name" | "operands">[],
  profile: AgiProfile,
): readonly NumberedOperand[] {
  const byName = new Map(commands.map((command) => [command.name, command]));
  const definitions = new Map(syntax.definitions.map((entry) => [entry.start, entry]));
  const references = new Map(syntax.references.map((entry) => [entry.start, entry]));
  const values = new Map<number, number>();
  const operands: NumberedOperand[] = [];
  const frames: { name: string; parameter: number }[] = [];
  const tokens = syntax.tokens;
  function add(token: Token, kind: NumberedKind, declaration = false) {
    const raw = /^([vfomsiwc])(\d+)$/.exec(token.text);
    const reference = references.get(token.start);
    const definitionStart = reference?.definitionStart;
    const num = raw
      ? Number(raw[2])
      : token.type === "number"
        ? Number(token.text)
        : values.get(definitionStart ?? -1);
    if (num === undefined || num > (kind === "w" ? 65535 : 255)) return;
    operands.push({
      kind,
      num,
      start: token.start,
      end: token.end,
      declaration,
      ...(!raw && token.type === "ident" ? { name: token.text } : {}),
      ...(definitionStart !== undefined ? { definitionStart } : {}),
    });
  }
  for (const [index, token] of tokens.entries()) {
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (token.type === "directive") {
      frames.length = 0;
      if (
        token.text === "#define" &&
        next?.type === "ident" &&
        tokens[index + 2]?.type === "number"
      )
        values.set(next.start, Number(tokens[index + 2]!.text));
      else if (token.text === "#message" && next?.type === "number") add(next, "m", true);
      continue;
    }
    if (token.type === "punct") {
      if (token.text === "(")
        frames.push({ name: previous?.type === "ident" ? previous.text : "", parameter: 0 });
      else if (token.text === ")") frames.pop();
      else if (token.text === "," && frames.length) frames[frames.length - 1]!.parameter++;
      // Recover an unfinished call at a statement boundary.
      else if ([";", "{", "}"].includes(token.text)) frames.length = 0;
      continue;
    }
    if (
      !["ident", "number"].includes(token.type) ||
      definitions.has(token.start) ||
      previous?.type === "directive" ||
      previous?.text === "#define" ||
      next?.text === ":" ||
      previous?.text === "goto" ||
      next?.text === "("
    )
      continue;
    const call = frames.at(-1);
    if (call && byName.has(call.name)) {
      const resource = resourceReferenceOperand(call.name, profile);
      const kind =
        call.name === "said"
          ? "w"
          : resource &&
              !resource.variable &&
              resource.kind !== "item" &&
              resource.operand === call.parameter
            ? resource.kind
            : ARGUMENT_KINDS[byName.get(call.name)!.operands[call.parameter] ?? ""];
      if (kind) add(token, kind);
    } else if (
      next?.text === "=" ||
      (next && ["==", "!=", "<", ">", "<=", ">="].includes(next.text))
    ) {
      add(token, token.text.startsWith("f") && /^f\d+$/.test(token.text) ? "f" : "v");
    } else if (token.type === "ident" && /^([vfomsiwc])\d+$/.test(token.text)) {
      add(token, token.text[0] as NumberedKind);
    }
  }
  // A numeric define acquires kinds from its typed uses, never from its value alone.
  const declaredKinds = new Set<string>();
  for (const operand of [...operands]) {
    const definition = definitions.get(operand.definitionStart ?? -1);
    const key = `${definition?.start}:${operand.kind}`;
    if (definition && !declaredKinds.has(key)) {
      declaredKinds.add(key);
      operands.push({
        kind: operand.kind,
        num: operand.num,
        start: definition.start,
        end: definition.end,
        name: definition.name,
        declaration: true,
      });
    }
  }
  return operands.sort((a, b) => a.start - b.start);
}
