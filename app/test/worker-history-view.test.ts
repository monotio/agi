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
  historyBootSemantic,
  historyFingerprint,
  historySyncDigest,
  type HistoryAnchor,
  type HistoryBatch,
  type HistoryRecording,
  type HistorySegment,
} from "../../src/agent/history.ts";
import { gameContainer } from "./worker-ctx.ts";
import {
  decodeHostImage,
  decodeSave,
  encodeHostImage,
  encodeSave,
} from "../../src/runtime/persistence.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { base64ToBytes, bytesToBase64 } from "../src/bytes.ts";
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

function viewHarness(
  container: GameContainer,
  boot?: Partial<BootMessage>,
  opts?: { gated?: boolean },
): ViewHarness {
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  let now = 0;
  const ctx = createWorkerContext({
    control: (message) => control.push(message),
    presentation: (message) => {
      // The real worker drops presentation while a seek is in flight —
      // without the gate the fake port sees frames a browser never would.
      if (opts?.gated && ctx.replay.isSeeking) return;
      presentation.push(message);
    },
    now: () => now,
  } satisfies WorkerPorts);
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
    if (batch.clock !== undefined) (segment.clock ??= []).push(...batch.clock);
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
  send({
    type: "historyViewTake",
    id: 3,
    segment: 0,
    tick: midTick,
    seq: viewedSeq,
    generation: opened.generation,
  });
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

test("the adopted session resumes the recorded PRNG and cycle clock", () => {
  const { h, recording } = playedSession();
  const { ctx, send, tick } = h;

  const recordedRoll = ctx.engine!.vars[60]!;
  assert.ok(recordedRoll >= 1 && recordedRoll <= 250);
  const abandonedRng = ctx.history.rng; // the live session's post-roll state

  // View the moment just before the recorded roll.
  const rollEvent = recording.segments[0]!.events.find(
    (e) => e.cause.kind === "debugWrite" && e.cause.flags?.some(([n]) => n === 202),
  )!;
  const midTick = Math.max(0, rollEvent.tick - 1);
  send({ type: "historyViewStart", id: 1, recording, segment: 0, tick: midTick });
  const opened = finalView(h.control, 1);
  assert.equal(opened.canResume, true);

  send({ type: "historyRetain", id: 2 });
  const retained = h.control.find(
    (m): m is Extract<WorkerControl, { type: "historyRetained" }> =>
      m.type === "historyRetained" && m.id === 2,
  );
  assert.ok(retained && retained.boot !== null);
  assert.equal(retained.boot.rng, abandonedRng, "the retained boot carries the abandoned rng");

  // The scratch's clock at the viewed position — the take must carry it,
  // not the abandoned session's stale live clock.
  const viewedClock = ctx.view.drive!.ctx.clocks.cycle.snapshot();

  send({
    type: "historyViewTake",
    id: 3,
    segment: 0,
    tick: midTick,
    seq: opened.seq,
    generation: opened.generation,
  });
  const taken = h.control.find(
    (m): m is Extract<WorkerControl, { type: "historyTaken" }> =>
      m.type === "historyTaken" && m.id === 3,
  );
  assert.ok(taken && taken.ok);

  const branch = collectSegments(h.control).at(-1)!;
  // The live PRNG is the viewed position's — not the abandoned future's.
  assert.equal(ctx.history.rng, branch.boot.rng);
  assert.notEqual(ctx.history.rng, abandonedRng);
  // The branch segment's boot records the adopted clock — the abandoned
  // session's live clock was still ticking when it was stamped.
  assert.deepEqual(branch.boot.clock, viewedClock);

  // The recorded clock waits out the parked interval: restoring it at adopt
  // time would have the first parked poll discard its accumulators.
  assert.deepEqual(ctx.cycle.pendingClock, viewedClock);
  tick(2);
  assert.ok(ctx.cycle.pendingClock !== null, "parked polls never touched it");

  send({ type: "pause", paused: false });
  const clock = ctx.clocks.cycle.snapshot();
  assert.equal(clock.remainder, viewedClock.remainder);
  assert.equal(clock.increments, viewedClock.increments);
  assert.equal(clock.paused, false);
  assert.equal(ctx.cycle.pendingClock, null);

  // The LCG continues from the recorded state — the same boundary rolls the
  // value the tape recorded, not whatever the abandoned future held.
  send({ type: "debugWrite", id: 9, flags: [[202, 1]] });
  tick(3);
  assert.equal(ctx.engine!.vars[60], recordedRoll, "the roll resumes the recorded rng");

  // Back to before with a recorded clock: the same deferral lands it on the
  // release — the parked polls in between must not consume it first.
  const patched = {
    ...retained.boot,
    clock: { remainder: 30, increments: 4, paused: false },
  };
  // The changed record is a new claim — re-stamp its fingerprint as the
  // recorder would.
  patched.fingerprint = historyFingerprint(historyBootSemantic(patched));
  send({ type: "pause", paused: true });
  send({ type: "historyViewRestore", id: 4, boot: patched, from: retained.from });
  const restored = h.control.find(
    (m): m is Extract<WorkerControl, { type: "historyViewRestored" }> =>
      m.type === "historyViewRestored" && m.id === 4,
  );
  assert.ok(restored && restored.ok);
  assert.deepEqual(ctx.cycle.pendingClock, patched.clock);
  assert.equal(ctx.history.rng, retained.boot.rng, "the parked session's rng is back");
  tick(2);
  assert.deepEqual(ctx.cycle.pendingClock, patched.clock, "still pending through parked polls");
  send({ type: "pause", paused: false });
  assert.equal(ctx.clocks.cycle.snapshot().increments, 4);
  assert.equal(ctx.clocks.cycle.snapshot().remainder, 30);
});

/** Read v60 — the LCG roll's landing spot. */
function playedRoll(ctx: WorkerContext): number {
  return ctx.engine!.vars[60]!;
}

test("a seek republishes the landing frame a dropped mid-seek frame matched", () => {
  // The gated port drops scratch frames in transit exactly like the real
  // worker's sendPresentation does while a seek is in flight.
  const h = viewHarness(viewGame(), { rngSeed: 0xbeef }, { gated: true });
  const { send, tick } = h;
  tick(4);
  send({ type: "debugWrite", id: 0, flags: [[216, 1]] }); // arm parser input
  tick(2);
  send({ type: "edit", text: "look" });
  tick(3);
  send({ type: "pause", paused: true });
  const recording = asRecording(collectSegments(h.control));
  const editEvent = recording.segments[0]!.events.find((e) => e.cause.kind === "edit");
  assert.ok(editEvent, "the tape carries the typed edit");

  // View just before the typing — the surface shows an empty input line.
  const beforeTick = Math.max(0, editEvent.tick - 1);
  send({ type: "historyViewStart", id: 1, recording, segment: 0, tick: beforeTick });
  assert.equal(finalView(h.control, 1).error, null);
  const frameBefore = h.presentation.at(-1);
  assert.ok(frameBefore?.type === "frame" && frameBefore.edit === "");

  // Scrub forward across the typed command. Mid-seek the edit applies and
  // the scratch postFrame computes the landing frame — the transit gate
  // drops it. The landing frame is identical, so unless the scratch's own
  // gate kept the cache unpolluted the terminal postFrame judges it "same"
  // and posts nothing: the screen would keep the pre-seek frame while the
  // readout says the position moved.
  send({ type: "historyViewSeek", id: 2, segment: 0, tick: editEvent.tick + 2 });
  assert.equal(finalView(h.control, 2).error, null);
  const frameAfter = h.presentation.at(-1);
  assert.ok(frameAfter?.type === "frame", "the landing position must post a frame");
  assert.equal(
    frameAfter.edit,
    "look",
    "the frame at the landing position shows the typed command",
  );
});

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

  // The unverified position cannot be taken worker-side either — a take
  // naming it is refused even with the view's own generation.
  send({
    type: "historyViewTake",
    id: 3,
    segment: 0,
    tick: report.tick,
    seq: report.seq,
    generation: report.generation,
  });
  const refused = h.control.find(
    (m): m is Extract<WorkerControl, { type: "historyTaken" }> =>
      m.type === "historyTaken" && m.id === 3,
  );
  assert.equal(refused?.ok, false);
  assert.match(refused?.message ?? "", /diverged/);
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
  // And the worker refuses a take naming it anyway — eligibility is
  // enforced at the take, not only by the transport's disabled button.
  send({
    type: "historyViewTake",
    id: 2,
    segment: 0,
    tick: report.tick,
    seq: report.seq,
    generation: report.generation,
  });
  const refused = h.control.find(
    (m): m is Extract<WorkerControl, { type: "historyTaken" }> =>
      m.type === "historyTaken" && m.id === 2,
  );
  assert.equal(refused?.ok, false);
  assert.match(refused?.message ?? "", /resumable boundary/);
});

