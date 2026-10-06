/**
 * A player's progress in one game: the twelve numbered save slots (the raw
 * AGI save images save.game wrote) and the host's latest autosave record. It
 * lives in browser storage per game, and it travels only with a project
 * archive (under `SAVES/`), never with a published game.
 */
import type { EngineMenuState } from "../../../src/runtime/engine.ts";
import { readHostRngState, type HostRngState } from "../../../src/runtime/rng.ts";
import { base64ToBytes, bytesToBase64 } from "../project/bytes.ts";
import { readGameSaveRecord, writeGameSave } from "./gameSaves.ts";
import { progressWriterMatches } from "./progressWriter.ts";
import { isProgressPreview, storeRecordWithPreviewFallback } from "./progressPreview.ts";
import type { ZipFileInput } from "../archive/zip.ts";
import type { ProjectId } from "../project/gameTypes.ts";
import {
  parseProgressLocator,
  type ProgressTarget,
  type ProjectProgressTarget,
} from "../project/progressTarget.ts";
import {
  gameIdentity,
  projectId,
  type GameIdentity,
  type ResourceRevision,
} from "../../../src/gameIdentity.ts";

const AUTOSAVE_PREFIX = "monotio_agi.autosave.";

/** Short publication lock; project document commits have a separate IndexedDB fence. */
export function withCheckpointLock<T>(
  targetKey: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const locator = parseProgressLocator(targetKey);
  const project =
    locator?.kind === "project" ? locator.project : locator === null ? projectId(targetKey) : null;
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks
    ? locks.request(`monotio_agi.checkpoint.${project ?? targetKey}`, operation)
    : Promise.resolve(operation());
}

/**
 * Which entry a stored autosave belongs to: `installed` selects the resume
 * path, `identity.project` is the entry's storage key (an authored project
 * id, or an installed edition's folder/hash) and `identity.revision` the
 * playable bytes it was taken under. Aliases are queries, not record
 * fields — nothing else may name the game.
 */
export interface AutosaveGame {
  readonly installed: boolean;
  readonly identity: GameIdentity;
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
  rng?: HostRngState;
  writerGeneration?: number;
  cycle: number;
  room: number;
  savedAt: number;
  game: AutosaveGame;
}

function autosaveTargetKey(game: AutosaveGame): string {
  return game.identity.project;
}

export function autosaveKey(target: string): string {
  return `${AUTOSAVE_PREFIX}${target}`;
}

/**
 * Whether a stored record's embedded identity belongs under `targetKey`.
 * The physical address decides first: a `project:` locator names the body
 * id its record must embed, and an `installed:` locator names one exact
 * folder build, so its records must carry the installed discriminator and
 * the locator's full revision. A released spelling (a bare project id,
 * folder, hash or alias) matches on the embedded project exactly as
 * released reads did.
 */
export function autosaveMatchesKey(game: AutosaveGame, targetKey: string): boolean {
  const parsed = parseProgressLocator(targetKey);
  if (parsed?.kind === "installed")
    return game.installed && game.identity.revision === parsed.revision;
  if (parsed?.kind === "project") {
    return !game.installed && game.identity.project === parsed.project;
  }
  return autosaveTargetKey(game) === targetKey;
}

/**
 * The record a target writes must embed the target's own released
 * identity: the installed discriminator and the full {project, revision}
 * pair. A record naming another game writes nothing rather than claiming
 * the address.
 */
