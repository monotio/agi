import assert from "node:assert/strict";
import { test } from "node:test";
import { readGameFiles } from "../app/src/gameZip.ts";
import {
  GAME_TESTS_FILE,
  GAME_TESTS_FORMAT,
  parseGameTests,
  serializeGameTests,
  testsForResource,
  verdictLine,
} from "../src/agent/gameTests.ts";
import { AGI_SYSTEM_PROMPT } from "../src/agent/prompt.ts";
import {
  ASK_TOOLS,
  buildObjectFile,
  createAgentSessionState,
  executeAgentTool,
  type AgentSessionState,
} from "../src/agent/tools.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildWordsTok } from "../src/logic/words.ts";
import { buildView } from "../src/view/view.ts";

/**
 * Game tests are playtest_room scenarios stored with the game in TESTS.JSON:
 * written and listed through tools, replayed on demand with a verdict-first
 * result, and rerun automatically by the write tools whose change can affect
 * them. The world here is the playtest test's: room 1 with a key to take.
 */
const DICTIONARY = new Map([
  ["take", 10],
  ["key", 11],
  ["look", 12],
]);

const ROOM_LOGIC = `
if (isset(f5)) {
 assignn(v10, 1); load.pic(v10); draw.pic(v10); show.pic();
 load.view(0); animate.obj(0); set.view(0,0); position(0,80,120); draw(0); accept.input();
 display(20, 1, "Room one");
}
if (said("take", "key")) {get(0);set(f30);assignn(v40, 7);print("You take the key.");}
return;`;

function world(): AgentSessionState {
  const state = createAgentSessionState();
  state.wordsPayload = buildWordsTok([...DICTIONARY].map(([word, id]) => ({ word, id })));
  state.objectPayload = buildObjectFile([{ name: "Key", startingRoom: 1 }]);
  for (const word of DICTIONARY.keys()) state.sources.words.set(word, DICTIONARY.get(word)!);
  state.container.putResource(
    "view",
    0,
    buildView({
      loops: [{ cels: [{ width: 3, height: 2, transparentColor: 0, pixels: [1, 1, 1, 1, 1, 1] }] }],
    }),
  );
  state.container.putResource("picture", 1, Uint8Array.of(0xf0, 2, 0xf8, 0, 0, 0xff));
  state.container.putResource(
    "logic",
    0,
    assembleLogic(`if (!isset(f200)) {set(f200);new.room(1);} call.v(v0); return;`, {
      dictionary: DICTIONARY,
    }).payload,
  );
  state.container.putResource(
    "logic",
    1,
    assembleLogic(ROOM_LOGIC, { dictionary: DICTIONARY }).payload,
  );
  return state;
}

const step = (action: string, command: string | null = null, ticks = 1) => ({
  action,
  command,
  direction: null,
  ticks,
  captureTicks: null,
});
const expectation = (fields: Record<string, unknown>) => ({
  room: null,
  carriedItems: null,
  flags: null,
  vars: null,
  printed: null,
  text: null,
  ...fields,
});
const takeKey = {
  name: "take the key",
  room: 1,
  spawnX: null,
  spawnY: null,
  steps: [step("command", "take key"), step("enter")],
  expect: expectation({
    carriedItems: [0],
    flags: [{ id: 30, value: true }],
    vars: [{ id: 40, value: 7 }],
    printed: "take the key",
    text: "Room one",
  }),
  cycleBudget: null,
};

test("the stored format round-trips and rejects what it cannot run", () => {
  const bytes = serializeGameTests([takeKey]);
  const doc = parseGameTests(bytes);
  assert.equal(doc.format, GAME_TESTS_FORMAT);
  assert.deepEqual(doc.tests, [takeKey]);
  assert.deepEqual(parseGameTests(undefined).tests, []);
  assert.throws(() => parseGameTests(new TextEncoder().encode("{")), /not valid JSON/);
  assert.throws(
    () => parseGameTests(new TextEncoder().encode(JSON.stringify({ format: "x", tests: [] }))),
    /format must be/,
  );
  const twice = JSON.stringify({ format: GAME_TESTS_FORMAT, tests: [takeKey, takeKey] });
  assert.throws(() => parseGameTests(new TextEncoder().encode(twice)), /unique/);
  const badStep = { ...takeKey, steps: [{ action: "dance" }] };
  assert.throws(
    () =>
      parseGameTests(
        new TextEncoder().encode(JSON.stringify({ format: GAME_TESTS_FORMAT, tests: [badStep] })),
      ),
    /action must be command, move, enter or wait/,
  );
  // Which stored tests a change can touch.
  const other = { ...takeKey, name: "room two", room: 2 };
  assert.deepEqual(testsForResource([takeKey, other], "logic", 2), [other]);
  assert.deepEqual(testsForResource([takeKey, other], "picture", 1), [takeKey]);
  assert.equal(testsForResource([takeKey, other], "logic", 0).length, 2);
  assert.equal(testsForResource([takeKey, other], "words", 0).length, 2);
  assert.equal(testsForResource([takeKey, other], "view", 0).length, 2);
});

