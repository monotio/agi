/** Markdown produces fixed element names and text nodes; source HTML remains text. */
interface MarkdownElement {
  tag: "p" | "strong" | "em" | "code" | "pre" | "ul" | "ol" | "li";
  children: MarkdownNode[];
}
export type MarkdownNode = string | MarkdownElement;
function inline(text: string): MarkdownNode[] {
  const tokens = /`([^`\n]+)`|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
  const result: MarkdownNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    if (match.index > offset) result.push(text.slice(offset, match.index));
    if (match[1] !== undefined) result.push({ tag: "code", children: [match[1]] });
    else if (match[2] !== undefined || match[3] !== undefined)
      result.push({ tag: "strong", children: inline(match[2] ?? match[3]!) });
    else result.push({ tag: "em", children: inline(match[4] ?? match[5]!) });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) result.push(text.slice(offset));
  return result;
}
export function parseAgentMarkdown(text: string): MarkdownNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownNode[] = [];
  const listItem = /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/;
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (!line.trim()) {
      index++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) code.push(lines[index++]!);
      index++;
      blocks.push({ tag: "pre", children: [{ tag: "code", children: [code.join("\n")] }] });
    } else if (listItem.test(line)) {
      const tag = listItem.exec(line)![1] ? "ul" : "ol";
      const items: MarkdownNode[] = [];
      while (index < lines.length) {
        const item = listItem.exec(lines[index]!);
        if (!item || (item[1] ? "ul" : "ol") !== tag) break;
        items.push({ tag: "li", children: inline(item[2]!) });
        index++;
      }
      blocks.push({ tag, children: items });
    } else {
      const paragraph = [line];
      index++;
      while (
        index < lines.length &&
        lines[index]!.trim() &&
        !/^\s*```/.test(lines[index]!) &&
        !listItem.test(lines[index]!)
      )
        paragraph.push(lines[index++]!);
      blocks.push({ tag: "p", children: inline(paragraph.join("\n")) });
    }
  }
  return blocks;
}
