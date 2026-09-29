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
 * (id 0x270f). AGI Studio's spellings of the two, "anyword" and "rol", are
 * accepted as well unless the game's own dictionary defines those words.
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

export interface LogicSourceEntry {
  readonly emissionId: number;
  readonly statementId: number;
  readonly kind: "action" | "return" | "goto" | "if" | "predicate" | "generated-jump";
  /** Half-open offsets into the exact input source, in UTF-16 code units. */
  readonly start: number;
  readonly end: number;
  /** Half-open byte offsets into code, excluding resource/message framing. */
  readonly pc: number;
  readonly endPc: number;
}

export interface LogicSourceMap {
  readonly version: 1;
  /** Exact compiler input, including any caller-supplied prelude. */
  readonly source: string;
  readonly profileId: string;
  readonly codeLength: number;
  readonly entries: readonly LogicSourceEntry[];
}

export interface AssembleDiagnostic {
  readonly code: "condition-effects";
  readonly message: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly col: number;
}

// Application work ceilings, not interpreter format limits. Bound both parsing
// and strict lowering before allocating expanded condition trees.
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_TOKENS = 100_000;
const MAX_DEPTH = 128;
const MAX_LOWERING_WORK = 100_000;
const MAX_CLAUSE_UNITS = 16_384;

export interface AssembleOptions {
  /** Capture origins for this exact input; never implicitly bind to a live run. */
  readonly sourceMap?: boolean;
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
  readonly diagnostics: readonly AssembleDiagnostic[];
  readonly sourceMap?: LogicSourceMap;
}

// ---------- Lexer ----------

type TokenType = "ident" | "number" | "string" | "punct" | "directive" | "eof";

interface Token {
  readonly type: TokenType;
  readonly text: string;
  readonly line: number;
  readonly col: number;
  readonly start: number;
  readonly end: number;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const col = () => i - lineStart + 1;
  let tokenStart = 0;
  const append = (token: Omit<Token, "start" | "end">): void => {
    if (tokens.length >= MAX_TOKENS) {
      throw new AssemblerError("token limit exceeded", token.line, token.col);
    }
    tokens.push({
      ...token,
      start: token.type === "eof" ? i : tokenStart,
      end: token.type === "punct" ? i + token.text.length : i,
    });
  };

  while (i < source.length) {
    tokenStart = i;
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
      const dir = source.slice(start, i);
      if (dir === "#message" || dir === "#define") {
        append({ type: "directive", text: dir, line, col: c });
        continue;
      }
      while (i < source.length && source[i] !== "\n") i++;
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
      append({ type: "string", text, line, col: c });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      const c = col();
      while (i < source.length && /[0-9]/.test(source[i]!)) i++;
      append({ type: "number", text: source.slice(start, i), line, col: c });
      continue;
    }
    if (/[a-zA-Z_.]/.test(ch)) {
      const start = i;
      const c = col();
      while (i < source.length && /[a-zA-Z0-9_.]/.test(source[i]!)) i++;
      append({ type: "ident", text: source.slice(start, i), line, col: c });
      continue;
    }
    if (ch === "&" && source[i + 1] === "&") {
      append({ type: "punct", text: "&&", line, col: col() });
      i += 2;
      continue;
    }
    if (ch === "|" && source[i + 1] === "|") {
      append({ type: "punct", text: "||", line, col: col() });
      i += 2;
      continue;
    }
    if (ch === "=" && source[i + 1] === "=") {
      append({ type: "punct", text: "==", line, col: col() });
      i += 2;
      continue;
    }
    if (ch === "!" && source[i + 1] === "=") {
      append({ type: "punct", text: "!=", line, col: col() });
      i += 2;
      continue;
    }
    if (ch === "<" && source[i + 1] === "=") {
      append({ type: "punct", text: "<=", line, col: col() });
      i += 2;
      continue;
    }
    if (ch === ">" && source[i + 1] === "=") {
      append({ type: "punct", text: ">=", line, col: col() });
      i += 2;
      continue;
    }
    if (ch === "<") {
      append({ type: "punct", text: "<", line, col: col() });
      i++;
      continue;
    }
    if (ch === ">") {
      append({ type: "punct", text: ">", line, col: col() });
      i++;
      continue;
    }
    if (ch === "=") {
      append({ type: "punct", text: "=", line, col: col() });
      i++;
      continue;
    }
    if ("(){};:,!".includes(ch)) {
      append({ type: "punct", text: ch, line, col: col() });
      i++;
      continue;
    }
    throw new AssemblerError(`unexpected character '${ch}'`, line, col());
  }
  append({ type: "eof", text: "", line, col: col() });
  return tokens;
}

