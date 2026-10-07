import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";

for (const policy of ["host-segment", "whole-pass"] as const) {
  test(`a debug pause over a real host answer preserves the ${policy} budget boundary`, () => {
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(
        '#message 1 "Number?"\nincrement(v40); get.num(1, v41); increment(v42); increment(v43); return;',
        { dictionary: new Map() },
      ).payload,
    );
    let requests = 0;
    const host: EngineHost = {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine: () => null,
      takeKeys: () => [],
      promptNumber: () => {
        requests++;
        throw new HostWait();
      },
    };
    const engine = new Engine(container, host, new Map(), {
      instructionBudget: 3,
      executionBudgetPolicy: policy,
    });
    engine.setExecutionGate(() => false);
    engine.tick();
    assert.equal(engine.awaitingHostAnswer, true);
    assert.equal(engine.vars[40], 1);
    assert.ok(engine.pauseExecution, "the engine must support pausing a parked host wait");
    engine.pauseExecution();
    engine.deliverHostAnswer(7);
    engine.tick();
    assert.deepEqual([engine.vars[41], engine.vars[42], engine.vars[43]], [0, 0, 0]);
    engine.resumeExecution();
    if (policy === "host-segment") {
      assert.doesNotThrow(
        () => engine.tick(),
        "a genuine host answer still starts its compatibility segment",
      );
      assert.deepEqual(
        [engine.vars[40], engine.vars[41], engine.vars[42], engine.vars[43]],
        [1, 7, 1, 1],
      );
      assert.equal(engine.completedCycleSerial, 1);
    } else {
      assert.throws(
        () => engine.tick(),
        /instruction budget/i,
        "debug resume cannot renew a whole-pass budget",
      );
    }
    assert.equal(requests, 1, "resumption never repeats the host request");
  });
}

for (const policy of ["host-segment", "whole-pass"] as const) {
  test(`an observer stop after print preserves the ${policy} host boundary`, () => {
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic('#message 1 "Hello"\nincrement(v40); print(1); increment(v41); return;', {
        dictionary: new Map(),
      }).payload,
    );
    const host: EngineHost = {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine: () => null,
      takeKeys: () => [],
    };
    const engine = new Engine(container, host, new Map(), {
      instructionBudget: 3,
      executionBudgetPolicy: policy,
    });
    let stopped = false;
    engine.setExecutionObserver((record) => {
      if (!stopped && record.cause.type === "instruction" && record.cause.boundary.opcodePc === 2) {
        stopped = true;
        return true;
      }
      return false;
    });
    engine.tick();
    assert.equal(stopped, true);
    assert.equal(engine.modalKind, "print");
    assert.deepEqual([engine.vars[40], engine.vars[41]], [1, 0]);
    engine.resumeExecution();
    engine.ackPrint();
    if (policy === "host-segment") {
      assert.doesNotThrow(
        () => engine.tick(),
        "the print acknowledgement renews its genuine host segment",
      );
      assert.deepEqual([engine.vars[40], engine.vars[41]], [1, 1]);
      assert.equal(engine.completedCycleSerial, 1);
    } else {
      assert.throws(() => engine.tick(), /instruction budget/i);
    }
  });
}
