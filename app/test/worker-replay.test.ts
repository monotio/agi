import { test } from "node:test";
import assert from "node:assert/strict";
import { gameContainer, workerHarness } from "./worker-ctx.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { GameContainer } from "../../src/types.ts";
import { buildSound } from "../../src/sound/build.ts";

// Blue box outline (10,10)-(60,40), filled — the same fixture bytes
// worker-autosave.test.ts uses to reach a resumable boundary.
const PICTURE_1 = new Uint8Array([
  0xf0, 0x01, 0xf6, 10, 10, 60, 10, 60, 40, 10, 40, 10, 10, 0xf8, 30, 20, 0xf1, 0xf2, 0x05, 0xf6, 0,
  150, 159, 150, 0xf3, 0xff,
]);

const VIEW_0 = new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 1, 1, 0, 0x51, 0]);

/** A drawn room plus a per-cycle counter — the state a snapshot must carry. */
function countingGame(): GameContainer {
  return gameContainer(
    [
      `if (!isset(f200)) { set(f200); assignn(v0, 1); new.room.v(v0); } call.v(v0); increment(v100); return;`,
      `if (isset(f5)) { assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic(); accept.input(); } return;`,
    ],
    (c) => {
      c.putResource("picture", 1, PICTURE_1);
      c.putResource("view", 0, VIEW_0);
    },
  );
}

test("advanceReplay parked on a prompt holds the tick until the answer lands", () => {
  const { ctx, control } = workerHarness(
    gameContainer([`#message 1 "How many?"\nget.num(1, v100);\nassignn(v101, 7);\nreturn;`]),
  );
  ctx.replay.replay = { tick: 0, revision: 0 };
  ctx.run.rng.word = 0;
  ctx.fns.tickEngine(); // parks on get.num; postHostRequest posts the blocked observation

  const observations = () => control.filter((m) => m.type === "replay").map((m) => m.observation);
  assert.equal(ctx.run.engine!.awaitingHostAnswer, true);
  assert.equal(observations().length, 1);
  assert.equal(observations()[0]!.blocked, "getnum");
  assert.equal(observations()[0]!.revision, 1);

  ctx.fns.onReplayAdvance({ type: "replayAdvance", id: 7, ticks: 10 });
  assert.equal(ctx.replay.replay.tick, 0, "a parked wait consumes no replay ticks");
  assert.equal(
    observations().length,
    1,
    "no further observation posts while the request is in flight",
  );

  ctx.fns.onHostAnswer({
    type: "hostAnswer",
    generation: ctx.run.generation,
    id: 1,
    response: "42",
  });
  assert.equal(ctx.run.engine!.vars[100], 42);
  assert.equal(ctx.run.engine!.vars[101], 7, "the resumed pass completed");
  const after = observations();
  assert.equal(after.length, 2, "the answer's delivery posts the unblocked observation");
  assert.equal(after[1]!.blocked, null);
  assert.equal(after[1]!.revision, 2);
});

test("a checkpoint snapshot restores the replay head and replays the gap identically", () => {
  const container = countingGame();
  const { ctx, control } = workerHarness(container);
  ctx.boot.currentBootFiles = new Map(container.files);
  ctx.boot.currentDictionary = new Map();
  ctx.boot.liveDictionary = new Map();
  ctx.replay.replay = { tick: 0, revision: 0 };
  ctx.run.rng.word = 1;
  ctx.replay.currentSessionId = 7;

  ctx.fns.onReplayAdvance({ type: "replayAdvance", id: 1, ticks: 60, sessionId: 7 });
  assert.equal(ctx.replay.replay.tick, 60);
  const atSnapshot = ctx.run.engine!.vars[100]!;
  assert.ok(atSnapshot > 0, "the tape advanced the counter");
  ctx.fns.onReplaySnapshot({ type: "replaySnapshot", sessionId: 7 });
  assert.equal(ctx.replay.snapshots.size, 1);

  ctx.fns.onReplayAdvance({ type: "replayAdvance", id: 2, ticks: 40, sessionId: 7 });
  ctx.fns.onReplaySnapshot({ type: "replaySnapshot", sessionId: 7 });
  const atHundred = ctx.run.engine!.vars[100]!;
  assert.ok(atHundred > atSnapshot);
  assert.equal(ctx.replay.snapshots.size, 2);

  // A seek to tick 80 lands on the tick-60 snapshot — the nearest at or before.
  ctx.fns.onReplayRestore({ type: "replayRestore", id: 9, tick: 80, sessionId: 7 });
  assert.equal(ctx.replay.replay.tick, 60);
  assert.equal(ctx.run.engine!.vars[100], atSnapshot, "the captured state returns");
  const restored = control.filter((m) => m.type === "replay").at(-1)!;
  assert.equal(restored.id, 9, "the restored observation answers the query");
  assert.equal(restored.observation.tick, 60);

  ctx.fns.onReplayAdvance({ type: "replayAdvance", id: 3, ticks: 40, sessionId: 7 });
  assert.equal(ctx.replay.replay.tick, 100);
  assert.equal(ctx.run.engine!.vars[100], atHundred, "the gap replays deterministically");
});

