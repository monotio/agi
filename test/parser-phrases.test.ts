import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine } from "../src/runtime/engine.ts";

test("parser retains whole dictionary phrases, ignores zero-ID phrases and reports unknown position", () => {
  const dictionary = new Map([
    ["pick", 2],
    ["pick up", 10],
    ["key", 11],
    ["the old", 0],
    ["look", 12],
    ["look at", 13],
  ]);
  const game = createContainer();
  game.putResource("logic", 0, assembleLogic("accept.input(); return;", { dictionary }).payload);
  let pending: string | null = null;
  const engine = new Engine(
    game,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine() {
        const line = pending;
        pending = null;
        return line;
      },
      takeKeys: () => [],
    },
    dictionary,
  );
  engine.tick();
  pending = "Pick up the old key";
  engine.tick();
  assert.deepEqual(engine.readState().parsedWords, [10, 11]);
  assert.deepEqual(engine.readState().parsedWordTexts, ["pick up", "key"]);
  pending = "look at key";
  engine.tick();
  assert.deepEqual(engine.readState().parsedWords, [13, 11]);
  pending = "pickup key";
  engine.tick();
  assert.equal(engine.vars[9], 1);
  pending = "pick up missing key";
  engine.tick();
  assert.equal(engine.vars[9], 2);
  assert.deepEqual(engine.readState().parsedWords, [10]);
});
