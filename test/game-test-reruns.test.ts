import assert from "node:assert/strict";
import { test } from "node:test";
import { resourceRevision } from "../src/agent/authoringState.ts";
import {
  parseGameTests,
  serializeGameTests,
  testsForResource,
  validateGameTest,
} from "../src/agent/gameTests.ts";
import {
  buildObjectFile,
  createAgentSessionState,
  executeAgentTool,
  type AgentSessionState,
} from "../src/agent/tools.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildWordsTok } from "../src/logic/words.ts";
import { buildView } from "../src/view/view.ts";

/**
 * Automatic test reruns after a write: selection follows the successful
 * mutation's own writtenResources/updatedFiles metadata (never a tool-name
 * list), follows call/new.room dependencies transitively, stays conservative
 * whenever a dependency scope cannot be proven, and reports skipped coverage
 * honestly. The world is the game-tests one: room 1 with a key to take.
 */
const DICTIONARY = new Map([
  ["take", 10],
  ["key", 11],
  ["look", 12],
  ["keycard", 13],
  ["dont", 14],
  ["ice cream", 15],
  ["juggle", 0],
  ["the", 0],
]);

const ROOM_LOGIC = `
if (isset(f5)) {
 assignn(v10, 1); load.pic(v10); draw.pic(v10); show.pic();
 load.view(0); animate.obj(0); set.view(0,0); position(0,80,120); draw(0); accept.input();
 display(20, 1, "Room one");
 random(1, 100, v50);
}
if (said("take", "key")) {get(0);set(f30);assignn(v40, 7);assignn(v3, 5);print("You take the key.");}
if (said("look")) {get.string(s0, "Name?", 0, 0, 10);assignn(v41, 1);}
return;`;

function world(logic = ROOM_LOGIC): AgentSessionState {
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
  state.container.putResource("logic", 1, assembleLogic(logic, { dictionary: DICTIONARY }).payload);
  return state;
}

/** One stored step in the normalized full shape; pass the fields the action uses. */
const step = (action: string, fields: Record<string, unknown> = {}) => ({
  action,
  command: null,
  direction: null,
  key: null,
  x: null,
  y: null,
  answer: null,
  until: null,
  ticks: null,
  captureTicks: null,
  ...fields,
});
/** One stored expectation set in the normalized full shape. */
const expectation = (fields: Record<string, unknown> = {}) => ({
  room: null,
  carriedItems: null,
  flags: null,
  vars: null,
  printed: null,
  text: null,
  score: null,
  object: null,
  reachable: null,
  ...fields,
});
const takeKey = {
  name: "take the key",
  room: 1,
  spawnX: null,
  spawnY: null,
  steps: [step("command", { command: "take key" }), step("enter")],
  expect: expectation({
    carriedItems: [0],
    flags: [{ id: 30, value: true }],
    vars: [{ id: 40, value: 7, min: null, max: null }],
    printed: "take the key",
    text: "Room one",
  }),
  cycleBudget: null,
};
/** A stored test that fails until the key is taken; no step takes it. */
const needsKey = {
  ...takeKey,
  name: "needs the key",
  steps: [step("enter")],
  expect: expectation({ flags: [{ id: 30, value: true }] }),
};

function putLogic(state: AgentSessionState, num: number, source: string): void {
  state.container.putResource(
    "logic",
    num,
    assembleLogic(source, { dictionary: DICTIONARY }).payload,
  );
}

test("testsForResource follows transitive calls, room transitions and unknown scopes", () => {
  const state = world();
  putLogic(state, 0, "return;"); // Isolate room dependencies from the global dispatcher.
  const names = (
    touched: { kind: "logic" | "picture" | "view" | "sound" | "words" | "objects"; num: number }[],
    tests = [takeKey],
  ) => testsForResource(state, tests, touched).map((entry) => entry.name);
  // A transitively called logic (room 1 -> 2 -> 3) selects the caller's test.
  state.sources.logics.set(1, "call(2);\nreturn;");
  state.sources.logics.set(2, "call(3);\nreturn;");
  putLogic(state, 3, "return;");
  assert.deepEqual(names([{ kind: "logic", num: 3 }]), ["take the key"]);
  assert.deepEqual(names([{ kind: "logic", num: 6 }]), [], "an unreached logic affects nothing");
  // A room the test can transition into is a real dependency.
  state.sources.logics.set(1, "new.room(7);\nreturn;");
  putLogic(state, 7, "return;");
  assert.deepEqual(names([{ kind: "logic", num: 7 }]), ["take the key"]);
  // Runtime-chosen call or transition targets are unknown: select the test.
  state.sources.logics.set(1, "call.v(v50);\nreturn;");
  assert.deepEqual(names([{ kind: "logic", num: 9 }]), ["take the key"]);
  state.sources.logics.set(1, "new.room.v(v50);\nreturn;");
  assert.deepEqual(names([{ kind: "logic", num: 9 }]), ["take the key"]);
  // A recorded setup restores state the file does not describe: never skip it.
  const recorded = { ...takeKey, name: "recorded", setup: { image: "AAAA" } };
  state.sources.logics.set(1, "return;");
  assert.deepEqual(names([{ kind: "logic", num: 99 }], [recorded]), ["recorded"]);
  // Even numeric picture operands name variables: their resource target is dynamic.
  state.sources.logics.set(1, "call(2);\nreturn;");
  state.sources.logics.set(2, "load.pic(8);\ndraw.pic(8);\nreturn;");
  assert.deepEqual(names([{ kind: "picture", num: 8 }]), ["take the key"]);
  assert.deepEqual(names([{ kind: "picture", num: 9 }]), ["take the key"]);
});

