import assert from "node:assert/strict";
import { test } from "node:test";
import { readGameFiles, readGameZip } from "../app/src/gameZip.ts";
import { buildProjectZip, buildPublicGameZip } from "../app/src/projectArchive.ts";
import {
  GAME_TESTS_FILE,
  GAME_TESTS_FORMAT,
  parseGameTests,
  serializeGameTests,
  testsForResource,
  verdictLine,
  type GameTest,
} from "../src/agent/gameTests.ts";
import { DIRECTION_KEYS, directionForDelta, randomSource } from "../src/agent/gameTestSteps.ts";
import { playtestRoom } from "../src/agent/playtest.ts";
import { splitToolResult } from "../src/agent/toolTransport.ts";
import {
  AGI_SYSTEM_PROMPT,
  createGenesisPrompt,
  createOrientationPrompt,
} from "../src/agent/prompt.ts";
import {
  ASK_TOOLS,
  buildObjectFile,
  createAgentSessionState,
  executeAgentTool,
  type AgentSessionState,
} from "../src/agent/tools.ts";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildWordsTok } from "../src/logic/words.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { buildView } from "../src/view/view.ts";
import {
  DIRECTION_KEYS as RUNNER_DIRECTION_KEYS,
  randomSource as runnerRandomSource,
} from "./speedrun/runner.ts";

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
  waypoints: null,
  target: null,
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

test("the stored format round-trips and rejects what it cannot run", () => {
  const bytes = serializeGameTests([takeKey]);
  const doc = parseGameTests(bytes);
  assert.equal(doc.format, GAME_TESTS_FORMAT);
  assert.deepEqual(doc.tests, [takeKey]);
  assert.deepEqual(parseGameTests(undefined).tests, []);
  // A sparse step (only the fields its action uses) parses to the full shape.
  const sparse = parseGameTests(
    new TextEncoder().encode(
      JSON.stringify({
        format: GAME_TESTS_FORMAT,
        tests: [{ name: "sparse", room: 1, steps: [{ action: "wait", ticks: 3 }] }],
      }),
    ),
  );
  assert.deepEqual(sparse.tests[0]!.steps, [step("wait", { ticks: 3 })]);
  assert.equal(sparse.tests[0]!.expect, null);
  assert.throws(() => parseGameTests(new TextEncoder().encode("{")), /not valid JSON/);
  assert.throws(
    () => parseGameTests(new TextEncoder().encode(JSON.stringify({ format: "x", tests: [] }))),
    /format must be/,
  );
  const twice = JSON.stringify({ format: GAME_TESTS_FORMAT, tests: [takeKey, takeKey] });
  assert.throws(() => parseGameTests(new TextEncoder().encode(twice)), /unique/);
  // The 256 KiB bound holds on reading and on writing.
  assert.throws(() => parseGameTests(new Uint8Array(262145)), /larger than 256 KiB/);
  const bulky = {
    ...takeKey,
    steps: Array.from({ length: 256 }, () =>
      step("command", { command: "take key".padEnd(80, " x") }),
    ),
  };
  assert.throws(
    () =>
      serializeGameTests(
        Array.from({ length: 8 }, (_, index) => ({ ...bulky, name: `bulky ${index}` })),
      ),
    /256 KiB/,
  );
});

test("validateGameTest rejects non-spec shapes at parse time, not at runtime", () => {
  const doc = (tests: unknown[]) =>
    parseGameTests(new TextEncoder().encode(JSON.stringify({ format: GAME_TESTS_FORMAT, tests })));
  const badStep = { ...takeKey, steps: [{ action: "dance" }] };
  assert.throws(() => doc([badStep]), /action must be one of/);
  // Negative and zero ticks are rejected at parse time.
  assert.throws(
    () => doc([{ ...takeKey, steps: [{ action: "wait", ticks: -1 }] }]),
    /ticks must be an integer from 1 to 60000/,
  );
  assert.throws(
    () => doc([{ ...takeKey, steps: [{ action: "wait", ticks: 0 }] }]),
    /ticks must be an integer from 1 to 60000/,
  );
  // Unknown step fields and fields that do not apply to the action are rejected.
  assert.throws(
    () => doc([{ ...takeKey, steps: [{ action: "wait", ticks: 1, turbo: true }] }]),
    /turbo is not a known field/,
  );
  assert.throws(
    () => doc([{ ...takeKey, steps: [{ action: "wait", ticks: 1, command: "look" }] }]),
    /command does not apply to a wait step/,
  );
  // Malformed nested expectations fail at parse time.
  assert.throws(
    () => doc([{ ...takeKey, expect: { flags: [{ id: "30", value: true }] } }]),
    /flags\[0\]\.id must be an integer/,
  );
  assert.throws(
    () => doc([{ ...takeKey, expect: { vars: [{ id: 40 }] } }]),
    /needs an exact value or a min\/max range/,
  );
  assert.throws(
    () => doc([{ ...takeKey, expect: { vars: [{ id: 40, min: 9, max: 2 }] } }]),
    /min must not exceed/,
  );
  assert.throws(
    () => doc([{ ...takeKey, expect: { score: -1 } }]),
    /score must be an integer from 0 to 255/,
  );
  assert.throws(
    () => doc([{ ...takeKey, expect: { mood: "happy" } }]),
    /mood is not a known field/,
  );
  assert.throws(
    () => doc([{ ...takeKey, steps: [{ action: "wait", until: {}, ticks: 5 }] }]),
    /needs at least one condition/,
  );
  assert.throws(
    () => doc([{ ...takeKey, steps: [{ action: "wait", ticks: 2, captureTicks: [2, 1] }] }]),
    /strictly increasing/,
  );
  assert.throws(
    () => doc([{ ...takeKey, steps: [{ action: "wait", ticks: 1, captureTicks: [3] }] }]),
    /exceeds the step's ticks/,
  );
});