function autosaveOwnedByTarget(game: AutosaveGame, target: ProgressTarget): boolean {
  return (
    game.installed === (target.kind === "installed") &&
    game.identity.project === target.identity.project &&
    game.identity.revision === target.identity.revision
  );
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
    const rawGame = parsed.game as { installed?: unknown; identity?: unknown } | undefined;
    const identity = gameIdentity(rawGame?.identity);
    if (typeof rawGame?.installed !== "boolean" || identity === null) return null;
    parsed.game = { installed: rawGame.installed, identity };
    if (!isProgressPreview(parsed.preview)) delete parsed.preview;
    if (parsed.rng !== undefined) parsed.rng = readHostRngState(parsed.rng);
    if (
      parsed.writerGeneration !== undefined &&
      (!Number.isSafeInteger(parsed.writerGeneration) || parsed.writerGeneration < 1)
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Preserve recognized checkpoints with a future integer version. Malformed
 * and format-less records are replaceable, so corrupt metadata cannot block
 * autosave for good.
 *
 * The record is stored under the resolved target's physical locator —
 * `installed:<folder digest>` or `project:<id>:<body epoch>` — and its
 * embedded `game` must be the target's own identity, checked field by
 * field before the write.
 */
export function writeAutosave(
  storage: Pick<Storage, "getItem" | "setItem">,
  target: ProgressTarget,
  record: AutosaveRecord,
): AutosaveRecord | null;
/**
 * The released spelling: the record keys itself under its embedded
 * `game.identity.project`, the pre-target storage key. Kept for callers
 * still on released storage keys; bound callers pass the ProgressTarget.
 */
export function writeAutosave(
  storage: Pick<Storage, "getItem" | "setItem">,
  record: AutosaveRecord,
): AutosaveRecord | null;
export function writeAutosave(
  storage: Pick<Storage, "getItem" | "setItem">,
  targetOrRecord: ProgressTarget | AutosaveRecord,
  record?: AutosaveRecord,
): AutosaveRecord | null {
  let key: string;
  let stored: AutosaveRecord;
  if (record === undefined) {
    stored = targetOrRecord as AutosaveRecord;
    if (stored.format !== "monotio.agi.autosave") return null;
    const legacyKey = autosaveTargetKey(stored.game);
    if (!legacyKey) return null;
    key = autosaveKey(legacyKey);
  } else {
    const target = targetOrRecord as ProgressTarget;
    if (!autosaveOwnedByTarget(record.game, target)) return null;
    stored = record;
    key = autosaveKey(target.locator);
  }
  try {
    const locator =
      record === undefined
        ? autosaveTargetKey(stored.game)
        : (targetOrRecord as ProgressTarget).locator;
    if (!progressWriterMatches(storage, locator, stored.writerGeneration)) return null;
    const raw = storage.getItem(key);
    if (raw !== null && isFutureAutosave(raw)) return null;
    return storeRecordWithPreviewFallback(storage, key, stored);
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
export interface GameProgress {
  amigaRegions?: Record<string, "ntsc" | "pal">;
  /** Slot number ("1" to "12") to the raw save image. */
  saves: Record<string, Uint8Array>;
  autosave: AutosaveRecord | null;
}

/**
 * The progress browser storage holds for a game; a corrupt entry stays
 * behind. `target` is the physical address — a resolved `ProgressTarget`
 * reads under its `locator`, a released spelling reads its own key — and
 * the autosave's embedded identity must belong under it
 * (autosaveMatchesKey).
 */
export function readGameProgress(
  storage: Pick<Storage, "getItem" | "setItem">,
  target: ProgressTarget | string,
): GameProgress {
  const targetKey = typeof target === "string" ? target : target.locator;
  let releasedAutosave: AutosaveRecord | null = null;
  // A released checkpoint still belongs to the matching saved body. Reads
  // preserve its bytes; new writes keep using the bound physical address.
  try {
    if (
      typeof target !== "string" &&
      target.kind === "project" &&
      target.bodyEpoch === "initial" &&
      storage.getItem(autosaveKey(targetKey)) === null
    ) {
      for (const key of target.legacyKeys) {
        const released = readGameProgress(storage, key);
        if (
          released.autosave !== null &&
          !released.autosave.game.installed &&
          released.autosave.game.identity.revision === target.identity.revision &&
          released.autosave.game.identity.project === target.project
        )
          releasedAutosave = released.autosave;
      }
    }
  } catch {
    /* Storage can refuse reads; the ordinary reader reports an empty result. */
  }
  const saves: Record<string, Uint8Array> = {};
  let slots: Record<string, string>;
  let amigaRegions: Record<string, "ntsc" | "pal"> = {};
  try {
    ({ slots, amigaRegions } = readGameSaveRecord(storage, target));
  } catch {
    slots = {};
  }
  for (const [slot, image] of Object.entries(slots)) {
    try {
      saves[slot] = base64ToBytes(image);
    } catch {
      /* not a save image */
    }
  }
  let autosave: AutosaveRecord | null;
  try {
    autosave = parseAutosaveRecord(storage.getItem(autosaveKey(targetKey))) ?? releasedAutosave;
  } catch {
    autosave = null;
  }
  if (
    autosave &&
    !(typeof target === "string"
      ? autosaveMatchesKey(autosave.game, targetKey)
      : autosaveOwnedByTarget(autosave.game, target))
  )
    autosave = null;
  return { saves, autosave, ...(Object.keys(amigaRegions).length ? { amigaRegions } : {}) };
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
  if (progress.amigaRegions && Object.keys(progress.amigaRegions).length)
    entries.push({
      name: "SAVES/TIMING.JSON",
      data: JSON.stringify({ amigaRegions: progress.amigaRegions }),
    });
  if (progress.autosave)
    entries.push({ name: AUTOSAVE_FILE, data: JSON.stringify(progress.autosave) });
  return entries;
}

/** What an import actually persisted: browser storage can refuse any single entry. */
export interface ImportStorageReport {
  /** Numbered slots written, ascending. */
  slots: number[];
  /** Numbered slots storage refused. */
  failedSlots: number[];
  /** The autosave record as stored, or null when there was none or storage refused it. */
  autosave: AutosaveRecord | null;
  /** Whether the imported world map reached storage, when the archive carried one. */
  map?: boolean;
  /** Whether the imported session tape reached storage, when the archive carried one. */
  history?: boolean;
}

/**
 * Store imported progress under the destination body's physical target —
 * the `project:<id>:<epoch>` locator of the stored body that was just
 * written. The autosave is re-addressed to that body's released identity:
 * the export compacts the container, so the bytes it wrote are not the
 * bytes the autosave hashed, and the interpreter restores its saves
 * without such a check anyway. What is checked is that every image decodes
 * for the game's profile and restores against the imported archive
 * (readProgressEntries).
 *
 * A storage failure mid-import is not hidden: the report names every entry
 * that landed and every entry storage refused, so the caller never presents a
 * half-written import as complete.
 */
export function storeImportedProgress(
  storage: Pick<Storage, "getItem" | "setItem">,
  target: ProjectProgressTarget,
  progress: GameProgress,
): ImportStorageReport;
/**
 * The released spelling: imported progress lands under the bare project id
 * and the imported revision. Kept for callers not yet bound to a target.
 */
export function storeImportedProgress(
  storage: Pick<Storage, "getItem" | "setItem">,
  projectId: ProjectId,
  revision: ResourceRevision,
  progress: GameProgress,
): ImportStorageReport;
export function storeImportedProgress(
  storage: Pick<Storage, "getItem" | "setItem">,
  targetOrId: ProjectProgressTarget | ProjectId,
  revisionOrProgress: ResourceRevision | GameProgress,
  maybeProgress?: GameProgress,
): ImportStorageReport {
  const report: ImportStorageReport = { slots: [], failedSlots: [], autosave: null };
  const locator = typeof targetOrId === "string" ? targetOrId : targetOrId.locator;
  const identity: GameIdentity =
    typeof targetOrId === "string"
      ? { project: targetOrId, revision: revisionOrProgress as ResourceRevision }
      : targetOrId.identity;
  const progress = (maybeProgress ?? revisionOrProgress) as GameProgress;
  const slots = Object.keys(progress.saves)
    .map(Number)
    .filter((slot) => Number.isInteger(slot))
    .sort((a, b) => a - b);
  for (const slot of slots) {
    if (
      writeGameSave(
        storage,
        locator,
        slot,
        bytesToBase64(progress.saves[String(slot)]!),
        progress.amigaRegions?.[String(slot)],
      )
    )
      report.slots.push(slot);
    else report.failedSlots.push(slot);
  }
  if (progress.autosave) {
    const record: AutosaveRecord = {
      ...progress.autosave,
      game: { installed: false, identity },
    };
    report.autosave =
      typeof targetOrId === "string"
        ? writeAutosave(storage, record)
        : writeAutosave(storage, targetOrId, record);
  }
  return report;
}
