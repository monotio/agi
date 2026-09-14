/**
 * The always-on recording's persistence layer: committed batches land on the
 * game's stored `HistoryRecording` under a `history/<gameStorageKey>` record
 * in the shared projects store. Resends dedup by the per-segment batch
 * counter, so a batch the worker reposts after a slow commit lands once.
 *
 * Retention is bounded twice: a segment-count cap and a total byte budget
 * (accumulated per segment from committed batch sizes). Either bound drops
 * the oldest segments first — never the live tail — and counts the loss in
 * `recording.dropped` so the transport can say where the tape starts.
 */
import {
  HISTORY_FORMAT_VERSION,
  validateHistoryRecording,
  type HistoryBatch,
  type HistoryRecording,
} from "../../src/agent/history.ts";
import {
  validateRetained,
  type HistoryBookmark,
  type ProjectHistory,
  type RetainedOriginal,
} from "./historyArchive.ts";
import { bodyTransaction, serializeWrite } from "./gameStorage.ts";

export type { HistoryBookmark, ProjectHistory, RetainedOriginal } from "./historyArchive.ts";

/**
 * Segments retained per game. A session that outlives its segment opens
 * another; the bound drops the oldest complete segments first — the live
 * tail is never dropped.
 */
const HISTORY_SEGMENTS_MAX = 64;

/**
 * Total serialized bytes the tape may occupy; beyond it the oldest segments
 * are evicted. The live tail is exempt — the earliest kept position moves
 * forward, playback never loses what is still being recorded.
 */
export const HISTORY_TOTAL_BYTE_LIMIT = 64 * 1024 * 1024;

interface StoredHistory {
  format: "monotio.agi.history";
  version: 1;
  /** The record key: `history/<gameStorageKey>`. */
  projectId: string;
  recording: HistoryRecording;
  /** Committed batch numbers per segment id — the resend dedup. A set, not a
   *  high-water mark: a failed commit must not block its later resend. */
  committed: Record<string, number[]>;
  /** Serialized bytes committed per segment id — the eviction budget. */
  bytes?: Record<string, number>;
  /** The one retained original (Resume here's departing session). */
  retained?: RetainedOriginal;
  /**
   * A departing session staged for a swap the worker has not yet
   * acknowledged. It stays until the swap commits — if the adoption's
   * outcome is uncertain, this is the recovery copy.
   */
  staged?: RetainedOriginal;
  /** Player-placed marks on the tape. */
  bookmarks?: HistoryBookmark[];
}

function readStoredHistory(raw: unknown): StoredHistory | null {
  if (raw === undefined) return null;
  const value = raw as Record<string, unknown>;
  if (value["format"] !== "monotio.agi.history" || value["version"] !== 1)
    throw new Error("This history record version is not supported by this app.");
  return value as unknown as StoredHistory;
}

/** Drop the oldest segments while a bound is exceeded; the live tail stays. */
function evictSegments(
  recording: HistoryRecording,
  committed: Record<string, number[]>,
  bytes: Record<string, number>,
): void {
  const drop = (): void => {
    const dropped = recording.segments.shift()!;
    delete committed[dropped.id];
    delete bytes[dropped.id];
    recording.dropped = (recording.dropped ?? 0) + 1;
  };
  while (recording.segments.length > HISTORY_SEGMENTS_MAX && recording.segments.length > 1) drop();
  let total = Object.values(bytes).reduce((sum, n) => sum + n, 0);
  while (total > HISTORY_TOTAL_BYTE_LIMIT && recording.segments.length > 1) {
    total -= bytes[recording.segments[0]!.id] ?? 0;
    drop();
  }
}

/**
 * Commit one posted history batch into the game's stored recording. Returns
 * false when the batch has no segment to land on (its boot batch never
 * committed) — the worker keeps it queued and resends.
 */