test("testsForResource follows real dependencies and stays conservative when they are unknown", () => {
  const state = world();
  // Isolate the room graph; the normal global call.v dispatcher has unknown reach.
  state.container.putResource(
    "logic",
    0,
    assembleLogic("return;", { dictionary: DICTIONARY }).payload,
  );
  const roomTwo = { ...takeKey, name: "room two", room: 2 };
  const roomThree = { ...takeKey, name: "room three", room: 3 };
  const tests = [takeKey, roomTwo, roomThree];
  const names = (
    touched: { kind: "logic" | "picture" | "view" | "sound" | "words" | "objects"; num: number }[],
  ) => testsForResource(state, tests, touched).map((entry) => entry.name);
  // A room's own logic selects that room's tests; room three's logic is
  // unreadable, so its dependencies are unknown and it is always selected.
  assert.deepEqual(names([{ kind: "logic", num: 2 }]), ["room two", "room three"]);
  // Global changes touch everything.
  assert.equal(names([{ kind: "logic", num: 0 }]).length, 3);
  assert.equal(names([{ kind: "words", num: 0 }]).length, 3);
  assert.equal(names([{ kind: "objects", num: 0 }]).length, 3);
  assert.equal(names([{ kind: "view", num: 0 }]).length, 3);
  // A called shared logic affects the caller's tests; an uncalled one does not.
  state.sources.logics.set(1, "call(5);\nreturn;");
  state.sources.logics.set(2, "return;");
  state.sources.logics.set(5, "return;");
  assert.deepEqual(names([{ kind: "logic", num: 5 }]), ["take the key", "room three"]);
  assert.deepEqual(names([{ kind: "logic", num: 6 }]), ["room three"]);
  // Picture operands always name variables, so their target is unknown.
  state.sources.logics.set(1, "load.pic(2);\ndraw.pic(2);\nreturn;");
  assert.deepEqual(names([{ kind: "picture", num: 2 }]), ["take the key", "room three"]);
  assert.deepEqual(names([{ kind: "picture", num: 3 }]), ["take the key", "room three"]);
  // A runtime-chosen picture or call target is unknown: select the test.
  state.sources.logics.set(1, "assignn(v10, 2);\nload.pic(v10);\nreturn;");
  assert.deepEqual(names([{ kind: "picture", num: 2 }]), ["take the key", "room three"]);
  state.sources.logics.set(1, "call.v(v50);\nreturn;");
  assert.deepEqual(names([{ kind: "logic", num: 5 }]), ["take the key", "room three"]);
  // Disassembled container logic is used when no authored source is stored.
  state.sources.logics.delete(1);
  state.sources.logics.delete(2);
  assert.equal(names([{ kind: "picture", num: 2 }]).length, 3, "room 1 loads its picture via v10");
  // Multi-resource writes consider every touched resource.
  state.sources.logics.set(1, "call(5);\nreturn;");
  assert.deepEqual(
    names([
      { kind: "logic", num: 2 },
      { kind: "logic", num: 5 },
    ]),
    ["take the key", "room two", "room three"],
  );
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
    tests: [
      {
        ...takeKey,
        name: "frobnicate",
        steps: [step("command", { command: "frobnicate key" })],
      },
    ],
  });
  assert.equal(unknown.success, false);
  assert.match(unknown.error ?? "", /frobnicate/);
  assert.match(unknown.error ?? "", /write_words/);
  const close = executeAgentTool(state, "write_game_tests", {
    mode: "merge",
    names: null,
    tests: [{ ...takeKey, name: "typo", steps: [step("command", { command: "tak key" })] }],
  });
  assert.equal(close.success, false);
  assert.match(close.error ?? "", /\btak\b/);
  assert.match(close.error ?? "", /\btake\b/, "the error names registered candidates");
  const merged = executeAgentTool(state, "write_game_tests", {
    mode: "merge",
    names: null,
    tests: [{ ...takeKey, name: "look around", steps: [step("wait", { ticks: 3 })], expect: null }],
  });
  assert.equal(merged.success, true, merged.error ?? "");
  assert.deepEqual(merged.details?.["names"], ["take the key", "look around"]);
  const listed = executeAgentTool(state, "read_game_tests", { names: ["look around"] });
  assert.equal(listed.success, true);
  assert.equal((JSON.parse(listed.details?.["definition"] as string) as unknown[]).length, 1);
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

