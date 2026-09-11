/**
 * A player's progress in one game: the twelve numbered save slots (the raw
 * AGI save images save.game wrote) and the host's latest autosave record. It
 * lives in browser storage per game, and it travels only with a project
 * archive (under `SAVES/`), never with a published game.
 */
import { Engine, type EngineHost, type EngineMenuState } from "../../src/runtime/engine.ts";
import { decodeHostImage, decodeSave } from "../../src/runtime/persistence.ts";
import { detectProfile } from "../../src/runtime/profile.ts";
import { parseWordsTok } from "../../src/logic/words.ts";
import { openContainer } from "../../src/container/container.ts";
import { readGameSaves, writeGameSave } from "./gameSaves.ts";
import { isProgressPreview, storeRecordWithPreviewFallback } from "./progressPreview.ts";
import type { ZipFileInput } from "./zip.ts";
import { gameStorageKey, type ProjectId } from "./gameTypes.ts";

const AUTOSAVE_PREFIX = "monotio_agi.autosave.";

export interface AutosaveGame {
  readonly installed: boolean;
  readonly revision: string;
  readonly projectId?: ProjectId | undefined;
  readonly hash?: string | undefined;
  readonly alias?: string | undefined;
  /** Installed editions share one content hash; progress belongs to the folder. */
  readonly folder?: string | undefined;
}

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
  game: AutosaveGame;
}

export function autosaveTargetKey(game: AutosaveGame): string {
  return gameStorageKey(game);
}

export function autosaveKey(target: string): string {
  return `${AUTOSAVE_PREFIX}${target}`;
}

/**
 * The autosave a stored or archived JSON describes, or null when it is not one
 * this release understands.
 */
