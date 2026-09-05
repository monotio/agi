/**
 * AGI logic assembler: source text -> real logic resource bytecode.
 *
 * This is the primary tool the authoring agent uses. Errors are precise
 * (line:col) because they feed the agent's retry loop.
 *
 * Source syntax (classic AGI flavor, tightened):
 *
 *   #message 1 "You are standing in a clearing."
 *   #define  fDoorOpen 42
 *
 *   start:
 *   if (isset(f5) && !isset(fDoorOpen)) {
 *     print(1);
 *     print("inline text auto-allocated as a message");
 *     goto done;
 *   } else {
 *     if (said("open", "door") || said("unlock", "door")) {
 *       set(fDoorOpen);
 *     }
 *   }
 *   done:
 *   return;
 *
 * Tests support !, &&, || and parentheses. Any boolean shape is accepted:
 * the compiler normalizes to CNF (AND of OR-clauses), which is what the AGI
 * condition-list bytecode encodes (0xfc OR-groups, 0xfd NOT per predicate).
 *
 * ONE-TERM OR GROUPS. Parentheses around a *single* literal are not redundant:
 * they ask for the 0xfc markers around that one predicate, which real Sierra
 * logics contain and which must survive a disassemble/re-assemble round trip.
 * So `if ((isset(f1)))` emits `ff fc 07 01 fc ff`, while `if (isset(f1))`
 * emits `ff 07 01 ff`. The rule is narrow on purpose: it applies only when the
 * parenthesized expression is one condition (optionally negated) and that
 * group survives normalization as a whole conjunct. Parentheses around
 * anything longer keep their ordinary grouping meaning, and a group that ends
 * up merged into a longer OR clause simply unwraps — the markers the clause
 * already needs are the same ones.
 *
 * LABELS may appear at any nesting depth, including inside an if/else block,
 * and `goto` reaches any of them; a label emits no bytes, it only names the
 * byte offset it sits at. Label names are one flat namespace per logic, so
 * duplicates are an error wherever they are.
 *
 * MESSAGE TEXT is a byte string, one source character per byte. The lexer
 * understands the C escapes \n, \r, \\ and \" plus \xNN for any other byte;
 * a raw newline inside a literal is still an error. `#message N "text"`
 * defines message N; `#message N` with no text declares slot N ABSENT (a zero
 * offset in the table), which is distinct from `#message N ""`, an empty but
 * present message that still costs a terminator byte.
 *
 * said() words resolve through the caller-supplied dictionary (word -> id).
 * "*" is the any-one-word wildcard (id 1), "..." the rest-of-line terminator
 * (id 0x270f).
 *
 * Variable/flag/object/message/string refs accept v5 / f5 / o5 / m5 / s5
 * tokens or plain numbers. Immediate operands are plain numbers or #defines.
 */

import {
  actionSpec,
  CONDITION_BY_NAME,
  GOTO,
  IF,
  NOT,
  OR,
  RETURN,
  SAID_ANY_WORD,
  SAID_REST,
} from "./opcodes.ts";
import { buildLogicResource } from "./resource.ts";
import { DEFAULT_V2_PROFILE, type AgiProfile } from "../runtime/profile.ts";

export class AssemblerError extends Error {
  readonly line: number;
  readonly col: number;

  constructor(message: string, line: number, col: number) {
    super(`${line}:${col}: ${message}`);
    this.name = "AssemblerError";
    this.line = line;
    this.col = col;
  }
}

export interface AssembleOptions {
  /** Instruction vocabulary and widths; defaults to AGI 2.936. */
  readonly profile?: AgiProfile;
  /** Lowercase word -> dictionary id, for said() resolution. */
  readonly dictionary: ReadonlyMap<string, number>;
}

export interface AssembleResult {
  /** Complete logic resource payload (framing + encrypted messages). */
  readonly payload: Uint8Array;
  /** Just the bytecode section. */
  readonly code: Uint8Array;
  /** 1-based message table (index 0 unused placeholder; `null` = absent slot). */
  readonly messages: readonly (string | null)[];
}

