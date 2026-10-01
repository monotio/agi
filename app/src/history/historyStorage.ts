/**
 * The always-on recording's persistence layer, append-oriented: each posted
 * batch commits as one immutable record addressed by `history/<key>/s/<segment>/<batch>`
 * while a small manifest at `history/<key>` carries the segment directory,
 * the resend dedup ledger and the retention bookkeeping. A commit rewrites
 * the manifest — never the tape — so the cost of landing a batch stays
 * bounded by the batch, not by the tape it joins.
 *
 * Resource payloads travel separately: a boot's file set lands under
 * `history/<key>/blob/<sha256>` keyed by content, so a rollover or retained
 * original that replays the same bytes never duplicates them. The manifest's
 * blob table names which segments and swap slots hold each blob; retention
 * drops a segment's batch records, its refs and any blob it was last holding
 * in the same transaction.
 *
 * Retention is bounded twice: a segment-count cap and a total byte budget
 * (accumulated per segment from committed batch sizes). Either bound drops
 * the oldest eligible segments first, protecting live writer leases, and counts loss in
 * `dropped` so the transport can say where the tape starts.
 *
 * Unsupported versions and malformed layouts are refused without rewriting
 * them, as an UnextendableHistoryError — a permanent refusal, never a
 * storage hiccup to retry. The player may then start a new timeline: the
 * tape continues under `history/<key>/next` while the old record keeps its
 * bytes for the reader that wrote it (see `onTape`).
 */
import { PROFILES, type ProfileId } from "../../../src/runtime/profile.ts";
import {
  HISTORY_FORMAT_READ_VERSIONS,
  HISTORY_FORMAT_VERSION,
  validateHistoryRecording,
  type HistoryAnchor,
  type HistoryBatch,
  type HistoryBoot,
  type HistoryEvent,
  type HistoryRecording,
  type HistoryRoomMark,
  type HistorySegment,
  type HistorySyncMark,
  type HistoryClockRun,
} from "../../../src/agent/history.ts";
import {
  validateRetained,
  type HistoryBookmark,
  type ProjectHistory,
  type RetainedOriginal,
} from "../archive/historyArchive.ts";
import {
  readBodyRecords,
  serializeWrite,
  updateBodyRecords as updateStoredBodyRecords,
  historyLifetimeGuard,
  projectBodyGuard,
  bodyTransaction,
} from "../project/gameStorage.ts";
import type { GameIdentity } from "../../../src/gameIdentity.ts";
import type { ProgressTarget } from "../project/progressTarget.ts";

export type {
  HistoryBookmark,
  ProjectHistory,
  RetainedOriginal,
} from "../archive/historyArchive.ts";

/**
 * Segments retained per game. A session that outlives its segment opens
 * another; the bound drops the oldest ended or expired segments first.
 * Every open segment with a renewed writer lease stays protected.
 */
const HISTORY_SEGMENTS_MAX = 64;

/** Paused writers renew independently of batches; crashed writers expire. */
export const HISTORY_WRITER_RENEW_MS = 30_000;
export const HISTORY_WRITER_LEASE_MS = 120_000;

/**
 * Total serialized bytes the tape may occupy; beyond it the oldest segments
 * are evicted. Active writer leases are exempt, so concurrent writers may
 * temporarily exceed this budget until their leases end or expire.
 */
export const HISTORY_TOTAL_BYTE_LIMIT = 64 * 1024 * 1024;
/** Recovery branches kept per game — the rewind undo list's bound. */
export const HISTORY_BRANCHES_MAX = 8;
/**
 * Unsettled swap candidates kept per game. A swap stages at most one, so
 * past this bound the oldest unresolved candidate joins the branch list —
 * it is a valid restore point either way, and the pending lane stays free.
 */
export const HISTORY_STAGED_MAX = 4;
/** Room marks a manifest segment keeps for the live timeline's notches. */
const MANIFEST_MARKS_MAX = 200;

/** A segment's place in tape order plus the retention-relevant metadata. */
interface ManifestSegment {
  id: string;
  /** Segment ids are unique writer ownership tokens; an open lease protects its tape. */
  writerExpiresAt?: number;
  /** The files blob this segment's boot references — release key on eviction. */
  blob?: string;
  end?: HistorySegment["end"];
  /**
   * The segment's recorded extent in ticks — the transport's flattened
   * timeline reads it without touching tape bytes.
   */
  extent?: number;
  /** Room marks, capped — the live timeline's notches before the tape opens. */
  marks?: HistoryRoomMark[];
}

/**
 * The small read-modify-write record — everything a commit needs to decide
 * and everything retention needs to collect, without touching tape bytes.
 */
interface HistoryManifest {
  /** The browser's tape record; HISTORY.JSON is the archive format. */
  format: "monotio.agi.stored-history";
  version: 1;
  /** The object store's keyPath: `history/<gameStorageKey>` — a record locator, not an identity. */
  projectId: string;
  /** The tape header — HistoryRecording minus its segment bodies. */
  recording: {
    version: number;
    identity: GameIdentity;
    profile: ProfileId;
    resourceSet: string;
    startedAt: number;
    dropped?: number;
  };
  /** The segment directory in tape order. */
  segments: ManifestSegment[];
  /** Committed batch numbers per segment id — the resend dedup. A set, not a
   *  high-water mark: a failed commit must not block its later resend. */
  committed: Record<string, number[]>;
  /** Serialized bytes committed per segment id — the eviction budget. */
  bytes: Record<string, number>;
  /** Exact published batches retained as bounded dedup receipts after eviction. */
  evicted?: { id: string; ranges: [number, number][] }[];
  /**
   * Kept recovery branches, oldest first — Resume from here's departing
   * sessions. Bounded by HISTORY_BRANCHES_MAX so repeated rewinds preserve
   * undo copies instead of silently replacing one slot.
   */
  branches?: StoredRetained[];
  /**
   * Departing sessions staged for swaps the worker has not yet
   * acknowledged. Each stays until its swap commits — if an adoption's
   * outcome is uncertain, its entry is the recovery copy.
   */
  staged?: StoredRetained[];
  /** Player-placed marks on the tape. */
  bookmarks?: HistoryBookmark[];
  /**
   * File-set blobs this tape holds: content hash → the refs keeping it —
   * `s:<segment>` for a boot, `retained`/`staged` for a swap slot. A blob
   * with no refs deletes inside the same transaction that dropped the ref.
   */
  blobs: Record<string, string[]>;
}

/** A stored boot: the file set lives in the referenced blob record. */
type StoredBoot = Omit<HistoryBoot, "files"> & { filesRef: string };

/** A stored retained/staged original — its boot's files are blobbed too. */
type StoredRetained = Omit<RetainedOriginal, "boot"> & { boot: StoredBoot };

/**
 * One committed batch — immutable once written. `anchors` is a list so an
 * imported segment can land as a single record; a live commit carries at
 * most one anchor per batch.
 */
interface StoredBatch {
  projectId: string;
  segment: string;
  batch: number;
  seqStart: number;
  seqEnd: number;
  boot?: StoredBoot;
  events: HistoryEvent[];
  marks: HistoryRoomMark[];
  sync: HistorySyncMark[];
  clock?: HistoryClockRun[];
  anchors?: HistoryAnchor[];
  end?: HistorySegment["end"];
}

