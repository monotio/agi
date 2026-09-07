/**
 * Game tests: playthrough regression tests stored with the game.
 *
 * A game test is a named playtest_room scenario (room, spawn, steps, expect)
 * kept in the cartridge file TESTS.JSON beside GAME.JSON, so it travels with
 * the ZIP, survives in cartridge storage and reruns after every patch. The
 * runner is the playtest simulation itself, so a stored test and an ad hoc
 * playtest can never disagree about what the game does.
 */
import { PLAYTEST_EXPECT_SCHEMA, PLAYTEST_STEPS_SCHEMA } from "./coreToolDefinitions.ts";
import { playtestRoom } from "./playtest.ts";
import type { AgentSessionState, AgentToolResult, ToolDefinition } from "./tools.ts";
import type { ResourceKind } from "../types.ts";

export const GAME_TESTS_FILE = "TESTS.JSON";
export const GAME_TESTS_FORMAT = "monotio.agi.tests.v1";
/** Stored tests per game; enough for a puzzle or two per room of a large game. */
export const MAX_GAME_TESTS = 64;
/** Tests rerun after one patch; keeps a write tool's latency bounded. */
const RERUN_LIMIT = 8;

export interface GameTest {
  readonly name: string;
  readonly room: number;
  readonly spawnX: number | null;
  readonly spawnY: number | null;
  readonly steps: readonly Record<string, unknown>[];
  readonly expect: Record<string, unknown> | null;
  readonly cycleBudget: number | null;
}

export interface GameTestsDocument {
  readonly format: typeof GAME_TESTS_FORMAT;
  readonly tests: readonly GameTest[];
}

function fail(message: string): never {
  throw new Error(message);
}

function integerOrNull(value: unknown, label: string, min: number, max: number): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    fail(`${label} must be an integer from ${min} to ${max}, or null.`);
  return value;
}

/** Shape-check one stored test; the simulation validates step and expect details when it runs. */
export function validateGameTest(value: unknown, label: string): GameTest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object.`);
  const test = value as Record<string, unknown>;
  const name = test["name"];
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.,'-]{0,59}$/.test(name))
    fail(`${label}.name must be 1 to 60 characters: letters, digits, spaces, _ . , ' -`);
  const room = test["room"];
  if (typeof room !== "number" || !Number.isInteger(room) || room < 1 || room > 255)
    fail(`${label}.room must be an integer from 1 to 255.`);
  const steps = test["steps"] ?? [];
  if (!Array.isArray(steps) || steps.length > 256)
    fail(`${label}.steps must hold at most 256 actions.`);
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== "object" || Array.isArray(step))
      fail(`${label}.steps[${index}] must be an action object.`);
    const action = (step as Record<string, unknown>)["action"];
    if (!["command", "move", "enter", "wait"].includes(String(action)))
      fail(`${label}.steps[${index}].action must be command, move, enter or wait.`);
  }
  const expect = test["expect"] ?? null;
  if (expect !== null && (typeof expect !== "object" || Array.isArray(expect)))
    fail(`${label}.expect must be an assertion object or null.`);
  return {
    name,
    room,
    spawnX: integerOrNull(test["spawnX"], `${label}.spawnX`, 0, 159),
    spawnY: integerOrNull(test["spawnY"], `${label}.spawnY`, 0, 167),
    steps: steps.map((step) => ({ ...(step as Record<string, unknown>) })),
    expect: expect === null ? null : { ...(expect as Record<string, unknown>) },
    cycleBudget: integerOrNull(test["cycleBudget"], `${label}.cycleBudget`, 1, 60000),
  };
}

export function parseGameTests(bytes: Uint8Array | undefined): GameTestsDocument {
  if (!bytes) return { format: GAME_TESTS_FORMAT, tests: [] };
  if (bytes.length > 262144) fail(`${GAME_TESTS_FILE} is larger than 256 KiB.`);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(`${GAME_TESTS_FILE} is not valid JSON.`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    fail(`${GAME_TESTS_FILE} must hold an object.`);
  const doc = raw as Record<string, unknown>;
  if (doc["format"] !== GAME_TESTS_FORMAT)
    fail(`${GAME_TESTS_FILE} format must be ${GAME_TESTS_FORMAT}.`);
  if (!Array.isArray(doc["tests"]) || doc["tests"].length > MAX_GAME_TESTS)
    fail(`${GAME_TESTS_FILE} must list at most ${MAX_GAME_TESTS} tests.`);
  const tests = doc["tests"].map((test, index) => validateGameTest(test, `tests[${index}]`));
  const names = new Set<string>();
  for (const test of tests) {
    if (names.has(test.name)) fail(`Game test names must be unique: ${JSON.stringify(test.name)}.`);
    names.add(test.name);
  }
  return { format: GAME_TESTS_FORMAT, tests };
}

export function serializeGameTests(tests: readonly GameTest[]): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ format: GAME_TESTS_FORMAT, tests }, null, 2) + "\n",
  );
}

export function readStoredTests(session: AgentSessionState): readonly GameTest[] {
  return parseGameTests(session.getFiles().get(GAME_TESTS_FILE)).tests;
}

