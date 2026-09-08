import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";

const host: EngineHost = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

function game(source: string, instructionBudget?: number): Engine {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  return new Engine(
    container,
    host,
    undefined,
    instructionBudget === undefined ? undefined : { instructionBudget },
  );
}

/**
 * Observed 3.002.107 bytecode (a title screen's key-to-skip path) zeroes v11
 * and spins `if (greaterv(v49, v11)) goto` inside one logic invocation until
 * the timer has advanced v11. The engine parks the call stack at the loop head
 * so the host clock can reach it, and resumes at the host cadence.
 */
test("a clock busy-wait parks the logic stack until the host clock advances", () => {
  const engine = game(`
    if (!isset(f200)) {
      set(f200); assignn(v49, 1); assignn(v11, 0);
      wait:
      if (greaterv(v49, v11)) { goto wait; }
      set(f201);
    }
    return;
  `);
  engine.tick();
  assert.equal(engine.continuationPending, true, "the pass is parked inside the loop");
  assert.equal(engine.flags[201], 0);
  assert.equal(engine.autosaveImage(), null, "no checkpoint mid-instruction");
  engine.advanceClock(999);
  engine.tick();
  assert.equal(engine.continuationPending, true, "v11 has not ticked yet");
  engine.advanceClock(1);
  assert.equal(engine.vars[11], 1);
  engine.tick();
  assert.equal(engine.continuationPending, false);
  assert.equal(engine.flags[201], 1, "the loop exits once the second elapses");
});

test("a bounded loop that reads the clock completes within one pass", () => {
  const engine = game(`
    assignn(v60, 200); assignn(v49, 5); assignn(v11, 0);
    loop:
    if (greaterv(v49, v11) && !equaln(v60, 0)) { decrement(v60); goto loop; }
    set(f201); return;
  `);
  engine.tick();
  assert.equal(engine.continuationPending, false);
  assert.deepEqual([engine.flags[201], engine.vars[60]], [1, 0]);
});

test("a clock comparison outside a runaway loop does not shield it from the budget", () => {
  // The comparison sits before the loop, not inside it: the loop is not a
  // clock wait and must exhaust the budget rather than park.
  const engine = game(
    `if (equaln(v11, 0)) { set(f210); }
     loop: if (equaln(v50, 0)) { goto loop; } return;`,
    5000,
  );
  assert.throws(() => engine.tick(), /instruction budget exceeded in logic 0/);
});

test("a runaway loop that never reads the clock still trips the playtest budget", () => {
  const engine = game(`loop: if (equaln(v50, 0)) { goto loop; } return;`, 5000);
  assert.throws(() => engine.tick(), /instruction budget exceeded in logic 0/);
});

test("a wait that never ends is reported once the host clock has run ten minutes", () => {
  // A coarse host tick can repeatedly skip over a legitimate clock target.
  // This is a feasible one-second wait, unlike a self-comparison tautology;
  // elapsed host time still bounds it if the host never samples that second.
  const engine = game(`loop: if (!equaln(v11, 1)) { goto loop; } return;`, 5000);
  engine.tick();
  assert.equal(engine.continuationPending, true);
  engine.advanceClock(5 * 60 * 1000);
  engine.tick();
  assert.equal(engine.continuationPending, true, "five minutes is still a plausible wait");
  engine.advanceClock(6 * 60 * 1000);
  assert.throws(() => engine.tick(), /clock busy-wait in logic 0 exceeded 600 seconds/);
});
