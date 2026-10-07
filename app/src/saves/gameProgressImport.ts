/**
 * The progress a project archive carries, checked against the game it
 * arrived with. This archive reader sits behind gameZip.ts's dynamic
 * import so the eager browser-storage module (gameProgress.ts) never
 * statically reaches the runtime Engine the restore check boots.
 */
import { Engine, type EngineHost } from "../../../src/runtime/engine.ts";
import { decodeHostImage, decodeSave } from "../../../src/runtime/persistence.ts";
import { detectProfile, type ProfileId } from "../../../src/runtime/profile.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import { openContainer } from "../../../src/container/container.ts";
import { base64ToBytes } from "../project/bytes.ts";
import {
  AUTOSAVE_FILE,
  parseAutosaveRecord,
  type AutosaveRecord,
  type GameProgress,
} from "./gameProgress.ts";
import { validateSaveRegions } from "./gameSaves.ts";

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
  profile: ProfileId | undefined,
): (label: string, image: Uint8Array) => void {
  let engine: Engine | undefined;
  return (label, image) => {
    if (!engine) {
      const words = files["WORDS.TOK"];
      engine = new Engine(
        openContainer(new Map(Object.entries(files)), profile ? { profile } : {}),
        RESTORE_CHECK_HOST,
        words
          ? new Map(parseWordsTok(words).map(({ word, id }): [string, number] => [word, id]))
          : undefined,
        profile ? { profile } : undefined,
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
  override?: ProfileId,
): GameProgress | undefined {
  const saves: Record<string, Uint8Array> = {};
  let amigaRegions: Record<string, "ntsc" | "pal"> = {};
  let autosaveBytes: Uint8Array | undefined;
  for (const [path, bytes] of entries) {
    if (!path.startsWith(root)) continue;
    const name = path.slice(root.length);
    if (name === "SAVES/TIMING.JSON") {
      if (bytes.length > 1024) throw new Error("Save timing metadata is too large.");
      const timing = JSON.parse(new TextDecoder().decode(bytes)) as { amigaRegions?: unknown };
      amigaRegions = validateSaveRegions(timing.amigaRegions);
    } else if (name === AUTOSAVE_FILE) autosaveBytes = bytes;
    else {
      const slot = SLOT_FILE.exec(name)?.[1];
      if (slot) saves[slot] = bytes;
    }
  }
  if (autosaveBytes === undefined && Object.keys(saves).length === 0) return undefined;
  // Saves decode under the interpreter the game boots under.
  const profile = detectProfile(new Map(Object.entries(files)), override);
  const restores = restoreChecker(files, override);
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
      hostImage = base64ToBytes(parsed.image);
      decodeSave(decodeHostImage(hostImage).image, profile);
    } catch {
      throw new Error("SAVES/AUTOSAVE.JSON does not hold a save image for this game.");
    }
    restores("SAVES/AUTOSAVE.JSON", hostImage);
    autosave = parsed;
  }
  return { saves, autosave, ...(Object.keys(amigaRegions).length ? { amigaRegions } : {}) };
}
