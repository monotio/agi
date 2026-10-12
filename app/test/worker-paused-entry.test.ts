import assert from "node:assert/strict";
import { test } from "node:test";
import { gameContainer, workerHarness, type WorkerHarness } from "./worker-ctx.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerInbound } from "../src/worker/workerProtocol.ts";

/**
 * A room entry the host began runs under the page's pause, so a change shows
 * and Play can save its room. With the debugger's execution control armed it
 * follows the same completion accounting as a cycle poll: a pass that reaches
 * its tail counts once, a stop or a yield counts nothing, and a yielded
 * remainder runs on the next paused polls, once.
 */

const LOGIC_0 = "if(equaln(v0,0)){new.room(1);}call.v(v0);return;";

function send(h: WorkerHarness, msg: WorkerInbound): void {
  onWorkerMessage(h.ctx, msg);
}

/** Room 1 entered once, the debugger attached with matching sources, then paused and re-entered. */
function pausedEntry(room: string) {
  const h = workerHarness(gameContainer([LOGIC_0, room]));
  let now = 0;
  const poll = (cycle = true) => h.ctx.fns.stepHostTick((now += 50), { cycle, sound: 0 });
  poll();
  poll();
  assert.equal(h.ctx.run.engine!.vars[0], 1);
  send(h, { type: "debugAttach", id: 1, sources: { "0": LOGIC_0, "1": room } });
  const attached = h.control.findLast((m) => m.type === "debugAttached");
  assert.ok(attached?.type === "debugAttached");
  assert.equal(h.ctx.run.engine!.executionControlActive, true);
  // The boot entry ran unarmed; the re-entry's marks start clear.
  h.ctx.run.engine!.vars[43] = 0;
  send(h, { type: "pause", paused: true });
  send(h, { type: "reenter" });
  assert.equal(h.ctx.run.engine!.roomEntryPending, true);
  return { h, poll };
}

test("an armed room entry under a pause counts its completed pass once", () => {
  const { h, poll } = pausedEntry("if(isset(f5)){increment(v40);}increment(v41);return;");
  const engine = h.ctx.run.engine!;
  const [cycles, serial, entries] = [
    h.ctx.run.cycle.cycleCount,
    engine.completedCycleSerial,
    engine.vars[40],
  ];
  assert.equal(poll(), true);
  assert.equal(engine.vars[40], entries! + 1);
  assert.equal(engine.completedCycleSerial, serial + 1);
  assert.equal(h.ctx.run.cycle.cycleCount, cycles + 1);
  assert.equal(poll(), false, "then the game waits");
  assert.equal(h.ctx.run.cycle.cycleCount, cycles + 1);
});

test("a breakpoint in a room entry under a pause counts no cycle", () => {
  const room = "increment(v41);\nif(isset(f5)){increment(v40);}\nreturn;";
  const { h, poll } = pausedEntry(room);
  send(h, {
    type: "debugConfigure",
    id: 2,
    epoch: h.ctx.run.debugger.epoch,
    revision: 1,
    breakpoints: [{ id: "b1", enabled: true, logic: 1, line: 1, mode: "statement" }],
  });
  const engine = h.ctx.run.engine!;
  const [cycles, entries, passes] = [h.ctx.run.cycle.cycleCount, engine.vars[40], engine.vars[41]];
  assert.equal(poll(), false);
  assert.ok(h.control.some((m) => m.type === "debugStopped"));
  assert.equal(h.ctx.run.cycle.cycleCount, cycles);
  assert.deepEqual([engine.vars[40], engine.vars[41]], [entries, passes]);
});

test("a room entry that yields under a pause finishes its remainder once on later polls", () => {
  const room = `if(isset(f5)){${"increment(v42);".repeat(1100)}assignn(v43,9);increment(v44);}return;`;
  const { h, poll } = pausedEntry(room);
  const engine = h.ctx.run.engine!;
  const cycles = h.ctx.run.cycle.cycleCount;
  assert.equal(poll(), false, "the first slice yields");
  assert.equal(engine.executionYieldPending, true);
  assert.equal(engine.vars[43], 0);
  assert.equal(h.ctx.run.cycle.cycleCount, cycles);
  for (let i = 0; i < 8 && engine.vars[43] !== 9; i++) poll();
  assert.equal(engine.vars[43], 9, "the remainder ran");
  assert.equal(engine.vars[44], 2, "once: one entry at boot, one now");
  assert.equal(h.ctx.run.cycle.cycleCount, cycles + 1, "and counted once");
  assert.equal(poll(), false, "then the game waits");
  assert.equal(engine.vars[44], 2);
});