/** Whether the REAL parser (engine said()/dictionary path) accepts a command line. */
function realParserAccepts(command: string): boolean {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic("accept.input();\nreturn;", { dictionary: DICTIONARY }).payload,
  );
  let line: string | null = null;
  const host: EngineHost = {
    print: () => {},
    displayAt: () => {},
    statusLine: () => {},
    takeInputLine: () => {
      const taken = line;
      line = null;
      return taken;
    },
    takeKeys: () => [],
  };
  const engine = new Engine(container, host, DICTIONARY);
  engine.tick();
  line = command;
  engine.tick();
  return engine.vars[9] === 0;
}

test("stored-command acceptance matches the real parser: normalization, punctuation, filler and phrases", () => {
  // The dictionary knows keycard, dont, "ice cream" and the ignored filler "the".
  const cases: [command: string, accepted: boolean][] = [
    ["take key", true],
    ["TAKE KEY", true],
    ["take, the key!", true],
    ["take key-card", true],
    ["don't look", true],
    ["take ice cream", true],
    ["frobnicate key", false],
  ];
  for (const [command, accepted] of cases)
    assert.equal(realParserAccepts(command), accepted, `real parser: ${command}`);
  for (const [command, accepted] of cases) {
    const state = world();
    const written = executeAgentTool(state, "write_game_tests", {
      mode: "replace",
      names: null,
      tests: [{ ...takeKey, steps: [step("command", { command })], expect: null }],
    });
    assert.equal(
      written.success,
      accepted,
      `write_game_tests must ${accepted ? "accept" : "reject"} ${JSON.stringify(command)} the way the real parser does${written.success ? "" : `: ${written.error}`}`,
    );
  }
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

test("stored test runs are deterministic: seeded random and a virtual clock", () => {
  const state = world();
  const args = {
    room: 1,
    spawnX: null,
    spawnY: null,
    steps: takeKey.steps,
    expect: null,
    cycleBudget: null,
    instructionBudget: null,
  };
  const first = playtestRoom(state, args);
  const second = playtestRoom(state, args);
  assert.equal(first.success, true, first.error ?? "");
  // v50 is random(1, 100) from room setup: identical across runs, and every
  // other observed state field too.
  assert.deepEqual(first.details?.["state"], second.details?.["state"]);
  const v50 = (
    first.details?.["state"] as { nonzeroVariables: { id: number; value: number }[] }
  ).nonzeroVariables.find((entry) => entry.id === 50);
  assert.ok(v50 && v50.value >= 1 && v50.value <= 100, "the seeded random source ran");
});

test("a write tool leads with the verdict and reports selection, coverage and parse failures", () => {
  const state = world();
  executeAgentTool(state, "write_game_tests", { mode: null, names: null, tests: [takeKey] });
  const kept = executeAgentTool(state, "write_logic_source", { room: 1, source: ROOM_LOGIC });
  assert.equal(kept.success, true, kept.error ?? "");
  assert.match(
    kept.message ?? "",
    /^Game tests: 1 game test pass, 0 fail\. 1 of 1 game tests rerun \(selection: room 1\)\. Logic 1 compiled successfully/,
  );
  assert.deepEqual(kept.details?.["gameTestsRerun"], { ran: 1, stored: 1, notRun: 0 });
  const broken = executeAgentTool(state, "write_logic_source", {
    room: 1,
    source: ROOM_LOGIC.replace("set(f30);", ""),
  });
  assert.equal(broken.success, true, broken.error ?? "");
  assert.match(
    broken.message ?? "",
    /^Game tests: 0 game tests pass, 1 fail: "take the key" Expected flag 30=true/,
  );
  const outcomes = broken.details?.["gameTests"] as { passed: boolean }[];
  assert.equal(outcomes[0]?.passed, false);
  // The global dynamic dispatcher means another room cannot be proven irrelevant.
  const elsewhere = executeAgentTool(state, "write_logic_source", { room: 2, source: "return;" });
  assert.equal(elsewhere.success, true, elsewhere.error ?? "");
  assert.match(elsewhere.message ?? "", /^Game tests:/);
});

test("reruns report skipped coverage instead of looking like full coverage", () => {
  const state = world();
  const nine = Array.from({ length: 9 }, (_, index) => ({ ...takeKey, name: `puzzle ${index}` }));
  executeAgentTool(state, "write_game_tests", { mode: null, names: null, tests: nine });
  const written = executeAgentTool(state, "write_logic_source", { room: 1, source: ROOM_LOGIC });
  assert.equal(written.success, true, written.error ?? "");
  assert.match(
    written.message ?? "",
    /^Game tests: 8 game tests pass, 0 fail\. 8 of 9 game tests rerun \(selection: room 1\); 1 not run\./,
  );
  assert.deepEqual(written.details?.["gameTestsRerun"], { ran: 8, stored: 9, notRun: 1 });
});

test("a malformed stored test document is reported loudly on the next write", () => {
  const state = world();
  state.testsPayload = new TextEncoder().encode("{");
  const written = executeAgentTool(state, "write_logic_source", { room: 1, source: ROOM_LOGIC });
  assert.equal(written.success, true, written.error ?? "");
  assert.match(
    written.message ?? "",
    /^Game tests: TESTS\.JSON could not be parsed \(TESTS\.JSON is not valid JSON\.\)/,
  );
  // run_game_tests fails loudly too instead of running nothing.
  const run = executeAgentTool(state, "run_game_tests", { names: null });
  assert.equal(run.success, false);
  assert.match(run.error ?? "", /not valid JSON/);
});

test("replace repairs malformed tests while failed validation preserves the original bytes", () => {
  const state = world();
  const corrupt = new TextEncoder().encode("{");
  state.testsPayload = corrupt;
  const bad = executeAgentTool(state, "write_game_tests", {
    mode: "replace",
    names: null,
    tests: [{ ...takeKey, cycleBudegt: 10 }],
  });
  assert.equal(bad.success, false);
  assert.equal(state.testsPayload, corrupt);
  const merge = executeAgentTool(state, "write_game_tests", {
    mode: "merge",
    names: null,
    tests: [takeKey],
  });
  assert.equal(merge.success, false);
  assert.equal(state.testsPayload, corrupt);
  const replaced = executeAgentTool(state, "write_game_tests", {
    mode: "replace",
    names: null,
    tests: [takeKey],
  });
  assert.equal(replaced.success, true, replaced.error ?? "");
  const run = executeAgentTool(state, "run_game_tests", { names: null });
  assert.equal(run.success, true, run.error ?? "");
});

test("the extended step vocabulary runs in the simulation", () => {
  const state = world();
  // key: a PC key word dismisses the opening modal like Enter does.
  const withModal = world(
    ROOM_LOGIC.replace(
      'if (said("take", "key"))',
      'if (!isset(f31)) {set(f31);print("Welcome");}\nif (said("take", "key"))',
    ),
  );
  const keyed = playtestRoom(withModal, {
    room: 1,
    spawnX: null,
    spawnY: null,
    steps: [step("key", { key: 13 }), ...takeKey.steps],
    expect: takeKey.expect,
    cycleBudget: null,
    instructionBudget: null,
  });
  assert.equal(keyed.success, true, keyed.error ?? "");
  // direction: a numeric heading steers ego like a named move.
  const headed = playtestRoom(state, {
    room: 1,
    spawnX: null,
    spawnY: null,
    steps: [step("direction", { direction: 3, ticks: 20 })],
    expect: expectation({
      object: { num: 0, view: 0, x0: 82, y0: 118, x1: 159, y1: 122, active: true },
    }),
    cycleBudget: null,
    instructionBudget: null,
  });
  assert.equal(headed.success, true, headed.error ?? "");
  // direction with compass name synonym 'east' and move with numeric '3' both work equivalently
  const headedSynonym = playtestRoom(state, {
    room: 1,
    spawnX: null,
    spawnY: null,
    steps: [step("direction", { direction: "east", ticks: 20 })],
    expect: expectation({
      object: { num: 0, view: 0, x0: 82, y0: 118, x1: 159, y1: 122, active: true },
    }),
    cycleBudget: null,
    instructionBudget: null,
  });
  assert.equal(headedSynonym.success, true, headedSynonym.error ?? "");
  const movedNumeric = playtestRoom(state, {
    room: 1,
    spawnX: null,
    spawnY: null,
    steps: [step("move", { direction: 3, ticks: 20 })],
    expect: expectation({
      object: { num: 0, view: 0, x0: 82, y0: 118, x1: 159, y1: 122, active: true },
    }),
    cycleBudget: null,
    instructionBudget: null,
  });
  assert.equal(movedNumeric.success, true, movedNumeric.error ?? "");
  // walkTo steers to the target; reachable asserts the same from the final state.
  const walked = playtestRoom(state, {
    room: 1,
    spawnX: null,
    spawnY: null,
    steps: [step("walkTo", { x: 100, y: 120 })],
    expect: expectation({
      object: { num: 0, view: null, x0: 98, y0: 118, x1: 102, y1: 122, active: true },
      reachable: { x: 120, y: 120 },
    }),
    cycleBudget: null,
    instructionBudget: null,
  });
  assert.equal(walked.success, true, walked.error ?? "");
  // walkWaypoints steers through intermediate points to a destination.
  const waypointed = playtestRoom(state, {
    room: 1,
    spawnX: null,
    spawnY: null,
    steps: [
      step("walkWaypoints", {
        waypoints: [
          [85, 120],
          [85, 125],
        ],
      }),
    ],
    expect: expectation({
      object: { num: 0, view: null, x0: 84, y0: 124, x1: 86, y1: 126, active: true },
    }),
    cycleBudget: null,
    instructionBudget: null,
  });
  assert.equal(waypointed.success, true, waypointed.error ?? "");
  // walkPath routes ego into a target bounding box.
  const pathWalked = playtestRoom(state, {
    room: 1,
    spawnX: null,
    spawnY: null,
    steps: [step("walkPath", { target: { x0: 90, y0: 120, x1: 95, y1: 125 } })],
    expect: expectation({
      object: { num: 0, view: null, x0: 89, y0: 119, x1: 96, y1: 126, active: true },
    }),
    cycleBudget: null,
    instructionBudget: null,
  });
  assert.equal(pathWalked.success, true, pathWalked.error ?? "");
  // A barrier blocks both walkTo and reachable.
  const blocked = world();
  blocked.container.putResource("picture", 1, Uint8Array.of(0xf2, 0, 0xf6, 156, 0, 156, 167, 0xff));
  const walled = playtestRoom(blocked, {
    room: 1,
    spawnX: null,
    spawnY: null,
    steps: [step("walkTo", { x: 158, y: 120, ticks: 60 })],
    expect: null,
    cycleBudget: null,
    instructionBudget: null,
  });
  assert.equal(walled.success, false);
  assert.match(walled.error ?? "", /walkTo did not reach \(158,120\)/);
  const unreachable = playtestRoom(blocked, {
    room: 1,
    spawnX: null,
    spawnY: null,
    steps: [],
    expect: expectation({ reachable: { x: 158, y: 120 } }),
    cycleBudget: null,
    instructionBudget: null,
  });
  assert.equal(unreachable.success, false);
  assert.match(unreachable.error ?? "", /\(158,120\) reachable/);
  // answer feeds get.string; without one the game reports the missing input.
  const answered = playtestRoom(state, {
    room: 1,
    spawnX: null,
    spawnY: null,
    steps: [
      step("answer", { answer: "xyzzy" }),
      step("command", { command: "look" }),
      step("wait", { ticks: 2 }),
    ],
    expect: expectation({ vars: [{ id: 41, value: 1, min: null, max: null }] }),
    cycleBudget: null,
    instructionBudget: null,
  });
  assert.equal(answered.success, true, answered.error ?? "");
  const unanswered = playtestRoom(state, {
    room: 1,
    spawnX: null,
    spawnY: null,
    steps: [step("command", { command: "look" }), step("wait", { ticks: 2 })],
    expect: null,
    cycleBudget: null,
    instructionBudget: null,
  });
  assert.equal(unanswered.success, false);
  assert.match(unanswered.error ?? "", /answer step/);
});

test("wait accepts cycles or an until predicate over room, flag and var", () => {
  const state = world();
  const until = (predicate: unknown, ticks = 10) =>
    playtestRoom(state, {
      room: 1,
      spawnX: null,
      spawnY: null,
      steps: [
        step("command", { command: "take key" }),
        step("enter"),
        step("wait", { until: predicate, ticks }),
      ],
      expect: null,
      cycleBudget: null,
      instructionBudget: null,
    });
  assert.equal(until({ room: 1, flag: null, var: null }).success, true);
  assert.equal(until({ room: null, flag: { id: 30, value: true }, var: null }).success, true);
  assert.equal(
    until({ room: null, flag: null, var: { id: 40, value: 7, min: null, max: null } }).success,
    true,
  );
  assert.equal(
    until({ room: null, flag: null, var: { id: 40, value: null, min: 5, max: 10 } }).success,
    true,
  );
  const unmet = until({ room: null, flag: { id: 31, value: true }, var: null }, 5);
  assert.equal(unmet.success, false);
  assert.match(unmet.error ?? "", /did not satisfy.*within 5 cycles/);
});

test("score, var range, object and reachable expectations report observed values", () => {
  const state = world();
  const run = (expect: unknown) =>
    playtestRoom(state, {
      room: 1,
      spawnX: null,
      spawnY: null,
      steps: takeKey.steps,
      expect,
      cycleBudget: null,
      instructionBudget: null,
    });
  assert.equal(run(expectation({ score: 5 })).success, true);
  const score = run(expectation({ score: 4 }));
  assert.equal(score.success, false);
  assert.match(score.error ?? "", /Expected score 4; observed 5/);
  assert.equal(
    run(expectation({ vars: [{ id: 40, value: null, min: 5, max: 10 }] })).success,
    true,
  );
  const range = run(expectation({ vars: [{ id: 40, value: null, min: 8, max: 10 }] }));
  assert.equal(range.success, false);
  assert.match(range.error ?? "", /Expected v40 in 8\.\.10; observed 7/);
  const view = run(
    expectation({
      object: { num: 0, view: 1, x0: null, y0: null, x1: null, y1: null, active: null },
    }),
  );
  assert.equal(view.success, false);
  assert.match(view.error ?? "", /object 0/);
});

test("the speedrun runner imports the shared step vocabulary", () => {
  assert.equal(RUNNER_DIRECTION_KEYS, DIRECTION_KEYS, "one PC direction-key table");
  assert.equal(runnerRandomSource, randomSource, "one seeded random source");
  assert.deepEqual(Array.from({ length: 4 }, randomSource(1)), [15496, 24200, 33046, 46195]);
  for (const [dx, dy, direction] of [
    [0, 0, 0],
    [0, -1, 1],
    [1, -1, 2],
    [1, 0, 3],
    [1, 1, 4],
    [0, 1, 5],
    [-1, 1, 6],
    [-1, 0, 7],
    [-1, -1, 8],
  ] as const)
    assert.equal(directionForDelta(dx, dy), direction, `delta ${dx},${dy}`);
});

test("genesis and orientation prompts require a stored test per puzzle", () => {
  const genesis = createGenesisPrompt("A quiet courtyard.");
  assert.match(genesis, /write_game_tests/);
  assert.match(genesis, /run_game_tests/);
  assert.match(genesis, /each puzzle|every puzzle/);
  const orientation = createOrientationPrompt({
    game: "kq1",
    profile: "2.917",
    room: 1,
    resourceListing: "logic 1",
    logicSource: "return;",
    pictureSource: "picture",
    wordsSummary: "look",
  });
  assert.match(orientation, /write_game_tests/);
  assert.match(orientation, /run_game_tests/);
  assert.match(orientation, /each puzzle|every puzzle/);
});

test("TESTS.JSON survives a ZIP import beside the game files", () => {
  const state = world();
  executeAgentTool(state, "write_game_tests", { mode: null, names: null, tests: [takeKey] });
  const files = new Map<string, Uint8Array>();
  for (const [name, bytes] of state.getFiles()) files.set(`Game/${name}`, bytes);
  const opened = readGameFiles(files);
  assert.deepEqual(parseGameTests(opened.files[GAME_TESTS_FILE]).tests, [takeKey]);
});

test("TESTS.JSON travels in the project archive and never in the game export", async () => {
  // The tests are walkthroughs (rooms, commands, the flags a puzzle sets): a
  // project archive continues the work elsewhere, a game export is published.
  const state = world();
  executeAgentTool(state, "write_game_tests", { mode: null, names: null, tests: [takeKey] });
  const data = {
    projectId: "world",
    title: "World",
    authoredAt: "2026-09-07T00:00:00.000Z",
    provider: "stub",
    model: "local-playback",
    files: Object.fromEntries(state.getFiles()),
    words: [...DICTIONARY] as [string, number][],
  };
  const published = await readGameZip(buildPublicGameZip(data));
  assert.equal(published.files[GAME_TESTS_FILE], undefined, "a published game keeps its secrets");
  const project = await readGameZip(await buildProjectZip(data));
  assert.deepEqual(parseGameTests(project.files[GAME_TESTS_FILE]).tests, [takeKey]);
});

/**
 * The recorder's setup capture, played by hand: the real engine boots, the
 * player takes the key, and serialize() writes the interpreter state exactly
 * as the browser recorder does when a recording starts.
 */
function recordSetupImage(state: AgentSessionState): string {
  const container = openContainer(state.getFiles(), { kind: state.profile.container });
  let line: string | null = null;
  const host: EngineHost = {
    print: () => {},
    displayAt: () => {},
    statusLine: () => {},
    randomWord: () => 42,
    takeInputLine: () => {
      const taken = line;
      line = null;
      return taken;
    },
    takeKeys: () => [],
  };
  const engine = new Engine(container, host, state.sources.words, {
    profile: state.profile,
  });
  engine.tick(); // Boot: logic 0 enters room 1.
  line = "take key";
  engine.tick(); // The said("take", "key") rule fires and prints.
  assert.equal(engine.flags[30], 1, "the recording engine really took the key");
  assert.equal(engine.vars[40], 7);
  if (engine.modalKind) engine.ackPrint();
  engine.tick();
  return Buffer.from(engine.serialize()).toString("base64");
}

test("recorded test reads omit opaque setup and paginate complete editable definitions", () => {
  const state = world();
  const engine = new Engine(
    openContainer(state.getFiles()),
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine: () => null,
      takeKeys: () => [],
    },
    state.sources.words,
    { profile: state.profile },
  );
  engine.tick();
  const setup = {
    image: Buffer.from(engine.recordingImage()!).toString("base64"),
    replay: JSON.stringify({
      state: engine.captureReplayState(),
      operations: Array.from({ length: 1000 }, () => ["clock", 1]),
    }),
  };
  state.testsPayload = serializeGameTests([
    { ...takeKey, setup, steps: Array.from({ length: 256 }, () => step("wait", { ticks: 1 })) },
  ]);
  const original = state.testsPayload;
  const listed = executeAgentTool(state, "read_game_tests", { names: null, offset: null });
  assert.equal(listed.success, true, listed.error ?? "");
  assert.ok(splitToolResult(listed).text.length < 12000);
  assert.equal(JSON.stringify(listed).includes(setup.image), false);
  let offset: number | null = 0;
  let definition = "";
  let pages = 0;
  do {
    const page = executeAgentTool(state, "read_game_tests", { names: [takeKey.name], offset });
    assert.equal(page.success, true, page.error ?? "");
    assert.ok(splitToolResult(page).text.length < 12000);
    assert.equal(typeof page.details?.["definition"], "string");
    definition += page.details!["definition"] as string;
    const next = page.details!["nextOffset"];
    assert.ok(next === null || (typeof next === "number" && next > offset));
    offset = next as number | null;
    assert.ok(++pages < 100, "pagination makes bounded progress");
  } while (offset !== null);
  const decoded = JSON.parse(definition) as GameTest[];
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0]!.steps.length, 256);
  assert.equal(decoded[0]!.setup, undefined);
  assert.ok(pages > 1);
  assert.equal(state.testsPayload, original, "reading never mutates the archive");
  assert.equal(
    executeAgentTool(state, "read_game_tests", { names: [takeKey.name], offset: -1 }).success,
    false,
  );
});

