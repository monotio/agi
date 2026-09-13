/**
 * The always-on recording's persistence layer: committed batches land on the
 * game's stored `HistoryRecording` under a `history/<gameStorageKey>` record
 * in the shared projects store. Resends dedup by the per-segment batch
 * counter, so a batch the worker reposts after a slow commit lands once.
 */
import {
  HISTORY_FORMAT_VERSION,
  validateHistoryBoot,
  validateHistoryRecording,
  type HistoryBatch,
  type HistoryBoot,
  type HistoryRecording,
} from "../../src/agent/history.ts";
import { bodyTransaction, serializeWrite } from "./gameStorage.ts";

/**
 * Segments retained per game. A session that outlives its segment opens
 * another; the bound drops the oldest complete segments first — the live
 * tail is never dropped.
 */
const HISTORY_SEGMENTS_MAX = 64;

/**
 * The session Resume here swapped away from: a full resume point plus the
 * tape position it paused at. Exactly one per game — taking control again
 * replaces it.
 */
export interface RetainedOriginal {
  boot: HistoryBoot;
  /** The departing session's tape position; null outside an open segment. */
  from: { segment: string; seq: number; tick: number } | null;
  retainedAt: number;
}

/** A player-placed mark on the recording. */
export interface HistoryBookmark {
  segment: string;
  seq: number;
  tick: number;
  label: string;
  at: number;
}

interface StoredHistory {
  format: "monotio.agi.history";
  version: 1;
  /** The record key: `history/<gameStorageKey>`. */
  projectId: string;
  recording: HistoryRecording;
  /** Committed batch numbers per segment id — the resend dedup. A set, not a
   *  high-water mark: a failed commit must not block its later resend. */
  committed: Record<string, number[]>;
  /** The one retained original (Resume here's departing session). */
  retained?: RetainedOriginal;
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
        while (recording.segments.length > HISTORY_SEGMENTS_MAX) {
          const dropped = recording.segments.shift()!;
          delete committed[dropped.id];
        }
      }
      segment.events.push(...batch.events);
      segment.marks.push(...batch.marks);
      segment.sync.push(...batch.sync);
      if (batch.anchor !== undefined) segment.anchors.push(batch.anchor);
      if (batch.end !== undefined) segment.end = batch.end;
      (committed[batch.segment] ??= []).push(batch.batch);
      await bodyTransaction("readwrite", (store) =>
        store.put({
          format: "monotio.agi.history",
          version: 1,
          projectId: key,
          recording,
          committed,
          // The adopted session's own boot batch commits right after a
          // Resume here — the retained original and the bookmarks must
          // survive every commit, not just the ones that set them.
          ...(stored?.retained !== undefined ? { retained: stored.retained } : {}),
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

/** Replace the retained-original slot — rc.11 keeps exactly one per game. */
export function saveRetainedOriginal(
  storageKey: string,
  retained: RetainedOriginal | null,
): Promise<void> {
  const key = `history/${storageKey}`;
  return serializeWrite(key, async () => {
    const stored = readStoredHistory(
      await bodyTransaction<unknown>("readonly", (store) => store.get(key)),
    );
    if (stored === null) return;
    const next = { ...stored };
    if (retained === null) delete next.retained;
    else next.retained = retained;
    await bodyTransaction("readwrite", (store) => store.put(next));
  });
}

/** The retained original, its boot validated; null when none is stored. */
export async function loadRetainedOriginal(storageKey: string): Promise<RetainedOriginal | null> {
  const stored = readStoredHistory(
    await bodyTransaction<unknown>("readonly", (store) => store.get(`history/${storageKey}`)),
  );
  const retained = stored?.retained;
  if (retained === undefined) return null;
  try {
    validateHistoryBoot(retained.boot);
  } catch {
    return null;
  }
  return retained;
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