/** Parser words a stored command uses that the dictionary does not know. */
function unknownWords(session: AgentSessionState, command: string): string[] {
  const known = session.sources.words;
  return command
    .toLowerCase()
    .split(/[^a-z0-9'-]+/)
    .filter((word) => word && !known.has(word));
}

/** The stored tests a change to `kind` `num` can affect. */
export function testsForResource(
  tests: readonly GameTest[],
  kind: ResourceKind | "words" | "objects",
  num: number,
): readonly GameTest[] {
  if (kind === "words" || kind === "objects" || (kind === "logic" && num === 0)) return tests;
  if (kind === "logic" || kind === "picture") return tests.filter((test) => test.room === num);
  return tests;
}

interface GameTestOutcome {
  name: string;
  room: number;
  status: string;
  passed: boolean;
  cycles: number | null;
  failure: string | null;
  nextSteps: readonly string[];
}

function runOne(
  session: AgentSessionState,
  test: GameTest,
): { outcome: GameTestOutcome; result: AgentToolResult } {
  const result = playtestRoom(session, {
    room: test.room,
    spawnX: test.spawnX,
    spawnY: test.spawnY,
    steps: test.steps,
    expect: test.expect,
    cycleBudget: test.cycleBudget,
    instructionBudget: null,
  });
  const details = result.details ?? {};
  return {
    result,
    outcome: {
      name: test.name,
      room: test.room,
      status: String(details["simulation"] ?? (result.success ? "passed" : "failed")),
      passed: result.success,
      cycles: typeof details["cycles"] === "number" ? details["cycles"] : null,
      failure: result.success ? null : (result.error ?? "failed"),
      nextSteps: Array.isArray(details["nextSteps"]) ? (details["nextSteps"] as string[]) : [],
    },
  };
}

/** One line a reader can act on: the count first, then the first failure with its room and cycle. */
export function verdictLine(outcomes: readonly GameTestOutcome[]): string {
  const failed = outcomes.filter((outcome) => !outcome.passed);
  const passed = outcomes.length - failed.length;
  if (!outcomes.length) return "No game tests stored.";
  const head = `${passed} game test${passed === 1 ? "" : "s"} pass, ${failed.length} fail`;
  if (!failed.length) return `${head}.`;
  const first = failed[0]!;
  const where =
    first.cycles === null ? `room ${first.room}` : `room ${first.room}, cycle ${first.cycles}`;
  return `${head}: ${JSON.stringify(first.name)} ${first.failure} (${where})${failed.length > 1 ? `; ${failed.length - 1} more` : ""}.`;
}

/** Run stored tests (all, or the named ones) and shape the verdict-first result. */
export function runGameTests(
  session: AgentSessionState,
  names: readonly string[] | null,
  limit = MAX_GAME_TESTS,
): AgentToolResult {
  let stored: readonly GameTest[];
  try {
    stored = readStoredTests(session);
  } catch (error) {
    return { success: false, error: String(error instanceof Error ? error.message : error) };
  }
  const missing = (names ?? []).filter((name) => !stored.some((test) => test.name === name));
  if (missing.length)
    return {
      success: false,
      error: `No game test named ${missing.map((name) => JSON.stringify(name)).join(", ")}. Stored: ${stored.map((test) => JSON.stringify(test.name)).join(", ") || "none"}.`,
    };
  const selected = (names ? stored.filter((test) => names.includes(test.name)) : stored).slice(
    0,
    limit,
  );
  const outcomes: GameTestOutcome[] = [];
  let firstFailure: AgentToolResult | null = null;
  for (const test of selected) {
    const { outcome, result } = runOne(session, test);
    outcomes.push(outcome);
    if (!outcome.passed && !firstFailure) firstFailure = result;
  }
  const line = verdictLine(outcomes);
  return {
    success: outcomes.every((outcome) => outcome.passed),
    ...(outcomes.every((outcome) => outcome.passed)
      ? { message: `${line} Each test replays its stored steps against the current resources.` }
      : { error: line }),
    details: {
      gameTests: outcomes,
      stored: stored.length,
      ran: outcomes.length,
      ...(firstFailure?.details ? { firstFailure: firstFailure.details } : {}),
    },
    ...(firstFailure?.images ? { images: firstFailure.images.slice(0, 1) } : {}),
  };
}

/**
 * After a successful write, rerun the stored tests the change can affect and
 * return the verdict line for the tool result, or null when nothing applies.
 */
export function rerunAffectedTests(
  session: AgentSessionState,
  kind: ResourceKind | "words" | "objects",
  num: number,
): { line: string; outcomes: readonly GameTestOutcome[] } | null {
  let stored: readonly GameTest[];
  try {
    stored = readStoredTests(session);
  } catch {
    return null;
  }
  const affected = testsForResource(stored, kind, num).slice(0, RERUN_LIMIT);
  if (!affected.length) return null;
  const outcomes = affected.map((test) => runOne(session, test).outcome);
  return { line: verdictLine(outcomes), outcomes };
}

const NAMES_SCHEMA = {
  type: ["array", "null"],
  maxItems: MAX_GAME_TESTS,
  items: { type: "string", maxLength: 60 },
};

export const GAME_TEST_TOOLS: readonly ToolDefinition[] = [
  {
    name: "read_game_tests",
    description:
      "List the game tests stored with the game (TESTS.JSON): name, room, steps and expectations. Null `names` lists all.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { names: NAMES_SCHEMA },
      required: ["names"],
    },
  },
  {
    name: "run_game_tests",
    description:
      "Replay stored game tests against the current resources in the bounded simulation and report the verdict first: how many pass, then the first failure with its room and cycle, per-test outcomes in details and the failing frame as an image. Null `names` runs every stored test. Write tools already rerun the tests their change touches.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { names: NAMES_SCHEMA },
      required: ["names"],
    },
  },
  {
    name: "write_game_tests",
    description:
      "Add or replace stored game tests by name (`mode` merge, default), replace the whole set (`mode` replace) or delete the tests listed in `names` (`mode` remove, `tests` null). Each test is a playtest_room scenario: `room`, optional `spawnX`/`spawnY`, `steps` and `expect`, optional `cycleBudget`. Commands must use registered words. Write at least one test per puzzle and rerun them with run_game_tests.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: ["string", "null"], enum: ["merge", "replace", "remove", null] },
        names: NAMES_SCHEMA,
        tests: {
          type: ["array", "null"],
          maxItems: MAX_GAME_TESTS,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string", maxLength: 60 },
              room: { type: "integer", minimum: 1, maximum: 255 },
              spawnX: { type: ["integer", "null"], minimum: 0, maximum: 159 },
              spawnY: { type: ["integer", "null"], minimum: 0, maximum: 167 },
              steps: PLAYTEST_STEPS_SCHEMA,
              expect: PLAYTEST_EXPECT_SCHEMA,
              cycleBudget: { type: ["integer", "null"], minimum: 1, maximum: 60000 },
            },
            required: ["name", "room", "spawnX", "spawnY", "steps", "expect", "cycleBudget"],
          },
        },
      },
      required: ["mode", "names", "tests"],
    },
  },
];