// ---------- Lexer ----------

type TokenType = "ident" | "number" | "string" | "punct" | "directive" | "eof";

interface Token {
  readonly type: TokenType;
  readonly text: string;
  readonly line: number;
  readonly col: number;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const col = () => i - lineStart + 1;

  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\n") {
      line++;
      i++;
      lineStart = i;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "#") {
      const start = i;
      const c = col();
      i++;
      while (i < source.length && /[a-zA-Z]/.test(source[i]!)) i++;
      tokens.push({ type: "directive", text: source.slice(start, i), line, col: c });
      continue;
    }
    if (ch === '"') {
      const c = col();
      i++;
      let text = "";
      for (;;) {
        if (i >= source.length || source[i] === "\n") {
          throw new AssemblerError("unterminated string", line, c);
        }
        const s = source[i]!;
        if (s === '"') break;
        if (s !== "\\") {
          text += s;
          i++;
          continue;
        }
        const esc = source[i + 1];
        if (esc === undefined) throw new AssemblerError("unterminated string", line, c);
        if (esc === "n") text += "\n";
        else if (esc === "r") text += "\r";
        else if (esc === "\\") text += "\\";
        else if (esc === '"') text += '"';
        else if (esc === "x") {
          const hex = source.slice(i + 2, i + 4);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
            throw new AssemblerError(`\\x needs two hex digits, got '${hex}'`, line, col());
          }
          text += String.fromCharCode(parseInt(hex, 16));
          i += 2;
        } else {
          throw new AssemblerError(
            `unknown escape '\\${esc}' (use \\n, \\r, \\\\, \\" or \\xNN)`,
            line,
            col(),
          );
        }
        i += 2;
      }
      i++;
      tokens.push({ type: "string", text, line, col: c });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      const c = col();
      while (i < source.length && /[0-9]/.test(source[i]!)) i++;
      tokens.push({ type: "number", text: source.slice(start, i), line, col: c });
      continue;
    }
    if (/[a-zA-Z_.]/.test(ch)) {
      const start = i;
      const c = col();
      while (i < source.length && /[a-zA-Z0-9_.]/.test(source[i]!)) i++;
      tokens.push({ type: "ident", text: source.slice(start, i), line, col: c });
      continue;
    }
    if (ch === "&" && source[i + 1] === "&") {
      tokens.push({ type: "punct", text: "&&", line, col: col() });
      i += 2;
      continue;
    }
    if (ch === "|" && source[i + 1] === "|") {
      tokens.push({ type: "punct", text: "||", line, col: col() });
      i += 2;
      continue;
    }
    if ("(){};:,!".includes(ch)) {
      tokens.push({ type: "punct", text: ch, line, col: col() });
      i++;
      continue;
    }
    throw new AssemblerError(`unexpected character '${ch}'`, line, col());
  }
  tokens.push({ type: "eof", text: "", line, col: col() });
  return tokens;
}

// ---------- AST ----------

type Ref =
  | { kind: "num"; value: number }
  | { kind: "v" | "f" | "o" | "m" | "s"; index: number }
  | { kind: "str"; text: string };

type TestExpr =
  | { type: "cond"; name: string; args: Ref[]; tok: Token }
  | { type: "not"; inner: TestExpr }
  | { type: "and"; parts: TestExpr[] }
  | { type: "or"; parts: TestExpr[] }
  /** Parentheses the author put around a single literal: emit 0xfc markers. */
  | { type: "group"; inner: TestExpr };

type Stmt =
  | { type: "action"; name: string; args: Ref[]; tok: Token }
  | { type: "return" }
  | { type: "goto"; label: string; tok: Token }
  | { type: "label"; name: string; tok: Token }
  | { type: "if"; test: TestExpr; then: Stmt[]; else_: Stmt[] | null };

// ---------- Parser ----------

