import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";

const host: EngineHost = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};
test("optional playtest instruction budget aborts work and renews at each tick", () => {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic("increment(v40); increment(v40); increment(v40); return;", {
      dictionary: new Map(),
    }).payload,
  );
  const bounded = new Engine(game, host, new Map(), { instructionBudget: 2 });
  assert.throws(() => bounded.tick(), /instruction budget/i);
  const normal = new Engine(game, host);
  normal.tick();
  normal.tick();
  assert.equal(normal.vars[40], 6);
  const renewed = new Engine(game, host, new Map(), { instructionBudget: 10 });
  renewed.tick();
  renewed.tick();
  assert.equal(renewed.vars[40], 6);
  game.putResource(
    "logic",
    0,
    assembleLogic("again: goto again;", { dictionary: new Map() }).payload,
  );
  assert.throws(
    () => new Engine(game, host, new Map(), { instructionBudget: 20 }).tick(),
    /instruction budget/i,
  );
});
