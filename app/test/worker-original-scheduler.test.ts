import assert from "node:assert/strict";
import { test } from "node:test";
import { gameContainer, workerHarness } from "./worker-ctx.ts";

test("worker clocks keep ordinary print waits visible to the resumed script", () => {
  const { ctx } = workerHarness(
    gameContainer(['assignn(v10,2);print("Wait.");assignv(v100,v11);return;']),
  );
  ctx.fns.tickEngine();
  ctx.fns.stepHostTick(1000);
  assert.equal(ctx.engine!.vars[11], 1);
  assert.equal(ctx.engine!.vars[100], 0);
  ctx.engine!.ackPrint();
  ctx.fns.stepHostTick(1000);
  assert.equal(ctx.engine!.vars[100], 1);
});

test("worker pause preserves pacing phase without banking suspended timer time", () => {
  const { ctx } = workerHarness(
    gameContainer(["if(!isset(f200)){set(f200);assignn(v10,4);pause();}increment(v100);return;"]),
  );
  ctx.clocks.cycle.poll(75, 4);
  ctx.fns.tickEngine();
  ctx.fns.stepHostTick(1075);
  ctx.engine!.ackPrint();
  ctx.fns.stepHostTick(1075);
  assert.equal(ctx.engine!.vars[100], 1, "finish the suspended invocation");
  ctx.fns.stepHostTick(1199);
  assert.equal(ctx.engine!.vars[100], 1, "only 199ms of unpaused pacing elapsed");
  ctx.fns.stepHostTick(1200);
  assert.equal(ctx.engine!.vars[100], 2, "preserved phase reaches four increments");
});

for (const action of ["save.game();", "restore.game();"]) {
  test(`worker ${action} freezes timer services throughout the pending selector`, () => {
    const { ctx } = workerHarness(gameContainer([`${action}increment(v100);return;`]));
    ctx.fns.tickEngine();
    assert.ok(ctx.engine!.hostInteractionPending);
    ctx.fns.stepHostTick(1000);
    assert.equal(ctx.engine!.vars[11], 0);
    assert.equal(ctx.engine!.vars[100], 0);
  });
}

test("worker input editor waits keep timer services running without another script pass", () => {
  const { ctx } = workerHarness(gameContainer(['get.num("Number?",v100);increment(v101);return;']));
  ctx.fns.tickEngine();
  ctx.fns.stepHostTick(1000);
  assert.equal(ctx.engine!.vars[11], 1);
  assert.equal(ctx.engine!.vars[101], 0);
  ctx.engine!.deliverHostAnswer("7");
  ctx.fns.stepHostTick(1000);
  assert.equal(ctx.engine!.vars[100], 7);
  assert.equal(ctx.engine!.vars[101], 1);
});

test("ordinary wait pacing survives a directly following interpreter pause", () => {
  const { ctx } = workerHarness(
    gameContainer([
      'if(!isset(f200)){set(f200);assignn(v10,4);print("Wait.");pause();}increment(v100);return;',
    ]),
  );
  ctx.fns.tickEngine();
  ctx.fns.stepHostTick(1000);
  ctx.engine!.ackPrint();
  ctx.fns.stepHostTick(1000);
  assert.equal(ctx.engine!.timerPaused, true);
  ctx.fns.stepHostTick(2000);
  ctx.engine!.ackPrint();
  ctx.fns.stepHostTick(2000);
  assert.equal(ctx.engine!.vars[100], 1);
  ctx.fns.stepHostTick(2001);
  assert.equal(ctx.engine!.vars[100], 2, "ordinary wait already supplied the pacing increments");
});
