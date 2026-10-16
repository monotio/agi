import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../../src/runtime/engine.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { gameContainer, workerHarness } from "./worker-ctx.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerInbound } from "../src/worker/workerProtocol.ts";

function setup(profile: keyof typeof PROFILES, source = "set.key(1,1,1); return;") {
  const container = gameContainer([source]);
  const { ctx } = workerHarness(container);
  ctx.run.engine = new Engine(container, ctx.host, undefined, { profile: PROFILES[profile] });
  const sample = (x: number, y: number, button1 = false, button2 = false) =>
    onWorkerMessage(ctx, { type: "joystick", sample: { x, y, button1, button2 } } as WorkerInbound);
  return { ctx, sample };
}

test("browser Gamepad samples reach the Amiga's native joystick and returning to center stops it", () => {
  const { ctx, sample } = setup("amiga-2.202");
  ctx.fns.tickEngine();
  sample(0.8, 0);
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.vars[6], 3);
  sample(0, 0);
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.vars[6], 0);
  sample(0, 0, true);
  ctx.fns.tickEngine();
  sample(0, 0, false);
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.controllers[1], 1);
});

test("a connected centered Gamepad opens PC calibration, while no device leaves it closed", () => {
  const { ctx, sample } = setup("2.936", "if (!isset(f200)) {set(f200);init.joy();} return;");
  sample(0, 0);
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.modalKind, "print");
  const absent = setup("2.936", "init.joy(); return;");
  absent.ctx.fns.tickEngine();
  assert.equal(absent.ctx.run.engine!.modalKind, null);
});

test("a fire press and release between slow logic cycles still reaches the next cycle", () => {
  const { ctx, sample } = setup("amiga-2.202");
  ctx.fns.tickEngine();
  ctx.run.engine!.vars[10] = 100;
  sample(0, 0, true);
  ctx.fns.stepHostTick(1, { sound: 0, cycle: false });
  sample(0, 0, false);
  ctx.fns.stepHostTick(2, { sound: 0, cycle: false });
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.controllers[1], 1);
});

import { OperationRecorder, validateRecordedReplay } from "../../src/agent/recordedReplay.ts";
import { createAgentSessionState } from "../../src/agent/agentState.ts";
import { Simulation } from "../../src/agent/playtest.ts";

test("a joystick deadline crossing a parked key wait replays once and leaves the next wait empty", () => {
  const source = `if (isset(f201)) {reset(f201);
  first: if (!have.key()) {goto first;} assignv(v100,v19); assignn(v19,0);
  second: if (!have.key()) {goto second;} assignv(v101,v19);
 } return;`;
  const { ctx, sample } = setup("amiga-2.202", source);
  const engine = ctx.run.engine!;
  sample(0, 0);
  ctx.fns.tickEngine();
  engine.flags[8] = 1;
  engine.vars[15] = 1;
  engine.flags[201] = 1;
  const image = engine.recordingImage(true)!;
  const state = engine.captureReplayState(true);
  const tape = new OperationRecorder();
  ctx.run.recording.recording = { tape, events: [], printed: [], tainted: null };
  ctx.fns.tickEngine();
  assert.equal(engine.awaitingKey, true);
  const clock = () => {
    for (let i = 0; i < 4; i++) {
      tape.clock();
      engine.advanceClock(1000 / 60);
    }
  };
  const fire = () => {
    sample(0, 0, true);
    ctx.fns.pollJoystickInput();
    sample(0, 0, false);
    ctx.fns.pollJoystickInput();
    clock();
    ctx.fns.pollJoystickInput();
  };
  fire();
  assert.equal(engine.vars[100], 13);
  assert.equal(engine.awaitingKey, true);
  assert.equal(engine.vars[101], 0);
  fire();
  assert.equal(engine.vars[101], 13);
  assert.equal(engine.awaitingKey, false);
  const sim = new Simulation(
    createAgentSessionState(gameContainer([source]), PROFILES["amiga-2.202"]),
  );
  sim.engine.restoreImage(image, { preservePresentation: true });
  sim.replay(validateRecordedReplay({ state, operations: tape.operations }));
  assert.equal(sim.engine.vars[100], 13);
  assert.equal(sim.engine.vars[101], 13);
  assert.equal(sim.engine.awaitingKey, false);
  assert.equal(sim.engine.captureReplayState(true).inputQueue.length, 0);
});