function namesArgument(value: unknown): readonly string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string"))
    fail("names must be null or an array of test names.");
  return value as string[];
}

export function executeGameTestTool(
  session: AgentSessionState,
  name: string,
  args: Record<string, unknown>,
): AgentToolResult | null {
  if (!GAME_TEST_TOOLS.some((tool) => tool.name === name)) return null;
  try {
    if (name === "read_game_tests") {
      const names = namesArgument(args["names"]);
      const stored = readStoredTests(session);
      const listed = names ? stored.filter((test) => names.includes(test.name)) : stored;
      return {
        success: true,
        message: listed.length
          ? `${listed.length} of ${stored.length} stored game test${stored.length === 1 ? "" : "s"}.`
          : stored.length
            ? "None of the named tests is stored."
            : "No game tests stored yet. Write one per puzzle with write_game_tests.",
        details: { tests: listed, stored: stored.length },
      };
    }
    if (name === "run_game_tests") return runGameTests(session, namesArgument(args["names"]));
    // write_game_tests
    const mode = args["mode"] ?? "merge";
    if (!["merge", "replace", "remove"].includes(String(mode)))
      fail("mode must be merge, replace, remove or null.");
    const stored = readStoredTests(session);
    let next: GameTest[];
    if (mode === "remove") {
      const names = namesArgument(args["names"]);
      if (!names?.length) fail("remove needs the names of the tests to delete.");
      const missing = names.filter((name) => !stored.some((test) => test.name === name));
      if (missing.length)
        fail(`No game test named ${missing.map((n) => JSON.stringify(n)).join(", ")}.`);
      next = stored.filter((test) => !names.includes(test.name));
    } else {
      const tests = args["tests"];
      if (!Array.isArray(tests) || !tests.length) fail(`${mode} needs at least one test in tests.`);
      const written = tests.map((test, index) => validateGameTest(test, `tests[${index}]`));
      for (const test of written)
        for (const step of test.steps) {
          if (step["action"] !== "command") continue;
          const unknown = unknownWords(session, String(step["command"] ?? ""));
          if (unknown.length)
            fail(
              `${JSON.stringify(test.name)}: the command ${JSON.stringify(step["command"])} uses words the dictionary does not know: ${unknown.join(", ")}. Register them with write_words first.`,
            );
        }
      const seen = new Set<string>();
      for (const test of written) {
        if (seen.has(test.name)) fail(`Duplicate test name ${JSON.stringify(test.name)} in tests.`);
        seen.add(test.name);
      }
      next =
        mode === "replace"
          ? written
          : [...stored.filter((test) => !seen.has(test.name)), ...written];
      if (next.length > MAX_GAME_TESTS) fail(`A game holds at most ${MAX_GAME_TESTS} tests.`);
    }
    session.testsPayload = serializeGameTests(next);
    return {
      success: true,
      message: `${next.length} game test${next.length === 1 ? "" : "s"} stored in ${GAME_TESTS_FILE}. Run them with run_game_tests; write tools rerun the ones their change touches.`,
      details: { stored: next.length, names: next.map((test) => test.name) },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
