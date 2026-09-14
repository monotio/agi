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
import { bodyTransaction, serializeWrite, updateBodyRecord } from "./gameStorage.ts";

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
  /**
   * Segment ids retention already dropped. A late batch for one — an end
   * marker that was in flight when its segment evicted — acks and drops:
   * refusing would pin the worker's resend on a segment that is gone on
   * purpose.
   */
  evicted?: string[];
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

/**
 * Drop segments while a bound is exceeded. Ended segments evict
 * oldest-first wherever they sit — an open segment ahead of them (a
 * crashed or still-writing session's tail) must not pin every later
 * segment past the bound. When only open segments remain over budget,
 * the oldest sheds too: a live tail is always the newest append, so the
 * newest open segment stays. Evicted ids are tombstoned so a late batch
 * for one acks-and-drops instead of pinning the sender's resend on a
 * segment that is gone on purpose.
 */
function evictSegments(
  recording: HistoryRecording,
  committed: Record<string, number[]>,
  bytes: Record<string, number>,
  evicted: string[],
): void {
  let total = Object.values(bytes).reduce((sum, n) => sum + n, 0);
  const over = () =>
    recording.segments.length > HISTORY_SEGMENTS_MAX || total > HISTORY_TOTAL_BYTE_LIMIT;
  while (recording.segments.length > 1 && over()) {
    const ended = recording.segments.findIndex((segment) => segment.end !== undefined);
    const dropped = recording.segments.splice(ended >= 0 ? ended : 0, 1)[0]!;
    delete committed[dropped.id];
    total -= bytes[dropped.id] ?? 0;
    delete bytes[dropped.id];
    evicted.push(dropped.id);
    if (evicted.length > HISTORY_SEGMENTS_MAX) evicted.shift();
    recording.dropped = (recording.dropped ?? 0) + 1;
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
  return serializeWrite(key, () => mergeHistoryBatch(key, batch, profile));
}

/**
 * The batch merge each tab runs: read-modify-write inside one read-write
 * transaction, so a second client's commit can never slip between the read
 * and the write and silently drop acknowledged history. Exported for the
 * two-client storage test, which interleaves two merge calls the way two
 * tabs would — each tab's own appendHistoryBatch mutex does not reach the
 * other tab, so the transaction is the only guard.
 */
export async function mergeHistoryBatch(
  key: string,
  batch: HistoryBatch,
  profile: string,
): Promise<boolean> {
  try {
    return await updateBodyRecord<boolean>(key, (raw) => {
      const stored = readStoredHistory(raw);
      const committed: Record<string, number[]> = { ...(stored?.committed ?? {}) };
      const ledger = (committed[batch.segment] ??= []);
      if (ledger.includes(batch.batch)) return { result: true }; // a resend of a committed batch
      const bytes: Record<string, number> = { ...(stored?.bytes ?? {}) };
      const recording: HistoryRecording = stored?.recording ?? {
        version: HISTORY_FORMAT_VERSION,
        profile,
        resourceSet: batch.boot?.resourceSet ?? "",
        startedAt: Date.now(),
        segments: [],
      };
      const evicted: string[] = [...(stored?.evicted ?? [])];
      let segment = recording.segments.find((s) => s.id === batch.segment);
      if (segment === undefined) {
        // A batch without its boot opens nothing — the worker's resend will
        // eventually deliver the boot batch that does. The one exception:
        // a segment retention already evicted is gone on purpose — its
        // stragglers ack-and-drop so the sender's resend does not pin on a
        // segment that can never come back.
        if (batch.boot === undefined) return { result: evicted.includes(batch.segment) };
        segment = {
          id: batch.segment,
          boot: batch.boot,
          anchors: [],
          events: [],
          marks: [],
          sync: [],
        };
        recording.segments.push(segment);
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
          // The abandoned numbers join the ledger: a resend of one dedups
          // to an ack instead of retrying a write the sender dropped.
          for (let b = last + 1; b < batch.batch; b++) ledger.push(b);
        } else if (batch.batch !== last + 1) return { result: false };
      }
      segment.events.push(...batch.events);
      segment.marks.push(...batch.marks);
      segment.sync.push(...batch.sync);
      if (batch.clock !== undefined) (segment.clock ??= []).push(...batch.clock);
      if (batch.anchor !== undefined) segment.anchors.push(batch.anchor);
      if (batch.end !== undefined) segment.end = batch.end;
      ledger.push(batch.batch);
      bytes[batch.segment] = (bytes[batch.segment] ?? 0) + JSON.stringify(batch).length;
      evictSegments(recording, committed, bytes, evicted);
      return {
        put: {
          format: "monotio.agi.history",
          version: 1,
          projectId: key,
          recording,
          committed,
          bytes,
          ...(evicted.length > 0 ? { evicted } : {}),
          // The adopted session's own boot batch commits right after a
          // Resume here — the retained original, the staged swap candidate
          // and the bookmarks must survive every commit, not just the ones
          // that set them.
          ...(stored?.retained !== undefined ? { retained: stored.retained } : {}),
          ...(stored?.staged !== undefined ? { staged: stored.staged } : {}),
          ...(stored?.bookmarks !== undefined ? { bookmarks: stored.bookmarks } : {}),
        } satisfies StoredHistory,
        result: true,
      };
    });
  } catch (error) {
    console.error("History commit failed:", error);
    return false;
  }
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
  const from = `history/${fromStorageKey}`;
  const to = `history/${toStorageKey}`;
  return serializeWrite(from, async () => {
    const stored = readStoredHistory(
      await bodyTransaction<unknown>("readonly", (store) => store.get(from)),
    );
    if (stored === null) return;
    await serializeWrite(to, () =>
      updateBodyRecord<void>(to, (raw) => {
        const existing = readStoredHistory(raw);
        if (existing === null) return { put: { ...stored, projectId: to }, result: undefined };
        // The destination already holds a tape — union rather than
        // overwrite: segments and commit ledgers merge by id so neither
        // record's acknowledged batches are lost.
        const ids = new Set(existing.recording.segments.map((segment) => segment.id));
        for (const segment of stored.recording.segments)
          if (!ids.has(segment.id)) existing.recording.segments.push(segment);
        for (const [segment, ledger] of Object.entries(stored.committed)) {
          const into = (existing.committed[segment] ??= []);
          for (const batch of ledger) if (!into.includes(batch)) into.push(batch);
        }
        for (const [segment, size] of Object.entries(stored.bytes ?? {})) {
          const into = (existing.bytes ??= {});
          if (into[segment] === undefined) into[segment] = size;
        }
        const evicted = new Set([...(existing.evicted ?? []), ...(stored.evicted ?? [])]);
        if (evicted.size > 0) existing.evicted = [...evicted];
        existing.recording.dropped =
          (existing.recording.dropped ?? 0) + (stored.recording.dropped ?? 0);
        return { put: existing, result: undefined };
      }),
    );
  });
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
  return serializeWrite(key, () =>
    updateBodyRecord<boolean>(key, (raw) => {
      const stored = readStoredHistory(raw);
      if (stored === null) return { result: true }; // no record yet — nothing to conflict with
      if (stored.staged !== undefined) return { result: false };
      return { put: { ...stored, staged }, result: true };
    }),
  );
}

