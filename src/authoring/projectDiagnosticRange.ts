/** Translate native instruction origins back to exact authored operand tokens. */
import { compileProjectLogic } from "./projectLogic.ts";
import { scanLogicTokens } from "../logic/syntax.ts";

export function projectDiagnosticRanges(
  documents: Readonly<Record<string, string | Uint8Array>>,
  context: Parameters<typeof compileProjectLogic>[1],
) {
  const cache = new Map<string, ReturnType<typeof compileProjectLogic>>();
  return (origin: {
    document: string;
    pc?: number;
    operand?: number;
  }): { start: number; end: number } | undefined => {
    const source = documents[origin.document];
    if (
      !origin.document.startsWith("logic:") ||
      typeof source !== "string" ||
      origin.pc === undefined
    )
      return;
    let compiled = cache.get(origin.document);
    if (!compiled) {
      compiled = compileProjectLogic(source, { ...context, sourceMap: true });
      cache.set(origin.document, compiled);
    }
    const entry = compiled.assembly.sourceMap?.entries.find(
      (entry) => entry.pc === origin.pc && ["action", "predicate"].includes(entry.kind),
    );
    if (!entry) return;
    const base = compiled.expansion.authoredStart;
    const tokens = scanLogicTokens(source).filter((token) => token.start >= entry.start - base);
    let parameter = 0;
    for (const token of tokens.slice(2)) {
      if ([")", ";", "{"].includes(token.text)) break;
      if (token.text === ",") parameter++;
      else if (parameter === (origin.operand ?? 0)) return { start: token.start, end: token.end };
    }
    return { start: entry.start - base, end: entry.end - base };
  };
}