test("a failed start leaves no half-open session behind", () => {
  const { h, recording } = playedSession();
  const { ctx, send } = h;

  // A start naming a segment the tape does not have fails cleanly.
  send({ type: "historyViewStart", id: 1, recording, segment: 9, tick: 0 });
  const refused = finalView(h.control, 1);
  assert.ok(refused.error !== null);
  assert.equal(ctx.view.recording, null, "no recording stays mounted");
  assert.equal(ctx.view.drive, null, "no drive stays mounted");
  assert.equal(ctx.replay.isSeeking, false, "the frame gate released");

  // The live engine still owns the surface: its commands still run.
  const liveTicks = ctx.cycle.tickCount;
  send({ type: "historyViewSeek", id: 2, segment: 0, tick: 1 });
  const orphan = finalView(h.control, 2);
  assert.match(orphan.error ?? "", /no history view session/);
  send({ type: "pause", paused: false });
  h.tick(2);
  assert.ok(ctx.cycle.tickCount > liveTicks, "the live engine resumed normally");
});

test("a start whose anchor mismatches the folded stream reports the error and cleans up", () => {
  const { h, recording, lastTick } = playedSession();
  const { ctx, send } = h;

  // Tamper the anchor the seek selects (the last at-or-before the target):
  // the drive cannot trust it — the open reports the structural failure
  // instead of parking a dead session.
  const tampered = JSON.parse(JSON.stringify(recording)) as HistoryRecording;
  const anchor = tampered.segments[0]!.anchors.at(-1);
  assert.ok(anchor, "the session recorded an anchor to corrupt");
  anchor.resourceSet = "bogus-revision";

  send({ type: "historyViewStart", id: 1, recording: tampered, segment: 0, tick: lastTick });
  const report = finalView(h.control, 1);
  assert.match(report.error ?? "", /resource set/);
  assert.equal(ctx.view.recording, null, "the failed open mounted nothing");
  assert.equal(ctx.view.drive, null);
  assert.equal(ctx.replay.isSeeking, false);

  // A good start still works afterwards — the failed open poisoned nothing.
  send({ type: "historyViewStart", id: 2, recording, segment: 0, tick: lastTick });
  const opened = finalView(h.control, 2);
  assert.equal(opened.error, null);
  assert.equal(opened.tick, lastTick);
  send({ type: "historyViewEnd" });
});

