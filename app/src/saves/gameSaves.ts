/** Browser storage for the engine's twelve authentic save images, scoped per game. */
import type { ProgressTarget } from "../project/progressTarget.ts";
import { earlierProgressReceiptKey } from "../project/earlierProgressReceipt.ts";
import { progressWriterMatches } from "./progressWriter.ts";
type SaveStorage = Pick<Storage, "getItem" | "setItem">;

export function gameSavesKey(targetKey: string): string {
  return `monotio_agi.saves.${encodeURIComponent(targetKey)}`;
}

/** Read native images and their optional timing from one storage snapshot. */
export function readGameSaveRecord(
  storage: Pick<Storage, "getItem">,
  target: string | ProgressTarget,
): { slots: Record<string, string>; amigaRegions: Record<string, "ntsc" | "pal"> } {
  const targetKey = typeof target === "string" ? target : target.locator;
  const stored =
    storage.getItem(gameSavesKey(targetKey)) ??
    (typeof target !== "string" &&
    target.kind === "project" &&
    target.bodyEpoch === "initial" &&
    storage.getItem(earlierProgressReceiptKey(target.project)) === null
      ? storage.getItem(gameSavesKey(target.project))
      : null);
  if (stored === null) return { slots: {}, amigaRegions: {} };
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
  const amigaRegions = validateSaveRegions(record["amigaRegions"]);
  return { slots, amigaRegions };
}

export function readGameSaves(
  storage: SaveStorage,
  target: string | ProgressTarget,
): Record<string, string> {
  return readGameSaveRecord(storage, target).slots;
}

/** Validate optional archive/storage timing with bounded slot keys. */
export function validateSaveRegions(value: unknown): Record<string, "ntsc" | "pal"> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid save regions.");
  const out: Record<string, "ntsc" | "pal"> = {};
  for (const [slot, region] of Object.entries(value)) {
    if (!/^(?:[1-9]|1[0-2])$/.test(slot) || (region !== "pal" && region !== "ntsc"))
      throw new Error("Invalid save region.");
    out[slot] = region;
  }
  return out;
}

export function writeGameSave(
  storage: SaveStorage,
  target: string | ProgressTarget,
  slot: number,
  image: string,
  amigaRegion: "ntsc" | "pal" = "ntsc",
  writerGeneration?: number,
): boolean {
  if (!Number.isInteger(slot) || slot < 1 || slot > 12) return false;
  try {
    if (
      !progressWriterMatches(
        storage,
        typeof target === "string" ? target : target.locator,
        writerGeneration,
      )
    )
      return false;
    const { slots, amigaRegions } = readGameSaveRecord(storage, target);
    if (amigaRegion === "pal") amigaRegions[String(slot)] = amigaRegion;
    else delete amigaRegions[String(slot)];
    slots[String(slot)] = image;
    storage.setItem(
      gameSavesKey(typeof target === "string" ? target : target.locator),
      JSON.stringify({
        format: "monotio.agi.saves",
        version: 1,
        slots,
        ...(Object.keys(amigaRegions).length ? { amigaRegions } : {}),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Forget a game's numbered saves: a game added again under the same key starts with empty slots. */
export function clearGameSaves(storage: Pick<Storage, "removeItem">, targetKey: string): void {
  storage.removeItem(gameSavesKey(targetKey));
}
