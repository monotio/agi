/**
 * Earlier checkpoint preparation — the read-side half of the Earlier
 * progress "Open checkpoint" action.
 *
 * `listEarlierCheckpoints` reports which localStorage strings of a pinned
 * `EarlierRead` snapshot are supported checkpoints: the exact
 * `autosaveKey(source)` entry whose raw string parses as a v1 autosave
 * record embedded for that source. `prepareEarlierCheckpoint` re-validates
 * the explicitly selected entry, proves it restores into the selected
 * destination's actual bytes under the selected interpreter (the existing
 * archive reader's dry-run against a real Engine boot), and returns a
 * rebound record — a separate value; the raw source string stays exact.
 *
 * The module is ephemeral ordinary data only: no storage reads or writes,
 * no persisted token, no new released field. Its runtime dependency on the
 * archive reader (and through it the Engine) loads dynamically inside
 * `prepareEarlierCheckpoint` so it stays off the eager Play graph; the
 * future consumer dynamically imports this module itself.
 */
import { gameRevision } from "../project/gameMetadata.ts";
import type { EarlierRead } from "../project/earlierProgress.ts";
import type { RawLocalEntry } from "../project/legacyProgressRecovery.ts";
import type { ProgressTarget } from "../project/progressTarget.ts";
import { detectProfile, type ProfileId } from "../../../src/runtime/profile.ts";
import {
  AUTOSAVE_FILE,
  autosaveKey,
  autosaveMatchesKey,
  parseAutosaveRecord,
  type AutosaveRecord,
} from "./gameProgress.ts";

/**
 * One selectable checkpoint inside a read's local string array: the actual
 * array index plus the exact raw storage key, with the parsed autosave
 * record as its supported metadata. Duplicate keys stay separate choices —
 * the index, never a merge or newest-first guess, selects the entry.
 */
export interface EarlierCheckpointChoice {
  /** Index into the read's local string array (`record.local` or `local`). */
  readonly index: number;
  /** The exact storage key — `autosaveKey(source)` for this snapshot's source. */
  readonly key: string;
  /** The raw string's parsed autosave record; the source identity is embedded. */
  readonly record: AutosaveRecord;
}

/**
 * A checkpoint proven restorable into its destination. Ephemeral: handed to
 * the boot lifecycle on Open checkpoint, never persisted. `record` is the
 * rebound autosave — same image, menus and preview, `game` rebound to the
 * selected destination's identity; `raw` keeps the original stored string
 * byte-exact.
 */
export interface PreparedEarlierCheckpoint {
  /**
   * Which snapshot supplied the checkpoint: the removal capture's exact
   * record key, or the live source spelling the read observed.
   */
  readonly origin:
    | { readonly kind: "capture"; readonly key: string }
    | { readonly kind: "live"; readonly source: string };
  /** The selected entry's index in the read's local string array. */
  readonly index: number;
  /** The entry's exact storage key. */
  readonly key: string;
  /** The complete original raw string, byte-identical to storage. */
  readonly raw: string;
  /** The explicitly selected destination. */
  readonly target: ProgressTarget;
  /** The effective interpreter the restore proof ran under. */
  readonly profile: ProfileId;
  /** The validated autosave rebound to the destination's identity. */
  readonly record: AutosaveRecord;
}

interface EarlierCheckpointLocals {
  readonly origin: PreparedEarlierCheckpoint["origin"];
  /** The released storage spelling this snapshot's local keys belong to. */
  readonly spelling: string;
  readonly local: readonly RawLocalEntry[];
}

/**
 * The local string array a read can actually answer for, with the source
 * spelling its autosave key must name. Only known captures and live reads
 * carry strings: an `unsupported`/`unreadable`/`absent` capture envelope is
 * opaque, and a `local` orphan row has no established source spelling —
 * both stay download-only.
 */
function checkpointLocals(read: EarlierRead): EarlierCheckpointLocals | undefined {
  if (read.kind === "capture") {
    if (read.state !== "available") return undefined;
    return {
      origin: { kind: "capture", key: read.key },
      spelling: read.record.source,
      local: read.record.local,
    };
  }
  if (read.kind === "live") {
    return {
      origin: { kind: "live", source: read.source },
      spelling: read.source,
      local: read.local,
    };
  }
  return undefined;
}

