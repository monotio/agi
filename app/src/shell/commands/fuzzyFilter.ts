/** Case-insensitive subsequences, with exact and contiguous matches first. */
function score(title: string, query: string): number | null {
  const text = title.toLowerCase();
  if (text === query) return -2;
  const contiguous = text.indexOf(query);
  if (contiguous >= 0) return -1 + contiguous / (text.length + 1);
  let position = -1;
  let gaps = 0;
  for (const character of query) {
    const next = text.indexOf(character, position + 1);
    if (next < 0) return null;
    gaps += next - position - 1;
    position = next;
  }
  return gaps;
}

export function fuzzyFilter<T>(
  entries: readonly T[],
  query: string,
  title: (entry: T) => string,
): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...entries];
  return entries
    .flatMap((entry, index) => {
      const rank = score(title(entry), normalized);
      return rank === null ? [] : [{ entry, index, rank }];
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((match) => match.entry);
}
