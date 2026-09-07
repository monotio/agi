/**
 * A player's progress in one game: the twelve numbered save slots (the raw
 * AGI save images save.game wrote) and the host's latest autosave record. It
 * lives in browser storage per game slug, and it travels only with a project
 * archive (under `SAVES/`), never with a published game.
 */
import type { EngineMenuState } from "../../src/runtime/engine.ts";
import { decodeHostImage, decodeSave } from "../../src/runtime/persistence.ts";
import { detectProfile } from "../../src/runtime/profile.ts";
import { readGameSaves, writeGameSave } from "./gameSaves.ts";
import { isProgressPreview, storeRecordWithPreviewFallback } from "./progressPreview.ts";
import type { ZipFileInput } from "./zip.ts";

const AUTOSAVE_PREFIX = "monotio_agi.autosave.";

/** One stored autosave: the save-file image plus what it takes to boot into it. */
export interface AutosaveRecord {
  format: "monotio.agi.autosave";
  version: 1;
  /** base64 of the host autosave envelope (save.game's image plus the screen sequence). */
  image: string;
  /** Exact composed engine frame captured with this save image, when available. */
  preview?: string;
  /** Menus are session state and are not present in the AGI save envelope. */
  menus?: EngineMenuState;
  cycle: number;
  room: number;
  savedAt: number;
  game: { slug: string; installed: boolean; revision: string };
}

export function autosaveKey(slug: string): string {
  return `${AUTOSAVE_PREFIX}${slug}`;
}

/**
 * The autosave a stored or archived JSON describes, or null when it is not one
 * this release understands. The slug it names is the caller's to check.
 */