export function parseAutosaveRecord(raw: unknown): AutosaveRecord | null {
  try {
    const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as AutosaveRecord | null;
    if (parsed?.format !== "monotio.agi.autosave" || parsed.version !== 1) return null;
    if (typeof parsed.image !== "string" || !parsed.image) return null;
    if (!Number.isInteger(parsed.room) || parsed.room < 0 || parsed.room > 255) return null;
    if (!Number.isInteger(parsed.cycle) || parsed.cycle < 0 || !Number.isFinite(parsed.savedAt))
      return null;
    const rawGame = parsed.game as
      | {
          projectId?: unknown;
          hash?: unknown;
          alias?: unknown;
          folder?: unknown;
          installed?: unknown;
          revision?: unknown;
        }
      | undefined;
    if (
      typeof rawGame?.installed !== "boolean" ||
      typeof rawGame?.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(rawGame.revision)
    )
      return null;
    const installed = rawGame.installed;
    const revision = rawGame.revision;
    const projectId = typeof rawGame.projectId === "string" ? rawGame.projectId : undefined;
    const hash = typeof rawGame.hash === "string" ? rawGame.hash : undefined;
    const alias = typeof rawGame.alias === "string" ? rawGame.alias : undefined;
    const folder = typeof rawGame.folder === "string" ? rawGame.folder : undefined;
    if (installed ? !hash && !alias && !folder : !projectId) return null;
    parsed.game = {
      installed,
      revision,
      ...(installed
        ? {
            ...(hash ? { hash } : {}),
            ...(alias ? { alias } : {}),
            ...(folder ? { folder } : {}),
          }
        : { projectId: projectId! }),
    };
    if (!isProgressPreview(parsed.preview)) delete parsed.preview;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Preserve recognized checkpoints with a future integer version. Malformed
 * records and unreleased older formats are replaceable, so corrupt metadata
 * cannot block autosave for good.
 */
export function writeAutosave(
  storage: Pick<Storage, "getItem" | "setItem">,
  record: AutosaveRecord,
): AutosaveRecord | null {
  const target = autosaveTargetKey(record.game);
  if (!target) return null;
  const key = autosaveKey(target);
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
    const existing = JSON.parse(raw) as { format?: unknown; version?: unknown } | null;
    return (
      existing?.format === "monotio.agi.autosave" &&
      typeof existing.version === "number" &&
      Number.isInteger(existing.version) &&
      existing.version > 1
    );
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

/** Restore checks run against a boot of the imported game itself, not a live session. */
const RESTORE_CHECK_HOST: EngineHost = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

/**
 * Structural decode is not enough for progress: a save can decode cleanly yet
 * replay resources the archive does not carry, importing as a checkpoint that
 * only fails when the player resumes it. Boot the imported game once and
 * dry-run every image's restore against it; failures name their archive entry.
 */
function restoreChecker(
  files: Record<string, Uint8Array>,
): (label: string, image: Uint8Array) => void {
  let engine: Engine | undefined;
  return (label, image) => {
    if (!engine) {
      const words = files["WORDS.TOK"];
      engine = new Engine(
        openContainer(new Map(Object.entries(files))),
        RESTORE_CHECK_HOST,
        words
          ? new Map(parseWordsTok(words).map(({ word, id }): [string, number] => [word, id]))
          : undefined,
      );
    }
    try {
      engine.restoreImage(image);
    } catch (error) {
      throw new Error(
        `${label} cannot be restored into this game: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };
}

export interface GameProgress {
  /** Slot number ("1" to "12") to the raw save image. */
  saves: Record<string, Uint8Array>;
  autosave: AutosaveRecord | null;
}

/** The progress browser storage holds for a game; a corrupt entry stays behind. */
export function readGameProgress(
  storage: Pick<Storage, "getItem" | "setItem">,
  targetKey: string,
): GameProgress {
  const saves: Record<string, Uint8Array> = {};
  let slots: Record<string, string>;
  try {
    slots = readGameSaves(storage, targetKey);
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
    autosave = parseAutosaveRecord(storage.getItem(autosaveKey(targetKey)));
  } catch {
    autosave = null;
  }
  if (autosave && autosaveTargetKey(autosave.game) !== targetKey) autosave = null;
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
  const restores = restoreChecker(files);
  for (const [slot, image] of Object.entries(saves)) {
    if (image.length > MAX_SAVE_IMAGE_BYTES)
      throw new Error(`SAVES/SG.${slot} is too large to be a save file.`);
    try {
      decodeSave(image, profile);
    } catch {
      throw new Error(`SAVES/SG.${slot} is not a save file for this game.`);
    }
    restores(`SAVES/SG.${slot}`, image);
  }
  let autosave: AutosaveRecord | null = null;
  if (autosaveBytes) {
    if (autosaveBytes.length > MAX_AUTOSAVE_RECORD_BYTES)
      throw new Error("SAVES/AUTOSAVE.JSON is too large to be an autosave record.");
    const parsed = parseAutosaveRecord(new TextDecoder().decode(autosaveBytes));
    if (!parsed)
      throw new Error("SAVES/AUTOSAVE.JSON is not an autosave record this app understands.");
    let hostImage: Uint8Array;
    try {
      hostImage = fromBase64(parsed.image);
      decodeSave(decodeHostImage(hostImage).image, profile);
    } catch {
      throw new Error("SAVES/AUTOSAVE.JSON does not hold a save image for this game.");
    }
    restores("SAVES/AUTOSAVE.JSON", hostImage);
    autosave = parsed;
  }
  return { saves, autosave };
}

/** What an import actually persisted: browser storage can refuse any single entry. */
export interface ImportStorageReport {
  /** Numbered slots written, ascending. */
  slots: number[];
  /** Numbered slots storage refused. */
  failedSlots: number[];
  /** The autosave record as stored, or null when there was none or storage refused it. */
  autosave: AutosaveRecord | null;
}

/**
 * Store imported progress under the project ID the game received. The
 * autosave is re-addressed to that project ID and to the imported revision: the
 * export compacts the container, so the bytes it wrote are not the bytes the
 * autosave hashed, and the interpreter restores its saves without such a
 * check anyway. What is checked is that every image decodes for the game's
 * profile and restores against the imported archive (readProgressEntries).
 *
 * A storage failure mid-import is not hidden: the report names every entry
 * that landed and every entry storage refused, so the caller never presents a
 * half-written import as complete.
 */
export function storeImportedProgress(
  storage: Pick<Storage, "getItem" | "setItem">,
  projectId: ProjectId,
  revision: string,
  progress: GameProgress,
): ImportStorageReport {
  const report: ImportStorageReport = { slots: [], failedSlots: [], autosave: null };
  const slots = Object.keys(progress.saves)
    .map(Number)
    .filter((slot) => Number.isInteger(slot))
    .sort((a, b) => a - b);
  for (const slot of slots) {
    if (writeGameSave(storage, projectId, slot, toBase64(progress.saves[String(slot)]!)))
      report.slots.push(slot);
    else report.failedSlots.push(slot);
  }
  if (progress.autosave)
    report.autosave = writeAutosave(storage, {
      ...progress.autosave,
      game: { projectId, installed: false, revision },
    });
  return report;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
