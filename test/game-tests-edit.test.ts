import assert from "node:assert/strict";
import { test } from "node:test";
import { editGameTests, GameTestsEditError } from "../src/agent/gameTestsEdit.ts";
import { parseGameTests, serializeGameTests } from "../src/agent/gameTestFormat.ts";
import { Engine } from "../src/runtime/engine.ts";
import { createContainer } from "../src/container/container.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { buildWordsTok } from "../src/logic/words.ts";

const profile = PROFILES["2.936"];
const words = buildWordsTok([{ word: "look", id: 2 }]);
const scenario = (name: string) => ({
  name,
  room: 1,
  steps: [],
  expect: null,
  spawnX: null,
  spawnY: null,
  cycleBudget: null,
});
const document = serializeGameTests([scenario("first"), scenario("second")]);

test("manual edits keep the test's position, and rename, reorder and delete use the same document", () => {
  let result = editGameTests(
    { document, profile, words },
    { kind: "update", name: "first", test: { ...scenario("first"), room: 2 } },
  );
  assert.deepEqual(
    result.tests.map((test) => [test.name, test.room]),
    [
      ["first", 2],
      ["second", 1],
    ],
  );
  result = editGameTests(
    { document: result.payload, profile, words },
    { kind: "rename", name: "first", to: "new name" },
  );
  result = editGameTests(
    { document: result.payload, profile, words },
    { kind: "reorder", names: ["second", "new name"] },
  );
  result = editGameTests(
    { document: result.payload, profile, words },
    { kind: "remove", names: ["second"] },
  );
  assert.deepEqual(
    parseGameTests(result.payload, profile).tests.map((test) => test.name),
    ["new name"],
  );
});

test("Write tests first: a command can save before its words exist", () => {
  const edited = editGameTests(
    { document, profile, words },
    {
      kind: "merge",
      tests: [{ ...scenario("unknown"), steps: [{ action: "command", command: "xyzzy" }] }],
    },
  );
  const test = parseGameTests(edited.payload, profile).tests.find(
    (test) => test.name === "unknown",
  )!;
  assert.equal(test.steps[0]!["command"], "xyzzy");
});

test("an unreadable imported tests file is refused and its bytes stay intact", () => {
  const document = Uint8Array.of(0xff, 0x01);
  const before = document.slice();
  assert.throws(
    () => editGameTests({ document, profile, words }, { kind: "merge", tests: [scenario("new")] }),
    (error) => error instanceof GameTestsEditError && error.kind === "document",
  );
  assert.deepEqual(document, before);
});

test("updating a recorded test preserves its setup and released random sequence", () => {
  const engine = new Engine(
    createContainer(),
    { print() {}, displayAt() {}, statusLine() {}, takeInputLine: () => null, takeKeys: () => [] },
    new Map(),
  );
  const setup = { image: Buffer.from(engine.serialize()).toString("base64") };
  const document = serializeGameTests([
    { ...scenario("first"), setup, rngVersion: 1 },
    scenario("second"),
  ]);
  const result = editGameTests(
    { document, profile, words },
    { kind: "update", name: "first", test: { ...scenario("renamed"), room: 2 } },
  );
  assert.deepEqual(result.tests[0]!.setup, setup);
  assert.equal(result.tests[0]!.rngVersion, 1);
  assert.equal(result.tests[1]!.name, "second");
});
