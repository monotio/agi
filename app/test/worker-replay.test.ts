import { test } from "node:test";
import assert from "node:assert/strict";
import { gameContainer, workerHarness } from "./worker-ctx.ts";
import type { GameContainer } from "../../src/types.ts";

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
  ctx.replay.replay = { tick: 0, revision: 0, random: 0 };
  ctx.fns.tickEngine(); // parks on get.num; postHostRequest posts the blocked observation

  const observations = () => control.filter((m) => m.type === "replay").map((m) => m.observation);
  assert.equal(ctx.engine!.awaitingHostAnswer, true);
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

  ctx.fns.onHostAnswer({ type: "hostAnswer", id: 1, response: "42" });
  assert.equal(ctx.engine!.vars[100], 42);
  assert.equal(ctx.engine!.vars[101], 7, "the resumed pass completed");
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
  ctx.replay.replay = { tick: 0, revision: 0, random: 1 };
  ctx.replay.currentSessionId = 7;

  ctx.fns.onReplayAdvance({ type: "replayAdvance", id: 1, ticks: 60, sessionId: 7 });
  assert.equal(ctx.replay.replay.tick, 60);
  const atSnapshot = ctx.engine!.vars[100]!;
  assert.ok(atSnapshot > 0, "the tape advanced the counter");
  ctx.fns.onReplaySnapshot({ type: "replaySnapshot", sessionId: 7 });
  assert.equal(ctx.replay.snapshots.size, 1);

  ctx.fns.onReplayAdvance({ type: "replayAdvance", id: 2, ticks: 40, sessionId: 7 });
  ctx.fns.onReplaySnapshot({ type: "replaySnapshot", sessionId: 7 });
  const atHundred = ctx.engine!.vars[100]!;
  assert.ok(atHundred > atSnapshot);
  assert.equal(ctx.replay.snapshots.size, 2);

  // A seek to tick 80 lands on the tick-60 snapshot — the nearest at or before.
  ctx.fns.onReplayRestore({ type: "replayRestore", id: 9, tick: 80, sessionId: 7 });
  assert.equal(ctx.replay.replay.tick, 60);
  assert.equal(ctx.engine!.vars[100], atSnapshot, "the captured state returns");
  const restored = control.filter((m) => m.type === "replay").at(-1)!;
  assert.equal(restored.id, 9, "the restored observation answers the query");
  assert.equal(restored.observation.tick, 60);

  ctx.fns.onReplayAdvance({ type: "replayAdvance", id: 3, ticks: 40, sessionId: 7 });
  assert.equal(ctx.replay.replay.tick, 100);
  assert.equal(ctx.engine!.vars[100], atHundred, "the gap replays deterministically");
});

test("replayRestore without a covering snapshot reboots to tick 0, and a reset drops them", () => {
  const container = countingGame();
  const { ctx } = workerHarness(container);
  ctx.boot.currentBootFiles = new Map(container.files);
  ctx.boot.currentDictionary = new Map();
  ctx.boot.liveDictionary = new Map();
  ctx.replay.replay = { tick: 0, revision: 0, random: 1 };
  ctx.replay.currentSessionId = 7;

  ctx.fns.onReplayAdvance({ type: "replayAdvance", id: 1, ticks: 60, sessionId: 7 });
  ctx.fns.onReplaySnapshot({ type: "replaySnapshot", sessionId: 7 });
  assert.equal(ctx.replay.snapshots.size, 1);

  // The only snapshot sits at tick 60 — past the target — so the replay
  // rebuilds from the boot.
  ctx.fns.onReplayRestore({ type: "replayRestore", id: 9, tick: 30, sessionId: 7 });
  assert.equal(ctx.replay.replay.tick, 0);
  assert.equal(ctx.engine!.vars[100], 0, "a fresh engine carries no tape progress");

  // Snapshots from a previous tape must never land on a new trajectory.
  ctx.fns.onReplayAdvance({ type: "replayAdvance", id: 2, ticks: 60, sessionId: 7 });
  ctx.fns.onReplaySnapshot({ type: "replaySnapshot", sessionId: 7 });
  assert.equal(ctx.replay.snapshots.size, 1);
  ctx.fns.onResetReplay({ type: "resetReplay", sessionId: 8 });
  assert.equal(ctx.replay.snapshots.size, 0, "a new tape starts without stale restore points");
});
