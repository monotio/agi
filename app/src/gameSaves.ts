/** Browser storage for the engine's twelve authentic save images, scoped per game. */
type SaveStorage = Pick<Storage, "getItem" | "setItem">;

export function readGameSaves(storage: SaveStorage, slug: string): Record<string, string> {
  const stored = storage.getItem(`monotio_agi.saves.${encodeURIComponent(slug)}`);
  if (stored !== null) {
    const value: unknown = JSON.parse(stored);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid saved game list");
    const slots: Record<string, string> = {};
    for (let slot = 1; slot <= 12; slot++) {
      const image = (value as Record<string, unknown>)[String(slot)];
      if (typeof image === "string") slots[String(slot)] = image;
    }
    return slots;
  }
  // The engine checks the image's signature before offering this legacy slot.
  const legacy = storage.getItem("monotio_agi.save");
  return legacy ? { "1": legacy } : {};
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
    storage.setItem(`monotio_agi.saves.${encodeURIComponent(slug)}`, JSON.stringify(slots));
    return true;
  } catch {
    return false;
  }
}