class Parser {
  private pos = 0;
  readonly defines = new Map<string, number>();
  /** Declared message slots; `null` is an explicitly absent slot. */
  readonly explicitMessages = new Map<number, string | null>();
  /** The program in source order; labels are statements that emit no bytes. */
  readonly program: Stmt[] = [];
  readonly labels = new Set<string>();

  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expect(type: TokenType, text?: string): Token {
    const tok = this.next();
    if (tok.type !== type || (text !== undefined && tok.text !== text)) {
      throw new AssemblerError(
        `expected ${text ?? type}, got '${tok.text || tok.type}'`,
        tok.line,
        tok.col,
      );
    }
    return tok;
  }

  parseProgram(): void {
    while (this.peek().type !== "eof") {
      if (this.peek().type === "directive") {
        this.parseDirective();
        continue;
      }
      this.program.push(this.parseLabel() ?? this.parseStmt());
    }
  }

  /** A `name:` label, at any nesting depth; null when the next token is not one. */
  private parseLabel(): Stmt | null {
    const tok = this.peek();
    if (tok.type !== "ident" || this.tokens[this.pos + 1]?.text !== ":") return null;
    this.next();
    this.next();
    if (this.labels.has(tok.text)) {
      throw new AssemblerError(`duplicate label '${tok.text}'`, tok.line, tok.col);
    }
    this.labels.add(tok.text);
    return { type: "label", name: tok.text, tok };
  }

  private parseDirective(): void {
    const dir = this.next();
    if (dir.text === "#message") {
      const num = this.expect("number");
      // No text at all declares an ABSENT slot: the table entry is a zero
      // offset, which is what the original tools left behind for a hole and
      // is distinct from `#message N ""`, a present but empty message.
      const str = this.peek().type === "string" ? this.next() : null;
      const n = Number(num.text);
      if (n < 1 || n > 255)
        throw new AssemblerError("message number must be 1..255", num.line, num.col);
      if (this.explicitMessages.has(n)) {
        throw new AssemblerError(`duplicate #message ${n}`, num.line, num.col);
      }
      this.explicitMessages.set(n, str === null ? null : str.text);
    } else if (dir.text === "#define") {
      const name = this.expect("ident");
      const num = this.expect("number");
      const n = Number(num.text);
      if (n < 0 || n > 255)
        throw new AssemblerError("#define value must be 0..255", num.line, num.col);
      if (this.defines.has(name.text)) {
        throw new AssemblerError(`duplicate #define '${name.text}'`, name.line, name.col);
      }
      this.defines.set(name.text, n);
    } else {
      throw new AssemblerError(
        `unknown directive '${dir.text}' (want #message or #define)`,
        dir.line,
        dir.col,
      );
    }
  }

  private parseBlock(): Stmt[] {
    this.expect("punct", "{");
    const out: Stmt[] = [];
    while (this.peek().text !== "}") {
      if (this.peek().type === "eof") {
        throw new AssemblerError("unterminated block", this.peek().line, this.peek().col);
      }
      out.push(this.parseLabel() ?? this.parseStmt());
    }
    this.expect("punct", "}");
    return out;
  }

  private parseStmt(): Stmt {
    const tok = this.next();
    if (tok.type !== "ident") {
      throw new AssemblerError(
        `expected statement, got '${tok.text || tok.type}'`,
        tok.line,
        tok.col,
      );
    }
    if (tok.text === "if") {
      this.expect("punct", "(");
      const test = this.parseTest();
      this.expect("punct", ")");
      const then = this.parseBlock();
      let else_: Stmt[] | null = null;
      if (this.peek().type === "ident" && this.peek().text === "else") {
        this.next();
        else_ = this.parseBlock();
      }
      return { type: "if", test, then, else_ };
    }
    if (tok.text === "return") {
      this.expect("punct", ";");
      return { type: "return" };
    }
    if (tok.text === "goto") {
      const label = this.expect("ident");
      this.expect("punct", ";");
      return { type: "goto", label: label.text, tok };
    }
    const args = this.parseCallArgs();
    return { type: "action", name: tok.text, args, tok };
  }

