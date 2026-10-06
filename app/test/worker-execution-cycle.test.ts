import assert from "node:assert/strict";
import { test } from "node:test";
import { gameContainer, workerHarness } from "./worker-ctx.ts";

test("a resumed pass that stops again still counts no cycle", () => {
  const { ctx } = workerHarness(gameContainer(["assignn(v40, 1); assignn(v41, 2); return;"]));
  ctx.run.engine!.setExecutionGate(() => true);
  assert.equal(ctx.fns.stepHostTick(100, { cycle: true, sound: 0 }), false);
  assert.equal(ctx.run.cycle.cycleCount, 0);
  // A parked tick while still stopped completes nothing.
  assert.equal(ctx.fns.stepHostTick(101, { cycle: true, sound: 0 }), false);
  assert.equal(ctx.run.cycle.cycleCount, 0);
  ctx.run.engine!.resumeExecution();
  // The pass advanced one action and stopped at the next boundary.
  assert.equal(ctx.fns.stepHostTick(102, { cycle: false, sound: 0 }), false);
  assert.equal(ctx.run.engine!.vars[40], 1);
  assert.ok(ctx.run.engine!.executionStop);
  assert.equal(ctx.run.cycle.cycleCount, 0);
  ctx.run.engine!.resumeExecution();
  assert.equal(ctx.fns.stepHostTick(103, { cycle: false, sound: 0 }), false);
  assert.equal(ctx.run.engine!.vars[41], 2);
  ctx.run.engine!.resumeExecution();
  assert.equal(ctx.fns.stepHostTick(104, { cycle: false, sound: 0 }), true);
  assert.equal(ctx.run.cycle.cycleCount, 1);
  // The next pass stops at its first boundary — still no count.
  assert.equal(ctx.fns.stepHostTick(105, { cycle: true, sound: 0 }), false);
  assert.equal(ctx.run.cycle.cycleCount, 1);
});

test("a host answer that re-suspends counts nothing until the pass finishes", () => {
  const { ctx, control } = workerHarness(
    gameContainer([
      '#message 1 "A?"\nget.num(1, v100);\n#message 2 "B?"\nget.num(2, v101); assignn(v102, 9); return;',
    ]),
  );
  ctx.run.engine!.setExecutionGate(() => false);
  ctx.fns.tickEngine();
  assert.equal(ctx.run.cycle.cycleCount, 0);
  const requests = control.filter((message) => message.type === "hostRequest");
  assert.equal(requests.length, 1);
  ctx.fns.onHostAnswer({ type: "hostAnswer", id: requests[0]!.id, response: "3" });
  // The resumed pass ran on and suspended on the second get.num.
  assert.equal(ctx.run.engine!.vars[100], 3);
  assert.equal(ctx.run.engine!.vars[102], 0);
  assert.equal(ctx.run.cycle.cycleCount, 0);
  const second = control.filter((message) => message.type === "hostRequest").at(-1)!;
  assert.notEqual(second.id, requests[0]!.id);
  ctx.fns.onHostAnswer({ type: "hostAnswer", id: second.id, response: "4" });
  assert.equal(ctx.run.engine!.vars[101], 4);
  assert.equal(ctx.run.engine!.vars[102], 9);
  assert.equal(ctx.run.cycle.cycleCount, 1);
  // No later entry can count that completion twice.
  assert.equal(ctx.fns.stepHostTick(100, { cycle: false, sound: 0 }), false);
  assert.equal(ctx.run.cycle.cycleCount, 1);
});

test("a faulted controlled pass never counts a cycle", () => {
  const { ctx } = workerHarness(gameContainer(["call(42); return;"]));
  ctx.run.engine!.setExecutionGate(() => false);
  assert.throws(() => ctx.fns.tickEngine(), /logic resource 42/);
  assert.equal(ctx.run.cycle.cycleCount, 0);
  // The fault stays latched; later entries rethrow and count nothing.
  assert.throws(() => ctx.fns.stepHostTick(100, { cycle: true, sound: 0 }), /logic resource 42/);
  assert.equal(ctx.run.cycle.cycleCount, 0);
});