export function appendHistoryBatch(
  storageKey: string,
  batch: HistoryBatch,
  profile: string,
): Promise<boolean> {
  const key = `history/${storageKey}`;
  return serializeWrite(key, async () => {
    try {
      const stored = readStoredHistory(
        await bodyTransaction<unknown>("readonly", (store) => store.get(key)),
      );
      const committed: Record<string, number[]> = { ...(stored?.committed ?? {}) };
      if ((committed[batch.segment] ?? []).includes(batch.batch)) return true;
      const bytes: Record<string, number> = { ...(stored?.bytes ?? {}) };
      const recording: HistoryRecording = stored?.recording ?? {
        version: HISTORY_FORMAT_VERSION,
        profile,
        resourceSet: batch.boot?.resourceSet ?? "",
        startedAt: Date.now(),
        segments: [],
      };
      let segment = recording.segments.find((s) => s.id === batch.segment);
      if (segment === undefined) {
        // A batch without its boot opens nothing — the worker's resend will
        // eventually deliver the boot batch that does.
        if (batch.boot === undefined) return false;
        segment = {
          id: batch.segment,
          boot: batch.boot,
          anchors: [],
          events: [],
          marks: [],
          sync: [],
        };
        recording.segments.push(segment);
      }
      segment.events.push(...batch.events);
      segment.marks.push(...batch.marks);
      segment.sync.push(...batch.sync);
      if (batch.anchor !== undefined) segment.anchors.push(batch.anchor);
      if (batch.end !== undefined) segment.end = batch.end;
      (committed[batch.segment] ??= []).push(batch.batch);
      bytes[batch.segment] = (bytes[batch.segment] ?? 0) + JSON.stringify(batch).length;
      evictSegments(recording, committed, bytes);
      await bodyTransaction("readwrite", (store) =>
        store.put({
          format: "monotio.agi.history",
          version: 1,
          projectId: key,
          recording,
          committed,
          bytes,
          // The adopted session's own boot batch commits right after a
          // Resume here — the retained original, the staged swap candidate
          // and the bookmarks must survive every commit, not just the ones
          // that set them.
          ...(stored?.retained !== undefined ? { retained: stored.retained } : {}),
          ...(stored?.staged !== undefined ? { staged: stored.staged } : {}),
          ...(stored?.bookmarks !== undefined ? { bookmarks: stored.bookmarks } : {}),
        } satisfies StoredHistory),
      );
      return true;
    } catch (error) {
      console.error("History commit failed:", error);
      return false;
    }
  });
}

/** The stored recording for a game, validated; null when none was committed. */
export async function loadGameHistory(storageKey: string): Promise<HistoryRecording | null> {
  const stored = readStoredHistory(
    await bodyTransaction<unknown>("readonly", (store) => store.get(`history/${storageKey}`)),
  );
  if (stored === null) return null;
  return validateHistoryRecording(stored.recording);
}

/**
 * Stage a departing session for the swap the worker is about to be asked to
 * make. The existing retained original is untouched until the adoption is
 * acknowledged — a failed or uncertain swap never costs the kept session.
 */
export function stageRetainedOriginal(storageKey: string, staged: RetainedOriginal): Promise<void> {
  const key = `history/${storageKey}`;
  return serializeWrite(key, async () => {
    const stored = readStoredHistory(
      await bodyTransaction<unknown>("readonly", (store) => store.get(key)),
    );
    if (stored === null) return;
    await bodyTransaction("readwrite", (store) => store.put({ ...stored, staged }));
  });
}

/** The worker acknowledged the swap: the staged candidate becomes the retained original. */
export function commitStagedOriginal(storageKey: string): Promise<void> {
  const key = `history/${storageKey}`;
  return serializeWrite(key, async () => {
    const stored = readStoredHistory(
      await bodyTransaction<unknown>("readonly", (store) => store.get(key)),
    );
    if (stored === null || stored.staged === undefined) return;
    const next = { ...stored, retained: stored.staged };
    delete next.staged;
    await bodyTransaction("readwrite", (store) => store.put(next));
  });
}