/** The worker acknowledged the swap: the staged candidate becomes the retained original. */
export function commitStagedOriginal(storageKey: string): Promise<void> {
  const key = `history/${storageKey}`;
  return serializeWrite(key, () =>
    updateBodyRecord<void>(key, (raw) => {
      const stored = readStoredHistory(raw);
      if (stored === null || stored.staged === undefined) return { result: undefined };
      const next = { ...stored, retained: stored.staged };
      delete next.staged;
      return { put: next, result: undefined };
    }),
  );
}

/** The swap is settled and the staged copy is not needed — drop it. */
export function clearStagedOriginal(storageKey: string): Promise<void> {
  const key = `history/${storageKey}`;
  return serializeWrite(key, () =>
    updateBodyRecord<void>(key, (raw) => {
      const stored = readStoredHistory(raw);
      if (stored === null || stored.staged === undefined) return { result: undefined };
      const next = { ...stored };
      delete next.staged;
      return { put: next, result: undefined };
    }),
  );
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
  return serializeWrite(key, () =>
    updateBodyRecord<StagedSwapResolution>(key, (raw) => {
      const stored = readStoredHistory(raw);
      const staged = stored?.staged;
      if (stored === null || staged === undefined) return { result: "none" };
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
      if (!adopted && !continued) return { result: "ambiguous" };
      const next = { ...stored };
      if (adopted) next.retained = staged;
      delete next.staged;
      return { put: next, result: adopted ? "promoted" : "cleared" };
    }),
  );
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
  return serializeWrite(key, () =>
    updateBodyRecord<void>(key, (raw) => {
      const stored = readStoredHistory(raw);
      if (stored === null) return { result: undefined };
      const bookmarks = [...(stored.bookmarks ?? []), bookmark];
      if (bookmarks.length > 500) bookmarks.splice(0, bookmarks.length - 500);
      return { put: { ...stored, bookmarks }, result: undefined };
    }),
  );
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
