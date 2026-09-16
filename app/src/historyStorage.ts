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
 * Obsolete prerelease layouts are cleared, not migrated: a commit replaces
 * them with a fresh manifest and a read reports an empty tape.
 */
import {
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
} from "../../src/agent/history.ts";
import {
  validateRetained,
  type HistoryBookmark,
  type ProjectHistory,
  type RetainedOriginal,
} from "./historyArchive.ts";
import { readBodyRecords, serializeWrite, updateBodyRecords } from "./gameStorage.ts";
import { projectId, type GameIdentity } from "../../src/gameIdentity.ts";

export type { HistoryBookmark, ProjectHistory, RetainedOriginal } from "./historyArchive.ts";

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
  format: "monotio.agi.history";
  version: 3;
  /** The object store's keyPath: `history/<gameStorageKey>` — a record locator, not an identity. */
  projectId: string;
  /** The tape header — HistoryRecording minus its segment bodies. */
  recording: {
    version: number;
    identity: GameIdentity;
    profile: string;
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

/** Manifest read result: the append layout, a cleared legacy record, or none. */
function readManifest(raw: unknown): HistoryManifest | "legacy" | null {
  if (raw === undefined) return null;
  const value = raw as Record<string, unknown>;
  if (value["format"] !== "monotio.agi.history")
    throw new Error("This history record version is not supported by this app.");
  // Before the first public release, old layouts are replaced, never migrated.
  if (value["version"] === 1 || value["version"] === 2) return "legacy";
  if (value["version"] !== 3)
    throw new Error("This history record version is not supported by this app.");
  return value as unknown as HistoryManifest;
}

const manifestKey = (storageKey: string): string => `history/${storageKey}`;
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
    format: "monotio.agi.history",
    version: 3,
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
  profile: string,
  identity: GameIdentity,
  resourceSet: string,
): HistoryManifest {
  return {
    format: "monotio.agi.history",
    version: 3,
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
 * batch's, or replay applies them out of order.
 */
export function appendHistoryBatch(
  storageKey: string,
  batch: HistoryBatch,
  profile: string,
  identity: GameIdentity,
): Promise<boolean> {
  const key = manifestKey(storageKey);
  return serializeWrite(key, () => mergeHistoryBatch(key, batch, profile, identity));
}

/** Renew the owning segment while its worker is alive, including while paused. */
export function renewHistoryWriter(storageKey: string, segment: string): Promise<boolean> {
  const key = manifestKey(storageKey);
  return serializeWrite(key, () =>
    updateBodyRecords<boolean>(key, (raw) => {
      const manifest = readManifest(raw);
      if (manifest === null || manifest === "legacy") return { result: false };
      const writer = manifest.segments.find((entry) => entry.id === segment);
      if (writer === undefined || writer.end !== undefined) return { result: false };
      writer.writerExpiresAt = Date.now() + HISTORY_WRITER_LEASE_MS;
      return { puts: [manifestPut(manifest)], result: true };
    }),
  );
}

/**
 * The batch merge each tab runs: the batch record, its file blob and the
 * manifest update commit inside one read-write transaction, so a second
 * client's commit can never slip between them and silently drop acknowledged
 * history — and a failed write publishes nothing. Exported for the
 * two-client storage test, which interleaves two merge calls the way two
 * tabs would — each tab's own appendHistoryBatch mutex does not reach the
 * other tab, so the transaction is the only guard.
 */
export async function mergeHistoryBatch(
  key: string,
  batch: HistoryBatch,
  profile: string,
  identity: GameIdentity,
): Promise<boolean> {
  try {
    // Content-key the boot's file set before the transaction opens — the
    // blob write is blind (same hash is the same bytes), so no read of it.
    const filesRef = batch.boot !== undefined ? await filesBlobHash(batch.boot.files) : undefined;
    return await updateBodyRecords<boolean>(key, (raw) => {
      const stored = readManifest(raw);
      // A tape from an older layout or recording version is unreadable to
      // this build — the new session's batches must not extend it under its
      // stale label. Pre-release tapes carry no migration: the fresh
      // manifest replaces it, clearing its ledger and segment references.
      const staleTape =
        stored === "legacy" ||
        (stored !== null && stored.recording.version !== HISTORY_FORMAT_VERSION);
      const w = emptyWrites();
      if (stored === "legacy" && (raw as { version: number }).version === 2)
        w.deletes.push(...manifestFollow(raw as HistoryManifest));
      const manifest: HistoryManifest =
        !staleTape && stored !== null
          ? stored
          : freshManifest(key, profile, identity, batch.boot?.resourceSet ?? "");
      if (staleTape && stored !== null && stored !== "legacy") {
        // A same-layout tape whose recording version moved: its batch and
        // blob records are unreachable once the manifest clears, so drop
        // them rather than leave orphans.
        for (const segment of stored.segments) {
          for (const n of stored.committed[segment.id] ?? [])
            w.deletes.push(batchKey(key, segment.id, n));
        }
        for (const hash of Object.keys(stored.blobs)) w.deletes.push(blobKey(key, hash));
      }
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
  if (manifest === null || manifest === "legacy") return null;
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
  const { head, records } = await readBodyRecords(manifestKey(storageKey), (raw) => {
    const manifest = readManifest(raw);
    return manifest === null || manifest === "legacy" ? [] : manifestFollow(manifest);
  });
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
export function migrateHistoryRecord(fromStorageKey: string, toStorageKey: string): Promise<void> {
  const from = manifestKey(fromStorageKey);
  const to = manifestKey(toStorageKey);
  return serializeWrite(from, async () => {
    const { head, records } = await readBodyRecords(from, (raw) => {
      const manifest = readManifest(raw);
      return manifest === null || manifest === "legacy" ? [] : manifestFollow(manifest);
    });
    const source = assembleRecording(head, records);
    if (source === null) return;
    const fromManifest = source.manifest;
    const toProject = projectId(toStorageKey);
    await serializeWrite(to, () =>
      updateBodyRecords<void>(to, (raw) => {
        const stored = readManifest(raw);
        const w = emptyWrites();
        // The moved tape is re-addressed to the project it now belongs to —
        // its own segment evidence stays untouched.
        const movedHeader = {
          ...fromManifest.recording,
          ...(toProject !== null
            ? {
                identity: {
                  project: toProject,
                  revision: fromManifest.recording.identity.revision,
                },
              }
            : {}),
        };
        if (stored === null || stored === "legacy") {
          const manifest = freshManifest(
            to,
            movedHeader.profile,
            movedHeader.identity,
            movedHeader.resourceSet,
          );
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
          if (fromManifest.bookmarks !== undefined)
            manifest.bookmarks = [...fromManifest.bookmarks];
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
        if (receipts.size > 0)
          manifest.evicted = [...receipts.values()].slice(-HISTORY_SEGMENTS_MAX);
        manifest.recording.dropped =
          (manifest.recording.dropped ?? 0) + (fromManifest.recording.dropped ?? 0);
        w.puts.push(manifestPut(manifest));
        return { ...w, result: undefined };
      }),
    );
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
  storageKey: string,
  staged: RetainedOriginal,
): Promise<void> {
  const key = manifestKey(storageKey);
  const filesRef = await filesBlobHash(staged.boot.files);
  return serializeWrite(key, () =>
    updateBodyRecords<void>(key, (raw) => {
      const stored = readManifest(raw);
      if (stored === null || stored === "legacy") return { result: undefined }; // no record yet
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
    }),
  );
}

/**
 * The worker acknowledged the swap: the named staged candidate becomes a
 * kept branch. `dropBranch` removes the branch the swap restored — the
 * adopted original leaves the undo list because it is live again.
 */
export function commitStagedOriginal(
  storageKey: string,
  stagedId: string,
  dropBranch?: string,
): Promise<void> {
  const key = manifestKey(storageKey);
  return serializeWrite(key, () =>
    updateBodyRecords<void>(key, (raw) => {
      const stored = readManifest(raw);
      if (stored === null || stored === "legacy") return { result: undefined };
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
    }),
  );
}

/** The swap is settled and the staged copy is not needed — drop it. */
export function clearStagedOriginal(storageKey: string, stagedId: string): Promise<void> {
  const key = manifestKey(storageKey);
  return serializeWrite(key, () =>
    updateBodyRecords<void>(key, (raw) => {
      const stored = readManifest(raw);
      if (stored === null || stored === "legacy") return { result: undefined };
      const idx = (stored.staged ?? []).findIndex((s) => s.id === stagedId);
      if (idx < 0) return { result: undefined };
      const w = emptyWrites();
      const staged = stored.staged![idx]!;
      stored.staged!.splice(idx, 1);
      releaseBlob(stored, key, staged.boot.filesRef, `staged:${staged.id}`, w);
      w.puts.push(manifestPut(stored));
      return { ...w, result: undefined };
    }),
  );
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
  storageKey: string,
  recording: HistoryRecording | null,
  liveSegment?: string | null,
): Promise<StagedSwapResolution> {
  const key = manifestKey(storageKey);
  return serializeWrite(key, () =>
    updateBodyRecords<StagedSwapResolution>(key, (raw) => {
      const stored = readManifest(raw);
      if (stored === null || stored === "legacy") return { result: "none" };
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
                  s.boot.resumedFrom?.segment === from.segment &&
                  s.boot.resumedFrom.tick < from.tick,
              ) ??
                false)) ||
            (liveSegment != null && from !== undefined && liveSegment !== from.segment);
          continued =
            !adopted &&
            from !== undefined &&
            ((recording?.segments.some(
              (s) =>
                s.boot.resumedFrom?.segment === from.segment &&
                s.boot.resumedFrom.tick >= from.tick,
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
    }),
  );
}

/**
 * The kept recovery branches, boots validated, oldest first. Staged
 * candidates are not listed — an unsettled swap stays in its own lane until
 * the tape or its commit settles it.
 */
export async function loadRetainedBranches(storageKey: string): Promise<RetainedOriginal[]> {
  const key = manifestKey(storageKey);
  const { head, records } = await readBodyRecords(key, (raw) => {
    const manifest = readManifest(raw);
    if (manifest === null || manifest === "legacy") return [];
    return (manifest.branches ?? []).map((b) => blobKey(key, b.boot.filesRef));
  });
  const manifest = readManifest(head);
  if (manifest === null || manifest === "legacy") return [];
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
 * The transport's flattened live axis: per-segment extent and room marks
 * from the manifest alone — no tape bytes. Segments written before the
 * manifest tracked these report extent 0 and no marks; their real shape
 * arrives when the view opens the tape.
 */
export async function loadTapeOutline(storageKey: string): Promise<{
  segments: { id: string; extent: number; marks: HistoryRoomMark[] }[];
  dropped: number;
  /** Kept recovery branches and unsettled swap candidates, counted only. */
  branches: number;
  pending: number;
} | null> {
  const { head } = await readBodyRecords(manifestKey(storageKey), () => []);
  const manifest = readManifest(head);
  if (manifest === null || manifest === "legacy") return null;
  return {
    segments: manifest.segments.map((s) => ({
      id: s.id,
      extent: s.extent ?? 0,
      marks: s.marks ?? [],
    })),
    dropped: manifest.recording.dropped ?? 0,
    branches: manifest.branches?.length ?? 0,
    pending: manifest.staged?.length ?? 0,
  };
}

/** Append a player bookmark; the record keeps them ordered by time placed. */
export function saveHistoryBookmark(storageKey: string, bookmark: HistoryBookmark): Promise<void> {
  const key = manifestKey(storageKey);
  return serializeWrite(key, () =>
    updateBodyRecords<void>(key, (raw) => {
      const stored = readManifest(raw);
      if (stored === null || stored === "legacy") return { result: undefined };
      const bookmarks = [...(stored.bookmarks ?? []), bookmark];
      if (bookmarks.length > 500) bookmarks.splice(0, bookmarks.length - 500);
      stored.bookmarks = bookmarks;
      return { puts: [manifestPut(stored)], result: undefined };
    }),
  );
}

/** The stored bookmarks — segment ids may point at dropped segments. */
export async function loadHistoryBookmarks(storageKey: string): Promise<HistoryBookmark[]> {
  const { head } = await readBodyRecords(manifestKey(storageKey), () => []);
  const manifest = readManifest(head);
  if (manifest === null || manifest === "legacy") return [];
  return manifest.bookmarks ?? [];
}

// ---------- project archive boundary ----------

/** The stored record's exportable part, validated. */
export async function loadProjectHistory(storageKey: string): Promise<ProjectHistory | null> {
  const { head, records } = await readBodyRecords(manifestKey(storageKey), (raw) => {
    const manifest = readManifest(raw);
    return manifest === null || manifest === "legacy" ? [] : manifestFollow(manifest);
  });
  const assembled = assembleRecording(head, records);
  if (assembled === null) return null;
  const recording = validateHistoryRecording(assembled.recording);
  const blobs = new Map<string, StoredBlob>();
  for (const hash of Object.keys(assembled.manifest.blobs)) {
    const blob = records.get(blobKey(assembled.manifest.projectId, hash)) as StoredBlob | undefined;
    if (blob !== undefined) blobs.set(hash, blob);
  }
  const branches: RetainedOriginal[] = [];
  for (const stored of assembled.manifest.branches ?? []) {
    const hydrated = rehydrateRetained(stored, blobs);
    const checked = hydrated === undefined ? null : validateRetained(hydrated);
    if (checked !== null) branches.push(checked);
  }
  return {
    recording,
    ...(branches.length > 0 ? { branches } : {}),
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
export function importGameHistory(
  storageKey: string,
  history: ProjectHistory,
  identity: GameIdentity,
): Promise<boolean> {
  const key = manifestKey(storageKey);
  return serializeWrite(key, async () => {
    try {
      // Hash every file set the tape carries before the transaction opens.
      const blobHashes = new Map<string, string>();
      const boots = history.recording.segments.map((segment) => segment.boot);
      for (const branch of history.branches ?? []) boots.push(branch.boot);
      for (const boot of boots) {
        const text = JSON.stringify(boot.files);
        if (!blobHashes.has(text)) blobHashes.set(text, await filesBlobHash(boot.files));
      }
      const hashOf = (boot: HistoryBoot): string => blobHashes.get(JSON.stringify(boot.files))!;
      await updateBodyRecords<void>(key, (raw) => {
        const stored = readManifest(raw);
        const w = emptyWrites();
        if (stored === "legacy" && (raw as { version: number }).version === 2)
          w.deletes.push(...manifestFollow(raw as HistoryManifest));
        if (stored !== null && stored !== "legacy") {
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
          identity,
          history.recording.resourceSet,
        );
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
        if (history.bookmarks !== undefined) manifest.bookmarks = [...history.bookmarks];
        w.puts.push(manifestPut(manifest));
        return { ...w, result: undefined };
      });
      return true;
    } catch (error) {
      console.error("History import failed:", error);
      return false;
    }
  });
}
