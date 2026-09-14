/**
 * Always-on history recording. Every accepted live boundary — input, host
 * answers, patches, pauses — lands in the open batch; batches post to the
 * host under bounded in-flight credit and the host persists them, then acks.
 * Anchors — taken on the autosave cadence, at every room entry and on
 * flush — carry a full resume point, so a segment replays offline from its
 * boot or from any anchor.
 *
 * Live randomness runs on the same LCG the replay drive uses (seeded per
 * boot, recorded into the segment's boot), so the recorded event stream
 * reproduces identically offline. A segment ends explicitly — boot,
 * walkthrough, quit, eject or budget — and a live session that outlives its
 * segment continues under a new one whose boot snapshots the current state.
 *
 * Pure functions of the worker context — importable under Node.
 */
import { bytesToBase64 } from "../bytes.ts";
import {
  HISTORY_BYTE_LIMIT,
  HISTORY_EVENT_LIMIT,
  HISTORY_INFLIGHT_MAX,
  HISTORY_SEGMENT_BYTE_LIMIT,
  HISTORY_SEGMENT_EVENT_LIMIT,
  computeSyncMark,
  type HistoryAnchor,
  type HistoryBatch,
  type HistoryBoot,
  type HistoryEndReason,
  type HistoryEventCause,
} from "../../../src/agent/history.ts";
import { resourceSetRevision } from "../../../src/agent/authoringState.ts";
import type { EdgeSide } from "../../../src/agent/roomMap.ts";
import type { BootMessage } from "../workerProtocol.ts";
import type { Inbound, WorkerContext } from "./context.ts";

/** One cheap divergence check per second of logic time, plus at every anchor. */
const SYNC_CYCLE_INTERVAL = 20;
/** Close the accumulating batch before a single post grows unwieldy. */
const BATCH_EVENT_MAX = 256;
const BATCH_BYTE_MAX = 256 * 1024;
/** Resend backoff for un-acked batches: starts short, doubles to a minute. */
const RESEND_MS = 4_000;
const RESEND_MAX_MS = 60_000;

/**
 * Clock/counter mix for session ids when the platform lacks crypto —
 * module-level so two fresh workers booting in the same millisecond still
 * mint distinct ids.
 */
let nonceCounter = 0;