  private parseCallArgs(): Ref[] {
    this.expect("punct", "(");
    const args: Ref[] = [];
    if (this.peek().text !== ")") {
      for (;;) {
        args.push(this.parseRef());
        if (this.peek().text === ",") {
          this.next();
          continue;
        }
        break;
      }
    }
    this.expect("punct", ")");
    this.expect("punct", ";");
    return args;
  }

  private parseTestArgs(): Ref[] {
    this.expect("punct", "(");
    const args: Ref[] = [];
    if (this.peek().text !== ")") {
      for (;;) {
        args.push(this.parseRef());
        if (this.peek().text === ",") {
          this.next();
          continue;
        }
        break;
      }
    }
    this.expect("punct", ")");
    return args;
  }

  private parseRef(): Ref {
    const tok = this.next();
    if (tok.type === "number") {
      const n = Number(tok.text);
      if (n > 255) throw new AssemblerError("byte value out of range 0..255", tok.line, tok.col);
      return { kind: "num", value: n };
    }
    if (tok.type === "string") return { kind: "str", text: tok.text };
    if (tok.type === "ident") {
      const m = /^([vfoms])(\d{1,3})$/.exec(tok.text);
      if (m) {
        const idx = Number(m[2]);
        if (idx > 255) throw new AssemblerError("index out of range 0..255", tok.line, tok.col);
        return { kind: m[1] as "v" | "f" | "o" | "m" | "s", index: idx };
      }
      const defined = this.defines.get(tok.text);
      if (defined !== undefined) return { kind: "num", value: defined };
      throw new AssemblerError(
        `unknown identifier '${tok.text}' (want vN/fN/oN/mN/sN, a number, or a #define)`,
        tok.line,
        tok.col,
      );
    }
    throw new AssemblerError(
      `unexpected '${tok.text || tok.type}' in argument list`,
      tok.line,
      tok.col,
    );
  }

  private parseTest(): TestExpr {
    return this.parseOr();
  }

  private parseOr(): TestExpr {
    const first = this.parseAnd();
    if (this.peek().text !== "||") return first;
    const parts = [first];
    while (this.peek().text === "||") {
      this.next();
      parts.push(this.parseAnd());
    }
    return { type: "or", parts };
  }

  private parseAnd(): TestExpr {
    const first = this.parseUnary();
    if (this.peek().text !== "&&") return first;
    const parts = [first];
    while (this.peek().text === "&&") {
      this.next();
      parts.push(this.parseUnary());
    }
    return { type: "and", parts };
  }

  private parseUnary(): TestExpr {
    const tok = this.peek();
    if (tok.text === "!") {
      this.next();
      return { type: "not", inner: this.parseUnary() };
    }
    if (tok.text === "(") {
      this.next();
      const inner = this.parseTest();
      this.expect("punct", ")");
      // Parentheses around exactly one literal are meaningful, not redundant:
      // they ask for a one-term OR group (0xfc <pred> 0xfc). See the header.
      if (inner.type === "cond" || (inner.type === "not" && inner.inner.type === "cond")) {
        return { type: "group", inner };
      }
      return inner;
    }
    if (tok.type !== "ident") {
      throw new AssemblerError(
        `expected condition, got '${tok.text || tok.type}'`,
        tok.line,
        tok.col,
      );
    }
    this.next();
    const args = this.parseTestArgs();
    return { type: "cond", name: tok.text, args, tok };
  }
}

// ---------- Test normalization to CNF ----------

function nnf(t: TestExpr, negate: boolean): TestExpr {
  switch (t.type) {
    case "cond":
      return negate ? { type: "not", inner: t } : t;
    case "not":
      return nnf(t.inner, !negate);
    case "and":
      return negate
        ? { type: "or", parts: t.parts.map((p) => nnf(p, true)) }
        : { type: "and", parts: t.parts.map((p) => nnf(p, false)) };
    case "or":
      return negate
        ? { type: "and", parts: t.parts.map((p) => nnf(p, true)) }
        : { type: "or", parts: t.parts.map((p) => nnf(p, false)) };
    case "group":
      // A group only ever wraps a literal, so negation stays inside it.
      return { type: "group", inner: nnf(t.inner, negate) };
  }
}

