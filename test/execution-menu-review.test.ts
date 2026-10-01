import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";

test("an input-phase debug stop preserves the menu-opening pass abandonment", () => {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `
    if (!isset(f200)) {
      set(f200); set.menu("Game"); set.menu.item("Go", 1); submit.menu(); set(f14);
    }
    if (isset(f201)) { reset(f201); menu.input(); }
    if (controller(1)) { increment(v61); }
    increment(v60); return;
  `,
      { dictionary: new Map() },
    ).payload,
  );
  const host: EngineHost = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  };
  const engine = new Engine(container, host, new Map());
  engine.tick();
  engine.flags[201] = 1;
  engine.tick();
  assert.equal(engine.vars[60], 2);
  assert.equal(engine.completedCycleSerial, 2);
  let once = false;
  engine.setExecutionObserver((entry) => {
    if (!once && entry.cause.type === "phase" && entry.cause.phase === "input") {
      once = true;
      return true;
    }
    return false;
  });
  engine.tick();
  assert.equal(engine.modalKind, "menu");
  assert.ok(engine.executionStopInfo);
  engine.resumeExecution();
  engine.modalKey(13);
  assert.equal(engine.modalKind, null);
  // This tick delivers the chosen controller in a fresh input phase. The
  // menu-opening pass was abandoned, so there is no pre-logic remainder.
  engine.tick();
  assert.equal(engine.vars[61], 1, "selection belongs to the next complete input phase");
  assert.equal(engine.vars[60], 3);
  assert.equal(engine.completedCycleSerial, 3);
});
