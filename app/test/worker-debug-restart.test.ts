import assert from "node:assert/strict";
import { test } from "node:test";
import { gameContainer, workerHarness, type WorkerHarness } from "./worker-ctx.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerInbound } from "../src/worker/workerProtocol.ts";

/**
 * In-place restart.game against an attached debugger session: the same
 * Engine object keeps serving a different run, so the session's epoch,
 * stops, plans and queued answers all had to be re-minted — the engine's
 * run-reset serial is the witness.
 */

function send(ctx: WorkerHarness["ctx"], msg: WorkerInbound): void {
  onWorkerMessage(ctx, msg);
}

function controls(h: WorkerHarness, type: string): Record<string, unknown>[] {
  return h.control.filter((m) => m.type === type) as Record<string, unknown>[];
}

function lastControl(h: WorkerHarness, type: string): Record<string, unknown> {
  const found = controls(h, type);
  assert.ok(found.length > 0, `expected a ${type} message`);
  return found.at(-1)!;
}

function attach(
  h: WorkerHarness,
  sources?: Record<string, string>,
): { epoch: number; buildId: string } {
  send(h.ctx, { type: "debugAttach", id: 1, ...(sources ? { sources } : {}) });
  const reply = lastControl(h, "debugAttached");
  return { epoch: reply["epoch"] as number, buildId: reply["buildId"] as string };
}

const BYPASS = `if (isset(f6)) { reset(f6); assignn(v40, 1); return; }
set(f16);
assignn(v40, 7);
restart.game();
return;`;

test("an f16 bypass restart mints a fresh epoch and strands the old session", () => {
  const h = workerHarness(gameContainer([BYPASS]));
  const engine = h.ctx.run.engine!;
  const { epoch, buildId } = attach(h, { "0": BYPASS });
  assert.equal(engine.runResetSerial, 0);

  h.ctx.fns.tickEngine();
  assert.equal(h.ctx.run.engine, engine, "the in-place restart kept the Engine instance");
  assert.equal(engine.runResetSerial, 1, "the engine witnessed one accepted restart");
  assert.equal(engine.vars[40], 1, "the reset run's initial logic executed");
  assert.equal(h.ctx.run.debugger.epoch, epoch + 1, "exactly one fresh epoch was minted");
  assert.equal(controls(h, "debugSessionReset").length, 1);
  const reset = lastControl(h, "debugSessionReset");
  assert.equal(reset["epoch"], h.ctx.run.debugger.epoch);
  assert.equal(reset["buildId"], buildId, "the same bytes verified under the new epoch");

  // Every command carrying the dead epoch is refused; none can touch the run.
  send(h.ctx, { type: "debugPause", id: 10, epoch });
  send(h.ctx, { type: "debugConfigure", id: 11, epoch, revision: 2 });
  send(h.ctx, { type: "debugResume", id: 12, epoch, stopId: 1, action: "continue" });
  send(h.ctx, {
    type: "debugRunTo",
    id: 13,
    epoch,
    stopId: 1,
    location: { logic: 0, pc: 0 },
  });
  send(h.ctx, { type: "debugInspect", id: 14, epoch, stopId: 1 });
  send(h.ctx, { type: "debugEvaluate", id: 15, epoch, stopId: 1, expression: "1" });
  send(h.ctx, { type: "debugSetValues", id: 16, epoch, stopId: 1, vars: [[41, 9]] });
  send(h.ctx, { type: "debugDetach", id: 17, epoch });
  const errors = controls(h, "debugError").map((m) => ({ id: m["id"], code: m["code"] }));
  assert.deepEqual(
    errors,
    [10, 11, 12, 13, 14, 15, 16, 17].map((id) => ({ id, code: "staleEpoch" })),
  );
  assert.equal(engine.executionStopInfo, null, "no stale command latched the reset run");
  assert.equal(engine.vars[41], 0, "no stale command mutated the reset run");

  // The live epoch still owns the run.
  send(h.ctx, { type: "debugPause", id: 18, epoch: h.ctx.run.debugger.epoch });
  assert.equal(lastControl(h, "debugAck")["id"], 18);
  assert.ok(engine.executionStopInfo !== null);
});