/** Distribute OR over AND until the root is an AND of clauses of ORs of literals. */
function distribute(t: TestExpr): TestExpr {
  if (t.type !== "or") {
    if (t.type === "and") return { type: "and", parts: t.parts.map(distribute) };
    return t;
  }
  const parts = t.parts.map(distribute);
  const andIdx = parts.findIndex((p) => p.type === "and");
  if (andIdx === -1) return { type: "or", parts };
  const andPart = parts[andIdx] as { type: "and"; parts: TestExpr[] };
  const rest = parts.filter((_, i) => i !== andIdx);
  // (A && B) || rest  =>  (A || rest) && (B || rest)
  return distribute({
    type: "and",
    parts: andPart.parts.map((p) => ({ type: "or", parts: [p, ...rest] })),
  });
}

interface Literal {
  readonly cond: Extract<TestExpr, { type: "cond" }>;
  readonly negated: boolean;
}

/** One CNF conjunct. `group` asks for the 0xfc markers around its literals. */
interface Clause {
  readonly lits: Literal[];
  readonly group: boolean;
}

function literalOf(expr: TestExpr): Literal {
  if (expr.type === "group") return literalOf(expr.inner);
  if (expr.type === "not" && expr.inner.type === "cond") {
    return { cond: expr.inner, negated: true };
  }
  if (expr.type === "cond") return { cond: expr, negated: false };
  throw new AssemblerError("internal: non-literal in CNF clause", 0, 0);
}

function toClauses(test: TestExpr): Clause[] {
  const normalized = distribute(nnf(test, false));
  const andParts = normalized.type === "and" ? normalized.parts : [normalized];
  return andParts.map((part): Clause => {
    // A group surviving as a whole conjunct is the author's one-term OR group;
    // inside a longer OR the markers are already there, so it just unwraps.
    if (part.type === "group") return { lits: [literalOf(part.inner)], group: true };
    const orParts = part.type === "or" ? part.parts : [part];
    return { lits: orParts.map(literalOf), group: orParts.length > 1 };
  });
}

// ---------- Emitter ----------

class Emitter {
  private buf: number[] = [];
  private readonly fixups: { at: number; label: string; tok: Token }[] = [];
  readonly labelPos = new Map<string, number>();

  get position(): number {
    return this.buf.length;
  }

  byte(b: number): void {
    this.buf.push(b & 0xff);
  }

  /** Signed 16-bit little-endian displacement; patched later or written now. */
  s16(value: number): void {
    if (value < -32768 || value > 32767) {
      throw new AssemblerError("jump displacement out of s16 range (logic too large)", 0, 0);
    }
    this.buf.push(value & 0xff, (value >> 8) & 0xff);
  }

  patchS16(at: number, value: number): void {
    if (value < -32768 || value > 32767) {
      throw new AssemblerError("jump displacement out of s16 range (logic too large)", 0, 0);
    }
    this.buf[at] = value & 0xff;
    this.buf[at + 1] = (value >> 8) & 0xff;
  }

  markLabel(name: string): void {
    this.labelPos.set(name, this.position);
  }

  emitGoto(label: string, tok: Token): void {
    this.byte(GOTO);
    this.fixups.push({ at: this.position, label, tok });
    this.s16(0);
  }

  resolveFixups(): void {
    for (const f of this.fixups) {
      const target = this.labelPos.get(f.label);
      if (target === undefined) {
        throw new AssemblerError(`goto of undefined label '${f.label}'`, f.tok.line, f.tok.col);
      }
      // Delta is relative to the position immediately after the 2 delta bytes.
      this.patchS16(f.at, target - (f.at + 2));
    }
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.buf);
  }
}

