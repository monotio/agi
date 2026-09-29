import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";

test("observing compatibility Play does not change its host-segment instruction allowance", () => {
  for (const armed of [false, true]) {
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(
        '#message 1 "Number?"\nincrement(v40); get.num(1, v41); increment(v42); return;',
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
    const engine = new Engine(container, host, new Map(), { instructionBudget: 3 });
    if (armed) engine.setExecutionGate(() => false);
    engine.tick();
    assert.equal(engine.awaitingHostAnswer, true);
    assert.equal(engine.vars[40], 1);
    engine.deliverHostAnswer(7);
    assert.doesNotThrow(() => engine.tick(), `armed=${armed}: host-segment allowance is unchanged`);
    assert.deepEqual([engine.vars[40], engine.vars[41], engine.vars[42]], [1, 7, 1]);
    assert.equal(requests, 1, "the completed host prefix is never replayed");
  }
});