/** A file set shared by any number of boots in this tape. */
interface StoredBlob {
  projectId: string;
  data: Record<string, string>;
}

/**
 * The stored tape is in a format this version cannot extend. Permanent:
 * the record is never rewritten, so no retry can land — only a new
 * timeline beside it (`startNewTimeline`). `stored` says which side of
 * this release wrote it: a version or interpreter this app does not know
 * is "newer"; any other layout (the pre-1.0 whole-tape record) is "older".
 */
export class UnextendableHistoryError extends Error {
  readonly stored: "older" | "newer";
  constructor(message: string, stored: "older" | "newer") {
    super(message);
    this.name = "UnextendableHistoryError";
    this.stored = stored;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read only the current manifest; unsupported data remains untouched. */
function readManifest(raw: unknown): HistoryManifest | null {
  if (raw === undefined) return null;
  if (!isObject(raw) || raw["format"] !== "monotio.agi.stored-history" || raw["version"] !== 1)
    throw new UnextendableHistoryError(
      "This history record version is not supported by this app.",
      isObject(raw) &&
        raw["format"] === "monotio.agi.stored-history" &&
        typeof raw["version"] === "number" &&
        raw["version"] > 1
        ? "newer"
        : "older",
    );
  const recording = raw["recording"];
  const storedVersion = isObject(recording) ? recording["version"] : undefined;
  if (
    isObject(recording) &&
    ((typeof storedVersion === "number" && storedVersion > HISTORY_FORMAT_VERSION) ||
      (typeof recording["profile"] === "string" && !Object.hasOwn(PROFILES, recording["profile"])))
  )
    throw new UnextendableHistoryError(
      "This history record version is not supported by this app.",
      "newer",
    );
  if (
    typeof raw["projectId"] !== "string" ||
    !isObject(recording) ||
    typeof storedVersion !== "number" ||
    !HISTORY_FORMAT_READ_VERSIONS.includes(storedVersion) ||
    typeof recording["profile"] !== "string" ||
    !Array.isArray(raw["segments"]) ||
    !isObject(raw["committed"]) ||
    !isObject(raw["bytes"]) ||
    !isObject(raw["blobs"]) ||
    (raw["branches"] !== undefined && !Array.isArray(raw["branches"])) ||
    (raw["staged"] !== undefined && !Array.isArray(raw["staged"]))
  )
    throw new UnextendableHistoryError(
      "This history record layout is not supported by this app.",
      "older",
    );
  return raw as unknown as HistoryManifest;
}

const manifestKey = (storageKey: string): string => `history/${storageKey}`;
/** Where the player's new timeline continues beside a tape this version cannot extend. */
const nextTimeline = (key: string): string => `${key}/next`;

/**
 * The manifest keys one progress target may write: `history/<locator>`
 * itself or a `…/next` timeline chain under it. Nothing else is this tape —
 * a caller-selected key outside the subtree refuses rather than redirecting
 * an owner's mutation onto another record.
 */
function ownedManifestKey(target: ProgressTarget, key: string): void {
  const base = manifestKey(target.locator);
  const rest = key.startsWith(base) ? key.slice(base.length) : null;
  if (rest === null || (rest !== "" && !/^\/next(?:\/next)*$/.test(rest)))
    throw new Error("This history write names a record outside its target's tape.");
}

/**
 * The ownership checks every history mutation runs inside its own write
 * transaction — never a preflight read, since an epoch captured earlier can
 * be retaken by then. A project target writes only while its saved body is
 * still present and still carries the captured body epoch; an installed
 * target needs the lifetime its caller captured at boot — a live string —
 * still holding at `lifetime/<locator>`. A supplied lifetime that conflicts
 * with a project target's bound epoch refuses rather than overriding it.
 */
function historyWriteGuards(
  target: ProgressTarget,
  installedLifetime: string | null | undefined,
): readonly { key: string; check: (stored: unknown) => void }[] {
  if (target.kind === "project") {
    if (installedLifetime !== undefined && installedLifetime !== target.bodyEpoch)
      throw new Error(
        "This history writer's lifetime does not match the project's captured epoch.",
      );
    return [
      historyLifetimeGuard(target.project, target.bodyEpoch),
      projectBodyGuard(target.project, () => {}),
    ];
  }
  if (typeof installedLifetime !== "string" || installedLifetime === "")
    throw new Error("An installed history write needs the lifetime captured with the game.");
  return [historyLifetimeGuard(target.locator, installedLifetime)];
}

/**
 * Every history mutation checks ownership in its own write transaction —
 * the target's binding and the caller's captured lifetime, whichever
 * timeline `key` addresses. The key must name the target's own tape.
 */
function updateBodyRecords<T>(
  key: string,
  target: ProgressTarget,
  installedLifetime: string | null | undefined,
  update: (stored: unknown) => { result: T; puts?: unknown[]; deletes?: string[] },
): Promise<T> {
  ownedManifestKey(target, key);
  return updateStoredBodyRecords(key, update, historyWriteGuards(target, installedLifetime));
}

async function recordExists(key: string): Promise<boolean> {
  return (await bodyTransaction<unknown>("readonly", (store) => store.get(key))) !== undefined;
}

/**
 * Run `operation` on the game's tape. That is `history/<key>` — the record
 * every release reads — unless it holds a tape this version cannot extend
 * and the player started a new timeline, whose manifest then exists at
 * `…/next`: its existence is the recorded choice, so no pointer record or
 * new format is needed. The refused attempt wrote nothing (the reader
 * throws before any put), so moving on to the next timeline is safe; with
 * none, the UnextendableHistoryError reaches the caller.
 */
async function onTape<T>(storageKey: string, operation: (key: string) => Promise<T>): Promise<T> {
  let key = manifestKey(storageKey);
  for (;;) {
    try {
      return await operation(key);
    } catch (error) {
      if (!(error instanceof UnextendableHistoryError) || !(await recordExists(nextTimeline(key))))
        throw error;
      key = nextTimeline(key);
    }
  }
}

/**
 * One read-modify-write of the game's tape: serialized per game, resolved
 * through `onTape`, checked against the game's lifetime. `update` receives
 * the manifest key it runs on — batch and blob keys hang off it.
 */
function mutateTape<T>(
  target: ProgressTarget,
  installedLifetime: string | null | undefined,
  update: (raw: unknown, key: string) => { result: T; puts?: unknown[]; deletes?: string[] },
): Promise<T> {
  return serializeWrite(manifestKey(target.locator), () =>
    onTape(target.locator, (key) =>
      updateBodyRecords<T>(key, target, installedLifetime, (raw) => update(raw, key)),
    ),
  );
}

/** One snapshot read of the game's tape, resolved through `onTape`. */
function readTape(
  storageKey: string,
  follow: (manifest: HistoryManifest) => string[],
): Promise<{ key: string; head: unknown; records: Map<string, unknown> }> {
  return onTape(storageKey, async (key) => ({
    key,
    ...(await readBodyRecords(key, (raw) => {
      const manifest = readManifest(raw);
      return manifest === null ? [] : follow(manifest);
    })),
  }));
}
const batchKey = (key: string, segment: string, batch: number): string =>
  `${key}/s/${segment}/${String(batch).padStart(8, "0")}`;
const blobKey = (key: string, hash: string): string => `${key}/blob/${hash}`;

/** Content key of a boot's file set — the blob record's address. */
async function filesBlobHash(files: Record<string, string>): Promise<string> {
  const text = JSON.stringify(
    Object.keys(files)
      .sort()
      .map((name) => [name, files[name]!.length, files[name]]),
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Split a wire boot into its stored form plus the blob it references. */
function splitBoot(boot: HistoryBoot, filesRef: string): StoredBoot {
  const { files: _files, ...rest } = boot;
  return { ...rest, filesRef };
}

/** Reattach a stored boot's file set from its blob. */
function joinBoot(boot: StoredBoot, blobs: Map<string, StoredBlob>): HistoryBoot {
  const { filesRef, ...rest } = boot;
  return { ...rest, files: blobs.get(filesRef)?.data ?? {} };
}

/**
 * The writes a manifest decision produces. Every returned key pair lands in
 * the same transaction as the manifest put — a failed commit leaves no
 * orphan batch or half-updated manifest.
 */
interface HistoryWrites {
  puts: unknown[];
  deletes: string[];
}

function emptyWrites(): HistoryWrites {
  return { puts: [], deletes: [] };
}

/** Record a ref's release; a blob nobody holds is deleted outright. */
function releaseBlob(
  manifest: HistoryManifest,
  key: string,
  hash: string,
  ref: string,
  w: HistoryWrites,
): void {
  const refs = (manifest.blobs[hash] ?? []).filter((r) => r !== ref);
  if (refs.length > 0) manifest.blobs[hash] = refs;
  else {
    delete manifest.blobs[hash];
    w.deletes.push(blobKey(key, hash));
  }
}

/**
 * Evict ended or expired segments oldest-first. Every live writer is
 * protected, even when it is not the newest tab. Bounds may be exceeded
 * while all writers hold leases; crashed or suspended writers become
 * eligible after expiry. The current commit is always retained.
 */
function evictSegments(
  manifest: HistoryManifest,
  key: string,
  w: HistoryWrites,
  current: string,
): void {
  let total = Object.values(manifest.bytes).reduce((sum, n) => sum + n, 0);
  const over = () =>
    manifest.segments.length > HISTORY_SEGMENTS_MAX || total > HISTORY_TOTAL_BYTE_LIMIT;
  const now = Date.now();
  while (manifest.segments.length > 1 && over()) {
    const eligible = manifest.segments.findIndex(
      (segment) =>
        segment.id !== current &&
        (segment.end !== undefined || (segment.writerExpiresAt ?? 0) <= now),
    );
    if (eligible < 0) break;
    const dropped = manifest.segments.splice(eligible, 1)[0]!;
    const committed = manifest.committed[dropped.id] ?? [];
    const ranges: [number, number][] = [];
    for (const n of committed) {
      w.deletes.push(batchKey(key, dropped.id, n));
      const last = ranges.at(-1);
      if (last !== undefined && last[1] + 1 === n) last[1] = n;
      else ranges.push([n, n]);
    }
    // Only actual publications become receipts. A lost ACK can retry after
    // retention, but no previously unseen or abandoned batch earns an ACK.
    // Extremely old receipts expire conservatively: retries then refuse.
    const evicted = (manifest.evicted ??= []);
    evicted.push({ id: dropped.id, ranges: ranges.slice(-HISTORY_SEGMENTS_MAX) });
    if (evicted.length > HISTORY_SEGMENTS_MAX) evicted.shift();
    delete manifest.committed[dropped.id];
    total -= manifest.bytes[dropped.id] ?? 0;
    delete manifest.bytes[dropped.id];
    if (dropped.blob !== undefined) releaseBlob(manifest, key, dropped.blob, `s:${dropped.id}`, w);
    manifest.recording.dropped = (manifest.recording.dropped ?? 0) + 1;
  }
}

function manifestPut(manifest: HistoryManifest): unknown {
  const put: Record<string, unknown> = {
    format: "monotio.agi.stored-history",
    version: 1,
    projectId: manifest.projectId,
    recording: manifest.recording,
    segments: manifest.segments,
    committed: manifest.committed,
    bytes: manifest.bytes,
    blobs: manifest.blobs,
  };
  if (manifest.evicted !== undefined && manifest.evicted.length > 0)
    put["evicted"] = manifest.evicted;
  if (manifest.branches !== undefined && manifest.branches.length > 0)
    put["branches"] = manifest.branches;
  if (manifest.staged !== undefined && manifest.staged.length > 0) put["staged"] = manifest.staged;
  if (manifest.bookmarks !== undefined) put["bookmarks"] = manifest.bookmarks;
  return put;
}

function freshManifest(
  key: string,
  profile: ProfileId,
  identity: GameIdentity,
  resourceSet: string,
): HistoryManifest {
  return {
    format: "monotio.agi.stored-history",
    version: 1,
    projectId: key,
    recording: {
      version: HISTORY_FORMAT_VERSION,
      identity,
      profile,
      resourceSet,
      startedAt: Date.now(),
    },
    segments: [],
    committed: {},
    bytes: {},
    blobs: {},
  };
}

/**
 * Commit one posted history batch into the game's stored tape. Returns
 * false when the batch has no segment to land on (its boot batch never
 * committed) or when an earlier batch of its segment is still uncommitted —
 * the worker keeps the batch queued and resends oldest-first, so the gap
 * closes and the refused batch retries. That ordering is the tape's
 * integrity: a late resend must never append its events after a younger
 * batch's, or replay applies them out of order. Throws
 * UnextendableHistoryError when the stored tape is one this version cannot
 * extend — no resend of this batch can ever land there.
 */
export async function appendHistoryBatch(
  target: ProgressTarget,
  batch: HistoryBatch,
  profile: ProfileId | undefined,
  installedLifetime?: string | null,
): Promise<boolean> {
  return serializeWrite(manifestKey(target.locator), () =>
    onTape(target.locator, (key) =>
      mergeHistoryBatch(target, key, batch, profile, installedLifetime),
    ),
  );
}

/** Renew the owning segment while its worker is alive, including while paused. */
export function renewHistoryWriter(
  target: ProgressTarget,
  segment: string,
  installedLifetime?: string | null,
): Promise<boolean> {
  return mutateTape<boolean>(target, installedLifetime, (raw) => {
    const manifest = readManifest(raw);
    if (manifest === null) return { result: false };
    const writer = manifest.segments.find((entry) => entry.id === segment);
    if (writer === undefined || writer.end !== undefined) return { result: false };
    writer.writerExpiresAt = Date.now() + HISTORY_WRITER_LEASE_MS;
    return { puts: [manifestPut(manifest)], result: true };
  });
}

/**
 * The batch merge each tab runs: the batch record, its file blob and the
 * manifest update commit inside one read-write transaction, so a second
 * client's commit can never slip between them and silently drop acknowledged
 * history — and a failed write publishes nothing. Exported for the
 * two-client storage test, which interleaves two merge calls the way two
 * tabs would — each tab's own appendHistoryBatch mutex does not reach the
 * other tab, so the transaction is the only guard. `key` is the selected
 * manifest key and must name `target`'s own tape — the root or a `…/next`
 * timeline under it; a key pointing at another subtree refuses. A storage
 * failure answers false (the worker resends), while a tape this version
 * cannot extend throws its permanent refusal.
 */
export async function mergeHistoryBatch(
  target: ProgressTarget,
  key: string,
  batch: HistoryBatch,
  profile: ProfileId | undefined,
  installedLifetime?: string | null,
): Promise<boolean> {
  try {
    // Content-key the boot's file set before the transaction opens — the
    // blob write is blind (same hash is the same bytes), so no read of it.
    const filesRef = batch.boot !== undefined ? await filesBlobHash(batch.boot.files) : undefined;
    return await updateBodyRecords<boolean>(key, target, installedLifetime, (raw) => {
      const stored = readManifest(raw);
      const w = emptyWrites();
      // Only a batch that names the running interpreter can open a tape.
      if (stored === null && profile === undefined) return { result: false };
      const manifest =
        stored ?? freshManifest(key, profile!, target.identity, batch.boot?.resourceSet ?? "");
      const ledger = (manifest.committed[batch.segment] ??= []);
      if (ledger.includes(batch.batch)) return { result: true }; // a resend of a committed batch
      let directory = manifest.segments.find((s) => s.id === batch.segment);
      if (directory === undefined) {
        const receipt = manifest.evicted?.find((entry) => entry.id === batch.segment);
        if (receipt !== undefined)
          return {
            result: receipt.ranges.some(
              ([first, last]) => first <= batch.batch && batch.batch <= last,
            ),
          };
        // No unknown segment can acknowledge durability. An expired writer
        // retains its uncommitted batches for the host's recovery download.
        if (batch.boot === undefined) return { result: false };
        directory = { id: batch.segment, ...(filesRef !== undefined ? { blob: filesRef } : {}) };
        manifest.segments.push(directory);
        (manifest.blobs[filesRef!] ??= []).push(`s:${batch.segment}`);
        w.puts.push({
          projectId: blobKey(key, filesRef!),
          data: batch.boot.files,
        } satisfies StoredBlob);
      } else {
        // A segment's batches are one consecutive run of the session's
        // counter: only the next number extends it. Refusing keeps the
        // stream a contiguous verified prefix — the missing batch's resend
        // lands first, then this one retries. The one legal jump is a batch
        // whose sender declares the earlier numbers it abandoned: the
        // worker's queue overflow drops those unsent, so its closing batch
        // can never be reached by the consecutive rule. `end` alone never
        // grants the skip — a normal closer waits for its predecessors.
        const last = ledger[ledger.length - 1] ?? 0;
        if (batch.batch > last + 1) {
          const abandoned = new Set(batch.gap ?? []);
          for (let b = last + 1; b < batch.batch; b++)
            if (!abandoned.has(b)) return { result: false };
          // Declared gaps permit the jump but never join the committed ledger.
        } else if (batch.batch !== last + 1) return { result: false };
      }
      const { boot, anchor, ...rest } = batch;
      const record: StoredBatch = {
        projectId: batchKey(key, batch.segment, batch.batch),
        ...rest,
        ...(boot !== undefined ? { boot: splitBoot(boot, filesRef!) } : {}),
        ...(anchor !== undefined ? { anchors: [anchor] } : {}),
      };
      w.puts.push(record);
      ledger.push(batch.batch);
      manifest.bytes[batch.segment] =
        (manifest.bytes[batch.segment] ?? 0) + JSON.stringify(batch).length;
      // A current writer's first commit on an older tape upgrades the
      // recording header in the same transaction before a current-only
      // event can land in it. Reads,
      // bookmark/branch writes and dedup resent batches never reach here, so
      // they never rewrite the version; a refused batch aborts the upgrade
      // with its record.
      if (manifest.recording.version < HISTORY_FORMAT_VERSION)
        manifest.recording.version = HISTORY_FORMAT_VERSION;
      if (batch.end !== undefined) {
        directory.end = batch.end;
        delete directory.writerExpiresAt;
      } else if (directory.end === undefined) {
        directory.writerExpiresAt = Date.now() + HISTORY_WRITER_LEASE_MS;
      }
      // The transport's flattened axis: the manifest tracks each segment's
      // extent and room marks so the live timeline needs no tape load.
      const extent = Math.max(
        batch.end?.tick ?? 0,
        batch.events.length ? batch.events[batch.events.length - 1]!.tick : 0,
        batch.marks.length ? batch.marks[batch.marks.length - 1]!.tick : 0,
        batch.sync.length ? batch.sync[batch.sync.length - 1]!.tick : 0,
      );
      if (extent > (directory.extent ?? 0)) directory.extent = extent;
      if (batch.marks.length > 0) {
        const marks = [...(directory.marks ?? []), ...batch.marks];
        directory.marks =
          marks.length > MANIFEST_MARKS_MAX ? marks.slice(-MANIFEST_MARKS_MAX) : marks;
      }
      evictSegments(manifest, key, w, batch.segment);
      w.puts.push(manifestPut(manifest));
      return { ...w, result: true };
    });
  } catch (error) {
    if (error instanceof UnextendableHistoryError) throw error;
    console.error("History commit failed:", error);
    return false;
  }
}

/**
 * The batch and blob keys a manifest names — the follow set of a snapshot
 * read. Segment bodies assemble from their committed batches; boots and
 * swap slots draw their file sets from the blob table.
 */
function manifestFollow(manifest: HistoryManifest): string[] {
  const key = manifest.projectId;
  const keys: string[] = [];
  for (const segment of manifest.segments)
    for (const n of manifest.committed[segment.id] ?? []) keys.push(batchKey(key, segment.id, n));
  for (const hash of Object.keys(manifest.blobs)) keys.push(blobKey(key, hash));
  return keys;
}

/**
 * Fold one segment's committed batches back into tape order. Abandoned
 * numbers never enter the ledger; a boot on a later batch is ignored
 * the way the append path ignored it — the segment's opener owns the boot.
 */
function assembleSegment(
  key: string,
  directory: ManifestSegment,
  committed: readonly number[],
  records: Map<string, unknown>,
  blobs: Map<string, StoredBlob>,
): HistorySegment {
  const segment: HistorySegment = {
    id: directory.id,
    boot: undefined as unknown as HistoryBoot,
    anchors: [],
    events: [],
    marks: [],
    sync: [],
  };
  for (const n of [...committed].sort((a, b) => a - b)) {
    const record = records.get(batchKey(key, directory.id, n)) as StoredBatch | undefined;
    if (record === undefined) continue;
    if (record.boot !== undefined && segment.boot === undefined)
      segment.boot = joinBoot(record.boot, blobs);
    segment.events.push(...record.events);
    segment.marks.push(...record.marks);
    segment.sync.push(...record.sync);
    if (record.clock !== undefined) (segment.clock ??= []).push(...record.clock);
    if (record.anchors !== undefined) segment.anchors.push(...record.anchors);
    if (record.end !== undefined) segment.end = record.end;
  }
  return segment;
}

/** A snapshot read's reassembled tape, or null when nothing was committed. */
function assembleRecording(
  head: unknown,
  records: Map<string, unknown>,
): { manifest: HistoryManifest; recording: HistoryRecording } | null {
  const manifest = readManifest(head);
  if (manifest === null) return null;
  const blobs = new Map<string, StoredBlob>();
  for (const hash of Object.keys(manifest.blobs)) {
    const blob = records.get(blobKey(manifest.projectId, hash)) as StoredBlob | undefined;
    if (blob !== undefined) blobs.set(hash, blob);
  }
  const recording: HistoryRecording = {
    ...manifest.recording,
    segments: manifest.segments.map((directory) =>
      assembleSegment(
        manifest.projectId,
        directory,
        manifest.committed[directory.id] ?? [],
        records,
        blobs,
      ),
    ),
  };
  return { manifest, recording };
}

function rehydrateRetained(
  stored: StoredRetained | undefined,
  blobs: Map<string, StoredBlob>,
): RetainedOriginal | undefined {
  if (stored === undefined) return undefined;
  return { ...stored, boot: joinBoot(stored.boot, blobs) };
}

/** The stored recording for a game, validated; null when none was committed. */
export async function loadGameHistory(storageKey: string): Promise<HistoryRecording | null> {
  const { head, records } = await readTape(storageKey, manifestFollow);
  const assembled = assembleRecording(head, records);
  if (assembled === null) return null;
  return validateHistoryRecording(assembled.recording);
}

/**
 * Carry a live session's tape to a new storage identity — a catalog game
 * that became its remix project mid-session keeps one continuous
 * recording under the key it turned into. The read queues behind the
 * source key's pending commits so the copy includes every batch already
 * posted there; the source record stays — that game keeps the prefix its
 * own sessions recorded. Without the move, the continuing worker's next
 * batch would land on a key that never saw its segment and every later
 * commit would refuse.
 */
export async function moveHistoryRecord(
  fromTarget: ProgressTarget,
  toTarget: ProgressTarget,
  installedDestinationLifetime?: string | null,
): Promise<void> {
  return serializeWrite(manifestKey(fromTarget.locator), async () => {
    const { key: from, head, records } = await readTape(fromTarget.locator, manifestFollow);
    const source = assembleRecording(head, records);
    if (source === null) return;
    const fromManifest = source.manifest;
    await mutateTape<void>(toTarget, installedDestinationLifetime, (raw, to) => {
      const stored = readManifest(raw);
      const w = emptyWrites();
      // The moved tape is re-addressed to the project it now belongs to —
      // its own segment evidence stays untouched.
      const movedHeader = {
        ...fromManifest.recording,
        identity: {
          project: toTarget.identity.project,
          revision: fromManifest.recording.identity.revision,
        },
      };
      if (stored === null) {
        const manifest = freshManifest(
          to,
          movedHeader.profile,
          movedHeader.identity,
          movedHeader.resourceSet,
        );
        // The move re-keys the tape but writes none of its stream — the
        // record keeps the version it was written under, like an import.
        manifest.recording.version = movedHeader.version;
        manifest.recording.startedAt = movedHeader.startedAt;
        if (movedHeader.dropped !== undefined) manifest.recording.dropped = movedHeader.dropped;
        manifest.segments = fromManifest.segments.map((segment) => ({ ...segment }));
        manifest.committed = { ...fromManifest.committed };
        manifest.bytes = { ...fromManifest.bytes };
        manifest.blobs = Object.fromEntries(
          Object.entries(fromManifest.blobs).map(([hash, refs]) => [hash, [...refs]]),
        );
        if (fromManifest.evicted !== undefined)
          manifest.evicted = structuredClone(fromManifest.evicted);
        if (fromManifest.branches !== undefined)
          manifest.branches = structuredClone(fromManifest.branches);
        if (fromManifest.staged !== undefined)
          manifest.staged = structuredClone(fromManifest.staged);
        if (fromManifest.bookmarks !== undefined) manifest.bookmarks = [...fromManifest.bookmarks];
        for (const segment of manifest.segments)
          for (const n of manifest.committed[segment.id] ?? []) {
            const record = records.get(batchKey(from, segment.id, n)) as StoredBatch | undefined;
            if (record !== undefined)
              w.puts.push({ ...record, projectId: batchKey(to, segment.id, n) });
          }
        for (const hash of Object.keys(manifest.blobs)) {
          const blob = records.get(blobKey(from, hash)) as StoredBlob | undefined;
          if (blob !== undefined) w.puts.push({ ...blob, projectId: blobKey(to, hash) });
        }
        w.puts.push(manifestPut(manifest));
        return { ...w, result: undefined };
      }
      // The destination already holds a tape — union rather than
      // overwrite: segments and commit ledgers merge by id so neither
      // record's acknowledged batches are lost.
      const manifest = stored;
      // A merged tape must not claim an older version than any record it
      // now holds — a v1 destination receiving v2 segments upgrades.
      manifest.recording.version = Math.max(
        manifest.recording.version,
        fromManifest.recording.version,
      );
      const ids = new Set(manifest.segments.map((segment) => segment.id));
      for (const segment of fromManifest.segments) {
        if (ids.has(segment.id)) continue;
        manifest.segments.push({ ...segment });
        for (const n of fromManifest.committed[segment.id] ?? []) {
          const record = records.get(batchKey(from, segment.id, n)) as StoredBatch | undefined;
          if (record !== undefined)
            w.puts.push({ ...record, projectId: batchKey(to, segment.id, n) });
        }
      }
      for (const [segment, ledger] of Object.entries(fromManifest.committed)) {
        const into = (manifest.committed[segment] ??= []);
        for (const batch of ledger) if (!into.includes(batch)) into.push(batch);
      }
      for (const [segment, size] of Object.entries(fromManifest.bytes)) {
        if (manifest.bytes[segment] === undefined) manifest.bytes[segment] = size;
      }
      for (const [hash, refs] of Object.entries(fromManifest.blobs)) {
        const into = (manifest.blobs[hash] ??= []);
        for (const ref of refs) if (!into.includes(ref)) into.push(ref);
        const blob = records.get(blobKey(from, hash)) as StoredBlob | undefined;
        if (blob !== undefined) w.puts.push({ ...blob, projectId: blobKey(to, hash) });
      }
      const receipts = new Map(
        [...(fromManifest.evicted ?? []), ...(manifest.evicted ?? [])].map((entry) => [
          entry.id,
          entry,
        ]),
      );
      if (receipts.size > 0) manifest.evicted = [...receipts.values()].slice(-HISTORY_SEGMENTS_MAX);
      manifest.recording.dropped =
        (manifest.recording.dropped ?? 0) + (fromManifest.recording.dropped ?? 0);
      w.puts.push(manifestPut(manifest));
      return { ...w, result: undefined };
    });
  });
}

/**
 * Move a staged entry onto the branch list, bounded — the oldest kept
 * branch sheds its blob ref past HISTORY_BRANCHES_MAX.
 */
function promoteStaged(
  stored: HistoryManifest,
  key: string,
  staged: StoredRetained,
  w: HistoryWrites,
): void {
  const refs = (stored.blobs[staged.boot.filesRef] ?? []).filter(
    (r) => r !== `staged:${staged.id}`,
  );
  stored.blobs[staged.boot.filesRef] = [...refs, `branch:${staged.id}`];
  const branches = (stored.branches ??= []);
  branches.push(staged);
  while (branches.length > HISTORY_BRANCHES_MAX) {
    const dropped = branches.shift()!;
    releaseBlob(stored, key, dropped.boot.filesRef, `branch:${dropped.id}`, w);
  }
}

/**
 * Stage a departing session for the swap the worker is about to be asked to
 * make. Existing branches are untouched until the adoption is acknowledged
 * — a failed or uncertain swap never costs a kept session. Leftover staged
 * entries never block a new one: past HISTORY_STAGED_MAX the oldest joins
 * the branches, where it remains a valid restore point.
 */
export async function stageRetainedOriginal(
  target: ProgressTarget,
  staged: RetainedOriginal,
  installedLifetime?: string | null,
): Promise<void> {
  const filesRef = await filesBlobHash(staged.boot.files);
  return mutateTape<void>(target, installedLifetime, (raw, key) => {
    const stored = readManifest(raw);
    if (stored === null) return { result: undefined }; // no record yet
    const w = emptyWrites();
    const pending = (stored.staged ??= []);
    pending.push({ ...staged, boot: splitBoot(staged.boot, filesRef) });
    (stored.blobs[filesRef] ??= []).push(`staged:${staged.id}`);
    w.puts.push({
      projectId: blobKey(key, filesRef),
      data: staged.boot.files,
    } satisfies StoredBlob);
    while (pending.length > HISTORY_STAGED_MAX) {
      const oldest = pending.shift()!;
      promoteStaged(stored, key, oldest, w);
    }
    w.puts.push(manifestPut(stored));
    return { ...w, result: undefined };
  });
}

/**
 * The worker acknowledged the swap: the named staged candidate becomes a
 * kept branch. `dropBranch` removes the branch the swap restored — the
 * adopted original leaves the undo list because it is live again.
 */
export function commitStagedOriginal(
  target: ProgressTarget,
  stagedId: string,
  dropBranch?: string,
  installedLifetime?: string | null,
): Promise<void> {
  return mutateTape<void>(target, installedLifetime, (raw, key) => {
    const stored = readManifest(raw);
    if (stored === null) return { result: undefined };
    const idx = (stored.staged ?? []).findIndex((s) => s.id === stagedId);
    const w = emptyWrites();
    if (idx >= 0) {
      const staged = stored.staged![idx]!;
      stored.staged!.splice(idx, 1);
      promoteStaged(stored, key, staged, w);
    }
    if (dropBranch !== undefined) {
      const bi = (stored.branches ?? []).findIndex((b) => b.id === dropBranch);
      if (bi >= 0) {
        const dropped = stored.branches![bi]!;
        stored.branches!.splice(bi, 1);
        releaseBlob(stored, key, dropped.boot.filesRef, `branch:${dropped.id}`, w);
      }
    }
    w.puts.push(manifestPut(stored));
    return { ...w, result: undefined };
  });
}

/** The swap is settled and the staged copy is not needed — drop it. */
export function clearStagedOriginal(
  target: ProgressTarget,
  stagedId: string,
  installedLifetime?: string | null,
): Promise<void> {
  return mutateTape<void>(target, installedLifetime, (raw, key) => {
    const stored = readManifest(raw);
    if (stored === null) return { result: undefined };
    const idx = (stored.staged ?? []).findIndex((s) => s.id === stagedId);
    if (idx < 0) return { result: undefined };
    const w = emptyWrites();
    const staged = stored.staged![idx]!;
    stored.staged!.splice(idx, 1);
    releaseBlob(stored, key, staged.boot.filesRef, `staged:${staged.id}`, w);
    w.puts.push(manifestPut(stored));
    return { ...w, result: undefined };
  });
}

export type StagedSwapResolution = "none" | "settled" | "ambiguous";

/**
 * Settle staged candidates left behind by interrupted swaps — each is
 * judged independently. The tape is the witness: only adoption stamps the
 * departing segment's "resume" end, so a staged copy with that marker is
 * owed a branch slot (the worker adopted; only the promotion write failed).
 * One whose session plainly went on — a non-resume end, a later segment
 * continuing it, or the very segment still being the tape's live tail — is
 * a redundant snapshot and drops. When the tape proves neither the
 * candidate stays preserved; it blocks nothing — the next swap simply
 * stages beside it.
 *
 * `liveSegment` is the worker's current segment when the caller just asked.
 * It is decisive in both directions: a staged candidate whose departing
 * segment is still live was never adopted; one whose segment the worker has
 * left was. Without it the tape alone cannot prove an open segment dead —
 * its "resume" end may be the very write that failed — so that case stays
 * ambiguous rather than risk the only durable copy of a departed session.
 */
export function resolveStagedSwap(
  target: ProgressTarget,
  recording: HistoryRecording | null,
  liveSegment?: string | null,
  installedLifetime?: string | null,
): Promise<StagedSwapResolution> {
  return mutateTape<StagedSwapResolution>(target, installedLifetime, (raw, key) => {
    const stored = readManifest(raw);
    if (stored === null) return { result: "none" };
    const pending = stored.staged ?? [];
    if (pending.length === 0) return { result: "none" };
    const w = emptyWrites();
    let ambiguous = 0;
    const kept: StoredRetained[] = [];
    for (const staged of pending) {
      const from = staged.from ?? undefined;
      const departing = recording?.segments.find((s) => s.id === from?.segment);
      let adopted: boolean;
      let continued: boolean;
      if (departing?.end !== undefined) {
        // The departing segment's end is decisive on its own: only
        // adoption stamps "resume"; any other end means the session went
        // on to die naturally and the staged snapshot is redundant.
        adopted = departing.end.reason === "resume";
        continued = !adopted;
      } else {
        // Only an adopted session boots a segment resuming from an
        // EARLIER tick of the departing one (a take of its own tape); a
        // continuation resumes at-or-after the staged tick. The caller's
        // live-segment hint is decisive in both directions when the tape
        // is silent.
        adopted =
          (from !== undefined &&
            (recording?.segments.some(
              (s) =>
                s.boot.resumedFrom?.segment === from.segment && s.boot.resumedFrom.tick < from.tick,
            ) ??
              false)) ||
          (liveSegment != null && from !== undefined && liveSegment !== from.segment);
        continued =
          !adopted &&
          from !== undefined &&
          ((recording?.segments.some(
            (s) =>
              s.boot.resumedFrom?.segment === from.segment && s.boot.resumedFrom.tick >= from.tick,
          ) ??
            false) ||
            (liveSegment != null && liveSegment === from.segment));
      }
      if (!adopted && !continued) {
        ambiguous++;
        kept.push(staged);
        continue;
      }
      if (adopted) promoteStaged(stored, key, staged, w);
      else releaseBlob(stored, key, staged.boot.filesRef, `staged:${staged.id}`, w);
    }
    stored.staged = kept;
    w.puts.push(manifestPut(stored));
    return {
      ...w,
      result: ambiguous > 0 ? "ambiguous" : "settled",
    };
  });
}

/**
 * The kept recovery branches, boots validated, oldest first. Staged
 * candidates are not listed — an unsettled swap stays in its own lane until
 * the tape or its commit settles it.
 */
export async function loadRetainedBranches(storageKey: string): Promise<RetainedOriginal[]> {
  const { key, head, records } = await readTape(storageKey, (manifest) =>
    (manifest.branches ?? []).map((b) => blobKey(manifest.projectId, b.boot.filesRef)),
  );
  const manifest = readManifest(head);
  if (manifest === null) return [];
  const branches: RetainedOriginal[] = [];
  for (const stored of manifest.branches ?? []) {
    const blob = records.get(blobKey(key, stored.boot.filesRef)) as StoredBlob | undefined;
    const blobs = new Map<string, StoredBlob>();
    if (blob !== undefined) blobs.set(stored.boot.filesRef, blob);
    const checked = validateRetained({ ...stored, boot: joinBoot(stored.boot, blobs) });
    if (checked !== null) branches.push(checked);
  }
  return branches;
}

/**
 * A boot that starts the game from its beginning: it continues no earlier
 * segment and restores no checkpoint. After an earlier segment of the same
 * tape, that may be a Start over, a Play with no checkpoint to resume or a
 * reload that could not resume one: the boot records no cause.
 */
export function startsFresh(boot: Pick<HistoryBoot, "resumedFrom" | "image">): boolean {
  return boot.resumedFrom === undefined && boot.image === undefined;
}

/** Each segment's opening batch — the one whose record carries its boot. */
function openingBatches(manifest: HistoryManifest): string[] {
  const keys: string[] = [];
  for (const segment of manifest.segments) {
    const committed = manifest.committed[segment.id] ?? [];
    if (committed.length > 0)
      keys.push(batchKey(manifest.projectId, segment.id, Math.min(...committed)));
  }
  return keys;
}

/**
 * The transport's flattened live axis: per-segment extent and room marks
 * from the manifest, and whether each segment starts fresh from its opening
 * batch's boot — no other tape bytes. Segments written before the manifest
 * tracked extents report extent 0 and no marks; their real shape arrives
 * when the view opens the tape.
 */
export async function loadTapeOutline(storageKey: string): Promise<{
  segments: { id: string; extent: number; marks: HistoryRoomMark[]; fresh: boolean }[];
  dropped: number;
  /** Kept recovery branches and unsettled swap candidates, counted only. */
  branches: number;
  pending: number;
} | null> {
  const { key, head, records } = await readTape(storageKey, openingBatches);
  const manifest = readManifest(head);
  if (manifest === null) return null;
  const boot = (id: string): StoredBoot | undefined => {
    const committed = manifest.committed[id] ?? [];
    if (committed.length === 0) return undefined;
    const record = records.get(batchKey(key, id, Math.min(...committed))) as
      StoredBatch | undefined;
    return record?.boot;
  };
  const segments = manifest.segments.map((s) => {
    const opening = boot(s.id);
    return {
      id: s.id,
      extent: s.extent ?? 0,
      marks: s.marks ?? [],
      fresh: opening !== undefined && startsFresh(opening),
    };
  });
  return {
    segments,
    dropped: manifest.recording.dropped ?? 0,
    branches: manifest.branches?.length ?? 0,
    pending: manifest.staged?.length ?? 0,
  };
}

/** Append a player bookmark; the record keeps them ordered by time placed. */
export function saveHistoryBookmark(
  target: ProgressTarget,
  bookmark: HistoryBookmark,
  installedLifetime?: string | null,
): Promise<void> {
  return mutateTape<void>(target, installedLifetime, (raw) => {
    const stored = readManifest(raw);
    if (stored === null) return { result: undefined };
    const bookmarks = [...(stored.bookmarks ?? []), bookmark];
    if (bookmarks.length > 500) bookmarks.splice(0, bookmarks.length - 500);
    stored.bookmarks = bookmarks;
    return { puts: [manifestPut(stored)], result: undefined };
  });
}

/** The stored bookmarks — segment ids may point at dropped segments. */
export async function loadHistoryBookmarks(storageKey: string): Promise<HistoryBookmark[]> {
  const { head } = await readTape(storageKey, () => []);
  const manifest = readManifest(head);
  if (manifest === null) return [];
  return manifest.bookmarks ?? [];
}

// ---------- project archive boundary ----------

/** The stored record's exportable part, validated. */
export async function loadProjectHistory(storageKey: string): Promise<ProjectHistory | null> {
  const { head, records } = await readTape(storageKey, manifestFollow);
  const assembled = assembleRecording(head, records);
  if (assembled === null) return null;
  const recording = validateHistoryRecording(assembled.recording);
  const blobs = new Map<string, StoredBlob>();
  for (const hash of Object.keys(assembled.manifest.blobs)) {
    const blob = records.get(blobKey(assembled.manifest.projectId, hash)) as StoredBlob | undefined;
    if (blob !== undefined) blobs.set(hash, blob);
  }
  const retainedList = (storedList: StoredRetained[] | undefined): RetainedOriginal[] => {
    const list: RetainedOriginal[] = [];
    for (const stored of storedList ?? []) {
      const hydrated = rehydrateRetained(stored, blobs);
      const checked = hydrated === undefined ? null : validateRetained(hydrated);
      if (checked !== null) list.push(checked);
    }
    return list;
  };
  const branches = retainedList(assembled.manifest.branches);
  const staged = retainedList(assembled.manifest.staged);
  return {
    recording,
    ...(branches.length > 0 ? { branches } : {}),
    ...(staged.length > 0 ? { staged } : {}),
    ...(assembled.manifest.bookmarks !== undefined
      ? { bookmarks: assembled.manifest.bookmarks }
      : {}),
  };
}

/**
 * Land an imported project's tape in storage: the segments land as whole
 * immutable records beside a fresh manifest — no worker alive could still
 * resend the imported session's batches, so the dedup ledger starts clean.
 * Returns false when the write is refused; the caller reports it like a
 * failed save slot.
 */
export async function importGameHistory(
  target: ProgressTarget,
  history: ProjectHistory,
  installedLifetime?: string | null,
): Promise<boolean> {
  return serializeWrite(manifestKey(target.locator), async () => {
    try {
      if (!HISTORY_FORMAT_READ_VERSIONS.includes(history.recording.version)) return false;
      // Hash every file set the tape carries before the transaction opens.
      const blobHashes = new Map<string, string>();
      const boots = history.recording.segments.map((segment) => segment.boot);
      for (const branch of history.branches ?? []) boots.push(branch.boot);
      for (const staged of history.staged ?? []) boots.push(staged.boot);
      for (const boot of boots) {
        const text = JSON.stringify(boot.files);
        if (!blobHashes.has(text)) blobHashes.set(text, await filesBlobHash(boot.files));
      }
      const hashOf = (boot: HistoryBoot): string => blobHashes.get(JSON.stringify(boot.files))!;
      await onTape(target.locator, (key) =>
        updateBodyRecords<void>(key, target, installedLifetime, (raw) => {
          const stored = readManifest(raw);
          const w = emptyWrites();
          if (stored !== null) {
            // Replacing an existing append tape: its batch and blob records
            // go in the same transaction so none are orphaned.
            for (const segment of stored.segments)
              for (const n of stored.committed[segment.id] ?? [])
                w.deletes.push(batchKey(key, segment.id, n));
            for (const hash of Object.keys(stored.blobs)) w.deletes.push(blobKey(key, hash));
          }
          const manifest = freshManifest(
            key,
            history.recording.profile,
            target.identity,
            history.recording.resourceSet,
          );
          // The imported tape keeps the version it was written under — an
          // import is a copy, not a writer's append. A released v1 tape
          // stays v1 (byte-exact re-export, still readable by its own
          // release) until a live writer's first commit upgrades it.
          manifest.recording.version = history.recording.version;
          manifest.recording.startedAt = history.recording.startedAt;
          if (history.recording.dropped !== undefined)
            manifest.recording.dropped = history.recording.dropped;
          const seenBlobs = new Set<string>();
          for (const segment of history.recording.segments) {
            const filesRef = hashOf(segment.boot);
            // The flattened-axis metadata the append path maintains — an
            // imported tape's live timeline needs it without a tape load.
            const extent = Math.max(
              segment.end?.tick ?? 0,
              segment.events.length ? segment.events[segment.events.length - 1]!.tick : 0,
              segment.marks.length ? segment.marks[segment.marks.length - 1]!.tick : 0,
              segment.sync.length ? segment.sync[segment.sync.length - 1]!.tick : 0,
            );
            manifest.segments.push({
              id: segment.id,
              blob: filesRef,
              extent,
              ...(segment.marks.length > 0
                ? { marks: segment.marks.slice(-MANIFEST_MARKS_MAX) }
                : {}),
              ...(segment.end !== undefined ? { end: segment.end } : {}),
            });
            (manifest.blobs[filesRef] ??= []).push(`s:${segment.id}`);
            if (!seenBlobs.has(filesRef)) {
              seenBlobs.add(filesRef);
              w.puts.push({
                projectId: blobKey(key, filesRef),
                data: segment.boot.files,
              } satisfies StoredBlob);
            }
            const { boot, anchors, events, marks, sync, clock, end, id } = segment;
            const record: StoredBatch = {
              projectId: batchKey(key, id, 1),
              segment: id,
              batch: 1,
              seqStart: events[0]?.seq ?? 0,
              seqEnd: end?.seq ?? events[events.length - 1]?.seq ?? 0,
              boot: splitBoot(boot, filesRef),
              events: [...events],
              marks: [...marks],
              sync: [...sync],
              ...(clock !== undefined ? { clock: [...clock] } : {}),
              ...(anchors.length > 0 ? { anchors: [...anchors] } : {}),
              ...(end !== undefined ? { end } : {}),
            };
            w.puts.push(record);
            manifest.committed[id] = [1];
            manifest.bytes[id] = JSON.stringify(segment).length;
          }
          for (const branch of history.branches ?? []) {
            const filesRef = hashOf(branch.boot);
            (manifest.branches ??= []).push({
              ...branch,
              boot: splitBoot(branch.boot, filesRef),
            });
            (manifest.blobs[filesRef] ??= []).push(`branch:${branch.id}`);
            if (!seenBlobs.has(filesRef)) {
              seenBlobs.add(filesRef);
              w.puts.push({
                projectId: blobKey(key, filesRef),
                data: branch.boot.files,
              } satisfies StoredBlob);
            }
          }
          // Unsettled candidates land back in the staged slot — an imported
          // tape cannot pretend the swap settled, so the settle pass on the
          // next boot resolves them like an interrupted session's own.
          for (const staged of history.staged ?? []) {
            const filesRef = hashOf(staged.boot);
            (manifest.staged ??= []).push({
              ...staged,
              boot: splitBoot(staged.boot, filesRef),
            });
            (manifest.blobs[filesRef] ??= []).push(`staged:${staged.id}`);
            if (!seenBlobs.has(filesRef)) {
              seenBlobs.add(filesRef);
              w.puts.push({
                projectId: blobKey(key, filesRef),
                data: staged.boot.files,
              } satisfies StoredBlob);
            }
          }
          if (history.bookmarks !== undefined) manifest.bookmarks = [...history.bookmarks];
          w.puts.push(manifestPut(manifest));
          return { ...w, result: undefined };
        }),
      );
      return true;
    } catch (error) {
      console.error("History import failed:", error);
      return false;
    }
  });
}

// ---------- a tape this version cannot extend ----------

/**
 * The player's "Start a new timeline", beside a tape this version cannot
 * extend: a fresh manifest opens at `…/next` (after any new timeline
 * started before it), so the next batch — the worker's resent boot — lands
 * there. The old record and its children keep their bytes for the release
 * that wrote them. A no-op when the game's tape is extendable already, and
 * refused like any history write once the game was removed.
 */
export async function startNewTimeline(
  target: ProgressTarget,
  profile: ProfileId,
  installedLifetime?: string | null,
): Promise<void> {
  return serializeWrite(manifestKey(target.locator), () =>
    onTape(target.locator, async (key) => {
      try {
        readManifest((await readBodyRecords(key, () => [])).head);
      } catch (error) {
        const next = nextTimeline(key);
        // An earlier new timeline exists: onTape follows it instead.
        if (!(error instanceof UnextendableHistoryError) || (await recordExists(next))) throw error;
        await updateBodyRecords<void>(next, target, installedLifetime, (raw) =>
          raw === undefined
            ? {
                puts: [manifestPut(freshManifest(next, profile, target.identity, ""))],
                result: undefined,
              }
            : { result: undefined },
        );
      }
    }),
  );
}

/**
 * The old timeline, for its own reader: when the game's tape at
 * `history/<key>` is one this version cannot extend, every stored record at
 * or under that key — the new timeline's subtree excluded — as JSON of the
 * values exactly as stored, each beside its key. Null when there is no
 * such record.
 */
export async function readOldTimeline(storageKey: string): Promise<string | null> {
  const key = manifestKey(storageKey);
  const next = nextTimeline(key);
  const children = (
    await bodyTransaction<IDBValidKey[]>("readonly", (store) =>
      store.getAllKeys(IDBKeyRange.bound(`${key}/`, `${key}/￿`)),
    )
  ).filter(
    (child): child is string =>
      typeof child === "string" &&
      child.startsWith(`${key}/`) &&
      child !== next &&
      !child.startsWith(`${next}/`),
  );
  const { head, records } = await readBodyRecords(key, () => children);
  if (head === undefined) return null;
  try {
    readManifest(head);
    return null;
  } catch (error) {
    if (!(error instanceof UnextendableHistoryError)) throw error;
  }
  return JSON.stringify({
    records: [
      { key, value: head },
      ...children
        .filter((child) => records.has(child))
        .map((child) => ({ key: child, value: records.get(child) })),
    ],
  });
}