// ---------- Condition/action validation & emission ----------

function refByte(ref: Ref, allowString: false, tok: Token, what: string): number {
  if (ref.kind === "str") {
    throw new AssemblerError(`string not allowed as ${what} operand`, tok.line, tok.col);
  }
  return ref.kind === "num" ? ref.value : ref.index;
}

function emitCondition(
  e: Emitter,
  lit: Literal,
  dictionary: ReadonlyMap<string, number>,
  profile: AgiProfile,
): void {
  const spec = CONDITION_BY_NAME[lit.cond.name];
  if (!spec) {
    throw new AssemblerError(
      `unknown condition '${lit.cond.name}' (known: ${[...Object.keys(CONDITION_BY_NAME)].join(", ")})`,
      lit.cond.tok.line,
      lit.cond.tok.col,
    );
  }
  if (spec.code > profile.maxCondition) {
    throw new AssemblerError(
      `condition '${spec.name}' is not available in profile ${profile.id}`,
      lit.cond.tok.line,
      lit.cond.tok.col,
    );
  }
  if (spec.name === "said") {
    if (lit.cond.args.length === 0) {
      throw new AssemblerError(
        "said() needs at least one word",
        lit.cond.tok.line,
        lit.cond.tok.col,
      );
    }
    if (lit.negated) e.byte(NOT);
    e.byte(spec.code);
    e.byte(lit.cond.args.length);
    for (const arg of lit.cond.args) {
      let id: number;
      if (arg.kind === "str") {
        const w = arg.text.toLowerCase();
        if (w === "*") id = SAID_ANY_WORD;
        else if (w === "...") id = SAID_REST;
        else {
          const found = dictionary.get(w);
          if (found === undefined) {
            throw new AssemblerError(
              `word '${arg.text}' is not in the dictionary`,
              lit.cond.tok.line,
              lit.cond.tok.col,
            );
          }
          id = found;
        }
      } else {
        id = arg.kind === "num" ? arg.value : arg.index;
      }
      e.byte(id & 0xff);
      e.byte((id >> 8) & 0xff);
    }
    return;
  }
  if (lit.cond.args.length !== spec.operands.length) {
    throw new AssemblerError(
      `condition '${spec.name}' takes ${spec.operands.length} operand(s), got ${lit.cond.args.length}`,
      lit.cond.tok.line,
      lit.cond.tok.col,
    );
  }
  if (lit.negated) e.byte(NOT);
  e.byte(spec.code);
  for (const arg of lit.cond.args) {
    e.byte(refByte(arg, false, lit.cond.tok, `condition '${spec.name}'`));
  }
}

function emitTest(
  e: Emitter,
  test: TestExpr,
  dictionary: ReadonlyMap<string, number>,
  profile: AgiProfile,
): void {
  e.byte(IF);
  for (const clause of toClauses(test)) {
    if (!clause.group) {
      emitCondition(e, clause.lits[0]!, dictionary, profile);
    } else {
      e.byte(OR);
      for (const lit of clause.lits) emitCondition(e, lit, dictionary, profile);
      e.byte(OR);
    }
  }
  e.byte(IF);
}

// ---------- Messages ----------

class MessageTable {
  private readonly byNumber = new Map<number, string | null>();
  private readonly inlineNumbers = new Map<string, number>();
  private nextInline: number;

  constructor(explicit: Map<number, string | null>) {
    for (const [n, text] of explicit) this.byNumber.set(n, text);
    this.nextInline = explicit.size === 0 ? 1 : Math.max(...explicit.keys()) + 1;
  }

  /** Message number for an inline string literal; identical text dedupes. */
  intern(text: string, tok: Token): number {
    const existing = this.inlineNumbers.get(text);
    if (existing !== undefined) return existing;
    for (const [n, t] of this.byNumber) if (t === text) return n;
    if (this.nextInline > 255) {
      throw new AssemblerError("message table full (255 messages)", tok.line, tok.col);
    }
    const n = this.nextInline++;
    this.byNumber.set(n, text);
    this.inlineNumbers.set(text, n);
    return n;
  }