test("a take carries the authoring checkpoint belonging to the adopted position", () => {
  const h = viewHarness(viewGame(), { rngSeed: 0xbeef });
  const { send, tick } = h;
  tick(4);
  send({ type: "debugWrite", id: 0, flags: [[216, 1]] });
  tick(2);
  send({ type: "input", text: "look" });
  tick(2);
  send({ type: "debugWrite", id: 1, flags: [[200, 1]] });
  tick(5); // room 2 drew — resumable from here on
  send({ type: "authoring", snapshot: { plan: "first commit" } });
  tick(2);
  send({ type: "authoring", snapshot: { plan: "second commit" } });
  tick(2);
  // A commit whose checkpoint never reached the tape: the patch lands with
  // no authoring event after it.
  send({ type: "patch", kind: "picture", num: 2, payload: PICTURE_1 });
  tick(2);
  send({ type: "pause", paused: true });
  const recording = asRecording(collectSegments(h.control));
  const checkpoints = recording.segments[0]!.events.filter((e) => e.cause.kind === "authoring");
  assert.equal(checkpoints.length, 2, "both commits landed on the tape");
  const takeAt = (id: number, tick: number) => {
    send({ type: "historyViewStart", id, recording, segment: 0, tick });
    const opened = finalView(h.control, id);
    assert.equal(opened.error, null);
    assert.equal(opened.canResume, true, `tick ${tick} is a resumable boundary`);
    send({
      type: "historyViewTake",
      id: id + 100,
      segment: 0,
      tick,
      seq: opened.seq,
      generation: opened.generation,
    });
    const taken = h.control.find(
      (m): m is Extract<WorkerControl, { type: "historyTaken" }> =>
        m.type === "historyTaken" && m.id === id + 100,
    );
    assert.ok(taken && taken.ok, `take refused: ${JSON.stringify(taken)}`);
    return taken;
  };

  // At the last commit's position the adopted state is the one it produced —
  // and the reply's boot names the adopted revision for the host to verify.
  const latest = takeAt(1, checkpoints[1]!.tick);
  assert.deepEqual(latest.session, { plan: "second commit" });
  assert.equal(
    latest.boot?.resourceSet,
    recording.segments[0]!.boot.resourceSet,
    "the reply's boot names the adopted revision",
  );

  // One tick earlier the second commit is still in the future: the position
  // adopts the first commit's state, not the newest on the tape.
  const middle = takeAt(2, checkpoints[1]!.tick - 1);
  assert.deepEqual(middle.session, { plan: "first commit" });

  // Upstream of every checkpoint there is no snapshot — the host's
  // same-revision carry or a clean rebuild decides, never a stale future.
  const earliest = takeAt(3, checkpoints[0]!.tick - 1);
  assert.equal(earliest.session, undefined, "no checkpoint upstream of the position");

  // At the uncheckpointed patch the tape cannot name the state belonging to
  // the adopted bytes — the older checkpoint is a different revision's and
  // must not install.
  const patch = recording.segments[0]!.events.find((e) => e.cause.kind === "patch")!;
  const uncheckpointed = takeAt(4, patch.tick);
  assert.equal(
    uncheckpointed.session,
    undefined,
    "a mutation newer than the last checkpoint vetoes the stale snapshot",
  );
});

