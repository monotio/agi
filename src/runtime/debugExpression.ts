/**
 * Bounded, side-effect-free expressions for the debugger and watchpoints.
 * Compilation statically checks types so evaluation only fails on snapshot
 * data: out-of-range indices, missing values, zero divisors and integer
 * overflow. Nothing is coerced, wrapped or caught silently.
 */

const MAX_SOURCE_LENGTH = 1024;
const MAX_NODES = 128;
const MAX_DEPTH = 16;

export class DebugExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DebugExpressionError";
  }
}

/** A value a debug expression can produce: integer number, boolean or string. */
export type DebugValue = number | boolean | string;
type DebugValueType = "number" | "boolean" | "string";

/** A whitelist record binding a name to one numbered game slot. */
interface DebugBinding {
  readonly kind: "variable" | "flag" | "string";
  readonly num: number;
}
export type DebugBindings = Record<string, DebugBinding>;

export interface DebugExpressionOptions {
  /** Enables the `old`/`new` watch operands. */
  readonly watch?: boolean;
  /** Static type of `old`/`new`; required when `watch` is set. */
  readonly watchType?: DebugValueType;
}

export interface DebugObjectState {
  readonly x: number;
  readonly y: number;
  readonly view: number;
  readonly loop: number;
  readonly cel: number;
  readonly direction: number;
  readonly priority: number;
  readonly active: boolean;
}

interface DebugInventoryItem {
  readonly room: number;
}

/** Detached primitive game state; never an Engine and never callback-bearing. */
export interface DebugSnapshot {
  readonly vars: readonly number[];
  readonly flags: readonly boolean[];
  readonly strings: readonly string[];
  readonly objects: readonly DebugObjectState[];
  readonly inventory: readonly DebugInventoryItem[];
  readonly room: number;
  readonly logic: number;
  readonly pc: number;
  readonly cycle: number;
  readonly old?: DebugValue;
  readonly new?: DebugValue;
}

export interface CompiledDebugExpression {
  readonly source: string;
  readonly type: DebugValueType;
  /** Pure: reads the snapshot, throws DebugExpressionError on bad data. */
  evaluate(snapshot: DebugSnapshot): DebugValue;
}

const STRING_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  "\\": "\\",
  '"': '"',
  "'": "'",
};

const OBJECT_FIELD_TYPES: Record<string, DebugValueType> = {
  x: "number",
  y: "number",
  view: "number",
  loop: "number",
  cel: "number",
  direction: "number",
  priority: "number",
  active: "boolean",
};

type ObjectField = "x" | "y" | "view" | "loop" | "cel" | "direction" | "priority" | "active";

type ScalarName = "room" | "logic" | "pc" | "cycle";

type Node =
  | { kind: "literal"; type: DebugValueType; value: DebugValue }
  | { kind: "var"; type: "number"; num: number }
  | { kind: "flag"; type: "boolean"; num: number }
  | { kind: "str"; type: "string"; num: number }
  | { kind: "scalar"; type: "number"; name: ScalarName }
  | { kind: "watch"; type: DebugValueType; which: "old" | "new" }
  | { kind: "object"; type: DebugValueType; index: Node; field: ObjectField }
  | { kind: "inventory"; type: "number"; index: Node }
  | { kind: "unary"; type: DebugValueType; op: "!" | "-"; operand: Node }
  | { kind: "binary"; type: DebugValueType; op: string; left: Node; right: Node };

type Token =
  | { kind: "number"; value: number; pos: number }
  | { kind: "string"; value: string; pos: number }
  | { kind: "name"; name: string; pos: number }
  | { kind: "op"; op: string; pos: number }
  | { kind: "end"; pos: number };

