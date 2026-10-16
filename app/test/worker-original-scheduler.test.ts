import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../../src/runtime/engine.ts";
import { configureSessionTiming } from "../src/worker/session.ts";
import { gameContainer, workerHarness } from "./worker-ctx.ts";

test("worker clocks keep ordinary print waits visible to the resumed script", () => {
  const { ctx } = workerHarness(
    gameContainer(['assignn(v10,2);print("Wait.");assignv(v100,v11);return;']),
  );
  ctx.fns.tickEngine();
  ctx.fns.stepHostTick(1000);
  assert.equal(ctx.run.engine!.vars[11], 1);
  assert.equal(ctx.run.engine!.vars[100], 0);
  ctx.run.engine!.ackPrint();
  ctx.fns.stepHostTick(1000);
  assert.equal(ctx.run.engine!.vars[100], 1);
});

test("worker pause preserves pacing phase without banking suspended timer time", () => {
  const { ctx } = workerHarness(
    gameContainer(["if(!isset(f200)){set(f200);assignn(v10,4);pause();}increment(v100);return;"]),
  );
  ctx.run.clocks.cycle.poll(75, 4);
  ctx.fns.tickEngine();
  ctx.fns.stepHostTick(1075);
  ctx.run.engine!.ackPrint();
  ctx.fns.stepHostTick(1075);
  assert.equal(ctx.run.engine!.vars[100], 1, "finish the suspended invocation");
  ctx.fns.stepHostTick(1199);
  assert.equal(ctx.run.engine!.vars[100], 1, "only 199ms of unpaused pacing elapsed");
  ctx.fns.stepHostTick(1200);
  assert.equal(ctx.run.engine!.vars[100], 2, "preserved phase reaches four increments");
});

for (const action of ["save.game();", "restore.game();"]) {
  test(`worker ${action} freezes timer services throughout the pending selector`, () => {
    const { ctx } = workerHarness(gameContainer([`${action}increment(v100);return;`]));
    ctx.fns.tickEngine();
    assert.ok(ctx.run.engine!.hostInteractionPending);
    ctx.fns.stepHostTick(1000);
    assert.equal(ctx.run.engine!.vars[11], 0);
    assert.equal(ctx.run.engine!.vars[100], 0);
  });
}

test("worker input editor waits keep timer services running without another script pass", () => {
  const { ctx } = workerHarness(gameContainer(['get.num("Number?",v100);increment(v101);return;']));
  ctx.fns.tickEngine();
  ctx.fns.stepHostTick(1000);
  assert.equal(ctx.run.engine!.vars[11], 1);
  assert.equal(ctx.run.engine!.vars[101], 0);
  ctx.run.engine!.deliverHostAnswer("7");
  ctx.fns.stepHostTick(1000);
  assert.equal(ctx.run.engine!.vars[100], 7);
  assert.equal(ctx.run.engine!.vars[101], 1);
});

test("ordinary wait pacing survives a directly following interpreter pause", () => {
  const { ctx } = workerHarness(
    gameContainer([
      'if(!isset(f200)){set(f200);assignn(v10,4);print("Wait.");pause();}increment(v100);return;',
    ]),
  );
  ctx.fns.tickEngine();
  ctx.fns.stepHostTick(1000);
  ctx.run.engine!.ackPrint();
  ctx.fns.stepHostTick(1000);
  assert.equal(ctx.run.engine!.timerPaused, true);
  ctx.fns.stepHostTick(2000);
  ctx.run.engine!.ackPrint();
  ctx.fns.stepHostTick(2000);
  assert.equal(ctx.run.engine!.vars[100], 1);
  ctx.fns.stepHostTick(2001);
  assert.equal(
    ctx.run.engine!.vars[100],
    2,
    "ordinary wait already supplied the pacing increments",
  );
});

test("worker 2.001 profile runs sound and cycle clocks at the 18.2065 Hz BIOS tick and freezes pacing on pause", () => {
  // docs/fidelity.md "PC booter clock": one tick is 65536 / 1193182 s.
  const tickMs = 65_536_000 / 1_193_182;
  const container = gameContainer([
    "if(!isset(f200)){set(f200);assignn(v10,2);pause();}increment(v100);return;",
  ]);
  const { ctx } = workerHarness(container);
  ctx.run.engine = new Engine(container, ctx.host, new Map(), { profile: "2.001" });
  ctx.run.engine.flags[9] = 1;
  configureSessionTiming(ctx);
  assert.equal(ctx.run.clocks.sound.hz, 1000 / tickMs);
  assert.equal(ctx.run.clocks.cycle.incrementMs, tickMs);
  // Advance 40 ms before pause (< 1 tick of 54.925 ms).
  ctx.fns.stepHostTick(40);
  assert.equal(ctx.run.engine!.timerPaused, true);
  // 1000 ms while timerPaused: both sound and cycle clocks freeze and rebase.
  ctx.fns.stepHostTick(1040);
  assert.equal(ctx.run.engine!.vars[11], 0);
  ctx.run.engine!.ackPrint();
  ctx.fns.stepHostTick(1040);
  assert.equal(ctx.run.engine!.vars[100], 1, "resumed pass completes");
  // Preserved 40 ms phase + 69 ms = 109 ms < 2 ticks = 109.85 ms.
  ctx.fns.stepHostTick(1109);
  assert.equal(ctx.run.engine!.vars[100], 1, "two ticks need 109.85 ms");
  ctx.fns.stepHostTick(1110);
  assert.equal(ctx.run.engine!.vars[100], 2, "two ticks reached at 110 ms");
});
