import assert from "node:assert/strict";
import { test } from "node:test";
import { gameContainer, workerHarness } from "./worker-ctx.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";

test("a detached boot uses the requested sound device before publishing its engine", (t) => {
  const container = gameContainer(["return;"]);
  const { ctx } = workerHarness(container);
  t.after(() => ctx.fns.stopTimers());
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(container.files),
    words: [],
    soundDevice: 0,
  });
  assert.equal(ctx.run.engine!.vars[22], 1);
});

test("losing play ownership holds a host answer until a newer generation takes it back", () => {
  const { ctx, control } = workerHarness(
    gameContainer(['get.num("Number?",v80);increment(v81);return;']),
  );
  ctx.fns.tickEngine();
  const request = control.find((msg) => msg.type === "hostRequest");
  assert.ok(request?.type === "hostRequest");
  onWorkerMessage(ctx, { type: "playOwner", active: false, generation: 2 });
  onWorkerMessage(ctx, { type: "hostAnswer", id: request.id, response: "9" });
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.vars[80], 0);
  assert.equal(ctx.run.engine!.vars[81], 0);
  onWorkerMessage(ctx, { type: "playOwner", active: true, generation: 1 });
  assert.equal(ctx.run.owner.active, false);
  onWorkerMessage(ctx, { type: "playOwner", active: true, generation: 3 });
  assert.equal(ctx.run.engine!.vars[80], 9);
  assert.equal(ctx.run.engine!.vars[81], 1);
  assert.equal(ctx.run.owner.answers.length, 0);
});

test("an older tab's keys and dismissals leave its parked print unchanged", () => {
  const { ctx } = workerHarness(gameContainer(['print("Wait");assignn(v80,9);return;']));
  ctx.fns.tickEngine();
  const before = ctx.run.engine!.recordingImage();
  onWorkerMessage(ctx, { type: "playOwner", active: false, generation: 2 });
  onWorkerMessage(ctx, { type: "key", code: 13 });
  onWorkerMessage(ctx, { type: "dismissPrint" });
  assert.equal(ctx.run.engine!.vars[80], 0);
  assert.deepEqual(ctx.run.engine!.recordingImage(), before);
  assert.equal(ctx.run.input.keyQueue.length, 0);
});

test("a rejected boot preserves the existing question and replay driver", () => {
  const container = gameContainer(['get.num("Number?",v80);return;']);
  const { ctx, control } = workerHarness(container);
  ctx.fns.tickEngine();
  ctx.replay.currentSessionId = 7;
  ctx.replay.replay = { tick: 27, revision: 4 };
  ctx.replay.reseeds = [321];
  ctx.replay.reseedCursor = 1;
  const run = ctx.run;
  const before = structuredClone(ctx.replay);
  const request = run.hostRequests.hostRequestOutstanding;
  assert.ok(request);
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(container.files),
    words: [],
    restoreRng: { word: -1, policy: { kind: "external" } },
  });
  assert.ok(control.findLast((message) => message.type === "error"));
  assert.equal(ctx.run, run);
  assert.equal(run.hostRequests.hostRequestOutstanding, request);
  assert.deepEqual(ctx.replay, before);
});

test("a seeded replay boot keeps its cold entropy policy when seeking before a snapshot", () => {
  for (const seed of [0, 58235]) {
    const container = gameContainer(["return;"]);
    const { ctx } = workerHarness(container);
    onWorkerMessage(ctx, {
      type: "boot",
      files: Object.fromEntries(container.files),
      words: [],
      replaySeed: seed,
      replayRngVersion: 2,
    });
    ctx.host.randomByte!();
    ctx.fns.onReplayRestore({ type: "replayRestore", id: 9, tick: 0 });
    assert.deepEqual(ctx.run.rng, {
      word: seed,
      policy: { kind: "sequence", next: seed, cursor: 0 },
    });
  }
});