test("merge edits preserve opaque recorded setup when the model omits it or sends null", () => {
  const state = world();
  const setup = { image: recordSetupImage(state) };
  state.testsPayload = serializeGameTests([{ ...takeKey, setup }]);
  for (const supplied of [undefined, null]) {
    const result = executeAgentTool(state, "write_game_tests", {
      mode: "merge",
      names: null,
      tests: [{ ...takeKey, ...(supplied === undefined ? {} : { setup: supplied }) }],
    });
    assert.equal(result.success, true, result.error ?? "");
    assert.deepEqual(parseGameTests(state.testsPayload).tests[0]!.setup, setup);
  }
  const replaced = executeAgentTool(state, "write_game_tests", {
    mode: "replace",
    names: null,
    tests: [takeKey],
  });
  assert.equal(replaced.success, true, replaced.error ?? "");
  assert.equal(parseGameTests(state.testsPayload).tests[0]!.setup, undefined);
});

test("test-read summaries remain bounded at capacity and JSON pages preserve escaped text", () => {
  const state = world();
  const tests = Array.from({ length: 64 }, (_, i) => ({
    ...takeKey,
    name: String(i).padEnd(60, "x"),
    expect: { printed: '"\\\n'.repeat(66) },
  }));
  state.testsPayload = serializeGameTests(tests);
  const summary = executeAgentTool(state, "read_game_tests", { names: null });
  assert.equal(summary.success, true, summary.error ?? "");
  assert.equal((summary.details!["tests"] as unknown[]).length, 64);
  assert.ok(splitToolResult(summary).text.length < 12000);
  const names = tests.map((test) => test.name);
  let offset: number | null = 0;
  let definition = "";
  do {
    const page = executeAgentTool(state, "read_game_tests", { names, offset });
    assert.equal(page.success, true, page.error ?? "");
    assert.ok(splitToolResult(page).text.length < 12000);
    definition += page.details!["definition"] as string;
    const next = page.details!["nextOffset"] as number | null;
    assert.ok(next === null || next > offset);
    offset = next;
  } while (offset !== null);
  assert.deepEqual(JSON.parse(definition), parseGameTests(state.testsPayload).tests);
});