export function parseAutosaveRecord(raw: unknown): AutosaveRecord | null {
  try {
    const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as AutosaveRecord | null;
    if (parsed?.format !== "monotio.agi.autosave" || parsed.version !== 1) return null;
    if (typeof parsed.image !== "string" || !parsed.image) return null;
    if (!Number.isInteger(parsed.room) || parsed.room < 0 || parsed.room > 255) return null;
    if (!Number.isInteger(parsed.cycle) || parsed.cycle < 0 || !Number.isFinite(parsed.savedAt))
      return null;
    if (
      typeof parsed.game?.slug !== "string" ||
      typeof parsed.game.installed !== "boolean" ||
      !/^[a-f0-9]{64}$/.test(parsed.game.revision)
    )
      return null;
    if (!isProgressPreview(parsed.preview)) delete parsed.preview;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Never replace a checkpoint whose format this release cannot understand. A
 * record without a recognised format (pre-release, or corrupt JSON) protects
 * nothing and is replaced, so a stale slot cannot block autosave for good.
 */
export function writeAutosave(
  storage: Pick<Storage, "getItem" | "setItem">,
  record: AutosaveRecord,
): AutosaveRecord | null {
  const key = autosaveKey(record.game.slug);
  try {
    const raw = storage.getItem(key);
    if (raw !== null && isFutureAutosave(raw)) return null;
    return storeRecordWithPreviewFallback(storage, key, record);
  } catch {
    return null;
  }
}

function isFutureAutosave(raw: string): boolean {
  try {
    const existing = JSON.parse(raw) as Partial<AutosaveRecord> | null;
    return existing?.format === "monotio.agi.autosave" && existing.version !== 1;
  } catch {
    return false;
  }
}

/** Where a project archive keeps the player's progress. */
export const AUTOSAVE_FILE = "SAVES/AUTOSAVE.JSON";
const SLOT_FILE = /^SAVES\/SG\.(1[0-2]|[1-9])$/;
/** A save image is a few kilobytes; the record adds a bounded PNG preview. */
const MAX_SAVE_IMAGE_BYTES = 64 * 1024;
const MAX_AUTOSAVE_RECORD_BYTES = 512 * 1024;

export interface GameProgress {
  /** Slot number ("1" to "12") to the raw save image. */
  saves: Record<string, Uint8Array>;
  autosave: AutosaveRecord | null;
}

/** The progress browser storage holds for a game; a corrupt entry stays behind. */
export function readGameProgress(
  storage: Pick<Storage, "getItem" | "setItem">,
  slug: string,
): GameProgress {
  const saves: Record<string, Uint8Array> = {};
  let slots: Record<string, string>;
  try {
    slots = readGameSaves(storage, slug);
  } catch {
    slots = {};
  }
  for (const [slot, image] of Object.entries(slots)) {
    try {
      saves[slot] = fromBase64(image);
    } catch {
      /* not a save image */
    }
  }
  let autosave: AutosaveRecord | null;
  try {
    autosave = parseAutosaveRecord(storage.getItem(autosaveKey(slug)));
  } catch {
    autosave = null;
  }
  if (autosave && autosave.game.slug !== slug) autosave = null;
  return { saves, autosave };
}

/**
 * Archive entries for a project: each slot as the interpreter's own save file
 * (`SAVES/SG.<n>`) and the autosave as the app's record (`SAVES/AUTOSAVE.JSON`).
 */
export function progressEntries(progress: GameProgress): ZipFileInput[] {
  const entries: ZipFileInput[] = [];
  const slots = Object.keys(progress.saves)
    .map(Number)
    .filter((slot) => Number.isInteger(slot) && slot >= 1 && slot <= 12)
    .sort((a, b) => a - b);
  for (const slot of slots)
    entries.push({ name: `SAVES/SG.${slot}`, data: progress.saves[String(slot)]! });
  if (progress.autosave)
    entries.push({ name: AUTOSAVE_FILE, data: JSON.stringify(progress.autosave) });
  return entries;
}

/**
 * The progress an archive carries under `root`, checked against the game it
 * arrived with: every slot image and the autosave's image must decode as a
 * save file for the game's interpreter profile. Other names under SAVES/ are
 * ignored; a slot that is not a save file is an error, since a player moving
 * between machines would otherwise lose it without a word.
 */
export function readProgressEntries(
  entries: ReadonlyMap<string, Uint8Array>,
  root: string,
  files: Record<string, Uint8Array>,
): GameProgress | undefined {
  const saves: Record<string, Uint8Array> = {};
  let autosaveBytes: Uint8Array | undefined;
  for (const [path, bytes] of entries) {
    if (!path.startsWith(root)) continue;
    const name = path.slice(root.length);
    if (name === AUTOSAVE_FILE) autosaveBytes = bytes;
    else {
      const slot = SLOT_FILE.exec(name)?.[1];
      if (slot) saves[slot] = bytes;
    }
  }
  if (autosaveBytes === undefined && Object.keys(saves).length === 0) return undefined;
  const profile = detectProfile(new Map(Object.entries(files)));
  for (const [slot, image] of Object.entries(saves)) {
    if (image.length > MAX_SAVE_IMAGE_BYTES)
      throw new Error(`SAVES/SG.${slot} is too large to be a save file.`);
    try {
      decodeSave(image, profile);
    } catch {
      throw new Error(`SAVES/SG.${slot} is not a save file for this game.`);
    }
  }
  let autosave: AutosaveRecord | null = null;
  if (autosaveBytes) {
    if (autosaveBytes.length > MAX_AUTOSAVE_RECORD_BYTES)
      throw new Error("SAVES/AUTOSAVE.JSON is too large to be an autosave record.");
    const parsed = parseAutosaveRecord(new TextDecoder().decode(autosaveBytes));
    if (!parsed)
      throw new Error("SAVES/AUTOSAVE.JSON is not an autosave record this app understands.");
    try {
      decodeSave(decodeHostImage(fromBase64(parsed.image)).image, profile);
    } catch {
      throw new Error("SAVES/AUTOSAVE.JSON does not hold a save image for this game.");
    }
    autosave = parsed;
  }
  return { saves, autosave };
}

/**
 * Store imported progress under the library slug the game received. The
 * autosave is re-addressed to that slug and to the imported revision: the
 * export compacts the container, so the bytes it wrote are not the bytes the
 * autosave hashed, and the interpreter restores its saves without such a
 * check anyway. What is checked is that every image decodes for the game's
 * profile (readProgressEntries).
 */
export function storeImportedProgress(
  storage: Pick<Storage, "getItem" | "setItem">,
  slug: string,
  revision: string,
  progress: GameProgress,
): void {
  for (const [slot, image] of Object.entries(progress.saves))
    writeGameSave(storage, slug, Number(slot), toBase64(image));
  if (progress.autosave)
    writeAutosave(storage, { ...progress.autosave, game: { slug, installed: false, revision } });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