// ---------- AST ----------

type Ref =
  /** A number literal keeps its token, so a byte operand out of range reports where it was written. */
  | { kind: "num"; value: number; tok?: Token }
  | { kind: "v" | "f" | "o" | "m" | "s"; index: number }
  | { kind: "str"; text: string };

type TestExpr =
  | { type: "cond"; name: string; args: Ref[]; tok: Token; end?: number }
  | { type: "not"; inner: TestExpr }
  | { type: "and"; parts: TestExpr[] }
  | { type: "or"; parts: TestExpr[] }
  /** Parentheses the author put around a single literal: emit 0xfc markers. */
  | { type: "group"; inner: TestExpr };

type StmtBody =
  | { type: "action"; name: string; args: Ref[]; tok: Token }
  | { type: "return" }
  | { type: "goto"; label: string; tok: Token }
  | { type: "label"; name: string; tok: Token }
  | { type: "if"; test: TestExpr; then: Stmt[]; else_: Stmt[] | null };

type Stmt = StmtBody & { readonly tok: Token; readonly end: number; readonly statementId: number };

// ---------- Parser ----------

class Parser {
  private pos = 0;
  private depth = 0;
  private nextStatementId = 0;

  private enter(tok: Token): void {
    if (++this.depth > MAX_DEPTH) {
      throw new AssemblerError("syntax nesting limit exceeded", tok.line, tok.col);
    }
  }
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
    return {
      type: "label",
      name: tok.text,
      tok,
      end: this.tokens[this.pos - 1]!.end,
      statementId: this.nextStatementId++,
    };
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
    const tok = this.peek();
    const statementId = this.nextStatementId++;
    this.enter(tok);
    const body = this.parseStmtBody();
    this.depth--;
    return { ...body, tok, end: this.tokens[this.pos - 1]!.end, statementId };
  }

  private parseStmtBody(): StmtBody {
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
      const test = this.parseOr();
      this.expect("punct", ")");
      const then = this.parseBlock();
      let else_: Stmt[] | null = null;
      if (this.peek().type === "ident" && this.peek().text === "else") {
        this.next();
        else_ = this.parseBlock();
      }
      return { type: "if", test, then, else_ };
    }
    if (this.peek().text === "=") {
      this.next();
      const right = this.parseRef();
      this.expect("punct", ";");
      let left: Ref;
      const m = /^v(\d{1,3})$/.exec(tok.text);
      if (m) {
        left = { kind: "v", index: Number(m[1]) };
      } else {
        const defined = this.defines.get(tok.text);
        if (defined !== undefined) left = { kind: "v", index: defined };
        else throw new AssemblerError(`cannot assign to '${tok.text}'`, tok.line, tok.col);
      }
      if (right.kind === "num")
        return { type: "action", name: "assignn", args: [left, right], tok };
      if (right.kind === "v") return { type: "action", name: "assignv", args: [left, right], tok };
      throw new AssemblerError(`cannot assign ${right.kind} to variable`, tok.line, tok.col);
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
      // said() word ids are 16-bit (9999 is the rest-of-line id); every other
      // operand is a byte, checked where it is emitted.
      const n = Number(tok.text);
      if (n > 0xffff) throw new AssemblerError("value out of range 0..65535", tok.line, tok.col);
      return { kind: "num", value: n, tok };
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
    this.enter(tok);
    let result = this.parseUnaryBody();
    this.depth--;
    const end = this.tokens[this.pos - 1]!.end;
    if (result.type === "cond") result = { ...result, end };
    else if (result.type === "not" && result.inner.type === "cond") {
      result = { ...result, inner: { ...result.inner, end } };
    }
    return result;
  }

  private parseUnaryBody(): TestExpr {
    const tok = this.peek();
    if (tok.text === "!") {
      this.next();
      return { type: "not", inner: this.parseUnary() };
    }
    if (tok.text === "(") {
      this.next();
      const inner = this.parseOr();
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
    const nextTok = this.tokens[this.pos + 1];
    if (nextTok && ["==", "!=", "<", ">", "<=", ">="].includes(nextTok.text)) {
      const left = this.parseRef();
      const op = this.next().text;
      const right = this.parseRef();
      return this.buildComparison(left, op, right, tok);
    }
    if (nextTok?.text !== "(") {
      const m = /^f(\d{1,3})$/.exec(tok.text);
      if (m) {
        const ref = this.parseRef();
        return { type: "cond", name: "isset", args: [ref], tok };
      }
    }
    this.next();
    const args = this.parseTestArgs();
    return { type: "cond", name: tok.text, args, tok };
  }

  private buildComparison(left: Ref, op: string, right: Ref, tok: Token): TestExpr {
    if (left.kind === "f") {
      const isTrue = right.kind === "num" && right.value === 1;
      const isFalse = right.kind === "num" && right.value === 0;
      if (op === "==") {
        if (isTrue) return { type: "cond", name: "isset", args: [left], tok };
        if (isFalse)
          return { type: "not", inner: { type: "cond", name: "isset", args: [left], tok } };
      }
      if (op === "!=") {
        if (isTrue)
          return { type: "not", inner: { type: "cond", name: "isset", args: [left], tok } };
        if (isFalse) return { type: "cond", name: "isset", args: [left], tok };
      }
      throw new AssemblerError(`unsupported flag comparison '${op}'`, tok.line, tok.col);
    }
    if (left.kind === "v") {
      if (right.kind === "num") {
        switch (op) {
          case "==":
            return { type: "cond", name: "equaln", args: [left, right], tok };
          case "!=":
            return {
              type: "not",
              inner: { type: "cond", name: "equaln", args: [left, right], tok },
            };
          case "<":
            return { type: "cond", name: "lessn", args: [left, right], tok };
          case ">":
            return { type: "cond", name: "greatern", args: [left, right], tok };
          case "<=":
            return {
              type: "not",
              inner: { type: "cond", name: "greatern", args: [left, right], tok },
            };
          case ">=":
            return {
              type: "not",
              inner: { type: "cond", name: "lessn", args: [left, right], tok },
            };
        }
      }
      if (right.kind === "v") {
        switch (op) {
          case "==":
            return { type: "cond", name: "equalv", args: [left, right], tok };
          case "!=":
            return {
              type: "not",
              inner: { type: "cond", name: "equalv", args: [left, right], tok },
            };
          case "<":
            return { type: "cond", name: "lessv", args: [left, right], tok };
          case ">":
            return { type: "cond", name: "greaterv", args: [left, right], tok };
          case "<=":
            return {
              type: "not",
              inner: { type: "cond", name: "greaterv", args: [left, right], tok },
            };
          case ">=":
            return {
              type: "not",
              inner: { type: "cond", name: "lessv", args: [left, right], tok },
            };
        }
      }
    }
    throw new AssemblerError(
      `unsupported comparison operands (${left.kind} ${op} ${right.kind})`,
      tok.line,
      tok.col,
    );
  }
}

