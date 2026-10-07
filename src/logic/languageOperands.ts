/** Numbered symbols retain the argument kind, including numeric source operands. */
import { resourceReferenceOperand, type CommandReference } from "./commandReference.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import type { analyzeLogicSyntax, Token } from "./syntax.ts";
import { systemBindings } from "./systemNames.ts";

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

/** The encoded variable index takes precedence over its selected resource family. */
export function numberedOperandKind(
  command: Pick<CommandReference, "name" | "operands" | "resourceOperand">,
  parameter: number,
): NumberedKind | undefined {
  if (command.name === "said") return "w";
  const resource = command.resourceOperand;
  if (resource && !resource.variable && resource.operand === parameter)
    return resource.kind === "item" ? "i" : resource.kind;
  return ARGUMENT_KINDS[command.operands[parameter] ?? ""];
}

export function collectLogicOperands(
  syntax: ReturnType<typeof analyzeLogicSyntax>,
  commands: readonly Pick<CommandReference, "name" | "operands" | "resourceOperand">[],
  profile: AgiProfile,
  builtins = systemBindings(),
): readonly NumberedOperand[] {
  const byName = new Map(
    commands.map((command) => [
      command.name,
      {
        ...command,
        ...(resourceReferenceOperand(command.name, profile)
          ? { resourceOperand: resourceReferenceOperand(command.name, profile)! }
          : {}),
      },
    ]),
  );
  const definitions = new Map(syntax.definitions.map((entry) => [entry.start, entry]));
  const references = new Map(syntax.references.map((entry) => [entry.start, entry]));
  const values = new Map<number, number>();
  const typedKinds = new Map<number, "v" | "f">();
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
        : definitionStart === undefined
          ? builtins[token.text]?.num
          : values.get(definitionStart);
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
        (tokens[index + 2]?.type === "number" || /^[vf]\d+$/.test(tokens[index + 2]?.text ?? ""))
      ) {
        const value = tokens[index + 2]!.text;
        values.set(next.start, Number(value.replace(/^[vf]/, "")));
        if (/^[vf]\d+$/.test(value)) typedKinds.set(next.start, value[0] as "v" | "f");
      } else if (token.text === "#message" && next?.type === "number") add(next, "m", true);
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
    const definitionStart = references.get(token.start)?.definitionStart;
    const namedKind =
      definitionStart === undefined ? builtins[token.text]?.kind : typedKinds.get(definitionStart);
    const call = frames.at(-1);
    if (call && byName.has(call.name)) {
      const kind = numberedOperandKind(byName.get(call.name)!, call.parameter);
      if (kind) add(token, kind);
    } else if (
      next?.text === "=" ||
      (next && ["==", "!=", "<", ">", "<=", ">="].includes(next.text))
    ) {
      add(
        token,
        namedKind ?? (token.text.startsWith("f") && /^f\d+$/.test(token.text) ? "f" : "v"),
      );
    } else if (namedKind) {
      add(token, namedKind);
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
