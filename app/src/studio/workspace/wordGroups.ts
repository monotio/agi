import { ANY_WORD, REST_OF_LINE } from "../../../../src/logic/words.ts";

export function wordGroups(entries: readonly (readonly [string, number])[]) {
  const groups: { id: number; words: string[] }[] = [];
  const byId: Record<string, { id: number; words: string[] }> = {};
  for (const [word, id] of entries) {
    let group = byId[String(id)];
    if (group === undefined) {
      group = { id, words: [] };
      byId[String(id)] = group;
      groups.push(group);
    }
    group.words.push(word);
  }
  return groups;
}

export function nextWordGroup(entries: readonly (readonly [string, number])[]): number {
  const used = new Set(entries.map(([, id]) => id));
  for (let id = 2; id <= 0xffff; id++) {
    if (id !== ANY_WORD && id !== REST_OF_LINE && !used.has(id)) return id;
  }
  throw new Error("Every word meaning is used. Add a word to an existing meaning.");
}
