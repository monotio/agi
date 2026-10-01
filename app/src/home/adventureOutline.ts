export type OutlineBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; rows: string[][] };

/** Display supported outline markup as text; Vue escapes all source content. */
function plainText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/([*`_])(.+?)\1/g, "$2")
    .trim();
}

/** A read-only projection: the complete source stays in the adventure draft. */
export function parseOutline(source: string): OutlineBlock[] {
  const body = source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const blocks: OutlineBlock[] = [];
  let paragraph: string[] = [];
  function flush(): void {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", text: plainText(paragraph.join(" ")) });
      paragraph = [];
    }
  }
  for (const line of body.split(/\r?\n/)) {
    const text = line.trim();
    const heading = text.match(/^(#{1,6})\s+(.+)$/);
    const item = text.match(/^(?:([-*+])|\d+[.)])\s+(.+)$/);
    if (!text) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, text: plainText(heading[2]!) });
    } else if (text.startsWith("|") && text.endsWith("|")) {
      flush();
      const cells = text.slice(1, -1).split("|").map(plainText);
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
      const last = blocks.at(-1);
      if (last?.kind === "table") last.rows.push(cells);
      else blocks.push({ kind: "table", rows: [cells] });
    } else if (item) {
      flush();
      const ordered = !item[1];
      const last = blocks.at(-1);
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(plainText(item[2]!));
      else blocks.push({ kind: "list", ordered, items: [plainText(item[2]!)] });
    } else {
      const last = blocks.at(-1);
      if (/^\s+/.test(line) && last?.kind === "list" && !paragraph.length) {
        const index = last.items.length - 1;
        last.items[index] += ` ${plainText(text)}`;
      } else paragraph.push(text);
    }
  }
  flush();
  return blocks;
}
