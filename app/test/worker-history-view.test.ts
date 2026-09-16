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
import { openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";
import {
  decodeHostImage,
  decodeSave,
  encodeHostImage,
  encodeSave,
} from "../../src/runtime/persistence.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { testProjectId, testRevision } from "./identity.ts";
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
const VIEW_LOGICS = [
  `if (isset(f6)) { reset(f6); new.room(1); }
   if (isset(f200)) { reset(f200); assignn(v3, 5); new.room(2); }
   if (isset(f202)) { reset(f202); random(1, 250, v60); }
   if (isset(f216)) { reset(f216); accept.input(); }
   if (isset(f218)) { reset(f218); load.view(1); animate.obj(o1); set.view(o1, 1);
     ignore.objs(o1); position(o1, 10, 80); draw(o1); assignn(v61, 4); step.size(o1, v61);
     move.obj(o1, 90, 80, 2, f62); end.of.loop(o1, f61); }
   if (isset(f219)) { reset(f219); set(f16); restart.game(); }
   if (isset(f221)) { reset(f221); set(f9); load.sound(1); sound(1, f60); }
   if (isset(f222)) { reset(f222);
     set.string(s0, "xyzzy"); parse(s0);
     if (said(1)) { assignn(v100, 1); }
     parse(s0);
     if (said(0)) { assignn(v101, 1); }
     parse(s0); }
   if (isset(f223)) { reset(f223); parse(s0); if (said(1)) { assignn(v102, 1); } }
   if (isset(f224)) { reset(f224); get.num("n?", v11); assignv(v64, v11); }
   if (isset(f225)) { reset(f225); get(0); }
   if (isset(f226)) { reset(f226); assignn(v66, 255); if (obj.in.room(0, v66)) { assignn(v65, 1); } }
   if (isset(f227)) { reset(f227); wait: if (!have.key()) { goto wait; } assignn(v62, 1); }
   if (v0 > 0) { call.v(v0); }
   return;`,
  `if (isset(f5)) { assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic(); } return;`,
  `if (isset(f5)) { assignn(v50, 2); load.pic(v50); draw.pic(v50); show.pic(); } return;`,
];

/** Two-item OBJECT file — the same fixture layout test/worker-history uses. */
const VIEW_OBJECT_FILE = new Uint8Array([
  6, 0, 10, 6, 0, 0, 10, 0, 0, 107, 101, 121, 0, 99, 111, 105, 110, 0,
]);

function populateViewResources(c: GameContainer, extra?: (c: GameContainer) => void): void {
  c.putFile("OBJECT", VIEW_OBJECT_FILE);
  c.putResource("picture", 1, PICTURE_1);
  c.putResource("picture", 2, PICTURE_1);
  c.putResource(
    "view",
    1,
    buildView({
      loops: [
        {
          cels: [
            { width: 2, height: 1, pixels: [1, 1] },
            { width: 2, height: 1, pixels: [2, 2] },
            { width: 2, height: 1, pixels: [3, 3] },
          ],
        },
      ],
    }),
  );
  extra?.(c);
}

function viewGame(extra?: (c: GameContainer) => void): GameContainer {
  return gameContainer(VIEW_LOGICS, (c) => populateViewResources(c, extra));
}

/**
 * The same game packed into a combined v3 container: with no interpreter
 * version string the folder detection lands on the default v3 profile,
 * 3.002.149 — the build whose 78-entry envelope the audit measured.
 */
function viewGameV3(extra?: (c: GameContainer) => void): GameContainer {
  const section = 256 * 3;
  const dir = new Uint8Array(8 + 4 * section).fill(0xff);
  for (let i = 0; i < 4; i++) {
    const offset = 8 + i * section;
    dir[i * 2] = offset & 0xff;
    dir[i * 2 + 1] = offset >> 8;
  }
  const c = openContainer(
    new Map([
      ["GAMEDIR", dir],
      ["GAMEVOL.0", new Uint8Array(0)],
    ]),
  );
  for (const [num, source] of VIEW_LOGICS.entries())
    c.putResource("logic", num, assembleLogic(source, { dictionary: new Map() }).payload);
  populateViewResources(c, extra);
  return c;
}

/**
 * A 200-tick tone on channel 0 at base attenuation 0 — long enough for the
 * v3 envelope's 77 steps and hold to play out inside one test session.
 */
const SOUND_LONG = new Uint8Array([
  8, 0, 15, 0, 15, 0, 15, 0, 200, 0, 0x23, 0x81, 0x90, 0xff, 0xff, 0xff, 0xff,
]);

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
    identity: { project: testProjectId("view-fixture"), revision: testRevision("view") },
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

test("a take mid-motion adopts the shared parameter bank, not separate fields", () => {
  // f218 arms the original's overwrite sequence: move.obj fills the bank,
  // then end.of.loop's flag byte lands on the destination byte, so the
  // object travels to 61 — never 90 (docs/fidelity.md, motion audit). If
  // the record → seek → adopt chain dropped the bank, the adopted session
  // would drive to the stale target the old separate fields held.
  const h = viewHarness(viewGame(), { rngSeed: 0xbeef });
  const { ctx, send, tick } = h;
  tick(4);
  send({ type: "debugWrite", id: 0, flags: [[200, 1]] });
  tick(5);
  send({ type: "debugWrite", id: 1, flags: [[218, 1]] });
  tick(3); // the sequence is armed and mid-flight
  send({ type: "pause", paused: true });
  const recording = asRecording(collectSegments(h.control));

  const arm = recording.segments[0]!.events.find(
    (e) => e.cause.kind === "debugWrite" && e.cause.flags?.some(([n]) => n === 218),
  );
  assert.ok(arm, "the recorded stream carries the sequence's boundary");
  const midTick = arm.tick + 2;
  send({ type: "historyViewStart", id: 2, recording, segment: 0, tick: midTick });
  const opened = finalView(h.control, 2);
  assert.equal(opened.error, null);
  assert.equal(opened.canResume, true, "a mid-motion position is resumable");

  send({
    type: "historyViewTake",
    id: 3,
    segment: 0,
    tick: opened.tick,
    seq: opened.seq,
    generation: opened.generation,
  });
  const taken = h.control.find(
    (m): m is Extract<WorkerControl, { type: "historyTaken" }> =>
      m.type === "historyTaken" && m.id === 3,
  );
  assert.ok(taken && taken.ok, "the take succeeded");

  // The adopted engine carries the bank the scratch replayed — flag byte on
  // the destination, saved step and completion flag in the trailing bytes.
  const o = ctx.engine!.screenObjects[1]!;
  assert.deepEqual(o.paramBank, [61, 80, 4, 62]);

  send({ type: "pause", paused: false });
  tick(80);
  assert.equal(o.x, 60, "the adopted session drove to the flag byte's target");
  assert.equal(ctx.engine!.flags[61], 1, "the loop's flag latched");
  assert.equal(ctx.engine!.flags[62], 1, "the motion's flag latched");
  assert.equal(o.motionMode, 0);
  assert.equal(o.stepSize, 4, "the saved step size came back");
});

test("a take mid-envelope adopts the v3 table and crosses its hold", () => {
  // GR1 3.002.149's envelope runs 77 steps before its hold — envelope
  // positions in [68,77] do not exist under the 2.917 table, so adopting
  // one restores only when the playback selected the v3 table and its own
  // length bounds the snapshot (docs/fidelity.md, sound player audit).
  const container = viewGameV3((c) => c.putResource("sound", 1, SOUND_LONG));
  const h = viewHarness(container, { rngSeed: 0xbeef });
  const { ctx, send, tick } = h;
  assert.equal(ctx.engine!.profile.id, "3.002.149");
  tick(4);
  send({ type: "debugWrite", id: 0, flags: [[200, 1]] });
  tick(5); // room 2 drawn — resumable
  send({ type: "debugWrite", id: 1, vars: [[23, 3]] });
  send({ type: "debugWrite", id: 2, flags: [[221, 1]] });
  tick(71); // the envelope index lands in the v3-only range

  const liveIndex = ctx.engine!.captureReplayState().sound?.playback.channels[0]!.envelopeIndex;
  assert.ok(
    liveIndex !== undefined && liveIndex >= 68 && liveIndex <= 77,
    `envelope index ${liveIndex} sits in the v3-only range`,
  );
  send({ type: "pause", paused: true });
  const recording = asRecording(collectSegments(h.control));
  const lastTick = Math.max(
    ...recording.segments[0]!.events.map((e) => e.tick),
    ...recording.segments[0]!.sync.map((s) => s.tick),
  );

  // Replaying the tape rebuilds the scratch's playback at the same v3
  // position; adopting it restores that state into the live engine. A
  // shared 68-entry bound would refuse the recorded position here.
  send({ type: "historyViewStart", id: 3, recording, segment: 0, tick: lastTick });
  const opened = finalView(h.control, 3);
  assert.equal(opened.error, null);
  assert.equal(opened.canResume, true);
  send({
    type: "historyViewTake",
    id: 4,
    segment: 0,
    tick: opened.tick,
    seq: opened.seq,
    generation: opened.generation,
  });
  const taken = h.control.find(
    (m): m is Extract<WorkerControl, { type: "historyTaken" }> =>
      m.type === "historyTaken" && m.id === 4,
  );
  assert.ok(taken && taken.ok, "the take adopted the mid-envelope position");
  const adopted = ctx.engine!.captureReplayState().sound?.playback.channels[0];
  assert.ok(adopted, "the adopted engine carries the sound's playback state");
  assert.equal(adopted.envelopeIndex, liveIndex);

  // Resumed ticks run the v3 tail to its hold: the last advancing step
  // clamps at 15 (0x9f), then the hold transition and every held tick emit
  // the stored 13 (0x9d) — v23 never re-enters (docs/fidelity.md).
  h.presentation.length = 0;
  send({ type: "pause", paused: false });
  tick(12);
  const attenuations = h.presentation
    .filter(
      (m): m is Extract<WorkerPresentation, { type: "soundOutput" }> => m.type === "soundOutput",
    )
    .map((m) => m.output)
    .filter((o): o is { kind: "psg"; bytes: number[] } => o.kind === "psg")
    .map((o) => o.bytes.at(-1)!)
    .filter((b) => (b & 0xf0) === 0x90);
  const hold = attenuations.indexOf(0x9d);
  assert.ok(hold > 0, "the resumed stream crosses the v3 hold");
  assert.ok(
    attenuations.slice(hold).every((b) => b === 0x9d),
    `held ticks keep the stored value: ${attenuations.join(",")}`,
  );
});

test("a take adopts the unknown-word slot said() still matches", () => {
  // docs/fidelity.md, parser unknown-word audit: an unknown token occupies
  // a parsed slot holding group zero. The slot rides the anchor's replay
  // state, so a seek replaying the f222 pass sees said(1) and said(0) match
  // — and the adopted session can still match after adoption.
  const h = viewHarness(viewGame(), { rngSeed: 0xbeef });
  const { ctx, send, tick } = h;
  tick(4);
  send({ type: "debugWrite", id: 0, flags: [[200, 1]] });
  tick(5); // room 2 drawn — resumable
  send({ type: "debugWrite", id: 1, flags: [[222, 1]] });
  tick(2);
  send({ type: "pause", paused: true });
  const recording = asRecording(collectSegments(h.control));
  const lastTick = Math.max(
    ...recording.segments[0]!.events.map((e) => e.tick),
    ...recording.segments[0]!.sync.map((s) => s.tick),
  );

  send({ type: "historyViewStart", id: 2, recording, segment: 0, tick: lastTick });
  const opened = finalView(h.control, 2);
  assert.equal(opened.error, null);
  assert.equal(opened.canResume, true);
  send({
    type: "historyViewTake",
    id: 3,
    segment: 0,
    tick: opened.tick,
    seq: opened.seq,
    generation: opened.generation,
  });
  const taken = h.control.find(
    (m): m is Extract<WorkerControl, { type: "historyTaken" }> =>
      m.type === "historyTaken" && m.id === 3,
  );
  assert.ok(taken && taken.ok, "the take adopted the post-parse position");

  // The scratch replayed the said checks against the zero slot — and the
  // anchor carried the slot itself into the adopted engine.
  assert.equal(ctx.engine!.vars[100], 1, "the replayed said(1) matched");
  assert.equal(ctx.engine!.vars[101], 1, "the replayed said(0) matched");
  const parser = ctx.engine!.captureReplayState();
  assert.deepEqual(parser.parsedWords, [0], "the adopted parser slot holds group zero");
  assert.equal(parser.parserCount, 1);
  assert.equal(parser.inputReady, 0, "f2 is per-cycle — cleared past the parse's own cycle");

  // Still live after adoption: re-parsing the restored string 0 yields the
  // zero slot again and said(1) matches it.
  send({ type: "pause", paused: false });
  send({ type: "debugWrite", id: 4, flags: [[223, 1]] });
  tick(3);
  assert.equal(ctx.engine!.vars[102], 1, "said(1) matches in the adopted session");
});

test("restart at RNG zero consumes no clock read; the next draw records one", () => {
  // docs/fidelity.md, save/restart audit, through the harness's own lane:
  // accepted restart leaves the worker's RNG word alone, so a stream still at
  // zero reseeds on the NEXT random call — and that one BIOS-word equivalent
  // lands on the tape where the tape drive can replay it.
  const h = viewHarness(viewGame(), { rngSeed: 0 });
  const { ctx, send, tick } = h;
  tick(4);
  send({ type: "debugWrite", id: 0, flags: [[219, 1]] }); // accepted restart
  tick(4); // the restart aborts, then f6 re-enters room 1
  assert.equal(ctx.history.rng, 0, "restart preserved the zero-state stream");

  send({ type: "debugWrite", id: 1, flags: [[202, 1]] }); // random(1,250,v60)
  tick(3);
  assert.notEqual(ctx.history.rng, 0, "the draw reseeded and advanced");

  send({ type: "pause", paused: true });
  const recording = asRecording(collectSegments(h.control));
  const reseeds = recording.segments
    .flatMap((s) => s.events)
    .filter((e) => e.cause.kind === "reseed");
  assert.equal(reseeds.length, 1, "exactly one recorded BIOS-word read");

  // The tape carries the word; viewing it replays the draw without drawing
  // a second one (a lane miss would throw inside the seek).
  const lastTick = Math.max(
    ...recording.segments[0]!.events.map((e) => e.tick),
    ...recording.segments[0]!.sync.map((s) => s.tick),
  );
  send({ type: "historyViewStart", id: 2, recording, segment: 0, tick: lastTick });
  const opened = finalView(h.control, 2);
  assert.equal(opened.error, null);
  assert.equal(opened.tick, lastTick);
  send({ type: "historyViewEnd" });
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
        (a.replay as { objectExtras: { priority: number }[] }).objectExtras[3]!.priority = 7;
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

test("a take adopts a parked key wait and the pack; a suspended prompt is not resumable", () => {
  // The D2 leftovers: a suspended host request is never an adoptable
  // boundary, the one suspended kind the continuation can describe — a
  // parked have.key — resumes on the adopted segment, and the OBJECT-file
  // pack rides the adopted image.
  const h = viewHarness(viewGame(), { rngSeed: 0xbeef });
  const { ctx, send, tick } = h;
  tick(4);

  const seen = new Set<number>();
  const awaitOp = (op: string) => {
    for (let i = 0; i < 40; i++) {
      const req = h.control.find((m) => m.type === "hostRequest" && m.op === op && !seen.has(m.id));
      if (req && req.type === "hostRequest") {
        seen.add(req.id);
        return req;
      }
      tick(1);
    }
    return assert.fail(`host request ${op} never posted`);
  };

  // Play in a drawn room so the session's boundaries are resumable:
  // f200 edges to room 2, whose entry is the anchor the seeks start from.
  send({ type: "debugWrite", id: 0, flags: [[200, 1]] });
  tick(5);
  assert.equal(ctx.engine!.vars[0], 2, "room 2 entered");

  // The key lands in the pack before the recorded waits.
  send({ type: "debugWrite", id: 1, flags: [[225, 1]] });
  tick(2);

  // A have.key busy loop parks the pass on a key wait — the suspended kind
  // the continuation record can describe.
  send({ type: "debugWrite", id: 2, flags: [[227, 1]] });
  tick(4);
  assert.equal(ctx.engine!.awaitingKey, true, "the recorded wait parked on a key");
  send({ type: "key", code: 65 });
  tick(3);
  assert.equal(ctx.engine!.vars[62], 1, "the recorded key resumed the pass");

  // A get.num prompt suspends on a host request the continuation cannot
  // describe; the parked polls give the suspended span recorded ticks.
  send({ type: "debugWrite", id: 3, flags: [[224, 1]] });
  const prompt = awaitOp("getnum");
  tick(3);
  send({ type: "hostAnswer", id: prompt.id, response: "7" });
  tick(3);
  assert.equal(ctx.engine!.vars[64], 7, "the answered prompt's pass resumed");

  send({ type: "pause", paused: true });
  const recording = asRecording(collectSegments(h.control));
  const segment = recording.segments[0]!;
  const keyEvent = segment.events.find((e) => e.cause.kind === "key" && e.cause.code === 65)!;
  const answerEvent = segment.events.find((e) => e.cause.kind === "answer")!;
  assert.ok(keyEvent.tick < answerEvent.tick, "the key wait precedes the prompt");

  // The parked key wait is a resumable boundary: the take adopts the
  // suspended pass and an arriving key completes it on the new segment.
  const parkedAt = keyEvent.tick - 1;
  send({ type: "historyViewStart", id: 10, recording, segment: 0, tick: parkedAt });
  const viewed = finalView(h.control, 10);
  assert.equal(viewed.error, null);
  assert.equal(viewed.canResume, true, "a parked key wait adopts");
  send({
    type: "historyViewTake",
    id: 11,
    segment: 0,
    tick: parkedAt,
    seq: viewed.seq,
    generation: viewed.generation,
  });
  const taken = h.control.find(
    (m): m is Extract<WorkerControl, { type: "historyTaken" }> =>
      m.type === "historyTaken" && m.id === 11,
  );
  assert.ok(taken && taken.ok);
  assert.equal(ctx.engine!.awaitingKey, true, "the adopted pass still waits on its key");
  send({ type: "pause", paused: false });
  send({ type: "key", code: 66 });
  tick(3);
  assert.equal(ctx.engine!.vars[62], 1, "the arrived key resumed the adopted pass");

  // Same recording, second view: the get.num-suspended tick refuses —
  // a live host request is not a resumable boundary.
  send({ type: "pause", paused: true });
  send({
    type: "historyViewStart",
    id: 12,
    recording,
    segment: 0,
    tick: answerEvent.tick - 1,
  });
  const suspended = finalView(h.control, 12);
  assert.equal(suspended.error, null);
  assert.equal(suspended.canResume, false, "a host-request suspension is not a boundary");

  // The answer's own tick is resumable — the take lands the resumed pass.
  send({ type: "historyViewSeek", id: 13, segment: 0, tick: answerEvent.tick });
  const landed = finalView(h.control, 13);
  assert.equal(landed.error, null);
  assert.equal(landed.canResume, true);
  send({
    type: "historyViewTake",
    id: 14,
    segment: 0,
    tick: answerEvent.tick,
    seq: landed.seq,
    generation: landed.generation,
  });
  const takenAgain = h.control.find(
    (m): m is Extract<WorkerControl, { type: "historyTaken" }> =>
      m.type === "historyTaken" && m.id === 14,
  );
  assert.ok(takenAgain && takenAgain.ok);
  assert.equal(ctx.engine!.vars[64], 7, "the resumed prompt's writes adopted");

  // The pack crossed both takes: the picked-up key rides the adopted image.
  send({ type: "pause", paused: false });
  send({ type: "debugWrite", id: 15, flags: [[226, 1]] });
  tick(3);
  assert.equal(ctx.engine!.vars[65], 1, "the carried key survived the take");
});