test("write_game_tests stores, merges, replaces and removes; commands need registered words", () => {
  const state = world();
  const written = executeAgentTool(state, "write_game_tests", {
    mode: null,
    names: null,
    tests: [takeKey],
  });
  assert.equal(written.success, true, written.error ?? "");
  assert.deepEqual(written.details?.["updatedFiles"], ["TESTS.JSON"]);
  assert.ok(state.getFiles().has(GAME_TESTS_FILE), "the file travels with the game");
  const unknown = executeAgentTool(state, "write_game_tests", {
    mode: "merge",
    names: null,
    tests: [{ ...takeKey, name: "juggle", steps: [step("command", "juggle key")] }],
  });
  assert.equal(unknown.success, false);
  assert.match(unknown.error ?? "", /juggle/);
  assert.match(unknown.error ?? "", /write_words/);
  const merged = executeAgentTool(state, "write_game_tests", {
    mode: "merge",
    names: null,
    tests: [{ ...takeKey, name: "look around", steps: [step("wait", null, 3)], expect: null }],
  });
  assert.equal(merged.success, true, merged.error ?? "");
  assert.deepEqual(merged.details?.["names"], ["take the key", "look around"]);
  const listed = executeAgentTool(state, "read_game_tests", { names: ["look around"] });
  assert.equal(listed.success, true);
  assert.equal((listed.details?.["tests"] as unknown[]).length, 1);
  const removed = executeAgentTool(state, "write_game_tests", {
    mode: "remove",
    names: ["look around"],
    tests: null,
  });
  assert.equal(removed.success, true, removed.error ?? "");
  assert.deepEqual(removed.details?.["names"], ["take the key"]);
  const replaced = executeAgentTool(state, "write_game_tests", {
    mode: "replace",
    names: null,
    tests: [{ ...takeKey, name: "only one" }],
  });
  assert.deepEqual(replaced.details?.["names"], ["only one"]);
  assert.ok(ASK_TOOLS.includes("read_game_tests") && ASK_TOOLS.includes("run_game_tests"));
  assert.ok(!ASK_TOOLS.includes("write_game_tests"), "writing is a Remix action");
  assert.ok(AGI_SYSTEM_PROMPT.includes("write_game_tests"));
});

test("run_game_tests replays stored tests and puts the verdict first", () => {
  const state = world();
  const broken = {
    ...takeKey,
    name: "key opens nothing",
    expect: expectation({ flags: [{ id: 31, value: true }] }),
  };
  executeAgentTool(state, "write_game_tests", {
    mode: null,
    names: null,
    tests: [takeKey, broken],
  });
  const all = executeAgentTool(state, "run_game_tests", { names: null });
  assert.equal(all.success, false);
  assert.match(
    all.error ?? "",
    /^1 game test pass, 1 fail: "key opens nothing" Expected flag 31=true; observed false\. \(room 1, cycle \d+\)\.$/,
  );
  const outcomes = all.details?.["gameTests"] as { name: string; passed: boolean }[];
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.name, outcome.passed]),
    [
      ["take the key", true],
      ["key opens nothing", false],
    ],
  );
  assert.equal(all.images?.length, 1, "the failing frame comes along");
  const one = executeAgentTool(state, "run_game_tests", { names: ["take the key"] });
  assert.equal(one.success, true, one.error ?? "");
  assert.match(one.message ?? "", /^1 game test pass, 0 fail\./);
  const missing = executeAgentTool(state, "run_game_tests", { names: ["nope"] });
  assert.equal(missing.success, false);
  assert.match(missing.error ?? "", /No game test named "nope"/);
  assert.equal(verdictLine([]), "No game tests stored.");
});

test("a write tool reruns the stored tests its change can touch and reports the verdict", () => {
  const state = world();
  executeAgentTool(state, "write_game_tests", { mode: null, names: null, tests: [takeKey] });
  const kept = executeAgentTool(state, "write_logic_source", { room: 1, source: ROOM_LOGIC });
  assert.equal(kept.success, true, kept.error ?? "");
  assert.match(kept.message ?? "", /Game tests: 1 game test pass, 0 fail\./);
  const broken = executeAgentTool(state, "write_logic_source", {
    room: 1,
    source: ROOM_LOGIC.replace("set(f30);", ""),
  });
  assert.equal(broken.success, true, broken.error ?? "");
  assert.match(
    broken.message ?? "",
    /Game tests: 0 game tests pass, 1 fail: "take the key" Expected flag 30=true/,
  );
  const outcomes = broken.details?.["gameTests"] as { passed: boolean }[];
  assert.equal(outcomes[0]?.passed, false);
  // A room the tests do not cover reruns nothing and says nothing about them.
  const elsewhere = executeAgentTool(state, "write_logic_source", { room: 2, source: "return;" });
  assert.equal(elsewhere.success, true, elsewhere.error ?? "");
  assert.ok(!/Game tests:/.test(elsewhere.message ?? ""));
});

test("TESTS.JSON survives a ZIP import beside the game files", () => {
  const state = world();
  executeAgentTool(state, "write_game_tests", { mode: null, names: null, tests: [takeKey] });
  const files = new Map<string, Uint8Array>();
  for (const [name, bytes] of state.getFiles()) files.set(`Game/${name}`, bytes);
  const opened = readGameFiles(files);
  assert.deepEqual(parseGameTests(opened.files[GAME_TESTS_FILE]).tests, [takeKey]);
});
