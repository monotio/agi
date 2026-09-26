/**
 * Typed Room Studio rules and their two directions: `emitRule` writes the one
 * canonical AGI logic fragment for a model, and `parseRule` reads a fragment
 * back into a model ONLY when it has exactly one of those canonical shapes.
 * Anything else — other opcodes, labels, gotos, extra clauses, a different
 * statement order — is "native": it stays source text the UI shows as is.
 * Whitespace, line breaks and comments never matter, so a fragment that went
 * through assemble → disassemble still reads (message numbers resolve through
 * the logic's message table; flag numbers read back as their binding name).
 *
 * Canonical shapes (F a flag: a named binding or fN; BOX is
 * `posn(o0, X1, Y1, X2, Y2)`; Cs flag tests joined by " && ": isset(F) or
 * !isset(F)):
 *
 *   edge exit  if (equaln(v2, EDGE)) { new.room(D); }
 *              if (equaln(v2, EDGE)) {
 *                if (isset(F)) { new.room(D); } else { assignn(v6, 0); [print("…");] }
 *              }
 *   door exit  if (BOX[ && isset(F)]) { new.room(D); }
 *   region     if (!isset(F) && BOX[ && Cs]) { set(F); [print("…");] }
 *
 * EDGE is the ego edge code in v2 (1 top, 2 right, 3 bottom, 4 left), the
 * values write_room compiles, and a blocked edge exit stops ego (v6 = 0) and
 * prints like write_room. BOX tests ego's baseline position every cycle:
 * posn is true while X1 <= x <= X2 and Y1 <= y <= Y2 for ego's left baseline
 * pixel. A door exit fires on the first cycle ego stands in its box; a locked
 * door (its flag clear) does nothing, because a message would repeat every
 * cycle ego stays inside. A region is a named spot: its flag is set on the
 * first cycle ego is inside (the tutorial's "stand_tag_seen" pattern), which
 * stops it firing again and tells other logic the spot was reached.
 */
import type { BindingKind } from "../../agent/authoringState.ts";
import { quoteLogicString } from "../../logic/disassembler.ts";
import { ruleFragmentText, type LogicDocument, type LogicRuleFragment } from "./logicDocument.ts";

/** A flag: a named binding (preferred) or a raw flag number. */
export type FlagRef = string | number;

export type Edge = "top" | "right" | "bottom" | "left";

/** v2 edge codes, as write_room compiles them. */
export const EDGE_CODES: Readonly<Record<Edge, number>> = { top: 1, right: 2, bottom: 3, left: 4 };

export interface FlagCondition {
  readonly flag: FlagRef;
  /** True: the flag must be set; false: clear. */
  readonly value: boolean;
}

export interface RuleBox {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface EdgeExitRule {
  readonly kind: "exit";
  readonly edge: Edge;
  readonly destination: number;
  readonly requiresFlag: FlagRef | null;
  /** Printed when the required flag is clear; needs `requiresFlag`. */
  readonly blockedMessage: string | null;
}

/** A doorway: entering the box goes to the destination. */
export interface DoorExitRule {
  readonly kind: "exit";
  readonly edge: null;
  readonly box: RuleBox;
  readonly destination: number;
  /** A clear flag keeps the door shut, silently. */
  readonly requiresFlag: FlagRef | null;
}

export type ExitRule = EdgeExitRule | DoorExitRule;

export interface RegionRule {
  readonly kind: "region";
  readonly box: RuleBox;
  /** Set on the first cycle ego is inside; the rule fires once. */
  readonly flag: FlagRef;
  readonly when: readonly FlagCondition[];
  readonly message: string | null;
}

export type RuleModel = ExitRule | RegionRule;

export interface RuleParseContext {
  /** The logic's message table (index = message number) for print(mN). */
  readonly messages?: readonly (string | null)[];
  /**
   * Named bindings. Flag names must be flag bindings, and a flag number with
   * exactly one flag binding reads back as that name.
   */
  readonly bindings?: Readonly<
    Record<string, { readonly kind: BindingKind; readonly num: number }>
  >;
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const EDGE_BY_CODE: Readonly<Record<number, Edge>> = {
  1: "top",
  2: "right",
  3: "bottom",
  4: "left",
};

/** The rule's box, for rules that have one (door exits and regions). */
export function ruleBox(model: RuleModel): RuleBox | null {
  return "box" in model ? model.box : null;
}

// ---------- Validation ----------

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function flagProblem(flag: unknown, label: string): string | null {
  if (typeof flag === "string")
    return NAME.test(flag) ? null : `${label} '${flag}' must be a lowercase binding name.`;
  return isInt(flag, 0, 255) ? null : `${label} must be a flag name or a number from 0 to 255.`;
}

function textProblem(text: unknown, label: string): string | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 1000)
    return `${label} must be text of 1 to 1000 characters.`;
  return null;
}

