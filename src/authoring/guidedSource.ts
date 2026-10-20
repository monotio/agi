/**
 * Parsed-structure surgery for guided room edits. Every helper works on the
 * strict assembler AST (src/logic/syntax.ts) over the binding-expanded source,
 * so recognition is structural — never a whole-file shape or a regex guess —
 * and every returned span addresses the authored text exactly.
 *
 * Recognition answers "is there exactly one room-entry ego setup / command
 * handler / annotated rule here", not "does this file look generated". Custom
 * code outside the recognized fragment stays byte for byte; an unrecognized
 * affected fragment is reported, not rewritten.
 */
import { systemBindings } from "../logic/systemNames.ts";
import { expandProjectLogic } from "./projectLogic.ts";
import {
  parseLogicSyntax,
  type Ref,
  type Stmt,
  type TestExpr,
  type Token,
} from "../logic/syntax.ts";

/** A strict parse of authored source with its #define bindings expanded. */
export interface ParsedRoom {
  /** Tokens of the expanded text; authored offsets subtract `base`. */
  readonly tokens: readonly Token[];
  readonly program: readonly Stmt[];
  /** UTF-16 offset where the authored text starts inside the expansion. */
  readonly base: number;
  /** The authored text the offsets in `spans` address. */
  readonly source: string;
}

/**
 * Parse a room's authored source under its binding names. Throws
 * AssemblerError when the source is not a complete strict program — callers
 * turn that into a refusal, never a guess.
 */
export function parseRoomSource(
  source: string,
  bindings: Readonly<Record<string, { readonly num: number }>>,
): ParsedRoom {
  const expansion = expandProjectLogic(source, bindings);
  const parsed = parseLogicSyntax(expansion.prelude + source, systemBindings(bindings));
  return { tokens: parsed.tokens, program: parsed.program, base: expansion.authoredStart, source };
}

/** Authored offset span of a token/statement from the expansion parse. */
function authoredSpan(base: number, start: number, end: number): { start: number; end: number } {
  return { start: start - base, end: end - base };
}

/** The tokens of one statement, in source order (expansion positions). */
export function stmtTokens(room: ParsedRoom, stmt: Stmt): Token[] {
  return room.tokens.filter(
    (token) => token.start >= stmt.tok.start && token.end <= stmt.end && token.type !== "eof",
  );
}

/**
 * Source span of the index-th call argument of an action or condition,
 * counting comma-separated operands inside the call's parentheses. The arg
 * may be a literal, a sigil or a binding name; all keep their written span.
 */
export function callArgSpan(
  room: ParsedRoom,
  stmt: { readonly tok: Token; readonly end: number },
  argIndex: number,
): { start: number; end: number } | null {
  const tokens = room.tokens.filter(
    (token) => token.start >= stmt.tok.start && token.end <= stmt.end,
  );
  let depth = 0;
  let index = -1;
  let open = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type === "punct" && token.text === "(") {
      depth++;
      if (depth === 1) {
        open = i;
        continue;
      }
    }
    if (open < 0) continue;
    if (token.type === "punct" && token.text === ")") {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (token.type === "punct" && token.text === ",") continue;
    index++;
    if (index === argIndex) return authoredSpan(room.base, token.start, token.end);
    if (index > argIndex) break;
  }
  return null;
}

/** Is the ref the ego object (o0 or a literal 0)? */
export function isEgo(ref: Ref | undefined): boolean {
  if (!ref) return false;
  return (ref.kind === "o" && ref.index === 0) || (ref.kind === "num" && ref.value === 0);
}

/** Literal value of a ref after define expansion, or null for registers/strings. */
export function numRef(ref: Ref | undefined): number | null {
  return ref !== undefined && ref.kind === "num" ? ref.value : null;
}

/** A flag sigil's index, or null. */
export function flagRef(ref: Ref | undefined): number | null {
  return ref !== undefined && ref.kind === "f" ? ref.index : null;
}

/** The single canonical room-entry test: `if (isset(new_room))` exactly. */
function isInitTest(test: TestExpr): boolean {
  if (test.type !== "cond" || test.name !== "isset" || test.args.length !== 1) return false;
  return flagRef(test.args[0]) === 5;
}

/** Top-level statements of a program that are `if (isset(new_room)) {…}` blocks. */
export function initBlocks(program: readonly Stmt[]): (Stmt & { type: "if" })[] {
  return program.filter(
    (stmt): stmt is Stmt & { type: "if" } => stmt.type === "if" && isInitTest(stmt.test),
  );
}

/** Every action statement named `name` within a statement list (one level deep). */
export function actionsNamed(stmts: readonly Stmt[], name: string): (Stmt & { type: "action" })[] {
  return stmts.filter(
    (stmt): stmt is Stmt & { type: "action" } => stmt.type === "action" && stmt.name === name,
  );
}

/**
 * The `}` token that closes an if-statement's then-block (expansion
 * position), or null when the statement shape is unexpected.
 */
