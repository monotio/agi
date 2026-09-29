/**
 * AGI logic source syntax: strict lexing and parsing for the assembler's
 * source language (documented in assembler.ts). Produces tokens and the
 * statement tree; lowering and bytecode emission live in assembler.ts.
 */

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

// Application work ceilings, not interpreter format limits. Bound both parsing
// and strict lowering before allocating expanded condition trees.
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_TOKENS = 100_000;
export const MAX_DEPTH = 128;

// ---------- Lexer ----------

type TokenType = "ident" | "number" | "string" | "punct" | "directive" | "eof";

export interface Token {
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

export type Ref =
  /** A number literal keeps its token, so a byte operand out of range reports where it was written. */
  | { kind: "num"; value: number; tok?: Token }
  | { kind: "v" | "f" | "o" | "m" | "s"; index: number }
  | { kind: "str"; text: string };

export type TestExpr =
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

export type Stmt = StmtBody & {
  readonly tok: Token;
  readonly end: number;
  readonly statementId: number;
};

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

// ---------- Public entry ----------

/** Parse a whole logic source, enforcing the input ceilings, or throw AssemblerError. */
export function parseLogicSyntax(source: string): {
  readonly tokens: Token[];
  readonly program: Stmt[];
  readonly explicitMessages: Map<number, string | null>;
} {
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
  return { tokens, program: parser.program, explicitMessages: parser.explicitMessages };
}
