/**
 * Play here through the real dispatch: a booted live session jumps to a room
 * and spot, keeps its flags, and its always-on recording stays replayable —
 * the jump closes the open segment and the next one boots from a snapshot
 * of the placed state, with no new event kind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { historySyncDigest, type HistorySegment } from "../../src/agent/history.ts";
import { buildView } from "../../src/view/view.ts";
import { buildObjectFile } from "../../src/authoring/inventory.ts";
import { gameContainer, replayHistorySegment } from "./worker-ctx.ts";
import { createWorkerContext, type WorkerPorts } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { createPlayHere } from "../src/worker/playHere.ts";
import { createPlayHereLoader } from "../src/worker/playHereLoader.ts";
import { workerHarness } from "./worker-ctx.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerControl, WorkerInbound } from "../src/worker/workerProtocol.ts";

/** Room 1 plain; room 2 has a control-0 barrier across y=100 and an entry window. */
function game() {
  const enter = (x: number, y: number) =>
    `load.pic(v0);draw.pic(v0);show.pic();load.view(0);animate.obj(o0);set.view(o0,0);position(o0,${x},${y});draw(o0);accept.input();`;
  return gameContainer(
    [
      "if(equaln(v0,0)){new.room(1);}call.v(v0);return;",
      `if(isset(f5)){${enter(20, 150)}}return;`,
      `#message 1 "Lab"\nif(isset(f5)){${enter(80, 120)}drop(0);if(isset(f50)){assignn(v51,1);}print(1);}return;`,
      "if(isset(f5)){new.room(1);}return;",
    ],
    (c) => {
      const blank = Uint8Array.of(0xf0, 15, 0xf6, 0, 0, 1, 0, 0xff);
      c.putResource("picture", 1, blank);
      c.putFile("OBJECT", buildObjectFile([{ name: "key", startingRoom: 255 }]));
      c.putResource("picture", 2, Uint8Array.of(0xf2, 0, 0xf6, 0, 100, 159, 100, 0xff));
      c.putResource(
        "view",
        0,
        buildView({ loops: [{ cels: [{ width: 3, height: 5, pixels: new Array(15).fill(1) }] }] }),
      );
    },
  );
}

function harness(eager = true) {
  const control: WorkerControl[] = [];
  let now = 0;
  const ports: WorkerPorts = {
    control: (message) => control.push(message),
    presentation: () => {},
    now: () => now,
    seedWord: () => 0x1234,
    schedule: (fn, ms) => ({ fn, ms }),
    cancelSchedule: () => {},
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);
  if (eager) Object.assign(ctx.fns, createPlayHere(ctx));
  let acked = 0;
  const send = (msg: WorkerInbound): void => {
    onWorkerMessage(ctx, msg);
    while (acked < control.length) {
      const message = control[acked++]!;
      if (message.type === "historyBatch")
        onWorkerMessage(ctx, {
          type: "historyAck",
          epoch: message.epoch,
          batch: message.batch.batch,
        });
    }
  };
  send({ type: "boot", files: Object.fromEntries(game().files), words: [], rngSeed: 7 });
  ctx.fns.stopTimers();
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  const playHere = (room: number, x: number, y: number) => {
    send({ type: "playHere", id: 41, room, x, y });
    const reply = control.findLast((m) => m.type === "playedHere");
    assert.ok(reply?.type === "playedHere");
    return reply;
  };
  return { ctx, control, send, tick, playHere };
}