test("the anchor fingerprint fails on mutations the sync digest cannot see", () => {
  const { h, recording, lastTick } = playedSession();
  const { send } = h;

  const anchor = recording.segments[0]!.anchors.at(-1);
  assert.ok(anchor?.fingerprint, "the session recorded a fingerprinted anchor");

  // Every lane mutates semantic state the sync digest does not cover —
  // room, score, text rows and object coordinates all stay identical, so
  // only the recorded-versus-restored fingerprint can catch the drift.
  const mutants: [string, (anchor: HistoryAnchor) => void][] = [
    ["PRNG", (a) => (a.rng = (a.rng + 1) & 0xffff)],
    ["request serial", (a) => a.requestSerial++],
    ["queued keys", (a) => a.inputQueue.push(13)],
    ["queued direction", (a) => a.directionQueue.push(2)],
    ["queued input lines", (a) => a.inputLines.push("east")],
    ["cycle clock", (a) => (a.clock.remainder += 1)],
    ["sound clock", (a) => (a.soundRemainder = (a.soundRemainder ?? 0) + 1)],
    ["patch generation", (a) => ((a.replay as { patchGeneration: number }).patchGeneration += 1)],
    [
      "engine clock remainder",
      (a) => ((a.replay as { clockRemainderMs: number }).clockRemainderMs += 1),
    ],
    [
      "object motion state",
      (a) => {
        (a.replay as { objectExtras: { wanderCount: number }[] }).objectExtras[3]!.wanderCount = 7;
      },
    ],
    [
      "a string inside the save image",
      (a) => {
        const host = decodeHostImage(base64ToBytes(a.image));
        const save = decodeSave(host.image, PROFILES["2.936"]);
        save.strings[0] = `${save.strings[0]}x`;
        a.image = bytesToBase64(
          encodeHostImage(
            encodeSave(save, PROFILES["2.936"]),
            host.screen ?? [],
            host.presentation,
            host.continuation,
          ),
        );
      },
    ],
  ];

  for (const [what, mutate] of mutants) {
    const tampered = JSON.parse(JSON.stringify(recording)) as HistoryRecording;
    mutate(tampered.segments[0]!.anchors.at(-1)!);
    send({ type: "historyViewStart", id: 1, recording: tampered, segment: 0, tick: lastTick });
    const report = finalView(h.control, 1);
    assert.match(
      report.error ?? "",
      /semantic fingerprint does not hold/,
      `${what}: the recorded expectation did not hold for the restored state`,
    );
    assert.equal(report.canResume, false);
    assert.equal(h.ctx.view.drive, null, `${what}: the failed open mounted nothing`);
    send({ type: "historyViewEnd" });
  }

  // The untouched tape still opens.
  send({ type: "historyViewStart", id: 2, recording, segment: 0, tick: lastTick });
  assert.equal(finalView(h.control, 2).error, null);
  send({ type: "historyViewEnd" });
});

