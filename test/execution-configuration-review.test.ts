import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";

function phaseStopped() {
  const container = createContainer();
  // assignn(v60, 7), return; no source compiler is needed for this contract.
  container.putResource("logic", 0, buildLogicResource(Uint8Array.of(3, 60, 7, 0), []));
  const host: EngineHost = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  };
  const engine = new Engine(container, host, new Map());
  let gateCalls = 0;
  engine.setExecutionGate(() => {
    gateCalls++;
    return false;
  });
  let stopping = true;
  engine.setExecutionObserver(
    (event) => stopping && event.cause.type === "phase" && event.cause.phase === "cycle-entry",
  );
  engine.tick();
  const stop = engine.executionStopInfo;
  assert.ok(stop);
  assert.deepEqual(stop.cause, { type: "phase", phase: "cycle-entry" });
  assert.equal(engine.vars[60], 0);
  assert.equal(engine.completedCycleSerial, 0);
  return {
    engine,
    stop,
    drain() {
      stopping = false;
      if (engine.executionStopInfo !== null) engine.resumeExecution();
      engine.tick();
      assert.equal(engine.vars[60], 7);
      assert.equal(engine.completedCycleSerial, 1);
      assert.equal(gateCalls, 2, "the original gate still observes assignn and return");
    },
  };
}

test("gate replacement is refused at a latched phase stop and preserves the installed controller", () => {
  const { engine, stop, drain } = phaseStopped();
  assert.throws(() => engine.setExecutionGate(null), /completed cycle boundary/);
  assert.equal(engine.executionStopInfo, stop);
  drain();
  assert.doesNotThrow(() => engine.setExecutionGate(null));
  assert.doesNotThrow(() => engine.setExecutionObserver(null));
});

test("gate replacement is refused while a resumed phase still owes its cycle remainder", () => {
  const { engine, drain } = phaseStopped();
  engine.resumeExecution();
  assert.equal(engine.executionStopInfo, null);
  assert.throws(() => engine.setExecutionGate(() => false), /completed cycle boundary/);
  drain();
  assert.doesNotThrow(() => engine.setExecutionGate(null));
  assert.doesNotThrow(() => engine.setExecutionObserver(null));
});