export function createHistory(ctx: WorkerContext) {
  /** A live segment records; scratch replay traffic never does. */
  function live(): boolean {
    return ctx.history.segment !== null && ctx.replay.replay === null && ctx.engine !== null;
  }
  const tick = () => ctx.cycle.tickCount - ctx.history.tickBase;
  const cycle = () => ctx.cycle.cycleCount - ctx.history.cycleBase;

  /** resourceSetRevision of the live container — patches included. */
  function currentResourceSet(): string {
    const files = new Map(ctx.engine!.containerFiles);
    if (ctx.boot.authoredWords) files.set("WORDS.TOK", ctx.boot.authoredWords);
    return resourceSetRevision({ getFiles: () => files });
  }

  function bootFiles(): Record<string, string> {
    const files: Record<string, string> = {};
    for (const [name, bytes] of ctx.engine!.containerFiles) files[name] = bytesToBase64(bytes);
    return files;
  }

  /** Push one accepted boundary cause into the accumulating batch. */
  function historyRecord(cause: HistoryEventCause): void {
    if (!live()) return;
    const h = ctx.history;
    h.open.events.push({ seq: h.seq++, tick: tick(), cycle: cycle(), cause });
    h.openBytes += JSON.stringify(cause).length + 64;
    if (h.open.events.length >= BATCH_EVENT_MAX || h.openBytes >= BATCH_BYTE_MAX) closeBatch();
  }

  /**
   * A room transition the journal posted — history's map lane. Returns the
   * recorded position so the journal entry can carry it as its jump target.
   */
  function historyMark(
    to: number,
    via: string,
    edge?: EdgeSide,
  ): { segment: string; seq: number; tick: number } | null {
    if (!live()) return null;
    const h = ctx.history;
    const mark = {
      seq: h.seq,
      tick: tick(),
      cycle: cycle(),
      room: to,
      via,
      ...(edge !== undefined ? { edge } : {}),
    };
    h.open.marks.push(mark);
    h.openBytes += 64;
    return { segment: h.segment!, seq: mark.seq, tick: mark.tick };
  }

  function syncMark(): void {
    const h = ctx.history;
    h.open.sync.push(computeSyncMark(ctx.engine!, h.seq, tick(), cycle()));
    h.lastSyncCycle = ctx.cycle.cycleCount;
    h.openBytes += 96;
  }

  /**
   * Per-cycle boundary work: periodic sync marks, a pending resume, and the
   * segment rollover — a live segment ends with "budget" and continues under
   * a fresh one rather than growing the persisted segment without bound.
   */
  function historyBoundary(): void {
    maybeResume();
    if (!live()) return;
    const h = ctx.history;
    if (
      h.segmentBytes >= HISTORY_SEGMENT_BYTE_LIMIT ||
      h.segmentEvents >= HISTORY_SEGMENT_EVENT_LIMIT
    ) {
      historyEnd("budget");
      h.resumePending = true;
      maybeResume();
      return;
    }
    if (ctx.cycle.cycleCount - h.lastSyncCycle >= SYNC_CYCLE_INTERVAL) syncMark();
  }

  /**
   * Capture a full resume point and close the open batch with it. Refused at
   * the boundaries where the engine refuses a snapshot — a live host request
   * owns the answer, a text screen owns the surface, or no room has drawn —
   * and the next boundary retries.
   */
  function historyAnchor(reason: HistoryAnchor["reason"]): void {
    if (!live()) {
      maybeResume();
      return;
    }
    const engine = ctx.engine!;
    const image = engine.recordingImage();
    if (!image) return;
    const h = ctx.history;
    syncMark();
    closeBatch({
      anchor: {
        seq: h.seq,
        tick: tick(),
        cycle: cycle(),
        reason,
        image: bytesToBase64(image),
        replay: engine.captureReplayState(),
        inputQueue: [...ctx.input.keyQueue],
        directionQueue: [...ctx.input.deferredMovement],
        inputLines: [...ctx.input.inputBuffer],
        requestSerial: ctx.hostRequests.hostRequestSerial,
        rng: h.rng,
        soundDevice: ctx.boot.selectedSoundDevice,
        clock: ctx.clocks.cycle.snapshot(),
        resourceSet: currentResourceSet(),
        patchGeneration: engine.patchGeneration,
      },
    });
  }

  function closeBatch(extra?: {
    boot?: HistoryBoot;
    anchor?: HistoryAnchor;
    end?: { seq: number; tick: number; cycle: number; reason: HistoryEndReason };
  }): void {
    const h = ctx.history;
    const batch: HistoryBatch = {
      segment: h.segment ?? "",
      batch: ++h.batch,
      seqStart: h.open.events.length ? h.open.events[0]!.seq : h.seq,
      seqEnd: h.seq,
      events: h.open.events,
      marks: h.open.marks,
      sync: h.open.sync,
      ...(extra?.boot !== undefined ? { boot: extra.boot } : {}),
      ...(extra?.anchor !== undefined ? { anchor: extra.anchor } : {}),
      ...(extra?.end !== undefined ? { end: extra.end } : {}),
    };
    h.open = { events: [], marks: [], sync: [] };
    h.openBytes = 0;
    enqueue(batch);
  }

  function enqueue(batch: HistoryBatch): void {
    const h = ctx.history;
    const size = JSON.stringify(batch).length;
    h.queue.push({ batch, size });
    h.queuedBytes += size;
    h.queuedEvents += batch.events.length;
    h.segmentBytes += size;
    h.segmentEvents += batch.events.length;
    drain();
    if (h.queuedBytes > HISTORY_BYTE_LIMIT || h.queuedEvents > HISTORY_EVENT_LIMIT) overflow();
  }

  /**
   * The host stopped draining: rather than grow without bound, drop the
   * backlog and end the segment so its committed tail stays replayable. The
   * end marker's seq exposes the dropped tail as a gap in the stored stream.
   */
  function overflow(): void {
    const h = ctx.history;
    const segment = h.segment;
    h.queue.length = 0;
    h.queuedBytes = 0;
    h.queuedEvents = 0;
    h.open = { events: [], marks: [], sync: [] };
    h.openBytes = 0;
    h.segment = null;
    h.resumePending = true;
    if (segment === null || h.sent.length >= HISTORY_INFLIGHT_MAX) return;
    h.resumedFrom = { segment, seq: h.seq, tick: tick() };
    const batch: HistoryBatch = {
      segment,
      batch: ++h.batch,
      seqStart: h.seq,
      seqEnd: h.seq,
      events: [],
      marks: [],
      sync: [],
      end: { seq: h.seq, tick: tick(), cycle: cycle(), reason: "budget" },
    };
    h.sent.push(batch);
    ctx.ports.control({ type: "historyBatch", epoch: h.epoch, batch });
    armResend();
  }

  function post(batch: HistoryBatch): void {
    const h = ctx.history;
    h.sent.push(batch);
    ctx.ports.control({ type: "historyBatch", epoch: h.epoch, batch });
    armResend();
  }

  /** Resend the oldest un-acked batch, bypassing the new-batch credit. */
  function resend(): void {
    const h = ctx.history;
    if (h.sent.length > 0)
      ctx.ports.control({ type: "historyBatch", epoch: h.epoch, batch: h.sent[0]! });
  }

  /**
   * While batches sit un-acked, keep retrying on a backoff schedule — the
   * credit cap bounds NEW posts, never the recovery of ones already owed an
   * ack. Without this, four refused commits would stall the tape forever.
   */
  function armResend(): void {
    const h = ctx.history;
    if (h.resendTimer !== null || h.sent.length === 0) return;
    const schedule = ctx.ports.schedule;
    if (schedule === undefined) return;
    h.resendTimer = schedule(() => {
      h.resendTimer = null;
      if (h.sent.length === 0) {
        h.resendDelay = RESEND_MS;
        return;
      }
      resend();
      h.resendDelay = Math.min(h.resendDelay * 2, RESEND_MAX_MS);
      armResend();
    }, h.resendDelay);
  }

  function disarmResend(): void {
    const h = ctx.history;
    if (h.resendTimer === null) return;
    ctx.ports.cancelSchedule?.(h.resendTimer);
    h.resendTimer = null;
  }

  function drain(): void {
    const h = ctx.history;
    while (h.queue.length > 0 && h.sent.length < HISTORY_INFLIGHT_MAX) {
      const { batch, size } = h.queue.shift()!;
      h.queuedBytes -= size;
      h.queuedEvents -= batch.events.length;
      post(batch);
    }
    // Nothing new to post but the host left a batch un-acked — resend the
    // oldest. The host dedups by (segment, batch), so a slow commit and a
    // dropped one retry through the same path, even at full credit.
    if (h.queue.length === 0 && h.sent.length > 0) resend();
  }

  /** The host persisted one batch — free the credit and drain the backlog. */
  function onHistoryAck(msg: Inbound<"historyAck">): void {
    const h = ctx.history;
    if (msg.epoch !== h.epoch) return;
    const index = h.sent.findIndex((batch) => batch.batch === msg.batch);
    if (index < 0) return; // a stale or duplicate ack
    h.sent.splice(index, 1);
    h.resendDelay = RESEND_MS; // progress resets the backoff
    if (h.sent.length === 0) disarmResend();
    drain();
  }

  /**
   * The player's "retry" on the unsaved-history notice: repost the oldest
   * un-acked batch now and restart the backoff from its short delay.
   */
  function onHistoryRetry(): void {
    const h = ctx.history;
    h.resendDelay = RESEND_MS;
    disarmResend(); // rearm at the short delay, not the doubled one
    resend();
    armResend();
  }

  /**
   * End the open segment: the last batch carries the end marker so the
   * stored stream shows where and why the recording stopped.
   */
  function historyEnd(reason: HistoryEndReason): void {
    const h = ctx.history;
    if (h.segment === null) return;
    const segment = h.segment;
    h.resumedFrom = { segment, seq: h.seq, tick: tick() };
    h.open.events.push({
      seq: h.seq++,
      tick: tick(),
      cycle: cycle(),
      cause: { kind: "end", reason },
    });
    h.openBytes += 64;
    closeBatch({ end: { seq: h.seq, tick: tick(), cycle: cycle(), reason } });
    h.segment = null;
  }

  /**
   * The recording session's persisted identity. A fresh id per boot keeps
   * every session's segment ids unique across worker lifetimes — the
   * storage dedup sees retransmissions of one session, never two different
   * sessions colliding on `e1.s1`. crypto.getRandomValues supplies the
   * entropy; where the platform lacks it a clock-and-counter mix fills in —
   * not random, only a collision guard, since ids just have to be unique.
   */
  function sessionNonce(): string {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = crypto.getRandomValues(new Uint8Array(9));
      let hex = "";
      for (const b of bytes) hex += b.toString(16).padStart(2, "0");
      return hex;
    }
    nonceCounter = (nonceCounter + 1) & 0xffff;
    const mixed = (Date.now() & 0xffffffffff) * 0x10000 + nonceCounter;
    return mixed.toString(36).padStart(12, "0").slice(-12);
  }

  function newSessionId(): string {
    return `s${sessionNonce().slice(0, 12)}`;
  }

  /**
   * Boot starts a fresh epoch: any open segment ends, the stream resets, and
   * a live (non-seeded) boot begins a new segment with a full boot record.
   */
  function historyBoot(msg: BootMessage): void {
    const h = ctx.history;
    historyEnd("boot");
    disarmResend();
    h.epoch++;
    h.session = newSessionId();
    h.segmentSerial = 0;
    h.batch = 0;
    h.sent = [];
    h.queue = [];
    h.queuedBytes = 0;
    h.queuedEvents = 0;
    h.segmentBytes = 0;
    h.segmentEvents = 0;
    h.resendDelay = RESEND_MS;
    h.open = { events: [], marks: [], sync: [] };
    h.openBytes = 0;
    h.seq = 0;
    h.lastSyncCycle = 0;
    h.resumePending = false;
    h.resumedFrom = null;
    h.rng = (typeof msg.rngSeed === "number" ? msg.rngSeed : 1) >>> 0;
    if (ctx.replay.replay) return; // a seeded boot is a scratch replay session
    beginSegment({
      files: bootFiles(),
      dictionary: [...ctx.boot.liveDictionary.entries()],
      authorRooms: ctx.boot.authorRooms,
      rng: h.rng,
      soundDevice: ctx.boot.selectedSoundDevice,
      resourceSet: currentResourceSet(),
      requestSerial: ctx.hostRequests.hostRequestSerial,
      ...(typeof msg.restoreImage === "string" && msg.restoreImage
        ? { image: msg.restoreImage }
        : {}),
      ...(msg.restoreMenus !== undefined ? { menus: msg.restoreMenus } : {}),
    });
  }

  function beginSegment(boot: HistoryBoot): void {
    const h = ctx.history;
    h.segment = `${h.session}.s${++h.segmentSerial}`;
    h.seq = 0;
    h.tickBase = ctx.cycle.tickCount;
    h.cycleBase = ctx.cycle.cycleCount;
    h.lastSyncCycle = ctx.cycle.cycleCount;
    h.segmentBytes = 0;
    h.segmentEvents = 0;
    h.open = { events: [], marks: [], sync: [] };
    h.openBytes = 0;
    closeBatch({ boot });
  }

  /** A segment continues live play — after replay exit or a budget rollover. */
  function historyResume(): void {
    ctx.history.resumePending = true;
    maybeResume();
  }

  /**
   * A mid-play segment boot snapshots everything replay needs: the full file
   * set, the resumable image plus host replay state, queues, RNG, the cycle
   * clock accumulators and the resource-set identity.
   */
  function snapshotBoot(): HistoryBoot | null {
    const engine = ctx.engine;
    if (!engine) return null;
    const image = engine.recordingImage();
    if (!image) return null;
    const h = ctx.history;
    return {
      files: bootFiles(),
      dictionary: [...ctx.boot.liveDictionary.entries()],
      authorRooms: ctx.boot.authorRooms,
      image: bytesToBase64(image),
      replay: engine.captureReplayState(),
      menus: engine.readMenuState(),
      inputQueue: [...ctx.input.keyQueue],
      directionQueue: [...ctx.input.deferredMovement],
      inputLines: [...ctx.input.inputBuffer],
      // An adoption's clock sits in pendingClock until the host releases the
      // parked session — snapshot it so the segment's boot records the
      // adopted continuation, not the abandoned session's stale live clock.
      clock: ctx.cycle.pendingClock ?? ctx.clocks.cycle.snapshot(),
      rng: h.rng,
      soundDevice: ctx.boot.selectedSoundDevice,
      resourceSet: currentResourceSet(),
      requestSerial: ctx.hostRequests.hostRequestSerial,
      ...(h.resumedFrom !== null ? { resumedFrom: h.resumedFrom } : {}),
    };
  }

  function maybeResume(): void {
    const h = ctx.history;
    if (!h.resumePending || h.segment !== null || ctx.replay.replay || !ctx.engine) return;
    const boot = snapshotBoot();
    if (boot === null) return; // not a resumable boundary — the next one retries
    h.resumePending = false;
    beginSegment(boot);
  }

  /**
   * Seal the open batch — the page is going away or the session is parking.
   * The anchor the boundary allows rides with it so the stream's tail
   * replays from storage alone.
   */
  function historyFlush(reason: HistoryAnchor["reason"] = "flush"): void {
    if (!live()) return;
    historyAnchor(reason);
    const h = ctx.history;
    if (h.open.events.length || h.open.marks.length || h.open.sync.length) closeBatch();
  }

  return {
    historyBoot,
    historyRecord,
    historyMark,
    historyAnchor,
    historyBoundary,
    historyEnd,
    historyResume,
    historyFlush,
    historySnapshot: snapshotBoot,
    onHistoryAck,
    onHistoryRetry,
  };
}

export type HistoryModule = ReturnType<typeof createHistory>;