test("the take boundary refuses anything but the settled verified position", () => {
  const { h, recording, lastTick } = playedSession();
  const { ctx, send } = h;

  send({ type: "historyViewStart", id: 1, recording, segment: 0, tick: lastTick });
  const opened = finalView(h.control, 1);
  assert.equal(opened.error, null);
  assert.equal(opened.canResume, true);
  const pos = {
    segment: 0,
    tick: opened.tick,
    seq: opened.seq,
    generation: opened.generation,
  };

  const take = (id: number, extra: Partial<typeof pos> = {}) => {
    send({ type: "historyViewTake", id, ...pos, ...extra });
    const reply = h.control.find(
      (m): m is Extract<WorkerControl, { type: "historyTaken" }> =>
        m.type === "historyTaken" && m.id === id,
    );
    assert.ok(reply, `take ${id} got no reply`);
    return reply;
  };

  // A take naming a position the drive no longer sits on is refused.
  assert.match(take(2, { segment: 1 }).message ?? "", /moved/);
  assert.match(take(3, { tick: pos.tick - 1 }).message ?? "", /moved/);
  assert.match(take(4, { seq: pos.seq + 1 }).message ?? "", /moved/);
  // A take from another view session's serial is refused even when its
  // position still matches.
  assert.match(take(5, { generation: pos.generation - 1 }).message ?? "", /not viewing/);
  // A seek still settling cannot be taken.
  ctx.view.request = 99;
  assert.match(take(6).message ?? "", /settling/);
  ctx.view.request = null;

  // A take a closed session issued is refused even when the reopened view
  // lands on the same position.
  send({ type: "historyViewEnd" });
  send({ type: "historyViewStart", id: 8, recording, segment: 0, tick: lastTick });
  const reopened = finalView(h.control, 8);
  assert.equal(reopened.tick, pos.tick, "the reopened view sits on the same position");
  assert.equal(reopened.seq, pos.seq);
  assert.notEqual(reopened.generation, pos.generation);
  assert.match(take(9).message ?? "", /not viewing/, "the stale session's take is refused");
  assert.equal(take(10, { generation: reopened.generation }).ok, true);
});
