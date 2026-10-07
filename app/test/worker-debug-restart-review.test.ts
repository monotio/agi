import assert from "node:assert/strict";
import { test } from "node:test";
import { gameContainer, workerHarness } from "./worker-ctx.ts";

// The accepted restart resets this same Engine; its debugger identity must
// change even when the authored bytes and Engine object remain unchanged.
test("an accepted in-game restart revokes the prior debugger epoch", () => {
  const source = `if (isset(f6)) { reset(f6); assignn(v40, 1); return; }
set(f16);
assignn(v40, 7);
restart.game();
return;`;
  const { ctx, control } = workerHarness(gameContainer([source]));
  const engine = ctx.run.engine;
  ctx.fns.onDebugAttach({ type: "debugAttach", id: 1, sources: { "0": source } });
  const attached = control.find((m) => m.type === "debugAttached");
  assert.ok(attached?.type === "debugAttached");
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine, engine, "native restart retains the Engine instance");
  assert.equal(engine?.vars[40], 1, "the accepted restart ran its initial logic");
  assert.ok(ctx.run.debugger.epoch > attached.epoch, "the reset run needs a new debugger epoch");
  const reset = control.find((m) => m.type === "debugSessionReset");
  assert.ok(reset?.type === "debugSessionReset");
  assert.equal(reset.epoch, ctx.run.debugger.epoch);
  ctx.fns.onDebugPause({ type: "debugPause", id: 2, epoch: attached.epoch });
  const rejected = control.find((m) => m.type === "debugError" && m.id === 2);
  assert.ok(rejected?.type === "debugError", "an outgoing command must not pause the reset run");
  assert.equal(ctx.run.engine?.executionStopInfo, null);
});
