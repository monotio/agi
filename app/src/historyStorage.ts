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
): Promise<boolean> {
  const key = `history/${storageKey}`;
  return serializeWrite(key, async () => {
    try {
      const stored = readStoredHistory(
        await bodyTransaction<unknown>("readonly", (store) => store.get(key)),
      );
      const committed: Record<string, number[]> = { ...(stored?.committed ?? {}) };
      const ledger = (committed[batch.segment] ??= []);
      if (ledger.includes(batch.batch)) return true; // a resend of a committed batch
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
      } else if (
        batch.batch !== (ledger[ledger.length - 1] ?? 0) + 1 &&
        !(batch.end !== undefined && batch.batch > (ledger[ledger.length - 1] ?? 0))
      ) {
        // A segment's batches are one consecutive run of the session's
        // counter: only the next number extends it. Refusing keeps the
        // stream a contiguous verified prefix — the missing batch's resend
        // lands first, then this one retries. The one legal jump is a
        // batch carrying the segment's end: the worker's queue overflow
        // drops unsent middle batches, so its closing batch can never be
        // reached by the consecutive rule. Its seq gap marks the loss.
        return false;
      }
      segment.events.push(...batch.events);
      segment.marks.push(...batch.marks);
      segment.sync.push(...batch.sync);
      if (batch.anchor !== undefined) segment.anchors.push(batch.anchor);
      if (batch.end !== undefined) segment.end = batch.end;
      ledger.push(batch.batch);
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
 * False when a staged candidate is already pending: overlapping swaps must
 * settle it (resolveStagedSwap, then finish or release) rather than
 * overwrite the recovery copy.
 */
export function stageRetainedOriginal(
  storageKey: string,
  staged: RetainedOriginal,
): Promise<boolean> {
  const key = `history/${storageKey}`;
  return serializeWrite(key, async () => {
    const stored = readStoredHistory(
      await bodyTransaction<unknown>("readonly", (store) => store.get(key)),
    );
    if (stored === null) return true; // no record yet — nothing to conflict with
    if (stored.staged !== undefined) return false;
    await bodyTransaction("readwrite", (store) => store.put({ ...stored, staged }));
    return true;
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

export type StagedSwapResolution = "none" | "promoted" | "cleared" | "ambiguous";

/**
 * Settle a staged candidate left behind by an interrupted swap. The tape is
 * the witness: only adoption stamps the departing segment's "resume" end,
 * so a staged copy with that marker is owed the retained slot (the worker
 * adopted; only the promotion write failed). One whose session plainly went
 * on — a non-resume end, a later segment continuing it, or the very
 * segment still being the tape's live tail — is a redundant snapshot. When
 * the tape proves neither (the segment is absent or open under a session
 * that can no longer be identified) the candidate stays for the player's
 * explicit keep/release — both candidates remain durable until then.
 *
 * `liveSegment` is the worker's current segment when the caller just asked
 * (resumeHere/backToBefore). It is decisive in both directions: a staged
 * candidate whose departing segment is still live was never adopted; one
 * whose segment the worker has left was. Without it the tape alone cannot
 * prove an open segment dead — its "resume" end may be the very write that
 * failed — so that case stays ambiguous rather than risk the only durable
 * copy of a departed session.
 */
export function resolveStagedSwap(
  storageKey: string,
  recording: HistoryRecording | null,
  liveSegment?: string | null,
): Promise<StagedSwapResolution> {
  const key = `history/${storageKey}`;
  return serializeWrite(key, async () => {
    const stored = readStoredHistory(
      await bodyTransaction<unknown>("readonly", (store) => store.get(key)),
    );
    const staged = stored?.staged;
    if (stored === null || staged === undefined) return "none";
    const from = staged.from ?? undefined;
    const departing = recording?.segments.find((s) => s.id === from?.segment);
    let adopted: boolean;
    let continued: boolean;
    if (departing?.end !== undefined) {
      // The departing segment's end is decisive on its own: only adoption
      // stamps "resume"; any other end means the session went on to die
      // naturally and the staged snapshot is redundant.
      adopted = departing.end.reason === "resume";
      continued = !adopted;
    } else {
      // Only an adopted session boots a segment resuming from an EARLIER
      // tick of the departing one (a take of its own tape); a continuation
      // resumes at-or-after the staged tick. The caller's live-segment
      // hint is decisive in both directions when the tape is silent.
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
    if (!adopted && !continued) return "ambiguous";
    const next = { ...stored };
    if (adopted) next.retained = staged;
    delete next.staged;
    await bodyTransaction("readwrite", (store) => store.put(next));
    return adopted ? "promoted" : "cleared";
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