function boxProblem(box: RuleBox): string | null {
  const { x1, y1, x2, y2 } = box;
  if (!isInt(x1, 0, 159) || !isInt(x2, 0, 159) || !isInt(y1, 0, 167) || !isInt(y2, 0, 167))
    return "A box must lie inside the 160x168 picture.";
  if (x1 > x2 || y1 > y2) return "A box needs x1 <= x2 and y1 <= y2.";
  return null;
}

/** Why a model cannot be emitted, in plain words; null when it is valid. */
export function ruleModelProblem(model: RuleModel): string | null {
  if (model.kind === "exit") {
    if (!isInt(model.destination, 1, 255)) return "An exit's destination is a room from 1 to 255.";
    if (model.requiresFlag !== null) {
      const problem = flagProblem(model.requiresFlag, "The exit's required flag");
      if (problem) return problem;
    }
    if (model.edge === null) return boxProblem(model.box);
    if (!Object.hasOwn(EDGE_CODES, model.edge))
      return "An exit leaves by the top, right, bottom or left edge, or through a door box.";
    if (model.blockedMessage === null) return null;
    if (model.requiresFlag === null)
      return "A blocked message needs a required flag to block the exit.";
    return textProblem(model.blockedMessage, "The blocked message");
  }
  if (model.kind === "region") {
    const problem =
      boxProblem(model.box) ??
      flagProblem(model.flag, "The region's flag") ??
      (model.message === null ? null : textProblem(model.message, "The region's message"));
    if (problem) return problem;
    if (!Array.isArray(model.when) || model.when.length > 8)
      return "A region can check at most 8 flags.";
    for (const condition of model.when) {
      const bad = flagProblem(condition.flag, "A condition's flag");
      if (bad) return bad;
    }
    return null;
  }
  return "Unknown rule kind.";
}

// ---------- Emit ----------

const flagText = (flag: FlagRef): string => (typeof flag === "number" ? `f${flag}` : flag);
const boxText = ({ x1, y1, x2, y2 }: RuleBox): string => `posn(o0, ${x1}, ${y1}, ${x2}, ${y2})`;
const printText = (text: string): string => `print(${quoteLogicString(text)});`;

/** `if (condition) { body }` with the body indented one level; `else` when given. */
function block(
  condition: string,
  body: readonly string[],
  otherwise?: readonly string[],
): string[] {
  const lines = [`if (${condition}) {`, ...body.map((line) => `  ${line}`)];
  if (otherwise === undefined) return [...lines, "}"];
  return [...lines, "} else {", ...otherwise.map((line) => `  ${line}`), "}"];
}