test("paused and inactive games reject joystick samples; disconnect stops without firing a held button", () => {
  const { ctx, sample } = setup("amiga-2.202");
  ctx.fns.tickEngine();
  sample(1, 0, true);
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.vars[6], 3);
  onWorkerMessage(ctx, { type: "pause", paused: true });
  sample(-1, 0, false);
  assert.equal(ctx.run.input.joystick, null);
  onWorkerMessage(ctx, { type: "pause", paused: false });
  // A fresh centered browser sample can arrive before the first resumed tick.
  sample(0, 0, false);
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.vars[6], 0);
  assert.equal(ctx.run.engine!.controllers[1], 0);
  onWorkerMessage(ctx, { type: "joystick", sample: null });
  ctx.run.owner.active = false;
  sample(1, 0);
  assert.equal(ctx.run.input.joystick, null);
});

import { loadAppearance } from "../src/render/appearance.ts";
import { collectSegments, replayHistorySegment } from "./worker-ctx.ts";
import { createWorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import type { WorkerControl } from "../src/worker/workerProtocol.ts";

test("history replays Gamepad samples and preserves a connected neutral sample in an anchor", async () => {
  await loadAppearance("amiga-2.202");
  const container = gameContainer(
    [
      `if (!isset(f200)) {set(f200);load.pic(v0);draw.pic(v0);show.pic();set.key(1,1,1);} if (controller(c1)) {increment(v40);} return;`,
    ],
    (c) => c.putResource("picture", 0, Uint8Array.of(255)),
  );
  const control: WorkerControl[] = [];
  let now = 0;
  const ctx = createWorkerContext({
    control: (m) => control.push(m),
    presentation: () => {},
    now: () => now,
  });
  ctx.host = createEngineHost(ctx);
  const send = (msg: WorkerInbound) => onWorkerMessage(ctx, msg);
  send({
    type: "boot",
    profile: "amiga-2.202",
    files: Object.fromEntries(container.files),
    words: [],
    joystick: { x: 0, y: 0, button1: false, button2: false },
  });
  ctx.fns.stopTimers();
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  tick(3);
  send({ type: "joystick", sample: { x: 1, y: 0, button1: true, button2: false } });
  tick(3);
  send({ type: "joystick", sample: { x: 0, y: 0, button1: false, button2: false } });
  tick(3);
  assert.equal(ctx.run.engine!.vars[40], 1);
  ctx.fns.historyFlush("flush");
  const [segment] = collectSegments(control);
  assert.ok(segment);
  assert.ok(segment.anchors.some((a) => a.joystick?.x === 0 && a.joystick.y === 0));
  const replay = replayHistorySegment(segment);
  assert.equal(replay.error, null);
  assert.equal(replay.diverged, null);
  assert.equal(replay.ctx.run.engine!.vars[40], 1);
});

test("invalid Gamepad axes and pointer-origin keys cannot bypass worker input gates", () => {
  const { ctx } = setup("amiga-2.202", 'set(f15); print("Banner"); set.key(1,4,4); return;');
  ctx.fns.tickEngine();
  for (const sample of [
    { x: NaN, y: 0 },
    { x: Infinity, y: 0 },
    { x: 2, y: 0 },
    { x: 0, y: 0, button1: "yes" },
  ]) {
    onWorkerMessage(ctx, { type: "joystick", sample } as WorkerInbound);
    assert.equal(ctx.run.input.joystick, null);
  }
  onWorkerMessage(ctx, { type: "key", code: 0x0401, pointer: true });
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.controllers[4], 0);
  onWorkerMessage(ctx, { type: "key", code: 0x0401 });
  ctx.fns.tickEngine();
  assert.equal(
    ctx.run.engine!.controllers[4],
    1,
    "native fire button words still reach the script while its persistent window is open",
  );
});

test("a native sound switch during a recorded key wait takes effect before the resumed script", () => {
  const source =
    "wait: if (!have.key()) {goto wait;} if (isset(f9)) {assignn(v100,1);} else {assignn(v100,2);} return;";
  const { ctx } = setup("amiga-2.202", source);
  const engine = ctx.run.engine!;
  const image = engine.recordingImage(true)!;
  const state = engine.captureReplayState(true);
  const tape = new OperationRecorder();
  ctx.run.recording.recording = { tape, events: [], printed: [], tainted: null };
  ctx.fns.tickEngine();
  onWorkerMessage(ctx, { type: "key", code: 0xff00 });
  onWorkerMessage(ctx, { type: "key", code: 0x61 });
  assert.equal(engine.vars[100], 2);
  const sim = new Simulation(
    createAgentSessionState(gameContainer([source]), PROFILES["amiga-2.202"]),
  );
  sim.engine.restoreImage(image, { preservePresentation: true });
  sim.replay({ state, operations: tape.operations });
  assert.equal(sim.engine.vars[100], 2);
});