function thenCloseBrace(room: ParsedRoom, stmt: Stmt): Token | null {
  if (stmt.type !== "if") return null;
  let depth = 0;
  let seenOpen = false;
  for (const token of stmtTokens(room, stmt)) {
    if (token.type !== "punct") continue;
    if (token.text === "{") {
      depth++;
      seenOpen = true;
    } else if (token.text === "}") {
      depth--;
      if (seenOpen && depth === 0) return token;
    }
  }
  return null;
}

/**
 * The last top-level `return;` in a program — the canonical end of a room's
 * per-cycle body — or undefined.
 */
function finalReturn(program: readonly Stmt[]): Stmt | undefined {
  let found: Stmt | undefined;
  for (const stmt of program) if (stmt.type === "return") found = stmt;
  return found;
}

// ---------- Text surgery ----------

export interface TextEdit {
  /** UTF-16 half-open span in the ORIGINAL text; start === end inserts. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface SplicedText {
  readonly text: string;
  /** Where each edit landed in the NEW text, in input order. */
  readonly spans: readonly { readonly start: number; readonly end: number }[];
}

/** Apply non-overlapping edits; throws when spans overlap or lie out of range. */
export function spliceText(source: string, edits: readonly TextEdit[]): SplicedText {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 0; i < ordered.length; i++) {
    const edit = ordered[i]!;
    if (edit.start < 0 || edit.end > source.length || edit.start > edit.end)
      throw new Error("Edit span out of range.");
    if (i > 0 && edit.start < ordered[i - 1]!.end) throw new Error("Edit spans overlap.");
  }
  let text = "";
  let cursor = 0;
  const spans: { start: number; end: number }[] = new Array(edits.length);
  const byInput = ordered.map((edit, i) => ({ edit, i }));
  for (const { edit, i } of byInput) {
    text += source.slice(cursor, edit.start) + edit.text;
    spans[i] = { start: text.length - edit.text.length, end: text.length };
    cursor = edit.end;
  }
  text += source.slice(cursor);
  return { text, spans };
}

/** 1-based inclusive line range covering a span of `text`. */
function linesCovering(text: string, start: number, end: number): { start: number; end: number } {
  const first = lineOf(text, start);
  return { start: first, end: lineOf(text, Math.max(start, end - 1)) };
}

/** 1-based line containing an offset. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** The inclusive 1-based line range covering each span, in order. */
export function lineRanges(
  text: string,
  spans: readonly { readonly start: number; readonly end: number }[],
): readonly { start: number; end: number }[] {
  return spans.map((span) => linesCovering(text, span.start, span.end));
}

/** Extract the 1-based inclusive line range as text. */
export function linesText(
  text: string,
  range: { readonly start: number; readonly end: number },
): string {
  return text
    .split("\n")
    .slice(range.start - 1, range.end)
    .join("\n");
}

/** Byte offset of the start of a 1-based line. */
export function lineStartOffset(text: string, line: number): number {
  if (line <= 1) return 0;
  let current = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      current++;
      if (current === line) return i + 1;
    }
  }
  return text.length;
}

/**
 * Insert complete lines before a 0-based line index (or a "split" variant:
 * when the insertion point shares its line with code, the splice lands at the
 * given offset and re-indents). Returns the text edit.
 */
export function insertLinesEdit(
  source: string,
  insertAtOffset: number,
  indent: string,
  lines: readonly string[],
): TextEdit {
  const needsNewline = insertAtOffset > 0 && source[insertAtOffset - 1] !== "\n";
  const text = `${needsNewline ? "\n" : ""}${lines.map((line) => `${indent}${line}`).join("\n")}\n`;
  return { start: insertAtOffset, end: insertAtOffset, text };
}

/**
 * Where to insert top-level statements before a statement's line, mirroring
 * the room convention: on its own line inserts cleanly; after a finished
 * statement on a shared line splits at the token; anything else refuses.
 * Returns the insertion offset and the trailing indentation to re-add.
 */
function topLevelInsertPoint(
  source: string,
  stmt: Stmt,
  base: number,
): { offset: number; indent: string; midLine: boolean } | "shared-line" {
  const start = stmt.tok.start - base;
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const before = source.slice(lineStart, start);
  if (before.trim() === "") {
    return { offset: lineStart, indent: "", midLine: false };
  }
  if (/[;}]\s*$/.test(before)) {
    const indent = /^\s*/.exec(before)![0];
    return { offset: start, indent, midLine: true };
  }
  return "shared-line";
}