  resolve(ref: Ref, tok: Token): number {
    if (ref.kind === "str") return this.intern(ref.text, tok);
    const n = ref.kind === "num" ? ref.value : ref.index;
    if (n === 0)
      throw new AssemblerError("message numbers are 1-based (m0 invalid)", tok.line, tok.col);
    return n;
  }

  /**
   * 1-based array; index 0 is an unused placeholder. A number no directive or
   * inline string claimed is `null`: an absent slot, not an empty message.
   */
  finalize(): readonly (string | null)[] {
    const max = this.byNumber.size === 0 ? 0 : Math.max(...this.byNumber.keys());
    const out: (string | null)[] = [""];
    for (let n = 1; n <= max; n++) out.push(this.byNumber.get(n) ?? null);
    return out;
  }
}

// ---------- Statement emission ----------

function emitStmt(
  e: Emitter,
  stmt: Stmt,
  messages: MessageTable,
  dictionary: ReadonlyMap<string, number>,
  profile: AgiProfile,
): void {
  switch (stmt.type) {
    case "return":
      e.byte(RETURN);
      return;
    case "label":
      // Emits nothing; it just names the current byte offset for goto.
      e.markLabel(stmt.name);
      return;
    case "goto":
      e.emitGoto(stmt.label, stmt.tok);
      return;
    case "if": {
      emitTest(e, stmt.test, dictionary, profile);
      const falseDeltaAt = e.position;
      e.s16(0);
      for (const s of stmt.then) emitStmt(e, s, messages, dictionary, profile);
      if (stmt.else_ !== null) {
        const endGotoFixup = e.position;
        e.byte(GOTO);
        e.s16(0);
        // False path: skip the 2-byte goto+delta... i.e. land after the goto's delta.
        e.patchS16(falseDeltaAt, e.position - (falseDeltaAt + 2));
        for (const s of stmt.else_) emitStmt(e, s, messages, dictionary, profile);
        e.patchS16(endGotoFixup + 1, e.position - (endGotoFixup + 3));
      } else {
        e.patchS16(falseDeltaAt, e.position - (falseDeltaAt + 2));
      }
      return;
    }
    case "action": {
      const spec = actionSpec(stmt.name, profile);
      if (!spec) {
        throw new AssemblerError(
          `unknown action '${stmt.name}' or action not available in profile ${profile.id} (check spelling and the selected profile)`,
          stmt.tok.line,
          stmt.tok.col,
        );
      }
      if (stmt.args.length !== spec.operands.length) {
        throw new AssemblerError(
          `action '${spec.name}' takes ${spec.operands.length} operand(s), got ${stmt.args.length}`,
          stmt.tok.line,
          stmt.tok.col,
        );
      }
      e.byte(spec.code);
      spec.operands.forEach((kind, i) => {
        const arg = stmt.args[i]!;
        if (kind === "message") {
          e.byte(messages.resolve(arg, stmt.tok));
        } else {
          e.byte(refByte(arg, false, stmt.tok, `action '${spec.name}'`));
        }
      });
      return;
    }
  }
}

// ---------- Public entry ----------

export function assembleLogic(source: string, opts: AssembleOptions): AssembleResult {
  const parser = new Parser(lex(source));
  parser.parseProgram();

  const messages = new MessageTable(parser.explicitMessages);
  const e = new Emitter();
  for (const stmt of parser.program)
    emitStmt(e, stmt, messages, opts.dictionary, opts.profile ?? DEFAULT_V2_PROFILE);
  e.resolveFixups();

  const code = e.bytes();
  const messageList = messages.finalize();
  // finalize() returns 1-based with placeholder at 0; resource builder wants 1..N.
  const payload = buildLogicResource(code, messageList.slice(1));
  return { payload, code, messages: messageList };
}