test("transferring play ownership cancels held Gamepad input before reclaim", () => {
  const { ctx, sample } = setup("amiga-2.202");
  ctx.fns.tickEngine();
  sample(1, 0, true);
  ctx.fns.tickEngine();
  onWorkerMessage(ctx, { type: "playOwner", active: false, generation: 1 });
  onWorkerMessage(ctx, { type: "playOwner", active: true, generation: 2 });
  sample(0, 0, false);
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.vars[6], 0);
  assert.equal(ctx.run.engine!.controllers[1], 0);
});

test("cancelling Gamepad ownership during a recorded key wait stops walking before its answer", () => {
  const source = "if (isset(f201)) {reset(f201); wait: if (!have.key()) {goto wait;}} return;";
  const { ctx, sample } = setup("amiga-2.202", source);
  const engine = ctx.run.engine!;
  ctx.fns.tickEngine();
  sample(1, 0, true);
  ctx.fns.tickEngine();
  engine.flags[201] = 1;
  const image = engine.recordingImage(true)!;
  const state = engine.captureReplayState(true);
  const tape = new OperationRecorder();
  ctx.run.recording.recording = { tape, events: [], printed: [], tainted: null };
  ctx.fns.tickEngine();
  assert.equal(engine.awaitingKey, true);
  onWorkerMessage(ctx, { type: "joystick", sample: null });
  onWorkerMessage(ctx, { type: "key", code: 97 });
  const sim = new Simulation(
    createAgentSessionState(gameContainer([source]), PROFILES["amiga-2.202"]),
  );
  sim.engine.restoreImage(image, { preservePresentation: true });
  sim.replay({ state, operations: tape.operations });
  assert.deepEqual(
    sim.engine.captureReplayState(true).inputQueue,
    engine.captureReplayState(true).inputQueue,
  );
  assert.equal(engine.vars[6], 0);
  assert.equal(sim.engine.vars[6], 0);
});

test("Gamepad cancellation during a recorded string prompt precedes its answer", () => {
  const source = 'if (isset(f201)) {reset(f201); get.string(s1,"Name?",20,0,10);} return;';
  const { ctx, sample } = setup("amiga-2.202", source);
  const engine = ctx.run.engine!;
  ctx.fns.tickEngine();
  sample(1, 0, true);
  ctx.fns.tickEngine();
  engine.flags[201] = 1;
  const image = engine.recordingImage(true)!;
  const state = engine.captureReplayState(true);
  const tape = new OperationRecorder();
  ctx.run.recording.recording = { tape, events: [], printed: [], tainted: null };
  ctx.fns.tickEngine();
  const request = ctx.run.hostRequests.hostRequestOutstanding!;
  assert.equal(request.op, "getstring");
  onWorkerMessage(ctx, { type: "joystick", sample: null });
  ctx.fns.onHostAnswer({
    type: "hostAnswer",
    generation: request.generation,
    id: request.id,
    response: "Ada",
  });
  const sim = new Simulation(
    createAgentSessionState(gameContainer([source]), PROFILES["amiga-2.202"]),
  );
  sim.engine.restoreImage(image, { preservePresentation: true });
  sim.replay({ state, operations: tape.operations });
  assert.equal(sim.engine.strings[1], "Ada");
  assert.equal(sim.engine.vars[6], 0);
  assert.deepEqual(
    sim.engine.captureReplayState(true).inputQueue,
    engine.captureReplayState(true).inputQueue,
  );
});

test("a Gamepad revealed after logic 0's init.joy comes online and replays identically", () => {
  // Browsers hide a pad until its first button press; the original reads a
  // connected stick whenever it polls (docs/fidelity.md F-IN-17).
  const source = "if (!isset(f200)) {set(f200); init.joy();} return;";
  const { ctx, sample } = setup("2.936", source);
  const engine = ctx.run.engine!;
  ctx.fns.tickEngine();
  assert.equal(engine.modalKind, null);
  const image = engine.recordingImage(true)!;
  const state = engine.captureReplayState(true);
  const tape = new OperationRecorder();
  ctx.run.recording.recording = { tape, events: [], printed: [], tainted: null };
  sample(0, 0, true);
  ctx.fns.pollJoystickInput();
  sample(0.9, 0, false);
  ctx.fns.pollJoystickInput();
  ctx.fns.tickEngine();
  assert.equal(engine.vars[6], 3, "the revealed pad walks the hero");
  const sim = new Simulation(createAgentSessionState(gameContainer([source]), PROFILES["2.936"]));
  sim.engine.restoreImage(image, { preservePresentation: true });
  sim.replay(validateRecordedReplay({ state, operations: tape.operations }));
  assert.equal(sim.engine.vars[6], 3);
  assert.deepEqual(
    sim.engine.captureReplayState(true).joystick,
    engine.captureReplayState(true).joystick,
  );
});