test("the restart prompt mints an epoch on accept and leaves it on decline", () => {
  const source = `if (isset(f6)) { reset(f6); assignn(v40, 1); return; }
assignn(v40, 7);
restart.game();
return;`;
  const h = workerHarness(gameContainer([source]));
  const engine = h.ctx.run.engine!;
  const { epoch } = attach(h, { "0": source });

  h.ctx.fns.tickEngine();
  assert.equal(engine.hostInteraction?.kind, "confirm", "no f16 — the prompt is up");
  assert.equal(engine.awaitingKey, true);
  assert.equal(engine.vars[40], 7);

  // Escape declines: the pass resumes past restart.game, identity untouched.
  h.ctx.fns.onKey({ type: "key", code: 0x1b });
  assert.equal(engine.runResetSerial, 0, "a declined restart never reached the reset");
  assert.equal(h.ctx.run.debugger.epoch, epoch, "decline kept the session epoch");
  assert.equal(controls(h, "debugSessionReset").length, 0);
  assert.equal(engine.vars[40], 7);
  assert.equal(engine.hostInteractionPending, false, "the declined pass completed");

  // The next cycle re-issues restart.game; Enter accepts this time.
  h.ctx.fns.tickEngine();
  assert.equal(engine.awaitingKey, true, "the prompt re-armed on the next pass");
  h.ctx.fns.onKey({ type: "key", code: 0x0d });
  assert.equal(engine.runResetSerial, 1);
  assert.equal(engine.vars[40], 1, "the accepted restart ran initial logic");
  assert.equal(h.ctx.run.debugger.epoch, epoch + 1);
  assert.equal(controls(h, "debugSessionReset").length, 1);
  assert.equal(lastControl(h, "debugSessionReset")["epoch"], h.ctx.run.debugger.epoch);

  send(h.ctx, { type: "debugPause", id: 20, epoch });
  assert.equal(lastControl(h, "debugError")["code"], "staleEpoch");
  assert.equal(engine.executionStopInfo, null);
});

test("a configured breakpoint rebinds and counts fresh hits in the reset run", () => {
  const source = `if (isset(f6)) { reset(f6); assignn(v40, 1); return; }
assignn(v41, 5);
set(f16);
restart.game();
return;`;
  const h = workerHarness(gameContainer([source]));
  const engine = h.ctx.run.engine!;
  const { epoch } = attach(h, { "0": source });
  send(h.ctx, {
    type: "debugConfigure",
    id: 30,
    epoch,
    revision: 1,
    breakpoints: [{ id: "b1", enabled: true, logic: 0, line: 2, mode: "statement" }],
  });
  assert.equal(lastControl(h, "debugConfigured")["revision"], 1);

  // The old epoch's hit lands before the statement runs.
  h.ctx.fns.tickEngine();
  const first = lastControl(h, "debugStopped");
  assert.deepEqual(first["reasons"], [{ kind: "breakpoint", id: "b1", hitCount: 1 }]);
  assert.equal(first["epoch"], epoch);
  assert.equal(engine.vars[41], 0);

  // Resuming runs into restart.game: the reset pass runs un-observed by the
  // dead epoch's plan — no stale hit, no stale stop survives the entry.
  send(h.ctx, {
    type: "debugResume",
    id: 31,
    epoch,
    stopId: first["stopId"] as number,
    action: "continue",
  });
  assert.equal(engine.runResetSerial, 1);
  assert.equal(engine.vars[41], 0, "the reset cleared the resumed write");
  assert.equal(engine.vars[40], 1);
  const reset = lastControl(h, "debugSessionReset");
  assert.equal(reset["epoch"], epoch + 1);
  const rebound = (
    reset["breakpoints"] as { id: string; binding: { bound: boolean }; hits: number }[]
  )[0]!;
  assert.equal(rebound.id, "b1");
  assert.equal(rebound.binding.bound, true, "the same bytes re-bound the spec");
  assert.equal(rebound.hits, 0, "the new run's hit counter starts clean");

  // The rebound breakpoint fires in the new run under the fresh epoch.
  h.ctx.fns.tickEngine();
  const second = lastControl(h, "debugStopped");
  assert.equal(second["epoch"], epoch + 1);
  assert.deepEqual(second["reasons"], [{ kind: "breakpoint", id: "b1", hitCount: 1 }]);

  // The dead epoch cannot even answer the live stop.
  send(h.ctx, {
    type: "debugResume",
    id: 32,
    epoch,
    stopId: second["stopId"] as number,
    action: "continue",
  });
  assert.equal(lastControl(h, "debugError")["code"], "staleEpoch");
  assert.ok(engine.executionStopInfo !== null, "the live stop stayed pinned");
});