/** Insert statement lines at the start of an if-statement's then-block. */
export function insertAtThenStart(
  room: ParsedRoom,
  stmt: Stmt,
  lines: readonly string[],
): TextEdit | "shared-line" {
  if (stmt.type !== "if") return "shared-line";
  const open = stmtTokens(room, stmt).find((t) => t.type === "punct" && t.text === "{");
  if (!open) return "shared-line";
  const openOffset = open.end - room.base;
  const source = room.source;
  const lineStart = source.lastIndexOf("\n", openOffset - 1) + 1;
  const stmtIndent = /^\s*/.exec(source.slice(lineStart))?.[0] ?? "";
  const innerIndent = stmtIndent + "  ";
  const lineEnd = source.indexOf("\n", openOffset);
  const rest = lineEnd === -1 ? source.slice(openOffset) : source.slice(openOffset, lineEnd);
  if (rest.trim() === "") {
    const insertAt = lineEnd === -1 ? source.length : lineEnd + 1;
    return {
      start: insertAt,
      end: insertAt,
      text: lines.map((line) => `${innerIndent}${line}\n`).join(""),
    };
  }
  return {
    start: openOffset,
    end: openOffset,
    text: `\n${lines.map((line) => `${innerIndent}${line}`).join("\n")}\n${innerIndent}`,
  };
}

/** Insert statement lines at the end of an if-statement's then-block. */
export function insertAtThenEnd(
  room: ParsedRoom,
  stmt: Stmt,
  lines: readonly string[],
): TextEdit | "shared-line" {
  const close = thenCloseBrace(room, stmt);
  if (!close) return "shared-line";
  const closeOffset = close.start - room.base;
  const source = room.source;
  const lineStart = source.lastIndexOf("\n", closeOffset - 1) + 1;
  const before = source.slice(lineStart, closeOffset);
  const stmtIndent = /^\s*/.exec(source.slice(lineStart))?.[0] ?? "";
  const innerIndent = stmtIndent + "  ";
  if (before.trim() === "") {
    return {
      start: lineStart,
      end: lineStart,
      text: lines.map((line) => `${innerIndent}${line}\n`).join(""),
    };
  }
  if (!/[;}]\s*$/.test(before)) return "shared-line";
  return {
    start: closeOffset,
    end: closeOffset,
    text: `\n${lines.map((line) => `${innerIndent}${line}`).join("\n")}\n${stmtIndent}`,
  };
}

/** Insert top-level statement lines before the last `return;`, or append at end. */
export function insertBeforeFinalReturn(
  room: ParsedRoom,
  lines: readonly string[],
): TextEdit | "shared-line" {
  const ret = finalReturn(room.program);
  const source = room.source;
  if (!ret) {
    const needsNewline = source.length > 0 && !source.endsWith("\n");
    return {
      start: source.length,
      end: source.length,
      text: `${needsNewline ? "\n" : ""}${lines.map((line) => `${line}\n`).join("")}`,
    };
  }
  const point = topLevelInsertPoint(source, ret, room.base);
  if (point === "shared-line") return "shared-line";
  if (point.midLine) {
    return {
      start: point.offset,
      end: point.offset,
      text: `\n${lines.join("\n")}\n`,
    };
  }
  return { start: point.offset, end: point.offset, text: lines.map((l) => `${l}\n`).join("") };
}

// ---------- Conditions and handlers ----------

/** Every condition call of a test expression, flattened through and/or/not/group. */
export function testConds(test: TestExpr): readonly (TestExpr & { type: "cond" })[] {
  const out: (TestExpr & { type: "cond" })[] = [];
  const walk = (expr: TestExpr): void => {
    switch (expr.type) {
      case "cond":
        out.push(expr);
        break;
      case "not":
      case "group":
        walk(expr.inner);
        break;
      case "and":
      case "or":
        expr.parts.forEach(walk);
        break;
    }
  };
  walk(test);
  return out;
}

/**
 * The dictionary group ids a `said(...)` condition tests, resolving quoted
 * words through the dictionary; null when a word is unknown or an argument is
 * not a word reference.
 */
export function saidWordIds(
  cond: TestExpr & { type: "cond" },
  dictionary: ReadonlyMap<string, number>,
): number[] | null {
  if (cond.name !== "said") return null;
  const ids: number[] = [];
  for (const arg of cond.args) {
    if (arg.kind === "str") {
      const id = dictionary.get(arg.text.toLowerCase());
      if (id === undefined) return null;
      ids.push(id);
    } else if (arg.kind === "num") {
      ids.push(arg.value);
    } else {
      return null;
    }
  }
  return ids;
}

/** `#message N "text"` directives: number, whole span, optional string span (authored offsets). */
export function messageDirectives(room: ParsedRoom): readonly {
  num: number;
  start: number;
  end: number;
  stringStart?: number;
  stringEnd?: number;
}[] {
  const out: {
    num: number;
    start: number;
    end: number;
    stringStart?: number;
    stringEnd?: number;
  }[] = [];
  const tokens = room.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type !== "directive" || token.text !== "#message") continue;
    const num = tokens[i + 1];
    if (!num || num.type !== "number") continue;
    const str = tokens[i + 2];
    if (str && str.type === "string" && str.line === num.line) {
      out.push({
        num: Number(num.text),
        start: token.start - room.base,
        end: str.end - room.base,
        stringStart: str.start - room.base,
        stringEnd: str.end - room.base,
      });
    } else {
      out.push({ num: Number(num.text), start: token.start - room.base, end: num.end - room.base });
    }
  }
  return out;
}