function fail(message: string, pos: number): never {
  throw new DebugExpressionError(`${message} at character ${pos}`);
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isNameStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isNameChar(code: number): boolean {
  return isNameStart(code) || isDigit(code);
}

const TWO_CHAR_OPS: Readonly<Record<string, true>> = {
  "||": true,
  "&&": true,
  "==": true,
  "!=": true,
  "<=": true,
  ">=": true,
};
const ONE_CHAR_OPS = "()[]+-*/%!<>.";

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const start = i;
    const code = source.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      i++;
      continue;
    }
    if (isDigit(code)) {
      while (i < source.length && isDigit(source.charCodeAt(i))) i++;
      const value = Number(source.slice(start, i));
      if (!Number.isSafeInteger(value)) fail("integer literal out of range", start);
      tokens.push({ kind: "number", value, pos: start });
      continue;
    }
    if (isNameStart(code)) {
      while (i < source.length && isNameChar(source.charCodeAt(i))) i++;
      tokens.push({ kind: "name", name: source.slice(start, i), pos: start });
      continue;
    }
    if (code === 34) {
      i++;
      let value = "";
      for (;;) {
        if (i >= source.length) fail("unterminated string literal", start);
        const ch = source.charAt(i);
        if (ch === '"') {
          i++;
          break;
        }
        if (ch === "\n" || ch === "\r") fail("newline in string literal", i);
        if (ch === "\\") {
          const mapped = Object.hasOwn(STRING_ESCAPES, source.charAt(i + 1))
            ? STRING_ESCAPES[source.charAt(i + 1)]
            : undefined;
          if (mapped === undefined) {
            fail(`unknown escape '\\${source.charAt(i + 1)}'`, i);
          }
          value += mapped;
          i += 2;
          continue;
        }
        value += ch;
        i++;
      }
      tokens.push({ kind: "string", value, pos: start });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (Object.hasOwn(TWO_CHAR_OPS, two)) {
      tokens.push({ kind: "op", op: two, pos: start });
      i += 2;
      continue;
    }
    const ch = source.charAt(i);
    if (ONE_CHAR_OPS.includes(ch)) {
      tokens.push({ kind: "op", op: ch, pos: start });
      i++;
      continue;
    }
    fail(`unexpected character '${ch}'`, start);
  }
  tokens.push({ kind: "end", pos: i });
  return tokens;
}

function describe(token: Token): string {
  switch (token.kind) {
    case "number":
      return `number ${token.value}`;
    case "string":
      return "string literal";
    case "name":
      return `'${token.name}'`;
    case "op":
      return `'${token.op}'`;
    case "end":
      return "end of input";
  }
}

class Parser {
  private index = 0;
  private nodeCount = 0;
  private readonly tokens: readonly Token[];
  private readonly bindings: DebugBindings;
  private readonly watchType: DebugValueType | null;

  constructor(tokens: readonly Token[], bindings: DebugBindings, watchType: DebugValueType | null) {
    this.tokens = tokens;
    this.bindings = bindings;
    this.watchType = watchType;
  }

  parse(): Node {
    const root = this.parseOr(0);
    const token = this.peek();
    if (token.kind !== "end") this.failHere(`unexpected ${describe(token)}`);
    return root;
  }