/** The swap is settled and the staged copy is not needed — drop it. */
export function clearStagedOriginal(storageKey: string): Promise<void> {
  const key = `history/${storageKey}`;
  return serializeWrite(key, async () => {
    const stored = readStoredHistory(
      await bodyTransaction<unknown>("readonly", (store) => store.get(key)),
    );
    if (stored === null || stored.staged === undefined) return;
    const next = { ...stored };
    delete next.staged;
    await bodyTransaction("readwrite", (store) => store.put(next));
  });
}

/**
 * The retained original, its boot validated; null when none is stored. When
 * no retained slot exists but a staged swap candidate does — an adoption
 * whose acknowledgement was lost — the staged copy is the recovery route.
 */
export async function loadRetainedOriginal(storageKey: string): Promise<RetainedOriginal | null> {
  const stored = readStoredHistory(
    await bodyTransaction<unknown>("readonly", (store) => store.get(`history/${storageKey}`)),
  );
  const retained = stored?.retained ?? stored?.staged;
  if (retained === undefined) return null;
  return validateRetained(retained);
}

/** Append a player bookmark; the record keeps them ordered by time placed. */
export function saveHistoryBookmark(storageKey: string, bookmark: HistoryBookmark): Promise<void> {
  const key = `history/${storageKey}`;
  return serializeWrite(key, async () => {
    const stored = readStoredHistory(
      await bodyTransaction<unknown>("readonly", (store) => store.get(key)),
    );
    if (stored === null) return;
    const bookmarks = [...(stored.bookmarks ?? []), bookmark];
    if (bookmarks.length > 500) bookmarks.splice(0, bookmarks.length - 500);
    await bodyTransaction("readwrite", (store) => store.put({ ...stored, bookmarks }));
  });
}

/** The stored bookmarks — segment ids may point at dropped segments. */
export async function loadHistoryBookmarks(storageKey: string): Promise<HistoryBookmark[]> {
  const stored = readStoredHistory(
    await bodyTransaction<unknown>("readonly", (store) => store.get(`history/${storageKey}`)),
  );
  return stored?.bookmarks ?? [];
}

// ---------- project archive boundary ----------

/** The stored record's exportable part, validated. */
export async function loadProjectHistory(storageKey: string): Promise<ProjectHistory | null> {
  const stored = readStoredHistory(
    await bodyTransaction<unknown>("readonly", (store) => store.get(`history/${storageKey}`)),
  );
  if (stored === null) return null;
  const recording = validateHistoryRecording(stored.recording);
  const retained =
    stored.retained === undefined ? undefined : (validateRetained(stored.retained) ?? undefined);
  return {
    recording,
    ...(retained !== undefined ? { retained } : {}),
    ...(stored.bookmarks !== undefined ? { bookmarks: stored.bookmarks } : {}),
  };
}

/**
 * Land an imported project's tape in storage: the record is written whole
 * with a fresh commit ledger — no worker alive could still resend the
 * imported session's batches, so dedup starts clean. Returns false when the
 * write is refused; the caller reports it like a failed save slot.
 */
export function importGameHistory(storageKey: string, history: ProjectHistory): Promise<boolean> {
  const key = `history/${storageKey}`;
  return serializeWrite(key, async () => {
    try {
      const bytes: Record<string, number> = {};
      for (const segment of history.recording.segments)
        bytes[segment.id] = JSON.stringify(segment).length;
      await bodyTransaction("readwrite", (store) =>
        store.put({
          format: "monotio.agi.history",
          version: 1,
          projectId: key,
          recording: history.recording,
          committed: {},
          bytes,
          ...(history.retained !== undefined ? { retained: history.retained } : {}),
          ...(history.bookmarks !== undefined ? { bookmarks: history.bookmarks } : {}),
        } satisfies StoredHistory),
      );
      return true;
    } catch (error) {
      console.error("History import failed:", error);
      return false;
    }
  });
}