/** The canonical fragment for a valid model, without indentation or directives. */
export function emitRule(model: RuleModel): string {
  const problem = ruleModelProblem(model);
  if (problem) throw new Error(problem);
  if (model.kind === "region") {
    const flag = flagText(model.flag);
    const terms = [
      `!isset(${flag})`,
      boxText(model.box),
      ...model.when.map((c) => `${c.value ? "" : "!"}isset(${flagText(c.flag)})`),
    ];
    const body = [`set(${flag});`, ...(model.message === null ? [] : [printText(model.message)])];
    return block(terms.join(" && "), body).join("\n");
  }
  const go = `new.room(${model.destination});`;
  const required = model.requiresFlag === null ? null : `isset(${flagText(model.requiresFlag)})`;
  if (model.edge === null)
    return block([boxText(model.box), ...(required ? [required] : [])].join(" && "), [go]).join(
      "\n",
    );
  const guard = `equaln(v2, ${EDGE_CODES[model.edge]})`;
  if (required === null) return block(guard, [go]).join("\n");
  const blocked = ["assignn(v6, 0);"];
  if (model.blockedMessage !== null) blocked.push(printText(model.blockedMessage));
  return block(guard, block(required, [go], blocked)).join("\n");
}

// ---------- Parse: a small statement grammar over the assembler's token set ----------

type Token = { readonly type: "ident" | "number" | "string" | "punct"; readonly text: string };

class NotCanonical extends Error {}

function refuse(): never {
  throw new NotCanonical();
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (source.startsWith("//", i)) {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (ch === '"') {
      let text = "";
      i++;
      for (;;) {
        const s = source[i];
        if (s === undefined || s === "\n") refuse();
        if (s === '"') break;
        if (s !== "\\") {
          text += s;
          i++;
          continue;
        }
        const esc = source[i + 1];
        if (esc === "n") text += "\n";
        else if (esc === "r") text += "\r";
        else if (esc === "\\" || esc === '"') text += esc;
        else if (esc === "x" && /^[0-9a-fA-F]{2}$/.test(source.slice(i + 2, i + 4))) {
          text += String.fromCharCode(parseInt(source.slice(i + 2, i + 4), 16));
          i += 2;
        } else refuse();
        i += 2;
      }
      i++;
      tokens.push({ type: "string", text });
    } else if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < source.length && /[0-9]/.test(source[i]!)) i++;
      tokens.push({ type: "number", text: source.slice(start, i) });
    } else if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < source.length && /[a-zA-Z0-9_.]/.test(source[i]!)) i++;
      tokens.push({ type: "ident", text: source.slice(start, i) });
    } else if (source.startsWith("&&", i) || source.startsWith("||", i)) {
      tokens.push({ type: "punct", text: source.slice(i, i + 2) });
      i += 2;
    } else if ("(){},;!".includes(ch)) {
      tokens.push({ type: "punct", text: ch });
      i++;
    } else refuse();
  }
  return tokens;
}

type Arg = Token;
interface Call {
  readonly name: string;
  readonly args: readonly Arg[];
}
type Expr =
  | { readonly t: "call"; readonly call: Call }
  | { readonly t: "not"; readonly e: Expr }
  | { readonly t: "and" | "or"; readonly items: readonly Expr[] };
type Stmt =
  | { readonly t: "call"; readonly call: Call }
  | {
      readonly t: "if";
      readonly cond: Expr;
      readonly then: readonly Stmt[];
      readonly else_: readonly Stmt[] | null;
    };