function segments(control: WorkerControl[]): HistorySegment[] {
  const byId = new Map<string, HistorySegment>();
  const seen = new Set<string>();
  for (const message of control) {
    if (message.type !== "historyBatch") continue;
    const batch = message.batch;
    if (seen.has(`${batch.segment}:${batch.batch}`)) continue;
    seen.add(`${batch.segment}:${batch.batch}`);
    let segment = byId.get(batch.segment);
    if (!segment) {
      assert.ok(batch.boot, `segment ${batch.segment} opens with a boot`);
      segment = {
        id: batch.segment,
        boot: batch.boot,
        anchors: [],
        events: [],
        marks: [],
        sync: [],
      };
      byId.set(batch.segment, segment);
    }
    segment.events.push(...batch.events);
    segment.marks.push(...batch.marks);
    segment.sync.push(...batch.sync);
    if (batch.clock !== undefined) (segment.clock ??= []).push(...batch.clock);
    if (batch.anchor !== undefined) segment.anchors.push(batch.anchor);
    if (batch.end !== undefined) segment.end = batch.end;
  }
  return [...byId.values()];
}

test("Create visits preserve the first moment across rooms and restore it exactly", () => {
  const { ctx, send, tick, control } = harness();
  tick(6);
  ctx.boot.authorRooms = true;
  const engine = ctx.engine!;
  engine.flags[50] = 1;
  engine.vars[3] = 17;
  engine.vars[75] = 23;
  ctx.history.rng = 4321;
  const image = engine.recordingImage();
  const replay = engine.captureReplayState();
  send({ type: "playHere", id: 50, room: 2, x: 0, y: 0, visit: "start" });
  const visit = control.findLast((m) => m.type === "playedHere");
  assert.ok(visit?.type === "playedHere");
  assert.equal(visit.ok, true, "a visit uses the room's placement, including its entry window");
  assert.equal(visit.returnRoom, 1);
  assert.equal(engine.vars[0], 2);
  assert.equal(
    control.some((m) => m.type === "hostRequest"),
    false,
    "existing rooms never ask the agent to prepare them",
  );
  send({ type: "dismissPrint" });
  engine.flags[50] = 0;
  engine.vars[3] = 99;
  ctx.history.rng = 99;
  send({ type: "playHere", id: 51, room: 1, x: 0, y: 0, visit: "start" });
  send({ type: "playHere", id: 52, room: 1, x: 0, y: 0, visit: "back" });
  assert.deepEqual(
    engine.recordingImage(),
    image,
    "position, flags, variables, inventory and text return",
  );
  assert.deepEqual(engine.captureReplayState(), replay, "transient state returns too");
  assert.equal(ctx.history.rng, 4321, "the random sequence resumes at the prior moment");
});

test("opening another editor of the visited room keeps its current moment", () => {
  const { ctx, send, tick, control } = harness();
  tick(6);
  send({ type: "playHere", id: 80, room: 2, x: 0, y: 0, visit: "start" });
  send({ type: "dismissPrint" });
  const image = ctx.engine!.recordingImage();
  const replay = ctx.engine!.captureReplayState();
  send({ type: "playHere", id: 81, room: 2, x: 0, y: 0, visit: "start" });
  const reply = control.findLast((m) => m.type === "playedHere");
  assert.ok(reply?.type === "playedHere");
  assert.equal(reply.ok, true);
  assert.equal(reply.returnRoom, 1);
  assert.deepEqual(ctx.engine!.recordingImage(), image);
  assert.deepEqual(ctx.engine!.captureReplayState(), replay);
});

test("Back refuses a removed cached resource before changing the live moment", () => {
  const container = game();
  container.putResource("view", 1, container.getResource("view", 0)!);
  const { ctx, control } = workerHarness(container);
  ctx.fns.tickEngine();
  // A cached view can be absent from the displayed room and still belong to its replay state.
  const engine = ctx.engine!;
  engine.restoreReplayState({
    ...engine.captureReplayState(),
    viewCache: { loaded: [0, 1], order: [0, 1] },
  });
  ctx.fns.onPlayHere({ type: "playHere", id: 71, room: 2, x: 0, y: 0, visit: "start" });
  engine.ackPrint();
  container.putResources([{ kind: "view", num: 1, payload: null }]);
  const image = engine.recordingImage();
  const replay = engine.captureReplayState();
  ctx.fns.onPlayHere({ type: "playHere", id: 72, room: 1, x: 0, y: 0, visit: "back" });
  const reply = control.findLast((m) => m.type === "playedHere");
  assert.ok(reply?.type === "playedHere");
  assert.equal(reply.ok, false);
  assert.deepEqual(engine.recordingImage(), image);
  assert.deepEqual(engine.captureReplayState(), replay);
});

