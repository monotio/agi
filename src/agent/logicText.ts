/** Typographic conveniences for newly authored source; the assembler stays byte-exact. */
const PUNCTUATION: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": '\\"',
  "\u201d": '\\"',
  "\u2013": "-",
  "\u2014": "--",
  "\u2026": "...",
};

export function normalizeAuthoredLogic(source: string): {
  source: string;
  adjustments: string[];
} {
  const changes = new Set<string>();
  // Match comments before literals so quotes in comments cannot start a string.
  // Escaped characters stay intact, including byte escapes from disassembly.
  const normalized = source.replace(/\/\/[^\n]*|"(?:\\[^\n]|[^"\\\n])*"/g, (token) => {
    if (token.startsWith("//")) return token;
    return token.replace(/\\[^\n]|[\u2018\u2019\u201c\u201d\u2013\u2014\u2026]/g, (char) => {
      const replacement = PUNCTUATION[char];
      if (replacement === undefined) return char;
      changes.add(
        `Converted U+${char.charCodeAt(0).toString(16).toUpperCase()} to ${JSON.stringify(replacement)} in authored text.`,
      );
      return replacement;
    });
  });
  return { source: normalized, adjustments: [...changes] };
}
