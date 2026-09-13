/**
 * The history transport's worker side: while the live session sits parked,
 * a scratch drive replays the recorded tape — seeks rebuild it from anchors,
 * advances step it forward, Resume here adopts the viewed moment as live,
 * and the departing session survives as the retained original Back to
 * before restores. The live engine must come through a whole viewing
 * session byte-identical: the scratch never touches it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GameContainer } from "../../src/types.ts";
import {
  HISTORY_FORMAT_VERSION,
  historySyncDigest,
  type HistoryBatch,
  type HistoryRecording,
  type HistorySegment,
} from "../../src/agent/history.ts";
import { gameContainer } from "./worker-ctx.ts";
import {
  createWorkerContext,
  type WorkerContext,
  type WorkerPorts,
} from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type {
  BootMessage,
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
} from "../src/workerProtocol.ts";

const PICTURE_1 = new Uint8Array([
  0xf0, 0x01, 0xf6, 10, 10, 60, 10, 60, 40, 10, 40, 10, 10, 0xf8, 30, 20, 0xf1, 0xf2, 0x05, 0xf6, 0,
  150, 159, 150, 0xf3, 0xff,
]);

/**
 * logic 0: f200 edges to room 2 with a score gain, f202 rolls the LCG, f216
 * opens the parser input line. Each room logic draws its picture so the
 * tape's anchors and snapshots exist.
 */
function viewGame(): GameContainer {
  return gameContainer(
    [
      `if (isset(f6)) { reset(f6); new.room(1); }
       if (isset(f200)) { reset(f200); assignn(v3, 5); new.room(2); }
       if (isset(f202)) { reset(f202); random(1, 250, v60); }
       if (isset(f216)) { reset(f216); accept.input(); }
       if (v0 > 0) { call.v(v0); }
       return;`,
      `if (isset(f5)) { assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic(); } return;`,
      `if (isset(f5)) { assignn(v50, 2); load.pic(v50); draw.pic(v50); show.pic(); } return;`,
    ],
    (c) => {
      c.putResource("picture", 1, PICTURE_1);
      c.putResource("picture", 2, PICTURE_1);
    },
  );
}

interface ViewHarness {
  ctx: WorkerContext;
  control: WorkerControl[];
  presentation: WorkerPresentation[];
  send(msg: WorkerInbound): void;
  tick(n?: number): void;
}

function viewHarness(container: GameContainer, boot?: Partial<BootMessage>): ViewHarness {
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  let now = 0;
  const ports: WorkerPorts = {
    control: (message) => control.push(message),
    presentation: (message) => presentation.push(message),
    now: () => now,
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);
  // The host commits each batch and acks it; resent duplicates get acked
  // again — that is how the worker's resend converges. Track messages by
  // cursor, not batch number, so a reposted batch is answered every time.
  let ackCursor = 0;
  const ackAll = (): void => {
    while (ackCursor < control.length) {
      const message = control[ackCursor++]!;
      if (message.type === "historyBatch")
        onWorkerMessage(ctx, {
          type: "historyAck",
          epoch: message.epoch,
          batch: message.batch.batch,
        });
    }
  };
  const send = (msg: WorkerInbound): void => {
    onWorkerMessage(ctx, msg);
    ackAll();
  };
  send({ type: "boot", files: Object.fromEntries(container.files), words: [], ...boot });
  ctx.fns.stopTimers();
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
    ackAll();
  };
  return { ctx, control, presentation, send, tick };
}

/**
 * Fold the posted historyBatch traffic into per-segment records, deduped by
 * batch number — the resend path reposts un-acked batches and the host
 * filters the duplicates the same way.
 */
