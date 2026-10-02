export interface PlayerSentence {
  readonly text: string;
  readonly room: number;
  readonly unknown: string;
  readonly count: number;
}
export function recordPlayerSentence(
  rows: readonly PlayerSentence[],
  entry: Omit<PlayerSentence, "count">,
): PlayerSentence[] {
  const found = rows.find((row) => row.room === entry.room && row.text === entry.text);
  if (found) return rows.map((row) => (row === found ? { ...entry, count: row.count + 1 } : row));
  return [...rows, { ...entry, count: 1 }];
}
export function resolvePlayerSentence(
  rows: readonly PlayerSentence[],
  entry: PlayerSentence,
): PlayerSentence[] {
  return rows.filter((row) => row.room !== entry.room || row.text !== entry.text);
}
const sentencesKey = (project: string): string => `monotio_agi.tried.${project}`;

export function readPlayerSentences(project: string): PlayerSentence[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(sentencesKey(project)) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(
      (row): row is PlayerSentence =>
        typeof row === "object" &&
        row !== null &&
        typeof row.text === "string" &&
        typeof row.unknown === "string" &&
        Number.isInteger(row.room) &&
        Number.isInteger(row.count) &&
        row.count > 0,
    );
  } catch {
    return [];
  }
}
export function savePlayerSentences(project: string, rows: readonly PlayerSentence[]): void {
  try {
    localStorage.setItem(sentencesKey(project), JSON.stringify(rows));
  } catch {
    /* Editor observations remain available in memory. */
  }
}

/** Forget what players typed in a removed project, so a game added again starts clean. */
export function clearPlayerSentences(storage: Pick<Storage, "removeItem">, project: string): void {
  storage.removeItem(sentencesKey(project));
}
