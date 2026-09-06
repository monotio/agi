/** Browser storage for the engine's twelve authentic save images, scoped per game. */
type SaveStorage = Pick<Storage, "getItem" | "setItem">;

export function readGameSaves(storage: SaveStorage, slug: string): Record<string, string> {
  const stored = storage.getItem(`monotio_agi.saves.${encodeURIComponent(slug)}`);
  if (stored === null) return {};
  const value: unknown = JSON.parse(stored);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid saved game list.");
  const record = value as Record<string, unknown>;
  if (record["format"] !== "monotio.agi.saves" || record["version"] !== 1)
    throw new Error("This saved game version is not supported by this app.");
  if (!record["slots"] || typeof record["slots"] !== "object" || Array.isArray(record["slots"]))
    throw new Error("Invalid saved game list.");
  const slots: Record<string, string> = {};
  for (let slot = 1; slot <= 12; slot++) {
    const image = (record["slots"] as Record<string, unknown>)[String(slot)];
    if (typeof image === "string") slots[String(slot)] = image;
  }
  return slots;
}

export function writeGameSave(
  storage: SaveStorage,
  slug: string,
  slot: number,
  image: string,
): boolean {
  if (!Number.isInteger(slot) || slot < 1 || slot > 12) return false;
  try {
    const slots = readGameSaves(storage, slug);
    slots[String(slot)] = image;
    storage.setItem(
      `monotio_agi.saves.${encodeURIComponent(slug)}`,
      JSON.stringify({ format: "monotio.agi.saves", version: 1, slots }),
    );
    return true;
  } catch {
    return false;
  }
}