test("a room that redirects a Create visit reports the failed entry and keeps Back", () => {
  const { send, tick, control } = harness();
  tick(6);
  send({ type: "playHere", id: 61, room: 3, x: 0, y: 0, visit: "start" });
  const visit = control.findLast((m) => m.type === "playedHere");
  assert.ok(visit?.type === "playedHere");
  assert.equal(visit.ok, false);
  assert.equal(visit.returnRoom, 1);
});

test("visiting uses the room's own hero placement", () => {
  const { ctx, send, tick, control } = harness();
  tick(6);
  ctx.engine!.flags[50] = 1;
  // Existing room 2 can run its entry with no placement probe.
  send({ type: "playHere", id: 60, room: 2, x: 0, y: 0, visit: "start" });
  const visit = control.findLast((m) => m.type === "playedHere");
  assert.ok(visit?.type === "playedHere");
  assert.equal(visit.ok, true);
  assert.equal(visit.x, 80);
});

test("play here enters the room, keeps the flags and stands ego on the spot", () => {
  const { ctx, send, tick, playHere } = harness();
  tick(6);
  assert.equal(ctx.engine!.vars[0], 1);
  send({ type: "debugWrite", id: 1, flags: [[50, 1]] });
  send({ type: "direction", dir: 3 });
  tick(2);

  const reply = playHere(2, 30, 140);
  assert.deepEqual(reply, { type: "playedHere", id: 41, ok: true, room: 2, x: 30, y: 140 });
  const engine = ctx.engine!;
  assert.equal(engine.flags[50], 1, "the session's flags stay");
  assert.equal(engine.vars[51], 1, "the room's entry logic saw them");
  assert.equal(engine.modalKind, "print", "the room's own entry window is up");

  // The window closes and play goes on from the spot, standing still.
  send({ type: "dismissPrint" });
  tick(4);
  const ego = engine.screenObjects[0]!;
  assert.deepEqual([engine.vars[0], ego.x, ego.y], [2, 30, 140]);
});

test("the recording ends at the jump and resumes from the placed state", () => {
  const { ctx, control, send, tick, playHere } = harness();
  tick(6);
  send({ type: "direction", dir: 3 });
  tick(2);
  assert.equal(playHere(2, 30, 140).ok, true);
  send({ type: "dismissPrint" });
  send({ type: "direction", dir: 7 });
  tick(6);
  // Seal the open batch, as parking the session does.
  ctx.fns.historyFlush();

  const [before, after, ...rest] = segments(control);
  assert.equal(rest.length, 0);
  assert.equal(before?.end?.reason, "walkthrough", "an existing end reason: a host takeover");
  assert.ok(after?.boot.image, "the next segment boots from a snapshot");
  assert.deepEqual(after.boot.resumedFrom?.segment, before.id);
  const kinds = new Set([...before.events, ...after.events].map((event) => event.cause.kind));
  // Direction presses record as keys while no key-release gate is armed.
  assert.deepEqual([...kinds].sort(), ["dismiss", "end", "key"]);

  const replayed = replayHistorySegment(after);
  assert.equal(replayed.error, null);
  assert.equal(replayed.diverged, null, "every sync mark after the jump holds");
  assert.equal(historySyncDigest(replayed.ctx.engine!), historySyncDigest(ctx.engine!));
  const ego = ctx.engine!.screenObjects[0]!;
  assert.ok(ego.x < 30 && ego.y === 140, `ego walked west from the spot, to ${ego.x},${ego.y}`);
});