test("replayRestore without a covering snapshot reboots to tick 0, and a reset drops them", () => {
  const container = countingGame();
  const { ctx } = workerHarness(container);
  ctx.boot.currentBootFiles = new Map(container.files);
  ctx.boot.currentDictionary = new Map();
  ctx.boot.liveDictionary = new Map();
  ctx.replay.replay = { tick: 0, revision: 0 };
  ctx.run.rng.word = 1;
  ctx.replay.currentSessionId = 7;

  ctx.fns.onReplayAdvance({ type: "replayAdvance", id: 1, ticks: 60, sessionId: 7 });
  ctx.fns.onReplaySnapshot({ type: "replaySnapshot", sessionId: 7 });
  assert.equal(ctx.replay.snapshots.size, 1);

  // The only snapshot sits at tick 60 — past the target — so the replay
  // rebuilds from the boot.
  ctx.fns.onReplayRestore({ type: "replayRestore", id: 9, tick: 30, sessionId: 7 });
  assert.equal(ctx.replay.replay.tick, 0);
  assert.equal(ctx.run.engine!.vars[100], 0, "a fresh engine carries no tape progress");

  // Snapshots from a previous tape must never land on a new trajectory.
  ctx.fns.onReplayAdvance({ type: "replayAdvance", id: 2, ticks: 60, sessionId: 7 });
  ctx.fns.onReplaySnapshot({ type: "replaySnapshot", sessionId: 7 });
  assert.equal(ctx.replay.snapshots.size, 1);
  ctx.fns.onResetReplay({ type: "resetReplay", sessionId: 8 });
  assert.equal(ctx.replay.snapshots.size, 0, "a new tape starts without stale restore points");
});

test("an acknowledged replay pause cancels every scheduled advance tick", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ctx, control } = workerHarness(countingGame());
  ctx.replay.replay = { tick: 0, revision: 0 };
  ctx.run.rng.word = 1;
  ctx.replay.currentSessionId = 7;
  onWorkerMessage(ctx, { type: "replayAdvance", id: 1, ticks: 1000, sessionId: 7 });
  onWorkerMessage(ctx, { type: "replayPause", id: 99, sessionId: 8 });
  assert.equal(ctx.replay.replayRequest, 1, "a stale session cannot interrupt the advance");
  const stoppedTick = ctx.replay.replay.tick;
  assert.ok(stoppedTick > 0 && stoppedTick < 1000, "the advance is between chunks");
  onWorkerMessage(ctx, { type: "replayPause", id: 2, sessionId: 7 });
  const ack = control.at(-1);
  assert.ok(ack?.type === "replay" && ack.id === 2);
  assert.equal(ack.observation.tick, stoppedTick);
  const interrupted = control.find((msg) => msg.type === "replay" && msg.id === 1);
  assert.ok(interrupted?.type === "replay");
  assert.equal(
    interrupted.observation.tick,
    stoppedTick,
    "the advance settles at its partial position",
  );
  t.mock.timers.runAll();
  assert.equal(ctx.replay.replay.tick, stoppedTick, "zero ticks after the pause acknowledgement");
  onWorkerMessage(ctx, { type: "replayAdvance", id: 3, ticks: 1000 - stoppedTick, sessionId: 7 });
  t.mock.timers.runAll();
  assert.equal(ctx.replay.replay.tick, 1000, "resume consumes exactly the remaining tape ticks");
});

