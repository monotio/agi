/** Resource operand roles and conservative local assignment links for project rewrites. */
import { analyzeLogicSyntax, type Ref, type Stmt, type TestExpr, type Token } from "./syntax.ts";
import { collectLogicOperands } from "./languageOperands.ts";
import {
  ACTIONS,
  V3_ACTIONS,
  IIGS_ACTIONS,
  AMIGA_ACTIONS,
  actionSpec,
  conditionSpec,
} from "./opcodes.ts";
import { resourceReferenceOperand } from "../authoring/projectReferences.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import type { ResourceKind } from "../types.ts";

export interface LogicResourceUse {
  readonly kind: ResourceKind;
  readonly command: string;
  readonly line: number;
  readonly start: number;
  readonly token: Token | undefined;
  readonly number: number | undefined;
  readonly variable?: number;
}
const value = (ref: Ref | undefined): number | undefined =>
  ref?.kind === "num" ? ref.value : ref && ref.kind !== "str" ? ref.index : undefined;

export function collectLogicResourceUses(
  source: string,
  profile: AgiProfile,
  syntax = analyzeLogicSyntax(source),
): readonly LogicResourceUse[] {
  const uses: LogicResourceUse[] = [];
  const unsafe = new Set<Token>();
  const definitions = new Map<number, Token>();
  const origins = new Map<Token, Set<string>>();
  const assignedValues = new Map<Token, number>();
  const tokens = syntax.tokens;
  function argumentsOf(statement: Stmt): readonly Token[] {
    const start = tokens.findIndex((token) => token.start === statement.tok.start);
    if (tokens[start + 1]?.text === "=") return [statement.tok, tokens[start + 2]!];
    const args: Token[] = [];
    for (let i = start + 2; i < tokens.length && tokens[i]!.start < statement.end; i++) {
      const token = tokens[i]!;
      if (token.text === ")") break;
      if (token.text !== ",") args.push(token);
    }
    return args;
  }
  function reads(args: readonly Ref[], operands: readonly string[], except = -1): void {
    args.forEach((arg, index) => {
      if (operands[index] !== "var" || index === except) return;
      const origin = definitions.get(value(arg) ?? -1);
      if (origin) unsafe.add(origin);
    });
  }
  function test(expr: TestExpr): void {
    if (expr.type === "cond") {
      // Current/previous room comparisons are room IDs, rather than arbitrary values.
      if (
        expr.name === "equaln" &&
        [0, 1].includes(value(expr.args[0]) ?? -1) &&
        expr.args[1]?.kind === "num"
      ) {
        const arg = expr.args[1];
        const token =
          arg.tok ??
          tokens.find(
            (token) =>
              token.start > expr.tok.start &&
              token.type === "number" &&
              Number(token.text) === arg.value,
          );
        uses.push({
          kind: "logic",
          command: expr.name,
          line: expr.tok.line,
          start: expr.tok.start,
          token,
          number: arg.value,
        });
      }
      reads(expr.args, conditionSpec(expr.name)?.operands ?? []);
    } else if (expr.type === "not" || expr.type === "group") test(expr.inner);
    else expr.parts.forEach(test);
  }
  function walk(statements: readonly Stmt[]): void {
    for (const statement of statements) {
      if (statement.type === "if") {
        test(statement.test);
        const before = new Map(definitions);
        walk(statement.then);
        definitions.clear();
        for (const [key, token] of before) definitions.set(key, token);
        if (statement.else_) walk(statement.else_);
        definitions.clear();
        continue;
      }
      if (statement.type !== "action") {
        definitions.clear();
        continue;
      }
      const args = argumentsOf(statement);
      const role = resourceReferenceOperand(statement.name, profile);
      if (role && role.kind !== "item") {
        const slot = value(statement.args[role.operand]);
        const origin = role.variable ? definitions.get(slot ?? -1) : args[role.operand];
        const assignment = origin && assignedValues.get(origin);
        const num = role.variable ? assignment : slot;
        const use: LogicResourceUse = {
          kind: role.kind,
          command: statement.name,
          line: statement.tok.line,
          start: statement.tok.start,
          token: origin,
          number: num,
          ...(role.variable && slot !== undefined ? { variable: slot } : {}),
        };
        uses.push(use);
        if (role.variable && origin) {
          const kinds = origins.get(origin) ?? new Set<string>();
          kinds.add(role.kind);
          origins.set(origin, kinds);
        }
      }
      const spec = actionSpec(statement.name, profile);
      reads(
        statement.args,
        spec?.operands ?? [],
        role?.variable ? role.operand : statement.name === "assignn" ? 0 : -1,
      );
      if (statement.name === "assignn") {
        const slot = value(statement.args[0]);
        if (slot !== undefined) {
          definitions.delete(slot);
          if (args[1] && value(statement.args[1]) !== undefined) {
            definitions.set(slot, args[1]);
            assignedValues.set(args[1], value(statement.args[1])!);
          }
          if (slot === 0)
            uses.push({
              kind: "logic",
              command: statement.name,
              line: statement.tok.line,
              start: statement.tok.start,
              token: args[1],
              number: value(statement.args[1]),
            });
        }
      } else if (
        ["call", "call.v", "lindirectn", "lindirectv", "rindirect"].includes(statement.name) ||
        (!role && spec?.operands.includes("var"))
      ) {
        definitions.clear();
      }
    }
  }
  walk(syntax.program);
  // Recover operand roles in unfinished calls through the language service's token analysis.
  const commands = [...ACTIONS, ...V3_ACTIONS, ...IIGS_ACTIONS, ...AMIGA_ACTIONS].filter(
    (command) => actionSpec(command.name, profile)?.code === command.code,
  );
  const numbered = new Map(
    collectLogicOperands(syntax, commands, profile)
      .filter((operand) => !operand.declaration)
      .map((operand) => [operand.start, operand]),
  );
  const analyzed = new Set(uses.map((use) => use.start));
  for (const [index, command] of tokens.entries()) {
    if (command.type !== "ident" || tokens[index + 1]?.text !== "(" || analyzed.has(command.start))
      continue;
    const role = resourceReferenceOperand(command.text, profile);
    if (!role || role.kind === "item" || !actionSpec(command.text, profile)) continue;
    let parameter = 0;
    let token: Token | undefined;
    for (let at = index + 2; at < tokens.length; at++) {
      const current = tokens[at]!;
      if ([")", ";", "{", "}"].includes(current.text)) break;
      if (current.text === ",") parameter++;
      else if (parameter === role.operand) {
        token = current;
        break;
      }
    }
    const number = token ? numbered.get(token.start)?.num : undefined;
    uses.push({
      kind: role.kind,
      command: command.text,
      line: command.line,
      start: command.start,
      token: role.variable ? undefined : token,
      number: role.variable ? undefined : number,
      ...(role.variable && number !== undefined ? { variable: number } : {}),
    });
  }
  return uses.map((use) =>
    use.variable !== undefined &&
    use.token &&
    (unsafe.has(use.token) || (origins.get(use.token)?.size ?? 0) > 1)
      ? { ...use, number: undefined, token: undefined }
      : use,
  );
}