test("rerun selection includes global helpers and named immediate operands", () => {
  const state = world("return;");
  putLogic(state, 0, "call(4); return;");
  putLogic(state, 4, "call(5); return;");
  putLogic(state, 5, "return;");
  assert.equal(testsForResource(state, [takeKey], [{ kind: "logic", num: 5 }]).length, 1);
  putLogic(state, 0, "return;");
  state.sources.logics.set(1, "#define HELPER 5\ncall(HELPER); return;");
  assert.equal(testsForResource(state, [takeKey], [{ kind: "logic", num: 5 }]).length, 1);
  state.sources.logics.set(1, "#define PIC 2\nload.pic(PIC); return;");
  assert.equal(testsForResource(state, [takeKey], [{ kind: "picture", num: 2 }]).length, 1);
});

test("a write to a transitively called logic reruns the starting room's tests", () => {
  const state = world(ROOM_LOGIC.replace("return;", "call(2);\nreturn;"));
  putLogic(state, 2, "call(3);\nreturn;");
  putLogic(state, 3, "return;");
  executeAgentTool(state, "write_game_tests", { mode: null, names: null, tests: [takeKey] });
  const written = executeAgentTool(state, "write_logic_source", { room: 3, source: "return;" });
  assert.equal(written.success, true, written.error ?? "");
  assert.match(
    written.message ?? "",
    /^Game tests: 1 game test pass, 0 fail\. 1 of 1 game tests rerun \(selection: room 3\)(?:; \d+ reused unchanged-tree verdicts?)?\./,
  );
});

test("write_actor, write_music and patch_view_cels rerun the tests they can affect", () => {
  const state = world();
  executeAgentTool(state, "write_game_tests", { mode: null, names: null, tests: [needsKey] });
  const verdict = /^Game tests: 0 game tests pass, 1 fail: "needs the key" Expected flag 30=true/;
  const coverage = { ran: 1, stored: 1, notRun: 0 };
  const actor = executeAgentTool(state, "write_actor", {
    num: 1,
    description: null,
    transparentColor: 0,
    mirrorLeftFromRight: true,
    right: [["120", "340"]],
    left: null,
    down: [["506", "780"]],
    up: [["90A", "BC0"]],
  });
  assert.equal(actor.success, true, actor.error ?? "");
  assert.match(actor.message ?? "", verdict);
  assert.deepEqual(actor.details?.["gameTestsRerun"], coverage);
  const music = executeAgentTool(state, "write_music", {
    num: 5,
    tempo: 120,
    tracks: [{ channel: "melody", volume: 13, events: [{ note: "C4", beats: 1, repeat: 1 }] }],
  });
  assert.equal(music.success, true, music.error ?? "");
  assert.match(music.message ?? "", verdict);
  assert.deepEqual(music.details?.["gameTestsRerun"], coverage);
  const patched = executeAgentTool(state, "patch_view_cels", {
    num: 1,
    expectedRevision: String(actor.details?.["revision"]),
    patches: [{ loop: 0, cel: 0, rows: ["999", "999"] }],
  });
  assert.equal(patched.success, true, patched.error ?? "");
  assert.match(patched.message ?? "", verdict);
  assert.deepEqual(patched.details?.["gameTestsRerun"], coverage);
});