// ---------- Test normalization to CNF ----------

class LoweringBudget {
  private remaining = MAX_LOWERING_WORK;
  private tok: Token;

  constructor(tok: Token) {
    this.tok = tok;
  }

  locate(tok: Token): void {
    this.tok = tok;
  }

  charge(units = 1, depth = 0): void {
    if (depth > MAX_DEPTH || units > this.remaining) {
      throw new AssemblerError(
        "condition lowering work limit exceeded",
        this.tok.line,
        this.tok.col,
      );
    }
    this.remaining -= units;
  }
}

function nnf(t: TestExpr, negate: boolean, budget: LoweringBudget, depth = 0): TestExpr {
  budget.charge(1, depth);
  switch (t.type) {
    case "cond":
      return negate ? { type: "not", inner: t } : t;
    case "not":
      return nnf(t.inner, !negate, budget, depth + 1);
    case "and":
      return negate
        ? { type: "or", parts: t.parts.map((p) => nnf(p, true, budget, depth + 1)) }
        : { type: "and", parts: t.parts.map((p) => nnf(p, false, budget, depth + 1)) };
    case "or":
      return negate
        ? { type: "and", parts: t.parts.map((p) => nnf(p, true, budget, depth + 1)) }
        : { type: "or", parts: t.parts.map((p) => nnf(p, false, budget, depth + 1)) };
    case "group":
      // A group only ever wraps a literal, so negation stays inside it.
      return { type: "group", inner: nnf(t.inner, negate, budget, depth + 1) };
  }
}