test("a queued host answer dies with the run the reset abandoned", () => {
  const source = `#message 1 "n?"
if (isset(f6)) { reset(f6); assignn(v40, 1); return; }
get.num(1, v100);
set(f16);
restart.game();
return;`;
  const h = workerHarness(gameContainer([source]));
  const engine = h.ctx.run.engine!;
  const { epoch } = attach(h, { "0": source });

  h.ctx.fns.tickEngine();
  const request = lastControl(h, "hostRequest");
  assert.equal(request["op"], "getnum");
  assert.equal(engine.hostInteractionPending, true);

  send(h.ctx, { type: "debugPause", id: 40, epoch });
  const stopped = lastControl(h, "debugStopped");
  assert.equal(stopped["wait"], "getnum");

  send(h.ctx, { type: "hostAnswer", id: request["id"] as number, response: "42" });
  assert.equal(lastControl(h, "debugAnswerReady")["id"], request["id"]);
  assert.equal(h.ctx.run.debugger.queuedAnswers.length, 1, "the answer parks behind the latch");
  assert.equal(engine.vars[100], 0);

  // The resume drains the answer and the resumed pass runs into restart.game
  // inside the same entry: the session resets mid-drain.
  send(h.ctx, {
    type: "debugResume",
    id: 41,
    epoch,
    stopId: stopped["stopId"] as number,
    action: "continue",
  });
  assert.equal(engine.runResetSerial, 1);
  assert.equal(h.ctx.run.debugger.epoch, epoch + 1);
  assert.equal(h.ctx.run.debugger.queuedAnswers.length, 0, "stale answers dropped with the epoch");
  assert.equal(engine.vars[100], 0, "the applied answer went down with the abandoned run");
  assert.equal(engine.vars[40], 1, "the reset run initialized instead");
  // The new run asked its own question — no stale answer auto-applies to it.
  const requests = controls(h, "hostRequest").filter((m) => m["op"] === "getnum");
  assert.equal(requests.length, 2);
  assert.equal(engine.hostInteractionPending, true);
});

test("an armed step continuation is cancelled by the reset, not replayed", () => {
  const h = workerHarness(gameContainer([BYPASS]));
  const engine = h.ctx.run.engine!;
  const { epoch } = attach(h, { "0": BYPASS });

  send(h.ctx, { type: "debugPause", id: 50, epoch });
  const idle = lastControl(h, "debugStopped");
  send(h.ctx, {
    type: "debugResume",
    id: 51,
    epoch,
    stopId: idle["stopId"] as number,
    action: "cycle",
  });
  assert.equal(engine.runResetSerial, 1, "the stepped-into pass ran the restart");
  assert.equal(h.ctx.run.debugger.step, null, "the dead epoch's step plan is gone");
  assert.equal(h.ctx.run.debugger.epoch, epoch + 1);
  assert.equal(engine.vars[40], 1);
  // No step stop was published for a run that no longer exists.
  assert.equal(
    controls(h, "debugStopped").filter((m) =>
      (m["reasons"] as { kind: string }[]).some((r) => r.kind === "step"),
    ).length,
    0,
  );
  assert.equal(engine.executionStopInfo, null, "the reset run is free-running");
});