test("a recorded setup replays from mid-game state against the CURRENT resources", () => {
  const state = world();
  const image = recordSetupImage(state);
  // After the recording, the game is patched: the take-key rule no longer
  // carries the item or sets the flag, and its message text changed.
  const patched = executeAgentTool(state, "write_logic_source", {
    room: 1,
    source: ROOM_LOGIC.replace(
      'if (said("take", "key")) {get(0);set(f30);assignn(v40, 7);assignn(v3, 5);print("You take the key.");}',
      'if (said("take", "key")) {assignn(v3, 5);print("You grab the key.");}',
    ),
  });
  assert.equal(patched.success, true, patched.error ?? "");
  const resumed = {
    name: "resume with the key",
    room: 1,
    spawnX: null,
    spawnY: null,
    setup: { image },
    steps: [step("command", { command: "take key" }), step("enter")],
    expect: expectation({
      carriedItems: [0],
      flags: [{ id: 30, value: true }],
      vars: [{ id: 40, value: 7, min: null, max: null }],
      printed: "You grab the key.",
      score: 5,
    }),
    cycleBudget: null,
  };
  // f30 and the carried item can only come from the restored image (the
  // patched logic never sets them); the new message text can only come from
  // the CURRENT resources. One verdict proves both halves of the contract.
  const fresh = {
    name: "fresh boot has no key",
    room: 1,
    spawnX: null,
    spawnY: null,
    steps: resumed.steps,
    expect: resumed.expect,
    cycleBudget: null,
  };
  const written = executeAgentTool(state, "write_game_tests", {
    mode: null,
    names: null,
    tests: [resumed, fresh],
  });
  assert.equal(written.success, true, written.error ?? "");
  const only = executeAgentTool(state, "run_game_tests", { names: ["resume with the key"] });
  assert.equal(only.success, true, only.error ?? "");
  const all = executeAgentTool(state, "run_game_tests", { names: null });
  assert.equal(all.success, false);
  assert.match(
    all.error ?? "",
    /^1 game test pass, 1 fail: "fresh boot has no key" Expected item 0 carried; observed room 1\. Expected flag 30=true; observed false\. Expected v40=7; observed 0\./,
  );
});