test("a rejected tape snapshot preserves the live sound, parked print and replay head", () => {
  const container = gameContainer(['load.sound(0);sound(0,f60);print("Wait");return;'], (c) =>
    c.putResource(
      "sound",
      0,
      buildSound([{ notes: [{ duration: 1000, freqDivisor: 226, attenuation: 0 }] }]),
    ),
  );
  const { ctx, control, presentation } = workerHarness(container);
  ctx.boot.currentBootFiles = new Map(container.files);
  ctx.boot.currentDictionary = new Map();
  ctx.fns.tickEngine();
  ctx.replay.replay = { tick: 27, revision: 4 };
  ctx.replay.currentSessionId = 7;
  ctx.fns.onReplaySnapshot({ type: "replaySnapshot", sessionId: 7 });
  const snapshot = ctx.replay.snapshots.get(27);
  assert.ok(snapshot);
  snapshot.image = Uint8Array.of(0);
  const run = ctx.run;
  const before = structuredClone(ctx.replay);
  const output = [control.length, presentation.length];
  assert.equal(run.engine!.flags[60], 0);
  assert.equal(run.engine!.modalKind, "print");
  assert.throws(() =>
    ctx.fns.onReplayRestore({ type: "replayRestore", id: 9, tick: 27, sessionId: 8 }),
  );
  assert.equal(ctx.run, run);
  assert.equal(run.engine!.flags[60], 0);
  assert.equal(run.engine!.modalKind, "print");
  assert.deepEqual(ctx.replay, before);
  assert.deepEqual([control.length, presentation.length], output);
});

for (const hold of ["owner", "debugger"] as const) {
  test(`replay adoption rejects the abandoned serial before the ${hold} queue`, (t) => {
    const container = gameContainer(
      [
        "if(equaln(v0,0)){new.room(1);}call.v(v0);return;",
        'if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();}if(isset(f70)){get.num("Number?",v80);}return;',
      ],
      (c) => c.putResource("picture", 1, PICTURE_1),
    );
    const { ctx, control } = workerHarness(container);
    t.after(() => ctx.fns.stopTimers());
    ctx.boot.currentBootFiles = new Map(container.files);
    ctx.boot.currentDictionary = new Map();
    ctx.fns.tickEngine();
    ctx.run.engine!.flags[70] = 1;
    ctx.replay.replay = { tick: 0, revision: 0 };
    ctx.fns.onReplaySnapshot({ type: "replaySnapshot" });
    assert.equal(ctx.replay.snapshots.size, 1);
    ctx.fns.tickEngine();
    const old = control.findLast((m) => m.type === "hostRequest");
    assert.ok(old?.type === "hostRequest");
    ctx.fns.onReplayRestore({ type: "replayRestore", id: 1, tick: 0 });
    ctx.fns.tickEngine();
    const next = control.findLast((m) => m.type === "hostRequest");
    assert.ok(next?.type === "hostRequest" && next !== old);
    assert.equal(next.id, old.id);
    if (hold === "owner") onWorkerMessage(ctx, { type: "playOwner", active: false, generation: 1 });
    else {
      ctx.fns.onExitReplay();
      ctx.fns.onDebugAttach({ type: "debugAttach", id: 1 });
      const epoch = ctx.run.debugger.epoch;
      ctx.fns.onDebugPause({ type: "debugPause", id: 2, epoch });
      assert.equal(ctx.fns.debugStoppedHeld(), true);
    }
    ctx.fns.onHostAnswer({
      type: "hostAnswer",
      generation: old.generation,
      id: old.id,
      response: "77",
    });
    assert.equal(ctx.run.owner.answers.length, 0);
    assert.equal(ctx.run.debugger.queuedAnswers.length, 0);
    assert.equal(ctx.run.engine!.vars[80], 0);
    ctx.fns.onHostAnswer({
      type: "hostAnswer",
      generation: next.generation,
      id: next.id,
      response: "9",
    });
    const queued = hold === "owner" ? ctx.run.owner.answers : ctx.run.debugger.queuedAnswers;
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.generation, next.generation);
    if (hold === "owner") onWorkerMessage(ctx, { type: "playOwner", active: true, generation: 2 });
    else
      ctx.fns.onDebugResume({
        type: "debugResume",
        id: 3,
        epoch: ctx.run.debugger.epoch,
        stopId: ctx.run.debugger.stopId!,
        action: "continue",
      });
    assert.equal(ctx.run.engine!.vars[80], 9);
  });
}
