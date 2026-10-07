/** Whitespace-only LOGIC formatting: tokens and their intervening trivia stay in order. */
import { AssemblerError, parseLogicSyntax, scanLogicTokens, type Token } from "./syntax.ts";
import { systemBindings } from "./systemNames.ts";
import { rangeAt, type TextEdit } from "./lspTypes.ts";

type FormatOptions = {
  readonly prelude?: string;
  readonly builtins?: Parameters<typeof parseLogicSyntax>[1];
};
interface Piece {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly token?: Token;
}

/** Return one whole-document edit, or none for invalid or already formatted source. */
export function formatLogic(source: string, options: FormatOptions = {}): TextEdit[] {
  let tokens: Token[];
  try {
    // Validation may use the project's generated bindings; output never includes the prelude.
    parseLogicSyntax((options.prelude ?? "") + source, options.builtins ?? systemBindings());
    tokens = scanLogicTokens(source);
  } catch (error) {
    if (!(error instanceof AssemblerError)) throw error;
    return [];
  }
  const labelStarts = new Set<number>();
  const labelColons = new Set<number>();
  const directiveEnds = new Set<number>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === "ident" && tokens[index + 1]?.text === ":") {
      labelStarts.add(token.start);
      labelColons.add(tokens[index + 1]!.start);
    }
    if (token.type === "directive") {
      const last = token.text === "#define" || tokens[index + 2]?.type === "string" ? 2 : 1;
      directiveEnds.add(tokens[index + last]!.end);
    }
  }
  const pieces: Piece[] = [];
  let end = 0;
  for (const token of tokens) {
    const gap = source.slice(end, token.start);
    for (const match of gap.matchAll(/\/\/[^\n]*|#[^\n]*/g)) {
      const start = end + match.index;
      pieces.push({ start, end: start + match[0].length, text: match[0].trimEnd() });
    }
    if (token.type !== "eof")
      pieces.push({
        start: token.start,
        end: token.end,
        text: source.slice(token.start, token.end),
        token,
      });
    end = token.end;
  }

  const lines: string[] = [];
  let line = "";
  let depth = 0;
  let parens = 0;
  let previous = "";
  let previousEnd = 0;
  let boundary = false;
  let inDirective = false;
  const flush = (): void => {
    if (line) lines.push(line.trimEnd());
    line = "";
    previous = "";
    boundary = false;
  };
  const operators = /^(?:=|==|!=|<=|>=|<|>|&&|\|\|)$/;
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index]!;
    const text = piece.text;
    const token = piece.token;
    const gap = source.slice(previousEnd, piece.start);
    const newLine = gap.includes("\n");
    const blank = (gap.match(/\n/g)?.length ?? 0) >= 2;
    const punct = token?.type === "punct";
    const close = punct && text === "}";
    const else_ = token?.type === "ident" && text === "else";
    const label = labelStarts.has(piece.start);
    const labelColon = labelColons.has(piece.start);
    const directive = token?.type === "directive" || (!token && text.startsWith("#"));
    const comment = !token && !directive;
    const joinElse = else_ && previous === "}";
    const keepBlank = blank && (boundary || close || label || directive || comment);

    if (
      close ||
      label ||
      directive ||
      (boundary && !joinElse && !(comment && !newLine)) ||
      (comment && newLine)
    )
      flush();
    if (keepBlank && !joinElse) {
      flush();
      if (lines.length && lines.at(-1) !== "") lines.push("");
    }
    if (joinElse) boundary = false;
    if (token?.type === "directive") inDirective = true;
    if (close) depth--;
    if (punct && text === ")") parens--;
    if (!line)
      line = "  ".repeat(
        directive || inDirective || label || labelColon ? 0 : depth + (parens > 0 ? 1 : 0),
      );
    const space =
      line.trim().length > 0 &&
      (!token ||
        text === "{" ||
        else_ ||
        operators.test(text) ||
        operators.test(previous) ||
        previous === "," ||
        (text === "(" && previous === "if") ||
        (!punct && !["(", "!"].includes(previous)));
    line += (space ? " " : "") + text;
    if (token && directiveEnds.has(token.end)) {
      inDirective = false;
      boundary = true;
    }
    if (punct && text === "(") parens++;
    if (punct && text === "{") depth++;
    if ((punct && [";", "{", "}", ":"].includes(text)) || !token) boundary = true;
    previous = text;
    previousEnd = piece.end;
  }
  flush();
  while (lines.at(-1) === "") lines.pop();
  const newText = lines.join("\n") + "\n";
  return source === newText ? [] : [{ range: rangeAt(source, 0, source.length), newText }];
}