function parseStatements(tokens: readonly Token[]): Stmt[] {
  let at = 0;
  const punct = (text: string): boolean =>
    tokens[at]?.type === "punct" && tokens[at]?.text === text;
  const keyword = (text: string): boolean =>
    tokens[at]?.type === "ident" && tokens[at]?.text === text;
  const expect = (text: string): void => {
    if (!punct(text)) refuse();
    at++;
  };
  const call = (): Call => {
    const name = tokens[at];
    if (name?.type !== "ident") refuse();
    at++;
    expect("(");
    const args: Arg[] = [];
    if (!punct(")")) {
      for (;;) {
        const arg = tokens[at];
        if (arg === undefined || arg.type === "punct") refuse();
        args.push(arg);
        at++;
        if (!punct(",")) break;
        at++;
      }
    }
    expect(")");
    return { name: name.text, args };
  };
  const unary = (): Expr => {
    if (punct("!")) {
      at++;
      return { t: "not", e: unary() };
    }
    if (punct("(")) {
      at++;
      const inner = or();
      expect(")");
      // A parenthesized single test asks the assembler for OR markers: not canonical.
      if (inner.t === "call" || inner.t === "not") refuse();
      return inner;
    }
    return { t: "call", call: call() };
  };
  const and = (): Expr => {
    const items = [unary()];
    while (punct("&&")) {
      at++;
      items.push(unary());
    }
    return items.length === 1 ? items[0]! : { t: "and", items };
  };
  const or = (): Expr => {
    const items = [and()];
    while (punct("||")) {
      at++;
      items.push(and());
    }
    return items.length === 1 ? items[0]! : { t: "or", items };
  };
  const blockBody = (): Stmt[] => {
    expect("{");
    const body: Stmt[] = [];
    while (at < tokens.length && !punct("}")) body.push(statement());
    expect("}");
    return body;
  };
  const statement = (): Stmt => {
    if (keyword("if")) {
      at++;
      expect("(");
      const cond = or();
      expect(")");
      const then = blockBody();
      let else_: Stmt[] | null = null;
      if (keyword("else")) {
        at++;
        else_ = blockBody();
      }
      return { t: "if", cond, then, else_ };
    }
    const c = call();
    expect(";");
    return { t: "call", call: c };
  };
  const statements: Stmt[] = [];
  while (at < tokens.length) statements.push(statement());
  return statements;
}

// ---------- Parse: canonical shape matching ----------

function numberArg(arg: Arg | undefined, min = 0, max = 255): number {
  if (arg?.type !== "number") refuse();
  const value = Number(arg.text);
  if (value < min || value > max) refuse();
  return value;
}

function sigilArg(arg: Arg | undefined, sigil: string): number {
  if (arg?.type === "ident" && new RegExp(`^${sigil}(0|[1-9]\\d{0,2})$`).test(arg.text)) {
    const value = Number(arg.text.slice(1));
    if (value <= 255) return value;
  }
  return refuse();
}

/** The call's arguments, when the node is exactly `name(…)` with `count` of them. */
function callArgs(node: Stmt | Expr | undefined, name: string, count: number): readonly Arg[] {
  if (node?.t !== "call" || node.call.name !== name || node.call.args.length !== count) refuse();
  return node.call.args;
}

const terms = (expr: Expr): readonly Expr[] => (expr.t === "and" ? expr.items : [expr]);

class Reader {
  readonly context: RuleParseContext;
  constructor(context: RuleParseContext) {
    this.context = context;
  }

  flag(arg: Arg | undefined): FlagRef {
    const bindings = this.context.bindings;
    if (arg?.type === "ident" && NAME.test(arg.text) && !/^[vfomsi]\d+$/.test(arg.text)) {
      if (bindings && bindings[arg.text]?.kind !== "flag") refuse();
      return arg.text;
    }
    const num = arg?.type === "number" ? numberArg(arg) : sigilArg(arg, "f");
    if (bindings) {
      const names = Object.entries(bindings).filter(([, b]) => b.kind === "flag" && b.num === num);
      if (names.length === 1) return names[0]![0];
    }
    return num;
  }

  /** The flag of `isset(F)` (value true) or `!isset(F)` (value false). */
  condition(expr: Expr | undefined): FlagCondition {
    const negated = expr?.t === "not";
    const inner = expr?.t === "not" ? expr.e : expr;
    return { flag: this.flag(callArgs(inner, "isset", 1)[0]), value: !negated };
  }

  room(stmt: Stmt | undefined): number {
    const [arg] = callArgs(stmt, "new.room", 1);
    if (arg?.type === "ident") {
      const binding = this.context.bindings?.[arg.text];
      if (binding?.kind !== "logic" || binding.num < 1) refuse();
      return binding.num;
    }
    return numberArg(arg, 1, 255);
  }

  message(stmt: Stmt | undefined): string {
    const [arg] = callArgs(stmt, "print", 1);
    if (arg?.type === "string") return arg.text;
    const num = arg?.type === "number" ? numberArg(arg, 1) : sigilArg(arg, "m");
    const text = this.context.messages?.[num];
    if (typeof text !== "string" || num === 0) refuse();
    return text;
  }