  private peek(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) throw new DebugExpressionError("parser overrun");
    return token;
  }

  private failHere(message: string): never {
    fail(message, this.peek().pos);
  }

  private eatOp(op: string): boolean {
    const token = this.peek();
    if (token.kind !== "op" || token.op !== op) return false;
    this.index++;
    return true;
  }

  private eatAny(ops: readonly string[]): string | null {
    const token = this.peek();
    if (token.kind !== "op" || !ops.includes(token.op)) return null;
    this.index++;
    return token.op;
  }

  private expectOp(op: string): void {
    if (!this.eatOp(op)) {
      this.failHere(`expected '${op}', found ${describe(this.peek())}`);
    }
  }

  private nest(depth: number): number {
    const inner = depth + 1;
    if (inner > MAX_DEPTH) {
      this.failHere(`expression nested deeper than ${MAX_DEPTH}`);
    }
    return inner;
  }

  private node<N extends Node>(node: N): N {
    this.nodeCount++;
    if (this.nodeCount > MAX_NODES) {
      this.failHere(`expression exceeds ${MAX_NODES} nodes`);
    }
    return Object.freeze(node);
  }

  private parseOr(depth: number): Node {
    let left = this.parseAnd(depth);
    while (this.eatOp("||")) {
      left = this.binary("||", left, this.parseAnd(depth));
    }
    return left;
  }

  private parseAnd(depth: number): Node {
    let left = this.parseEquality(depth);
    while (this.eatOp("&&")) {
      left = this.binary("&&", left, this.parseEquality(depth));
    }
    return left;
  }

  private parseEquality(depth: number): Node {
    let left = this.parseCompare(depth);
    for (;;) {
      const op = this.eatAny(["==", "!="]);
      if (op === null) return left;
      left = this.binary(op, left, this.parseCompare(depth));
    }
  }

  private parseCompare(depth: number): Node {
    let left = this.parseAdditive(depth);
    for (;;) {
      const op = this.eatAny(["<", "<=", ">", ">="]);
      if (op === null) return left;
      left = this.binary(op, left, this.parseAdditive(depth));
    }
  }

  private parseAdditive(depth: number): Node {
    let left = this.parseTerm(depth);
    for (;;) {
      const op = this.eatAny(["+", "-"]);
      if (op === null) return left;
      left = this.binary(op, left, this.parseTerm(depth));
    }
  }

  private parseTerm(depth: number): Node {
    let left = this.parseUnary(depth);
    for (;;) {
      const op = this.eatAny(["*", "/", "%"]);
      if (op === null) return left;
      left = this.binary(op, left, this.parseUnary(depth));
    }
  }

  private parseUnary(depth: number): Node {
    if (this.eatOp("!")) {
      const operand = this.parseUnary(this.nest(depth));
      if (operand.type !== "boolean") {
        this.failHere("'!' requires a boolean operand");
      }
      return this.node({ kind: "unary", type: "boolean", op: "!", operand });
    }
    if (this.eatOp("-")) {
      const operand = this.parseUnary(this.nest(depth));
      if (operand.type !== "number") {
        this.failHere("unary '-' requires a number operand");
      }
      return this.node({ kind: "unary", type: "number", op: "-", operand });
    }
    return this.parsePrimary(depth);
  }

  private parsePrimary(depth: number): Node {
    const token = this.peek();
    if (token.kind === "number") {
      this.index++;
      return this.node({ kind: "literal", type: "number", value: token.value });
    }
    if (token.kind === "string") {
      this.index++;
      return this.node({ kind: "literal", type: "string", value: token.value });
    }
    if (token.kind === "op" && token.op === "(") {
      this.index++;
      const inner = this.parseOr(this.nest(depth));
      this.expectOp(")");
      return inner;
    }
    if (token.kind === "name") {
      this.index++;
      return this.parseName(token.name, depth);
    }
    this.failHere(`unexpected ${describe(token)}`);
  }

  private parseName(name: string, depth: number): Node {
    if (name === "true" || name === "false") {
      return this.node({ kind: "literal", type: "boolean", value: name === "true" });
    }
    const ref = /^([vfs])(\d+)$/.exec(name);
    if (ref !== null) {
      const num = Number(ref[2]);
      if (!Number.isSafeInteger(num)) this.failHere(`index out of range in '${name}'`);
      if (ref[1] === "v") return this.node({ kind: "var", type: "number", num });
      if (ref[1] === "f") return this.node({ kind: "flag", type: "boolean", num });
      return this.node({ kind: "str", type: "string", num });
    }
    if (name === "object") return this.parseObjectIndex(depth);
    if (name === "inventory") return this.parseInventoryIndex(depth);
    if (name === "room" || name === "logic" || name === "pc" || name === "cycle") {
      return this.node({ kind: "scalar", type: "number", name });
    }
    if (name === "old" || name === "new") {
      if (this.watchType === null) {
        this.failHere(`'${name}' requires options.watch`);
      }
      return this.node({ kind: "watch", type: this.watchType, which: name });
    }
    const binding = Object.hasOwn(this.bindings, name) ? this.bindings[name] : undefined;
    if (binding === undefined) this.failHere(`unknown name '${name}'`);
    if (binding.kind === "variable") {
      return this.node({ kind: "var", type: "number", num: binding.num });
    }
    if (binding.kind === "flag") {
      return this.node({ kind: "flag", type: "boolean", num: binding.num });
    }
    return this.node({ kind: "str", type: "string", num: binding.num });
  }

  private parseObjectIndex(depth: number): Node {
    this.expectOp("[");
    const index = this.parseOr(this.nest(depth));
    this.expectOp("]");
    if (index.type !== "number") {
      this.failHere("object index must be a number");
    }
    this.expectOp(".");
    const field = this.peek();
    if (field.kind !== "name") {
      this.failHere(`expected an object field, found ${describe(field)}`);
    }
    this.index++;
    if (!Object.hasOwn(OBJECT_FIELD_TYPES, field.name)) {
      fail(`unknown object field '${field.name}'`, field.pos);
    }
    return this.node({
      kind: "object",
      type: OBJECT_FIELD_TYPES[field.name] ?? "number",
      index,
      field: field.name as ObjectField,
    });
  }

  private parseInventoryIndex(depth: number): Node {
    this.expectOp("[");
    const index = this.parseOr(this.nest(depth));
    this.expectOp("]");
    if (index.type !== "number") {
      this.failHere("inventory index must be a number");
    }
    this.expectOp(".");
    const field = this.peek();
    if (field.kind !== "name" || field.name !== "room") {
      this.failHere("inventory items expose only '.room'");
    }
    this.index++;
    return this.node({ kind: "inventory", type: "number", index });
  }

  private binary(op: string, left: Node, right: Node): Node {
    if (op === "||" || op === "&&") {
      if (left.type !== "boolean" || right.type !== "boolean") {
        this.failHere(`'${op}' requires boolean operands`);
      }
      return this.node({ kind: "binary", type: "boolean", op, left, right });
    }
    if (op === "==" || op === "!=") {
      if (left.type !== right.type) {
        this.failHere(`'${op}' requires operands of the same type`);
      }
      return this.node({ kind: "binary", type: "boolean", op, left, right });
    }
    if (left.type !== "number" || right.type !== "number") {
      this.failHere(`'${op}' requires number operands`);
    }
    const type = op === "<" || op === "<=" || op === ">" || op === ">=" ? "boolean" : "number";
    return this.node({ kind: "binary", type, op, left, right });
  }
}

function readNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DebugExpressionError(`${what} is not a safe integer`);
  }
  return value === 0 ? 0 : value;
}

function readBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    throw new DebugExpressionError(`${what} is not a boolean`);
  }
  return value;
}

function readString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new DebugExpressionError(`${what} is not a string`);
  }
  return value;
}

function readIndex(value: DebugValue, length: number, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= length) {
    throw new DebugExpressionError(`${what} index is out of range`);
  }
  return value;
}

/** Read only detached own data, without invoking an accessor or prototype lookup. */
function ownValue(record: unknown, key: string, what: string): unknown {
  if (typeof record !== "object" || record === null) {
    throw new DebugExpressionError(`${what} is missing from the snapshot`);
  }
  const property = Object.getOwnPropertyDescriptor(record, key);
  if (property === undefined || !Object.hasOwn(property, "value")) {
    throw new DebugExpressionError(`${what} must be an own snapshot data property`);
  }
  return property.value;
}

function readSlot(snap: DebugSnapshot, field: string, index: DebugValue, what: string): unknown {
  const values = ownValue(snap, field, field);
  if (!Array.isArray(values)) throw new DebugExpressionError(`${field} is not a snapshot array`);
  const i = readIndex(index, values.length, what);
  return ownValue(values, String(i), `${what}[${i}]`);
}

function readRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DebugExpressionError(`${what} is not a state record`);
  }
  return value as Record<string, unknown>;
}

function readWatch(node: Extract<Node, { kind: "watch" }>, snap: DebugSnapshot): DebugValue {
  const value = ownValue(snap, node.which, node.which);
  const what = `'${node.which}'`;
  if (value === undefined) {
    throw new DebugExpressionError(`${what} is missing from the snapshot`);
  }
  if (node.type === "number") return readNumber(value, what);
  if (node.type === "boolean") return readBoolean(value, what);
  return readString(value, what);
}

