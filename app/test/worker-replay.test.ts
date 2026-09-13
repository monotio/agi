import { test } from "node:test";
import assert from "node:assert/strict";
import { gameContainer, workerHarness } from "./worker-ctx.ts";

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