  box(expr: Expr | undefined): RuleBox {
    const args = callArgs(expr, "posn", 5);
    if (sigilArg(args[0], "o") !== 0) refuse();
    const box = {
      x1: numberArg(args[1], 0, 159),
      y1: numberArg(args[2], 0, 167),
      x2: numberArg(args[3], 0, 159),
      y2: numberArg(args[4], 0, 167),
    };
    if (boxProblem(box)) refuse();
    return box;
  }
}

function readEdgeExit(only: Stmt & { t: "if" }, r: Reader): EdgeExitRule {
  const guard = callArgs(only.cond, "equaln", 2);
  if (sigilArg(guard[0], "v") !== 2 || only.else_ !== null || only.then.length !== 1) refuse();
  const edge = EDGE_BY_CODE[numberArg(guard[1])] ?? refuse();
  const [body] = only.then;
  if (body?.t === "call")
    return {
      kind: "exit",
      edge,
      destination: r.room(body),
      requiresFlag: null,
      blockedMessage: null,
    };
  if (body?.t !== "if" || body.else_ === null || body.then.length !== 1) refuse();
  const requiresFlag = r.flag(callArgs(body.cond, "isset", 1)[0]);
  const destination = r.room(body.then[0]);
  const [stop, message, ...rest] = body.else_;
  const stopArgs = callArgs(stop, "assignn", 2);
  if (sigilArg(stopArgs[0], "v") !== 6 || numberArg(stopArgs[1]) !== 0 || rest.length > 0) refuse();
  const blockedMessage = message === undefined ? null : r.message(message);
  return { kind: "exit", edge, destination, requiresFlag, blockedMessage };
}

function readBoxRule(only: Stmt & { t: "if" }, r: Reader): DoorExitRule | RegionRule {
  if (only.else_ !== null) refuse();
  const list = terms(only.cond);
  if (list[0]?.t === "call" && list[0].call.name === "posn") {
    if (list.length > 2 || only.then.length !== 1) refuse();
    const box = r.box(list[0]);
    let requiresFlag: FlagRef | null = null;
    if (list[1] !== undefined) {
      const condition = r.condition(list[1]);
      if (!condition.value) refuse();
      requiresFlag = condition.flag;
    }
    return { kind: "exit", edge: null, box, destination: r.room(only.then[0]), requiresFlag };
  }
  const latch = r.condition(list[0]);
  if (latch.value) refuse();
  const box = r.box(list[1]);
  const when = list.slice(2).map((term) => r.condition(term));
  const [set, print, ...rest] = only.then;
  if (r.flag(callArgs(set, "set", 1)[0]) !== latch.flag || rest.length > 0) refuse();
  const message = print === undefined ? null : r.message(print);
  const model: RegionRule = { kind: "region", box, flag: latch.flag, when, message };
  if (ruleModelProblem(model)) refuse();
  return model;
}

/**
 * The model a fragment canonically encodes, or "native" for every other
 * shape. Never throws.
 */
export function parseRule(
  fragmentText: string,
  context: RuleParseContext = {},
): RuleModel | "native" {
  try {
    const stmts = parseStatements(tokenize(fragmentText));
    const [only] = stmts;
    if (stmts.length !== 1 || only?.t !== "if") return "native";
    const r = new Reader(context);
    const head = terms(only.cond)[0];
    return head?.t === "call" && head.call.name === "equaln"
      ? readEdgeExit(only, r)
      : readBoxRule(only, r);
  } catch (error) {
    if (error instanceof NotCanonical) return "native";
    throw error;
  }
}

/** Every annotated rule with its model; "native" when unterminated or not of its declared kind. */
export function readRules(
  document: LogicDocument,
  context: RuleParseContext = {},
): { readonly rule: LogicRuleFragment; readonly model: RuleModel | "native" }[] {
  return document.rules.map((rule) => {
    const model = rule.terminated ? parseRule(ruleFragmentText(document, rule), context) : "native";
    return { rule, model: model !== "native" && model.kind === rule.kind ? model : "native" };
  });
}
