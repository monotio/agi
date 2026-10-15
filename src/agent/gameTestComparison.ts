/** Test definitions compare structurally; JSON object key order expresses no intent. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function sameGameTestDefinition(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

/**
 * The tests Apply leaves: the current document with the names the Agent
 * added, changed or removed relative to its base. Untouched names keep the
 * current definition.
 */
export function mergeGameTestsByName<T extends { readonly name: string }>(
  base: readonly T[],
  candidate: readonly T[],
  current: readonly T[],
): readonly T[] {
  const changed = candidate.filter((test) => {
    const previous = base.find((entry) => entry.name === test.name);
    return !previous || !sameGameTestDefinition(previous, test);
  });
  const removed = new Set(
    base
      .filter((test) => !candidate.some((entry) => entry.name === test.name))
      .map((test) => test.name),
  );
  return [
    ...current
      .filter((test) => !removed.has(test.name))
      .map((test) => changed.find((entry) => entry.name === test.name) ?? test),
    ...changed.filter((test) => !current.some((entry) => entry.name === test.name)),
  ];
}