/**
 * Whether one raw entry is this source's checkpoint: the exact autosave
 * key, a supported parse, and an embedded identity the key associates.
 * Strings are parsed, never the snapshot's object — the parser mutates
 * parsed metadata.
 */
function checkpointEntry(
  entry: RawLocalEntry | undefined,
  key: string,
  spelling: string,
): AutosaveRecord | null {
  if (entry === undefined || entry.key !== key) return null;
  const record = parseAutosaveRecord(entry.value);
  if (record === null || !autosaveMatchesKey(record.game, spelling)) return null;
  return record;
}

/** The supported checkpoints of one pinned read, in local array order. */
export function listEarlierCheckpoints(read: EarlierRead): readonly EarlierCheckpointChoice[] {
  const locals = checkpointLocals(read);
  if (locals === undefined) return [];
  const key = autosaveKey(locals.spelling);
  const choices: EarlierCheckpointChoice[] = [];
  for (const [index, entry] of locals.local.entries()) {
    const record = checkpointEntry(entry, key, locals.spelling);
    if (record !== null) choices.push({ index, key: entry.key, record });
  }
  return choices;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Prove one selected checkpoint entry restores into the selected
 * destination. Refuses — without any write — when the entry is not the
 * source's own autosave string, when the supplied bytes no longer hash to
 * the destination's or the checkpoint's full resource revision, or when
 * the existing archive reader's real Engine restore dry-run rejects the
 * image. The destination may be another id or the installed domain;
 * equality of complete bytes and the selected interpreter, not matching
 * spellings, justifies the cross-ID rebind.
 */
export async function prepareEarlierCheckpoint(options: {
  readonly read: EarlierRead;
  readonly entryIndex: number;
  readonly target: ProgressTarget;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly profile?: ProfileId | undefined;
}): Promise<PreparedEarlierCheckpoint> {
  const locals = checkpointLocals(options.read);
  if (locals === undefined)
    throw new Error("This earlier progress source offers no checkpoint to open.");
  const entry = locals.local[options.entryIndex];
  if (entry === undefined || entry.key !== autosaveKey(locals.spelling))
    throw new Error("The selected entry is not this source's checkpoint.");
  const record = parseAutosaveRecord(entry.value);
  if (record === null)
    throw new Error("This checkpoint is not an autosave record this version can read.");
  if (!autosaveMatchesKey(record.game, locals.spelling))
    throw new Error("This checkpoint belongs to a different progress source.");

  // Own the resource bytes before the first await: a caller reusing the
  // buffers under an in-flight preparation must not change what is hashed
  // or booted.
  const files = Object.fromEntries(
    Object.entries(options.files).map(([name, bytes]) => [name, new Uint8Array(bytes)]),
  );
  const revision = await gameRevision(files);
  if (options.target.identity.revision !== revision)
    throw new Error("The selected game's current files do not match its progress binding.");
  if (record.game.identity.revision !== revision)
    throw new Error("This checkpoint was saved under different game data.");

  // The restore check boots a real Engine — load it lazily so it stays off
  // the Play boot path.
  const { readProgressEntries } = await import("./gameProgressImport.ts");
  const entries = new Map([[AUTOSAVE_FILE, new TextEncoder().encode(entry.value)]]);
  let autosave: AutosaveRecord | null | undefined;
  try {
    autosave = readProgressEntries(entries, "", files, options.profile)?.autosave;
  } catch (error) {
    throw new Error(
      `This checkpoint cannot be restored into the selected game: ${describe(error)}`,
      {
        cause: error,
      },
    );
  }
  if (!autosave)
    throw new Error("This checkpoint is not an autosave record this version can read.");

  return {
    origin: locals.origin,
    index: options.entryIndex,
    key: entry.key,
    raw: entry.value,
    target: options.target,
    profile: detectProfile(new Map(Object.entries(files)), options.profile).id,
    record: {
      ...autosave,
      game: { installed: options.target.kind === "installed", identity: options.target.identity },
    },
  };
}