function evalBinary(node: Extract<Node, { kind: "binary" }>, snap: DebugSnapshot): DebugValue {
  switch (node.op) {
    case "&&":
      return readBoolean(evalNode(node.left, snap), "'&&' operand")
        ? readBoolean(evalNode(node.right, snap), "'&&' operand")
        : false;
    case "||":
      return readBoolean(evalNode(node.left, snap), "'||' operand")
        ? true
        : readBoolean(evalNode(node.right, snap), "'||' operand");
    case "==":
      return evalNode(node.left, snap) === evalNode(node.right, snap);
    case "!=":
      return evalNode(node.left, snap) !== evalNode(node.right, snap);
  }
  const left = readNumber(evalNode(node.left, snap), `'${node.op}' operand`);
  const right = readNumber(evalNode(node.right, snap), `'${node.op}' operand`);
  switch (node.op) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "+":
      return readNumber(left + right, "sum");
    case "-":
      return readNumber(left - right, "difference");
    case "*":
      return readNumber(left * right, "product");
    case "/":
      if (right === 0) throw new DebugExpressionError("division by zero");
      return readNumber(Math.trunc(left / right), "quotient");
    case "%":
      if (right === 0) throw new DebugExpressionError("modulo by zero");
      return readNumber(left % right, "remainder");
  }
  throw new DebugExpressionError(`unknown operator '${node.op}'`);
}

function evalNode(node: Node, snap: DebugSnapshot): DebugValue {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "var":
      return readNumber(readSlot(snap, "vars", node.num, `v${node.num}`), `v${node.num}`);
    case "flag":
      return readBoolean(readSlot(snap, "flags", node.num, `f${node.num}`), `f${node.num}`);
    case "str":
      return readString(readSlot(snap, "strings", node.num, `s${node.num}`), `s${node.num}`);
    case "scalar":
      return readNumber(ownValue(snap, node.name, node.name), node.name);
    case "watch":
      return readWatch(node, snap);
    case "object": {
      const i = evalNode(node.index, snap);
      const record = readRecord(readSlot(snap, "objects", i, "object"), `object[${i}]`);
      const what = `object[${i}].${node.field}`;
      const value = ownValue(record, node.field, what);
      return node.type === "boolean" ? readBoolean(value, what) : readNumber(value, what);
    }
    case "inventory": {
      const i = evalNode(node.index, snap);
      const record = readRecord(readSlot(snap, "inventory", i, "inventory"), `inventory[${i}]`);
      return readNumber(ownValue(record, "room", `inventory[${i}].room`), `inventory[${i}].room`);
    }
    case "unary":
      if (node.op === "!") {
        return !readBoolean(evalNode(node.operand, snap), "'!' operand");
      }
      return readNumber(-readNumber(evalNode(node.operand, snap), "'-' operand"), "negation");
    case "binary":
      return evalBinary(node, snap);
  }
}

function validateBindings(bindings: DebugBindings): void {
  for (const name of Object.keys(bindings)) {
    const binding = bindings[name];
    if (typeof binding !== "object" || binding === null) {
      throw new DebugExpressionError(`binding '${name}' must be a record`);
    }
    if (binding.kind !== "variable" && binding.kind !== "flag" && binding.kind !== "string") {
      throw new DebugExpressionError(`binding '${name}' has an unknown kind`);
    }
    if (!Number.isSafeInteger(binding.num) || binding.num < 0) {
      throw new DebugExpressionError(`binding '${name}' has an invalid num`);
    }
  }
}

function resolveWatchType(options: DebugExpressionOptions): DebugValueType | null {
  if (options.watch === true) {
    const type = options.watchType;
    if (type !== "number" && type !== "boolean" && type !== "string") {
      throw new DebugExpressionError("options.watch requires an explicit watchType");
    }
    return type;
  }
  if (options.watchType !== undefined) {
    throw new DebugExpressionError("watchType requires options.watch");
  }
  return null;
}

/**
 * Compile a debugger expression. Throws DebugExpressionError on syntax,
 * type, binding or bound violations. The result is deeply frozen.
 */
export function compileDebugExpression(
  source: string,
  bindings: DebugBindings = {},
  options: DebugExpressionOptions = {},
): CompiledDebugExpression {
  if (typeof source !== "string") {
    throw new DebugExpressionError("expression source must be a string");
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new DebugExpressionError(`expression source exceeds ${MAX_SOURCE_LENGTH} characters`);
  }
  validateBindings(bindings);
  const watchType = resolveWatchType(options);
  const parser = new Parser(tokenize(source), bindings, watchType);
  const ast = parser.parse();
  return Object.freeze({
    source,
    type: ast.type,
    evaluate(snapshot: DebugSnapshot): DebugValue {
      if (typeof snapshot !== "object" || snapshot === null) {
        throw new DebugExpressionError("snapshot must be a record");
      }
      return evalNode(ast, snapshot);
    },
  });
}
