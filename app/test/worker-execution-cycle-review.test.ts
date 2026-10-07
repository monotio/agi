import assert from "node:assert/strict";
import { test } from "node:test";
import { gameContainer, workerHarness } from "./worker-ctx.ts";

test("an execution stop before the first action completes no worker cycle", () => {
  const { ctx } = workerHarness(gameContainer(["assignn(v40, 1); return;"]));
  ctx.run.engine!.setExecutionGate(() => true);
  const completed = ctx.fns.stepHostTick(100, { cycle: true, sound: 0 });
  assert.equal(ctx.run.engine!.executionStop?.pc, 0);
  assert.equal(ctx.run.engine!.vars[40], 0);
  assert.equal(ctx.run.cycle.cycleCount, 0);
  assert.equal(completed, false);
});

test("resuming a stopped pass counts its real completion exactly once", () => {
  const { ctx } = workerHarness(gameContainer(["assignn(v40, 1); return;"]));
  let stop = true;
  ctx.run.engine!.setExecutionGate(() => stop);
  ctx.fns.stepHostTick(100, { cycle: true, sound: 0 });
  const before = ctx.run.cycle.cycleCount;
  stop = false;
  ctx.run.engine!.resumeExecution();
  assert.equal(ctx.fns.stepHostTick(101, { cycle: false, sound: 0 }), true);
  assert.equal(ctx.run.cycle.cycleCount, before + 1);
  assert.equal(ctx.run.engine!.vars[40], 1);
  assert.equal(ctx.fns.stepHostTick(102, { cycle: false, sound: 0 }), false);
  assert.equal(ctx.run.cycle.cycleCount, before + 1);
});

test("cooperative execution slices share one completed cycle", () => {
  const source = `${"assignn(v40, 1); ".repeat(1025)} assignn(v41, 7); return;`;
  const { ctx } = workerHarness(gameContainer([source]));
  ctx.run.engine!.setExecutionGate(() => false);
  assert.equal(ctx.fns.stepHostTick(100, { cycle: true, sound: 0 }), false);
  assert.equal(ctx.run.engine!.executionYieldPending, true);
  assert.equal(ctx.run.cycle.cycleCount, 0);
  assert.equal(ctx.fns.stepHostTick(101, { cycle: false, sound: 0 }), true);
  assert.equal(ctx.run.engine!.vars[41], 7);
  assert.equal(ctx.run.cycle.cycleCount, 1);
});

test("a host answer completing a controlled pass counts it at that entry", () => {
  const { ctx, control } = workerHarness(
    gameContainer(['#message 1 "How many?"\nget.num(1, v100); assignn(v101, 7); return;']),
  );
  ctx.run.engine!.setExecutionGate(() => false);
  ctx.fns.tickEngine();
  assert.equal(ctx.run.cycle.cycleCount, 0);
  const request = control.find((message) => message.type === "hostRequest");
  assert.ok(request?.type === "hostRequest");
  ctx.fns.onHostAnswer({
    type: "hostAnswer",
    generation: ctx.run.generation,
    id: request.id,
    response: "5",
  });
  assert.equal(ctx.run.engine!.vars[100], 5);
  assert.equal(ctx.run.engine!.vars[101], 7);
  assert.equal(ctx.run.cycle.cycleCount, 1);
  ctx.fns.stepHostTick(100, { cycle: false, sound: 0 });
  assert.equal(ctx.run.cycle.cycleCount, 1);
});

test("a key completing a controlled wait counts its cycle once", () => {
  const { ctx } = workerHarness(
    gameContainer(["wait: if (!have.key()) { goto wait; } assignn(v101, 7); return;"]),
  );
  ctx.run.engine!.setExecutionGate(() => false);
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.awaitingKey, true);
  assert.equal(ctx.run.cycle.cycleCount, 0);
  ctx.fns.onKey({ type: "key", code: 0x62 });
  assert.equal(ctx.run.engine!.vars[101], 7);
  assert.equal(ctx.run.cycle.cycleCount, 1);
});

test("Play here stopped at room entry completes no controlled cycle", () => {
  const { ctx } = workerHarness(gameContainer(["return;", "assignn(v40, 1); return;"]));
  // This unit contract isolates cycle accounting. Debug-session history
  // admission is separate: a parked instruction cannot become a replay boot.
  ctx.fns.historyResume = () => {};
  ctx.run.engine!.setExecutionGate(() => true);
  const before = ctx.run.cycle.cycleCount;
  ctx.fns.onPlayHere({ type: "playHere", id: 1, room: 1, x: 40, y: 120 });
  assert.ok(ctx.run.engine!.executionStop);
  assert.equal(ctx.run.engine!.vars[40], 0);
  assert.equal(ctx.run.cycle.cycleCount, before);
});
