/**
 * Text -> a string literal the assembler's lexer reads back byte for byte.
 * Everything outside printable ASCII goes out as an escape, so the source
 * stays plain ASCII whatever code page the original text was written in.
 */
export function quoteLogicString(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const c = text.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    // A dictionary word could in principle hold a non-byte character; \xNN
    // could not express it, and mangling it would silently change its id.
    else if (c > 0xff) out += ch;
    else if (c < 0x20 || c >= 0x7f) out += `\\x${c.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `"${out}"`;
}