/** Distribute OR over AND until the root is an AND of clauses of ORs of literals. */
function distribute(t: TestExpr, budget: LoweringBudget, depth = 0): TestExpr {
  budget.charge(1, depth);
  if (t.type !== "or") {
    if (t.type === "and")
      return { type: "and", parts: t.parts.map((part) => distribute(part, budget, depth + 1)) };
    return t;
  }
  const parts = t.parts.map((part) => distribute(part, budget, depth + 1));
  const andIdx = parts.findIndex((p) => p.type === "and");
  if (andIdx === -1) return { type: "or", parts };
  const andPart = parts[andIdx] as { type: "and"; parts: TestExpr[] };
  const rest = parts.filter((_, i) => i !== andIdx);
  // (A && B) || rest  =>  (A || rest) && (B || rest)
  budget.charge(andPart.parts.length * (rest.length + 1), depth);
  return distribute(
    {
      type: "and",
      parts: andPart.parts.map((p) => ({ type: "or", parts: [p, ...rest] })),
    },
    budget,
    depth + 1,
  );
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

function toClauses(test: TestExpr, tok: Token, budget: LoweringBudget): Clause[] {
  budget.locate(tok);
  const normalized = distribute(nnf(test, false, budget), budget);
  const clauses: Clause[] = [];
  let units = 0;
  const append = (part: TestExpr): void => {
    budget.charge();
    if (part.type === "and") {
      for (const child of part.parts) append(child);
      return;
    }
    const lits: Literal[] = [];
    const collect = (expr: TestExpr): void => {
      budget.charge();
      if (expr.type === "or") {
        for (const child of expr.parts) collect(child);
      } else {
        if (++units > MAX_CLAUSE_UNITS) {
          throw new AssemblerError("condition clause/literal limit exceeded", tok.line, tok.col);
        }
        lits.push(literalOf(expr));
      }
    };
    collect(part);
    if (++units > MAX_CLAUSE_UNITS) {
      throw new AssemblerError("condition clause/literal limit exceeded", tok.line, tok.col);
    }
    clauses.push({ lits, group: part.type === "group" || lits.length > 1 });
  };
  append(normalized);
  return clauses;
}

// ---------- Emitter ----------

class Emitter {
  private buf: number[] = [];
  readonly entries: LogicSourceEntry[] = [];
  readonly diagnostics: AssembleDiagnostic[] = [];
  readonly lowering: LoweringBudget;
  private readonly mapping: boolean;
  private location: Token;

  constructor(mapping: boolean, location: Token) {
    this.mapping = mapping;
    this.location = location;
    this.lowering = new LoweringBudget(location);
  }

  locate(tok: Token): void {
    this.location = tok;
  }

  record(
    kind: LogicSourceEntry["kind"],
    stmt: Stmt,
    pc: number,
    endPc: number,
    origin: { tok: Token; end?: number } = stmt,
  ): void {
    if (!this.mapping) return;
    this.entries.push({
      emissionId: this.entries.length,
      statementId: stmt.statementId,
      kind,
      start: origin.tok.start,
      end: origin.end ?? origin.tok.end,
      pc,
      endPc,
    });
  }

  checkCapacity(count: number): void {
    // Even a LOGIC without messages needs five framing bytes in its u16 record.
    if (this.buf.length + count > 65530) {
      throw new AssemblerError(
        "logic code length limit exceeded",
        this.location.line,
        this.location.col,
      );
    }
  }
  private readonly fixups: { at: number; label: string; tok: Token }[] = [];
  readonly labelPos = new Map<string, number>();

  get position(): number {
    return this.buf.length;
  }

  byte(b: number): void {
    this.checkCapacity(1);
    this.buf.push(b & 0xff);
  }

  /** Signed 16-bit little-endian displacement; patched later or written now. */
  s16(value: number): void {
    if (value < -32768 || value > 32767) {
      throw new AssemblerError(
        "jump displacement out of s16 range (logic too large)",
        this.location.line,
        this.location.col,
      );
    }
    this.checkCapacity(2);
    this.buf.push(value & 0xff, (value >> 8) & 0xff);
  }

  patchS16(at: number, value: number): void {
    if (value < -32768 || value > 32767) {
      throw new AssemblerError(
        "jump displacement out of s16 range (logic too large)",
        this.location.line,
        this.location.col,
      );
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
  if (ref.kind === "num" && ref.value > 255) {
    const at = ref.tok ?? tok;
    throw new AssemblerError(`byte value out of range 0..255 in ${what}`, at.line, at.col);
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
  // The IIgs evaluator admits 0x13, but the slot overruns its handler table
  // (docs/fidelity.md "Apple IIgs interpreter"): no condition exists there.
  if (
    spec.code > profile.maxCondition ||
    (spec.code === 0x13 && profile.condition0x13 === "wild-dispatch")
  ) {
    throw new AssemblerError(
      `condition '${spec.name}' is not available in profile ${profile.id}`,
      lit.cond.tok.line,
      lit.cond.tok.col,
    );
  }
  if (spec.name === "said") {
    if (lit.cond.args.length > 255) {
      throw new AssemblerError(
        "said() supports at most 255 words",
        lit.cond.tok.line,
        lit.cond.tok.col,
      );
    }
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
        const found = dictionary.get(w);
        if (w === "*" || (w === "anyword" && found === undefined)) id = SAID_ANY_WORD;
        else if (w === "..." || (w === "rol" && found === undefined)) id = SAID_REST;
        else {
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
      if (!Number.isInteger(id) || id < 0 || id > 65535) {
        throw new AssemblerError(
          "said dictionary id must be 0..65535",
          lit.cond.tok.line,
          lit.cond.tok.col,
        );
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
  stmt: Extract<Stmt, { type: "if" }>,
  dictionary: ReadonlyMap<string, number>,
  profile: AgiProfile,
): void {
  const clauses = toClauses(stmt.test, stmt.tok, e.lowering);
  const literals = clauses.flatMap((clause) => clause.lits);
  const minimumAfter: number[] = [];
  let minimum = Infinity;
  for (let i = literals.length - 1; i >= 0; i--) {
    minimumAfter[i] = minimum;
    minimum = Math.min(minimum, literals[i]!.cond.tok.start);
  }
  const counts = new Map<number, number>();
  for (const { cond } of literals)
    counts.set(cond.tok.start, (counts.get(cond.tok.start) ?? 0) + 1);
  const warned = new Set<number>();
  let maximumBefore = -1;
  for (let i = 0; i < literals.length; i++) {
    const { cond } = literals[i]!;
    const at = cond.tok.start;
    if (
      (cond.name === "said" || cond.name === "have.key") &&
      ((counts.get(at) ?? 0) > 1 || maximumBefore > at || minimumAfter[i]! < at) &&
      !warned.has(at) &&
      e.diagnostics.length < 200
    ) {
      warned.add(at);
      e.diagnostics.push({
        code: "condition-effects",
        start: at,
        end: cond.end ?? cond.tok.end,
        line: cond.tok.line,
        col: cond.tok.col,
        message:
          "Condition lowering repeats or reorders this stateful test; emitted AGI order is preserved.",
      });
    }
    maximumBefore = Math.max(maximumBefore, at);
  }
  e.byte(IF);
  for (const clause of clauses) {
    if (clause.group) e.byte(OR);
    for (const lit of clause.lits) {
      const pc = e.position;
      e.locate(lit.cond.tok);
      emitCondition(e, lit, dictionary, profile);
      e.record("predicate", stmt, pc, e.position, lit.cond);
    }
    if (clause.group) e.byte(OR);
  }
  e.locate(stmt.tok);
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
    if (n > 255) throw new AssemblerError("byte value out of range 0..255", tok.line, tok.col);
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
  e.locate(stmt.tok);
  const pc = e.position;
  switch (stmt.type) {
    case "return":
      e.byte(RETURN);
      e.record("return", stmt, pc, e.position);
      return;
    case "label":
      // Emits nothing; it just names the current byte offset for goto.
      e.markLabel(stmt.name);
      return;
    case "goto":
      e.emitGoto(stmt.label, stmt.tok);
      e.record("goto", stmt, pc, e.position);
      return;
    case "if": {
      emitTest(e, stmt, dictionary, profile);
      const falseDeltaAt = e.position;
      e.s16(0);
      e.record("if", stmt, pc, e.position);
      for (const s of stmt.then) emitStmt(e, s, messages, dictionary, profile);
      if (stmt.else_ !== null) {
        const endGotoFixup = e.position;
        e.locate(stmt.tok);
        e.byte(GOTO);
        e.s16(0);
        e.record("generated-jump", stmt, endGotoFixup, e.position);
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
      e.record("action", stmt, pc, e.position);
      return;
    }
  }
}

// ---------- Public entry ----------

export function assembleLogic(source: string, opts: AssembleOptions): AssembleResult {
  // Count UTF-8 input bytes without a platform encoder or intermediate buffer.
  let sourceBytes = 0;
  for (let i = 0; i < source.length; i++) {
    const point = source.codePointAt(i)!;
    sourceBytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (point > 0xffff) i++;
    if (sourceBytes > MAX_SOURCE_BYTES)
      throw new AssemblerError("source byte limit exceeded", 1, 1);
  }
  const tokens = lex(source);
  const parser = new Parser(tokens);
  parser.parseProgram();

  const messages = new MessageTable(parser.explicitMessages);
  const e = new Emitter(opts.sourceMap === true, tokens[0]!);
  for (const stmt of parser.program)
    emitStmt(e, stmt, messages, opts.dictionary, opts.profile ?? DEFAULT_V2_PROFILE);
  e.resolveFixups();

  const code = e.bytes();
  const messageList = messages.finalize();
  // finalize() returns 1-based with placeholder at 0; resource builder wants 1..N.
  let payload: Uint8Array;
  try {
    payload = buildLogicResource(code, messageList.slice(1));
  } catch (error) {
    const at = tokens.find((token) => token.type === "string") ?? tokens[0]!;
    throw new AssemblerError(
      error instanceof Error ? error.message : String(error),
      at.line,
      at.col,
    );
  }
  const result: AssembleResult = {
    payload,
    code,
    messages: messageList,
    diagnostics: e.diagnostics,
  };
  if (!opts.sourceMap) return result;
  return {
    ...result,
    sourceMap: {
      version: 1,
      source,
      profileId: (opts.profile ?? DEFAULT_V2_PROFILE).id,
      codeLength: code.length,
      entries: e.entries
        .sort((a, b) => a.pc - b.pc)
        .map((entry, emissionId) => ({ ...entry, emissionId })),
    },
  };
}