function collectSegments(control: WorkerControl[]): HistorySegment[] {
  const segments = new Map<string, HistorySegment>();
  const seen = new Set<string>();
  for (const message of control) {
    if (message.type !== "historyBatch") continue;
    const batch: HistoryBatch = message.batch;
    const key = `${batch.segment}:${batch.batch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let segment = segments.get(batch.segment);
    if (segment === undefined) {
      assert.ok(batch.boot !== undefined, `segment ${batch.segment} opens with a boot batch`);
      segment = {
        id: batch.segment,
        boot: batch.boot,
        anchors: [],
        events: [],
        marks: [],
        sync: [],
      };
      segments.set(batch.segment, segment);
    }
    segment.events.push(...batch.events);
    segment.marks.push(...batch.marks);
    segment.sync.push(...batch.sync);
    if (batch.anchor !== undefined) segment.anchors.push(batch.anchor);
    if (batch.end !== undefined) segment.end = batch.end;
  }
  return [...segments.values()];
}

function asRecording(segments: HistorySegment[]): HistoryRecording {
  const first = segments[0]!;
  return {
    version: HISTORY_FORMAT_VERSION,
    profile: "2.936",
    resourceSet: first.boot.resourceSet,
    startedAt: 0,
    segments,
  };
}

/** The terminal report for a request id (progress posts share it). */
function finalView(control: WorkerControl[], id: number) {
  const reports = control.filter(
    (m): m is Extract<WorkerControl, { type: "historyView" }> =>
      m.type === "historyView" && m.id === id,
  );
  const last = reports.at(-1);
  assert.ok(last, `request ${id} produced no report`);
  assert.equal(last.final, true, "the last report for a request is terminal");
  return last;
}

/**
 * A recorded session parked mid-play: room 2 entered (drawn, anchored), an
 * LCG roll, some ticks. Returns the harness plus the tape the host would
 * have persisted.
 */
function playedSession(): { h: ViewHarness; recording: HistoryRecording; lastTick: number } {
  const h = viewHarness(viewGame(), { rngSeed: 0xbeef });
  const { send, tick } = h;
  tick(4);
  send({ type: "debugWrite", id: 0, flags: [[216, 1]] });
  tick(2);
  send({ type: "input", text: "look" });
  tick(2);
  send({ type: "debugWrite", id: 1, flags: [[200, 1]] });
  tick(5);
  send({ type: "debugWrite", id: 2, flags: [[202, 1]] });
  tick(4);
  // Opening the transport pauses live; the pause seals the recorded tail.
  send({ type: "pause", paused: true });
  const segments = collectSegments(h.control);
  const segment = segments[0]!;
  const lastTick = Math.max(
    ...segment.events.map((e) => e.tick),
    ...segment.sync.map((s) => s.tick),
    segment.end?.tick ?? 0,
  );
  return { h, recording: asRecording(segments), lastTick };
}

test("viewing the tape replays it in a scratch session the live engine never feels", () => {
  const { h, recording, lastTick } = playedSession();
  const { ctx, send, tick } = h;

  const liveDigest = historySyncDigest(ctx.engine!);
  const liveTicks = ctx.cycle.tickCount;
  const liveCycles = ctx.cycle.cycleCount;

  send({ type: "historyViewStart", id: 1, recording, segment: 0, tick: lastTick });
  const opened = finalView(h.control, 1);
  assert.equal(opened.error, null);
  assert.equal(opened.tick, lastTick, "the view lands at the recorded end");
  assert.equal(opened.room, 2, "the tape's final room shows");
  assert.equal(opened.canResume, true, "a drawn-room position is resumable");

  // Scrub back: the drive rebuilds from an earlier anchor and reports the
  // older position — the tape's own clock, not wall time.
  const firstMark = recording.segments[0]!.marks[1]!; // the room-2 entry
  send({ type: "historyViewSeek", id: 2, segment: 0, tick: firstMark.tick });
  const sought = finalView(h.control, 2);
  assert.equal(sought.tick, firstMark.tick);
  assert.equal(sought.room, 2);

  // Watch steps: advance a few recorded ticks.
  send({ type: "historyViewAdvance", id: 3, ticks: 4 });
  const advanced = finalView(h.control, 3);
  assert.equal(advanced.tick, Math.min(firstMark.tick + 4, lastTick));

  // Player input while viewing is transport traffic, never engine input:
  // neither the scratch's stream nor the parked engine's queues move.
  const queueDepth = ctx.input.keyQueue.length;
  send({ type: "key", code: 65 });
  send({ type: "input", text: "jump" });
  send({ type: "direction", dir: 8 });
  assert.equal(ctx.input.keyQueue.length, queueDepth, "the parked engine heard nothing");

  // The live engine sat through the whole session untouched.
  assert.equal(historySyncDigest(ctx.engine!), liveDigest, "the parked engine never moved");
  assert.equal(ctx.cycle.tickCount, liveTicks, "the live tick axis is the wall clock's");
  assert.equal(ctx.cycle.cycleCount, liveCycles);
  assert.equal(ctx.cycle.paused, true, "the live session stays parked");

  send({ type: "historyViewEnd" });
  assert.equal(ctx.view.recording, null);
  assert.equal(ctx.view.drive, null);

  // Back to live: the parked session resumes and ticks again.
  send({ type: "pause", paused: false });
  tick(3);
  assert.ok(ctx.cycle.cycleCount > liveCycles, "the live session resumed");
});

test("Resume here adopts the viewed moment; Back to before restores the original", () => {
  const { h, recording, lastTick } = playedSession();
  const { ctx, send, tick } = h;

  const liveDigest = historySyncDigest(ctx.engine!);
  const liveSegment = ctx.history.segment!;

  // View the moment just before the LCG roll — a resumable boundary in a
  // drawn room (the f202 write is the stream's last debugWrite).
  const rollEvent = recording.segments[0]!.events.find(
    (e) => e.cause.kind === "debugWrite" && e.cause.flags?.some(([n]) => n === 202),
  );
  assert.ok(rollEvent, "the recorded stream carries the roll's boundary");
  const midTick = Math.max(0, rollEvent.tick - 1);
  send({ type: "historyViewStart", id: 1, recording, segment: 0, tick: midTick });
  const opened = finalView(h.control, 1);
  assert.equal(opened.error, null);
  assert.equal(opened.tick, midTick);
  assert.equal(opened.canResume, true);
  const viewedSeq = opened.seq;

  // Keep the departing session as the retained original first.
  send({ type: "historyRetain", id: 2 });
  const retained = h.control.find(
    (m): m is Extract<WorkerControl, { type: "historyRetained" }> =>
      m.type === "historyRetained" && m.id === 2,
  );
  assert.ok(retained && retained.boot !== null, "the parked session is resumable");
  assert.deepEqual(retained.from, {
    segment: liveSegment,
    seq: ctx.history.seq,
    tick: lastTick,
  });

  // Take: the viewed moment becomes the live session, parked for the host.
  send({ type: "historyViewTake", id: 3 });
  const taken = h.control.find(
    (m): m is Extract<WorkerControl, { type: "historyTaken" }> =>
      m.type === "historyTaken" && m.id === 3,
  );
  assert.ok(taken && taken.ok, "the take succeeded");
  assert.equal(ctx.cycle.paused, true, "the adopted session waits for the host's release");

  // The adopted engine is the viewed one: pre-roll state, same room.
  const adopted = h.ctx.engine!;
  assert.equal(adopted.vars[0], 2);
  const rolledLive = playedRoll(ctx);
  void rolledLive;

  // The new segment's boot carries the provenance of the take.
  const segments = collectSegments(h.control);
  const branch = segments.at(-1)!;
  assert.notEqual(branch.id, liveSegment, "the take opened a new segment");
  assert.deepEqual(branch.boot.resumedFrom, {
    segment: recording.segments[0]!.id,
    seq: viewedSeq,
    tick: midTick,
  });

  // The adopted session actually runs once the host releases the pause.
  send({ type: "pause", paused: false });
  tick(3);
  assert.ok(ctx.cycle.cycleCount > 0, "the adopted session ticks");

  // Back to before: the retained original swaps back in, parked again.
  send({ type: "historyViewRestore", id: 4, boot: retained.boot, from: retained.from });
  const restored = h.control.find(
    (m): m is Extract<WorkerControl, { type: "historyViewRestored" }> =>
      m.type === "historyViewRestored" && m.id === 4,
  );
  assert.ok(restored && restored.ok, "the restore succeeded");
  assert.equal(
    historySyncDigest(ctx.engine!),
    liveDigest,
    "the original session is back byte-identical",
  );
  send({ type: "pause", paused: false });
  tick(3);
  assert.equal(historySyncDigest(ctx.engine!), liveDigest);
});

/** Read v60 — the LCG roll's landing spot. */
function playedRoll(ctx: WorkerContext): number {
  return ctx.engine!.vars[60]!;
}

test("a corrupted tape reports divergence instead of a position", () => {
  const { h, recording, lastTick } = playedSession();
  const { send } = h;

  // Tamper the room-2 transition: f200 becomes an unused flag, so the tape
  // never leaves room 0 — the room-2 anchor's sync mark cannot hold.
  const tampered = JSON.parse(JSON.stringify(recording)) as HistoryRecording;
  const edge = tampered.segments[0]!.events.find(
    (e) => e.cause.kind === "debugWrite" && e.cause.flags?.some(([n]) => n === 200),
  );
  assert.ok(edge && edge.cause.kind === "debugWrite");
  edge.cause.flags = [[205, 1]];

  // View just before the room-2 anchor: the drive rebuilds from the earlier
  // anchor — starting past it would restore its trusted image and hide the
  // corruption, as designed. Advancing through the transition's position
  // replays the tampered event, and its sync mark cannot hold.
  const edgeAnchor = tampered.segments[0]!.anchors.find((a) => a.reason === "room")!;
  send({
    type: "historyViewStart",
    id: 1,
    recording: tampered,
    segment: 0,
    tick: Math.max(0, edgeAnchor.tick - 1),
  });
  const landed = finalView(h.control, 1);
  assert.equal(landed.error, null);
  assert.equal(landed.diverged, null, "not yet across the mark");
  send({ type: "historyViewAdvance", id: 2, ticks: lastTick });
  const report = finalView(h.control, 2);
  assert.equal(report.error, null);
  assert.ok(report.diverged !== null, "the tampered stream cannot pass its sync marks");
});

test("a seek to an unwatched segment's open tail stops at the stream's end", () => {
  const { h, recording, lastTick } = playedSession();
  const { send } = h;

  send({ type: "historyViewStart", id: 1, recording, segment: 0, tick: lastTick });
  assert.equal(finalView(h.control, 1).tick, lastTick);

  // Asking past the recorded end lands on the tail, never past it.
  send({ type: "historyViewSeek", id: 2, segment: 0, tick: lastTick + 500 });
  const report = finalView(h.control, 2);
  assert.equal(report.tick, lastTick, "the drive halts where the tape ends");
});

test("viewing before any room draws reports the moment as non-resumable", () => {
  const h = viewHarness(viewGame(), { rngSeed: 9 });
  const { send, tick } = h;
  tick(3);
  send({ type: "pause", paused: true });
  const recording = asRecording(collectSegments(h.control));

  send({ type: "historyViewStart", id: 1, recording, segment: 0, tick: 1 });
  const report = finalView(h.control, 1);
  assert.equal(report.error, null);
  // Room 0 drew no picture: the engine cannot snapshot, so Resume here stays off.
  assert.equal(report.canResume, false);
});