test("a spot ego cannot stand on is refused after the room is entered", () => {
  const { ctx, tick, playHere } = harness();
  tick(6);
  const reply = playHere(2, 30, 100);
  assert.equal(reply.ok, false);
  assert.match(reply.reason ?? "", /cannot stand at \(30,100\).*barrier/);
  assert.deepEqual([reply.room, reply.x, reply.y], [2, 80, 120], "where the room put ego");
  assert.equal(ctx.engine!.vars[0], 2);
});

test("a room without logic, or a malformed spot, changes nothing", () => {
  const { ctx, control, tick, playHere } = harness();
  tick(6);
  const ego = ctx.engine!.screenObjects[0]!;
  for (const [room, x, y, reason] of [
    [9, 30, 140, /Room 9 has no logic/],
    [2, 160, 140, /x must be/],
  ] as const) {
    const reply = playHere(room, x, y);
    assert.equal(reply.ok, false);
    assert.match(reply.reason ?? "", reason);
    assert.deepEqual([ctx.engine!.vars[0], ego.x, ego.y], [1, 20, 150]);
  }
  assert.equal(segments(control).length, 1, "the recording goes on uninterrupted");
  assert.equal(segments(control)[0]!.end, undefined);
});

test("Play here refuses placement when room entry stops before setup completes", () => {
  const { ctx, control, tick, playHere } = harness();
  tick(6);
  ctx.engine!.setExecutionGate(() => {
    const ego = ctx.engine!.screenObjects[0]!;
    return ctx.engine!.vars[0] === 2 && ego.active && ego.x === 80 && ego.y === 120;
  });
  const reply = playHere(2, 30, 140);
  assert.equal(reply.ok, false);
  assert.match(reply.reason ?? "", /entry.*complete/);
  assert.deepEqual([reply.x, reply.y], [80, 120]);
  assert.ok(ctx.engine!.executionStopInfo);
  assert.equal(segments(control).length, 1, "no replay boot from a partial entry pass");
});

test("a breakpoint during Play here loading is released at the actual jump", async () => {
  const { ctx, control } = workerHarness(game());
  Object.assign(ctx.fns, createPlayHereLoader(ctx));
  ctx.fns.tickEngine();
  ctx.fns.onDebugAttach({ type: "debugAttach", id: 1 });
  const epoch = ctx.debugger.epoch;
  const answered = new Promise<void>((resolve) => {
    const post = ctx.ports.control;
    ctx.ports.control = (message) => {
      post(message);
      if (message.type === "playedHere") resolve();
    };
  });
  onWorkerMessage(ctx, { type: "playHere", id: 902, room: 2, x: 30, y: 140 });
  const epochWhileLoading = ctx.debugger.epoch;
  ctx.fns.onDebugPause({ type: "debugPause", id: 2, epoch: ctx.debugger.epoch });
  assert.ok(ctx.engine!.executionStopInfo);
  await answered;
  const reply = control.findLast((message) => message.type === "playedHere");
  assert.ok(reply?.type === "playedHere");
  assert.equal(reply.ok, true, reply.reason ?? "the deferred jump succeeds");
  assert.equal(epochWhileLoading, epoch, "loading preserves the debugger's identity");
  assert.ok(ctx.debugger.epoch > epoch);
});

test("Play here loads on demand and refuses a command whose game was replaced during loading", async (t) => {
  const h = harness(false);
  t.after(() => h.ctx.fns.stopTimers());
  h.send({ type: "playHere", id: 901, room: 2, x: 60, y: 150 });
  assert.equal(
    h.control.some((message) => message.type === "playedHere"),
    false,
  );
  h.send({ type: "boot", files: Object.fromEntries(game().files), words: [] });
  for (
    let turn = 0;
    turn < 400 && !h.control.some((message) => message.type === "playedHere");
    turn++
  ) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const reply = h.control.find((message) => message.type === "playedHere");
  assert.ok(reply?.type === "playedHere");
  assert.equal(reply.id, 901);
  assert.equal(reply.ok, false);
});