test("writers that delegate to another write tool rerun exactly once", () => {
  const state = world();
  executeAgentTool(state, "write_game_tests", { mode: null, names: null, tests: [needsKey] });
  const upserted = executeAgentTool(state, "upsert_inventory_item", {
    id: null,
    name: "Letter",
    location: "room",
    room: 1,
  });
  assert.equal(upserted.success, true, upserted.error ?? "");
  assert.match(upserted.message ?? "", /^Game tests: 0 game tests pass, 1 fail/);
  assert.deepEqual(upserted.details?.["gameTestsRerun"], { ran: 1, stored: 1, notRun: 0 });
  assert.equal(upserted.message?.split("Game tests:").length, 2, "one rerun, one verdict");
  const read = executeAgentTool(state, "read_logic", { num: 1, offset: null, limit: null });
  const line = String(read.details?.["source"] ?? "")
    .split("\n")
    .find((entry) => entry.includes("set(f30)"));
  assert.ok(line, "the disassembled source still sets flag 30");
  const edited = executeAgentTool(state, "edit_resource_source", {
    kind: "logic",
    num: 1,
    edits: [{ find: line, replace: line }],
    expectedRevision: String(read.details?.["revision"]),
  });
  assert.equal(edited.success, true, edited.error ?? "");
  assert.match(edited.message ?? "", /^Game tests: 0 game tests pass, 1 fail/);
  assert.equal(edited.message?.split("Game tests:").length, 2, "one rerun, one verdict");
});

test("a composite write's dictionary update reruns tests in rooms it did not write", () => {
  const state = world();
  putLogic(state, 2, ROOM_LOGIC);
  const roomTwo = { ...takeKey, name: "room two", room: 2 };
  const stored = executeAgentTool(state, "write_game_tests", {
    mode: null,
    names: null,
    tests: [roomTwo],
  });
  assert.equal(stored.success, true, stored.error ?? "");
  const written = executeAgentTool(state, "write_room", {
    room: 5,
    picture: 1,
    egoView: 0,
    title: "Lagoon",
    description: "A quiet lagoon.",
    expectedRevision: resourceRevision(null),
    spawn: { x: 80, y: 120, horizon: 36 },
    exits: [],
    interactions: [
      {
        commands: ["swim"],
        response: "You splash about.",
        blockedResponse: null,
        requiresItem: null,
        requiresFlag: null,
        giveItem: null,
        removeItem: null,
        setFlag: null,
        destination: null,
      },
    ],
  });
  assert.equal(written.success, true, written.error ?? "");
  assert.deepEqual(written.details?.["updatedFiles"], ["WORDS.TOK"]);
  assert.match(
    written.message ?? "",
    /^Game tests: 1 game test pass, 0 fail\. 1 of 1 game tests rerun \(selection: room 5, words\)(?:; \d+ reused unchanged-tree verdicts?)?\./,
  );
  assert.deepEqual(written.details?.["gameTestsRerun"], { ran: 1, stored: 1, notRun: 0 });
});

test("unknown top-level test fields are rejected like the nested validators reject them", () => {
  assert.throws(
    () => validateGameTest({ name: "typo", room: 1, cycleBudegt: 20 }, "tests[0]"),
    /tests\[0\]\.cycleBudegt is not a known field\./,
  );
  // Known fields survive normalization unchanged, including cycleBudget.
  const normalized = validateGameTest({ ...takeKey, cycleBudget: 42 }, "tests[0]");
  assert.equal(normalized.cycleBudget, 42);
  assert.equal(normalized.name, "take the key");
  // The stored-file parse path shares the rejection.
  const doc = JSON.parse(new TextDecoder().decode(serializeGameTests([takeKey]))) as {
    tests: Record<string, unknown>[];
  };
  doc.tests[0]!["cycles"] = 20;
  assert.throws(
    () => parseGameTests(new TextEncoder().encode(JSON.stringify(doc))),
    /tests\[0\]\.cycles is not a known field\./,
  );
});

test("a global dynamic dispatcher conservatively reruns even another room's tests", () => {
  const state = world(ROOM_LOGIC.replace("return;", "call(4);\nreturn;"));
  putLogic(state, 4, "call(5);\nreturn;");
  putLogic(state, 5, "return;");
  putLogic(state, 2, "return;");
  const roomTwo = { ...takeKey, name: "room two", room: 2, steps: [], expect: null };
  executeAgentTool(state, "write_game_tests", {
    mode: null,
    names: null,
    tests: [takeKey, roomTwo],
  });
  const written = executeAgentTool(state, "write_logic_source", { room: 5, source: "return;" });
  assert.equal(written.success, true, written.error ?? "");
  assert.match(
    written.message ?? "",
    /^Game tests: 1 game test pass, 1 fail: "room two" Room initialization/,
  );
  assert.deepEqual(written.details?.["gameTestsRerun"], { ran: 2, stored: 2, notRun: 0 });
});