test("a malformed setup image is rejected at parse and at write_game_tests", () => {
  const state = world();
  const docBytes = (setup: unknown) =>
    new TextEncoder().encode(
      JSON.stringify({ format: GAME_TESTS_FORMAT, tests: [{ ...takeKey, setup }] }),
    );
  // Shape and base64 checks need no profile.
  assert.throws(
    () => parseGameTests(docBytes({ image: "not base64!!" })),
    /setup\.image must be standard padded base64/,
  );
  assert.throws(() => parseGameTests(docBytes({ image: 42 })), /setup\.image must be base64/);
  assert.throws(
    () => parseGameTests(docBytes({ image: "AAAA", extra: true })),
    /setup\.extra is not a known field/,
  );
  // Well-formed base64 that is not a save image this profile can restore
  // fails the decodeSave validation when the profile is known.
  const truncated = Buffer.from(recordSetupImage(state), "base64").subarray(0, 16);
  const alien = truncated.toString("base64");
  assert.throws(
    () => parseGameTests(docBytes({ image: alien }), state.profile),
    /setup\.image is not a save image/,
  );
  // write_game_tests runs the same validation with the session's profile.
  const written = executeAgentTool(state, "write_game_tests", {
    mode: null,
    names: null,
    tests: [{ ...takeKey, setup: { image: alien } }],
  });
  assert.equal(written.success, false);
  assert.match(written.error ?? "", /setup\.image is not a save image/);
  const badBase64 = executeAgentTool(state, "write_game_tests", {
    mode: null,
    names: null,
    tests: [{ ...takeKey, setup: { image: "??" } }],
  });
  assert.equal(badBase64.success, false);
  assert.match(badBase64.error ?? "", /setup\.image must be standard padded base64/);
  // Tests without setup serialize exactly like the pre-setup format.
  assert.ok(
    !new TextDecoder().decode(serializeGameTests([takeKey])).includes("setup"),
    "no-setup tests stay byte-identical",
  );
});

// Keep the GameTest type referenced so the stored shape stays exported.
const _typecheck: GameTest = takeKey;
void _typecheck;
