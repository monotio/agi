/** Editor structure and colouring from the compiler's recoverable lexer. */
import { analyzeLogicSyntax } from "./syntax.ts";
import { createTextCoordinates } from "./lspTypes.ts";
import type { DocumentSymbol, FoldingRange, Range, SemanticTokens } from "./lspTypes.ts";

export function createLogicLanguageStructure(source: string) {
  const syntax = analyzeLogicSyntax(source);
  const { offsetAt, positionAt, rangeAt } = createTextCoordinates(source);
  const symbols: DocumentSymbol[] = syntax.definitions.map((entry) => ({
    name: entry.name,
    kind: entry.kind === "label" ? 12 : 14,
    range: rangeAt(entry.start, entry.end),
    selectionRange: rangeAt(entry.start, entry.end),
  }));
  for (let i = 0; i < syntax.tokens.length; i++) {
    const token = syntax.tokens[i]!;
    if (token.text === "#message" && token.type === "directive") {
      const number = syntax.tokens[i + 1];
      if (number?.type === "number")
        symbols.push({
          name: `Message ${number.text}`,
          kind: 15,
          range: rangeAt(token.start, syntax.tokens[i + 2]?.end ?? number.end),
          selectionRange: rangeAt(number.start, number.end),
        });
    }
    if (token.type === "ident" && token.text === "said" && syntax.tokens[i + 1]?.text === "(") {
      let end = i + 2;
      while (end < syntax.tokens.length && syntax.tokens[end]?.text !== ")") end++;
      const last = syntax.tokens[end];
      if (last?.text === ")")
        symbols.push({
          name: source.slice(token.start, last.end),
          kind: 12,
          range: rangeAt(token.start, last.end),
          selectionRange: rangeAt(token.start, token.end),
        });
    }
  }
  symbols.sort((a, b) => offsetAt(a.selectionRange.start) - offsetAt(b.selectionRange.start));
  const folding: FoldingRange[] = [];
  const stack: number[] = [];
  for (const token of syntax.tokens) {
    if (token.type !== "punct") continue;
    if (token.text === "{") stack.push(positionAt(token.start).line);
    else if (token.text === "}") {
      const startLine = stack.pop();
      const endLine = positionAt(token.start).line - 1;
      if (startLine !== undefined && endLine > startLine)
        folding.push({ startLine, endLine, kind: "region" });
    }
  }
  folding.sort((a, b) => a.startLine - b.startLine);

  function semanticTokens(range?: Range): SemanticTokens {
    const spans: { start: number; end: number; type: number }[] = [];
    let previousEnd = 0;
    for (let i = 0; i < syntax.tokens.length; i++) {
      const token = syntax.tokens[i]!;
      const gap = source.slice(previousEnd, token.start);
      // Strings are tokens, so a comment marker inside a string never enters a gap.
      for (const match of gap.matchAll(/\/\/[^\r\n]*|#[^\r\n]*/g))
        spans.push({
          start: previousEnd + match.index,
          end: previousEnd + match.index + match[0].length,
          type: 6,
        });
      previousEnd = token.end;
      let type: number | undefined;
      if (
        token.type === "directive" ||
        (token.type === "ident" && ["if", "else", "return", "goto"].includes(token.text))
      )
        type = 0;
      else if (token.type === "ident") type = syntax.tokens[i + 1]?.text === "(" ? 1 : 2;
      else if (token.type === "number") type = 3;
      else if (token.type === "string" || (token.type === "invalid" && source[token.start] === '"'))
        type = 4;
      else if (token.type === "punct" && !/[{}();,:]/.test(token.text)) type = 5;
      if (type !== undefined) spans.push({ start: token.start, end: token.end, type });
    }
    const start = range ? offsetAt(range.start) : 0;
    const end = range ? offsetAt(range.end) : source.length;
    const data: number[] = [];
    let previousLine = 0;
    let previousCharacter = 0;
    for (const span of spans) {
      let at = Math.max(start, span.start);
      const limit = Math.min(end, span.end);
      while (at < limit) {
        let to = at;
        while (to < limit && source[to] !== "\r" && source[to] !== "\n") to++;
        if (to > at) {
          const position = positionAt(at);
          const delta = position.line - previousLine;
          data.push(
            delta,
            delta ? position.character : position.character - previousCharacter,
            to - at,
            span.type,
            0,
          );
          previousLine = position.line;
          previousCharacter = position.character;
        }
        at = to + 1;
      }
    }
    return { data };
  }
  return { symbols, folding, semanticTokens };
}
