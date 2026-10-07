/** Value ranges in validated JSON, retaining the author's spacing and key order. */
export function jsonSourceRange(
  source: string,
  path: readonly (string | number)[],
): { start: number; end: number } | undefined {
  try {
    JSON.parse(source);
  } catch {
    return;
  }
  const tokens = [
    ...source.matchAll(
      /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]/g,
    ),
  ];
  let cursor = 0;
  let found: { start: number; end: number } | undefined;
  function value(at: readonly (string | number)[]): void {
    const first = tokens[cursor++]!;
    if (first[0] === "{") {
      while (tokens[cursor]?.[0] !== "}") {
        const key = JSON.parse(tokens[cursor++]![0]) as string;
        cursor++;
        value([...at, key]);
        if (tokens[cursor]?.[0] !== ",") break;
        cursor++;
      }
      cursor++;
    } else if (first[0] === "[") {
      let index = 0;
      while (tokens[cursor]?.[0] !== "]") {
        value([...at, index++]);
        if (tokens[cursor]?.[0] !== ",") break;
        cursor++;
      }
      cursor++;
    }
    if (at.length === path.length && at.every((part, index) => part === path[index])) {
      const last = tokens[cursor - 1]!;
      found = { start: first.index, end: last.index + last[0].length };
    }
  }
  value([]);
  return found;
}
