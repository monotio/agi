import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";

function game(sources: readonly string[], budget = 10000) {
  const container = createContainer();
  const dictionary = new Map<string, number>();
  sources.forEach((source, num) =>
    container.putResource("logic", num, assembleLogic(source, { dictionary }).payload),
  );
  const host: EngineHost = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  };
  return {
    engine: new Engine(container, host, dictionary, { instructionBudget: budget }),
    host,
  };
}

test("the completion serial rises once per pass that ran its post-logic tail", () => {
  const { engine } = game(["return;"]);
  assert.equal(engine.executionControlActive, false);
  assert.equal(engine.completedCycleSerial, 0);
  engine.tick();
  assert.equal(engine.completedCycleSerial, 1);
  engine.tick();
  assert.equal(engine.completedCycleSerial, 2);
});

test("a stopped pass counts nothing until its resumed tail runs", () => {
  const { engine } = game(["assignn(v40, 1); return;"]);
  engine.setExecutionGate(() => true);
  assert.equal(engine.executionControlActive, true);
  engine.tick();
  assert.equal(engine.executionStop!.pc, 0);
  assert.equal(engine.completedCycleSerial, 0);
  // Repeating the parked tick cannot invent a completion.
  engine.tick();
  assert.equal(engine.completedCycleSerial, 0);
  engine.resumeExecution();
  engine.tick();
  // The resume executed assignn and stopped again at the return boundary.
  assert.equal(engine.vars[40], 1);
  assert.equal(engine.executionStop!.kind, "return");
  assert.equal(engine.completedCycleSerial, 0);
  engine.resumeExecution();
  engine.tick();
  assert.equal(engine.executionStop, null);
  assert.equal(engine.completedCycleSerial, 1);
  // A fresh pass stops again without disturbing the count.
  engine.tick();
  assert.equal(engine.executionStop!.pc, 0);
  assert.equal(engine.completedCycleSerial, 1);
});

test("cooperative yields advance the serial only on the finishing slice", () => {
  const source = `${"assignn(v40, 1); ".repeat(1025)} assignn(v41, 7); return;`;
  const { engine } = game([source]);
  engine.setExecutionGate(() => false);
  engine.tick();
  assert.equal(engine.executionYieldPending, true);
  assert.equal(engine.completedCycleSerial, 0);
  engine.tick();
  assert.equal(engine.vars[41], 7);
  assert.equal(engine.executionYieldPending, false);
  assert.equal(engine.completedCycleSerial, 1);
  // The next pass slices the same way: its first tick completes nothing.
  engine.tick();
  assert.equal(engine.executionYieldPending, true);
  assert.equal(engine.completedCycleSerial, 1);
  engine.tick();
  assert.equal(engine.completedCycleSerial, 2);
});

test("a suspended host interaction counts when the resumed pass finishes", () => {
  const { engine, host } = game([
    '#message 1 "How many?"\nget.num(1, v100); assignn(v101, 7); return;',
  ]);
  host.promptNumber = () => {
    throw new HostWait();
  };
  engine.setExecutionGate(() => false);
  engine.tick();
  assert.equal(engine.awaitingHostAnswer, true);
  assert.equal(engine.completedCycleSerial, 0);
  // Ticks while the answer is in flight still complete nothing.
  engine.tick();
  assert.equal(engine.completedCycleSerial, 0);
  engine.deliverHostAnswer(5);
  engine.tick();
  assert.equal(engine.vars[100], 5);
  assert.equal(engine.vars[101], 7);
  assert.equal(engine.completedCycleSerial, 1);
});

test("a faulted pass leaves the serial untouched and cannot restart it", () => {
  const { engine } = game(["call(42); return;"]);
  engine.setExecutionGate(() => false);
  assert.throws(() => engine.tick(), /logic resource 42/);
  assert.equal(engine.completedCycleSerial, 0);
  assert.throws(() => engine.tick(), /logic resource 42/);
  assert.equal(engine.completedCycleSerial, 0);
});
