import { decodeRecordedReplay } from "./recordedReplay.ts";
/**
 * Game tests: playthrough regression tests stored with the game.
 *
 * A game test is a named playtest_room scenario (room, spawn, steps, expect)
 * kept in the game file TESTS.JSON beside GAME.JSON, so it travels with
 * the ZIP, survives in game storage and reruns after every patch. The
 * runner is the playtest simulation itself, so a stored test and an ad hoc
 * playtest can never disagree about what the game does.
 */
import { PLAYTEST_EXPECT_SCHEMA, PLAYTEST_STEPS_SCHEMA } from "./coreToolDefinitions.ts";
import {
  decodeBase64,
  validateGameTestExpect,
  validateGameTestSetup,
  validateGameTestStep,
  type GameTestSetup,
} from "./gameTestSteps.ts";
import { playtestRoom } from "./playtest.ts";
import type { AgentSessionState, AgentToolResult, ToolDefinition } from "./tools.ts";
import { createContainer } from "../container/container.ts";
import { assembleLogic } from "../logic/assembler.ts";
import { disassembleLogic } from "../logic/disassembler.ts";
import { Engine, type EngineHost } from "../runtime/engine.ts";
import { decodeHostImage, decodeSave } from "../runtime/persistence.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import type { ResourceKind } from "../types.ts";

export const GAME_TESTS_FILE = "TESTS.JSON";
export const GAME_TESTS_FORMAT = "monotio.agi.tests.v1";
/** Stored tests per game; enough for a puzzle or two per room of a large game. */
export const MAX_GAME_TESTS = 64;
/** TESTS.JSON is capped at 256 KiB on reading AND on writing. */
export const GAME_TESTS_MAX_BYTES = 262144;
/** Tests rerun after one patch; keeps a write tool's latency bounded. */
const RERUN_LIMIT = 8;
/** JSON text is escaped again in transport; 3000 characters keeps each page comfortably below 12k. */
const DEFINITION_PAGE_CHARS = 3000;

export interface GameTest {
  readonly name: string;
  readonly room: number;
  readonly spawnX: number | null;
  readonly spawnY: number | null;
  /** Normalized steps (validateGameTestStep); Record so existing stored-test literals stay assignable. */
  readonly steps: readonly Record<string, unknown>[];
  /** Normalized expectations (validateGameTestExpect) or null. */
  readonly expect: Record<string, unknown> | null;
  readonly cycleBudget: number | null;
  /**
   * Recorded tests only: the interpreter state at record-start, restored
   * before the steps run. Absent (never null) means a fresh boot.
   */
  readonly setup?: GameTestSetup | undefined;
}

export interface GameTestsDocument {
  readonly format: typeof GAME_TESTS_FORMAT;
  readonly tests: readonly GameTest[];
}

/** One resource a successful write touched; rerun selection considers every one of them. */
export interface TouchedResource {
  readonly kind: ResourceKind | "words" | "objects";
  readonly num: number;
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
/** Top-level fields of one stored test; anything else is a typo, not an option. */
const TEST_FIELDS = ["name", "room", "spawnX", "spawnY", "steps", "expect", "cycleBudget", "setup"];

/**
 * Strictly shape-check one stored test, including every step and expectation,
 * and return the normalized full shape. Stored-file parsing and the
 * write_game_tests tool share this one path; provider tool-schema validation
 * does not protect imported JSON. When the game's profile is known, a setup
 * image is also decoded through the runtime persistence layer (decodeSave):
 * a malformed image fails here, loudly, never mid-replay.
 */
export function validateGameTest(value: unknown, label: string, profile?: AgiProfile): GameTest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object.`);
  const test = value as Record<string, unknown>;
  for (const key of Object.keys(test))
    if (!TEST_FIELDS.includes(key)) fail(`${label}.${key} is not a known field.`);
  const name = test["name"];
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.,'-]{0,59}$/.test(name))
    fail(`${label}.name must be 1 to 60 characters: letters, digits, spaces, _ . , ' -`);
  const room = test["room"];
  if (typeof room !== "number" || !Number.isInteger(room) || room < 1 || room > 255)
    fail(`${label}.room must be an integer from 1 to 255.`);
  const steps = test["steps"] ?? [];
  if (!Array.isArray(steps) || steps.length > 256)
    fail(`${label}.steps must hold at most 256 actions.`);
  const expect = test["expect"] ?? null;
  const setup =
    test["setup"] == null ? null : validateGameTestSetup(test["setup"], `${label}.setup`);
  if (setup && profile) {
    try {
      decodeSave(decodeHostImage(decodeBase64(setup.image, `${label}.setup.image`)).image, profile);
    } catch (error) {
      fail(
        `${label}.setup.image is not a save image profile ${profile.id} can restore: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    name,
    room,
    spawnX: integerOrNull(test["spawnX"], `${label}.spawnX`, 0, 159),
    spawnY: integerOrNull(test["spawnY"], `${label}.spawnY`, 0, 167),
    steps: steps.map((step, index) => validateGameTestStep(step, `${label}.steps[${index}]`)),
    expect: expect === null ? null : validateGameTestExpect(expect, `${label}.expect`),
    cycleBudget: integerOrNull(test["cycleBudget"], `${label}.cycleBudget`, 1, 60000),
    // Absent setup serializes exactly like the pre-setup format.
    ...(setup ? { setup } : {}),
  };
}

export function parseGameTests(
  bytes: Uint8Array | undefined,
  profile?: AgiProfile,
): GameTestsDocument {
  if (!bytes) return { format: GAME_TESTS_FORMAT, tests: [] };
  if (bytes.length > GAME_TESTS_MAX_BYTES) fail(`${GAME_TESTS_FILE} is larger than 256 KiB.`);
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
  const tests = doc["tests"].map((test, index) =>
    validateGameTest(test, `tests[${index}]`, profile),
  );
  const names = new Set<string>();
  for (const test of tests) {
    if (names.has(test.name)) fail(`Game test names must be unique: ${JSON.stringify(test.name)}.`);
    names.add(test.name);
  }
  return { format: GAME_TESTS_FORMAT, tests };
}
export function serializeGameTests(tests: readonly GameTest[]): Uint8Array {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ format: GAME_TESTS_FORMAT, tests }, null, 2) + "\n",
  );
  if (bytes.length > GAME_TESTS_MAX_BYTES)
    fail(
      `${GAME_TESTS_FILE} would be ${bytes.length} bytes, over the 256 KiB limit. Remove or shorten tests.`,
    );
  return bytes;
}

export function readStoredTests(session: AgentSessionState): readonly GameTest[] {
  return parseGameTests(session.getFiles().get(GAME_TESTS_FILE), session.profile).tests;
}

/**
 * The first dictionary word the REAL parser rejects in a stored command, or
 * null when the parser accepts the whole line. Runs the engine's own
 * normalization and dictionary matching (parseInput via accept.input), so
 * punctuation, filler words and multi-word entries behave exactly as in the
 * game; there is no second word splitter.
 */
function createParserProbe(session: AgentSessionState): (command: string) => string | null {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic("accept.input();\nreturn;", {
      dictionary: session.sources.words,
      profile: session.profile,
    }).payload,
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
  const engine = new Engine(container, host, session.sources.words, {
    profile: session.profile,
  });
  engine.tick();
  return (command) => {
    line = command;
    engine.tick();
    if (engine.vars[9] === 0) return null;
    return engine.parsedWordTexts[engine.parsedWordTexts.length - 1] ?? null;
  };
}

/** Registered words that start like an unknown token, to offer as candidates. */
function wordCandidates(session: AgentSessionState, word: string): string[] {
  const prefix = word.slice(0, Math.min(3, Math.max(1, word.length)));
  return [...session.sources.words.keys()]
    .filter((known) => known.startsWith(prefix))
    .sort()
    .slice(0, 5);
}

/** The authored or disassembled source of a room's logic; null when it cannot be read. */
function roomLogicSource(session: AgentSessionState, room: number): string | null {
  const authored = session.sources.logics.get(room);
  if (authored !== undefined) return authored;
  const payload = session.container.getResource("logic", room);
  if (!payload) return null;
  try {
    return disassembleLogic(payload, {
      dictionary: session.sources.words,
      profile: session.profile,
    });
  } catch {
    return null;
  }
}

/** Logic source without comments and string literals, for reference scans. */
function scannable(source: string): string {
  return source.replace(/\/\/[^\n]*|"(?:\\[^\n]|[^"\\\n])*"/g, "");
}

/**
 * The literal call() and new.room() closure of one test's starting room, plus
 * whether those logics read pictures. Null when any part is unknown — an
 * unreadable logic source or a runtime-chosen call/room target — because then
 * no test can be proven unaffected. Following the closure transitively keeps
 * a change to a shared helper logic from silently selecting zero tests in the
 * rooms that reach it; new.room() targets are followed because a test can
 * transition into another room whose logic the change touches.
 */
function testDependencies(
  session: AgentSessionState,
  room: number,
): { logics: ReadonlySet<number>; readsPictures: boolean } | null {
  const logics = new Set<number>();
  let readsPictures = false;
  // Logic 0 runs every cycle and may call shared helpers independently of the room.
  const queue = [0, room];
  for (let head = 0; head < queue.length; head++) {
    const num = queue[head]!;
    if (logics.has(num)) continue;
    logics.add(num);
    const source = roomLogicSource(session, num);
    if (source === null) return null;
    const code = scannable(source);
    if (/\bcall\.v\s*\(/.test(code) || /\bnew\.room\.v\s*\(/.test(code)) return null;
    for (const match of code.matchAll(/\b(?:call|new\.room)\s*\(([^)]*)\)/g)) {
      // Named constants are valid authoring syntax; unknown is never unaffected.
      if (!/^\s*\d+\s*$/.test(match[1]!)) return null;
      const target = Number(match[1]);
      if (!logics.has(target)) queue.push(target);
    }
    // All picture opcodes take a VARIABLE index, including bare numeric syntax.
    // A source scan cannot prove the runtime value; select any changed picture.
    if (/\b(?:load|draw|overlay)\.pic\s*\(/.test(code)) readsPictures = true;
  }
  return { logics, readsPictures };
}

/**
 * Whether a change to one touched resource can affect a test with the given
 * dependency closure (null: unknown, so conservatively affected). Words,
 * objects, views and sounds always affect every test: the dictionary and
 * inventory drive commands anywhere, and any room may load a view or sound by
 * variable.
 */
function affectsTest(
  deps: { logics: ReadonlySet<number>; readsPictures: boolean } | null,
  touched: TouchedResource,
): boolean {
  const { kind, num } = touched;
  if (kind === "words" || kind === "objects") return true;
  if (kind === "logic" && num === 0) return true;
  if (deps === null) return true;
  if (kind === "logic") return deps.logics.has(num);
  if (kind === "picture") return deps.readsPictures;
  return true;
}

/** The stored tests a change to the touched resources can affect. */
export function testsForResource(
  session: AgentSessionState,
  tests: readonly GameTest[],
  touched: readonly TouchedResource[],
): readonly GameTest[] {
  return tests.filter((test) => {
    // A recorded setup restores interpreter state the stored file does not
    // describe; its real dependency scope is unknown, so never skip it.
    const deps = test.setup ? null : testDependencies(session, test.room);
    return touched.some((resource) => affectsTest(deps, resource));
  });
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
  const result = playtestRoom(
    session,
    {
      room: test.room,
      spawnX: test.spawnX,
      spawnY: test.spawnY,
      steps: test.steps,
      expect: test.expect,
      cycleBudget: test.cycleBudget,
      instructionBudget: null,
    },
    // A recorded setup replays from the restored interpreter state; the image
    // validated at read time, so this decode cannot fail.
    test.setup
      ? {
          setupImage: decodeBase64(test.setup.image, "setup.image"),
          ...(test.setup.replay ? { replay: decodeRecordedReplay(test.setup.replay) } : {}),
        }
      : {},
  );
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
  const runOneResults: AgentToolResult[] = [];
  let firstFailure: AgentToolResult | null = null;
  for (const test of selected) {
    const { outcome, result } = runOne(session, test);
    outcomes.push(outcome);
    runOneResults.push(result);
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
      // Per-test evidence origins: "recorded" when a test restored its stored
      // interpreter state, "boot" when it booted fresh against staged bytes.
      origins: outcomes.map((outcome, index) => ({
        name: outcome.name,
        kind: String(
          (runOneResults[index]?.details?.["origin"] as Record<string, unknown> | undefined)?.[
            "kind"
          ] ?? "boot",
        ),
      })),
      ...(firstFailure?.details ? { firstFailure: firstFailure.details } : {}),
    },
    ...(firstFailure?.images ? { images: firstFailure.images.slice(0, 1) } : {}),
  };
}

/** How a touched resource reads in the rerun report, e.g. "room 3" for its logic. */
function describeTouched(touched: TouchedResource): string {
  if (touched.kind === "words") return "words";
  if (touched.kind === "objects") return "objects";
  if (touched.kind === "logic") return touched.num === 0 ? "logic 0" : `room ${touched.num}`;
  return `${touched.kind} ${touched.num}`;
}

/**
 * After a successful write, rerun the stored tests the change can affect and
 * return the verdict line for the tool result, or null when nothing applies.
 * The line reports the selection, the coverage and any validation failure, so
 * a small green subset cannot be mistaken for full coverage.
 */
export function rerunAffectedTests(
  session: AgentSessionState,
  touched: readonly TouchedResource[],
): {
  line: string;
  outcomes: readonly GameTestOutcome[];
  selection: { ran: number; stored: number; notRun: number };
} | null {
  if (!touched.length) return null;
  let stored: readonly GameTest[];
  try {
    stored = readStoredTests(session);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      line: `${GAME_TESTS_FILE} could not be parsed (${reason}); no game tests rerun. Fix it with write_game_tests (mode replace) or remove it.`,
      outcomes: [],
      selection: { ran: 0, stored: 0, notRun: 0 },
    };
  }
  if (!stored.length) return null;
  const affected = testsForResource(session, stored, touched);
  if (!affected.length) return null;
  const selected = affected.slice(0, RERUN_LIMIT);
  const outcomes = selected.map((test) => runOne(session, test).outcome);
  const notRun = stored.length - outcomes.length;
  const selection = touched.map(describeTouched).join(", ");
  const line = `${verdictLine(outcomes)} ${outcomes.length} of ${stored.length} game tests rerun (selection: ${selection})${notRun ? `; ${notRun} not run` : ""}.`;
  return {
    line,
    outcomes,
    selection: { ran: outcomes.length, stored: stored.length, notRun },
  };
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
      "Read stored game tests (TESTS.JSON). Null names lists compact summaries. Specified names returns editable definitions as JSON text in bounded pages; concatenate definition chunks using nextOffset until null. offset is a character offset, null or omitted starts at zero. Opaque recording setup is omitted and preserved by write_game_tests merge edits.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        names: NAMES_SCHEMA,
        offset: { type: ["integer", "null"], minimum: 0 },
      },
      required: ["names", "offset"],
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
      "Add or replace stored game tests by name (`mode` merge, default), replace the whole set (`mode` replace) or delete the tests listed in `names` (`mode` remove, `tests` null). Each test is a playtest_room scenario: `room`, optional `spawnX`/`spawnY`, `steps` and `expect`, optional `cycleBudget`, and an optional `setup` {image, replay} — the base64 host image and optional machine-generated recording JSON text, which a recorded test restores and replays before its steps. Merge preserves existing setup when null or omitted; replace uses only supplied setup (no setup boots fresh). Steps are command, move, enter, wait (cycles or an until predicate over room/flag/var), key (PC key word), direction (0..8), walkTo (x, y) and answer (prompt text); expectations add score, var ranges, object and reachable to room, carriedItems, flags, vars, printed and text. Commands must use registered words. Write at least one test per puzzle and rerun them with run_game_tests.",
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
              setup: {
                type: ["object", "null"],
                additionalProperties: false,
                properties: {
                  image: { type: "string" },
                  replay: { type: ["string", "null"], maxLength: 262144 },
                },
                required: ["image", "replay"],
              },
            },
            required: [
              "name",
              "room",
              "spawnX",
              "spawnY",
              "steps",
              "expect",
              "cycleBudget",
              "setup",
            ],
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
      const offset = args["offset"] ?? 0;
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
        fail("offset must be a nonnegative integer or null.");
      if (!names && offset !== 0)
        fail("Specify names to read definition pages; summaries use offset 0.");
      const definition = names
        ? JSON.stringify(listed.map(({ setup: _setup, ...test }) => test))
        : null;
      if (definition !== null && offset > definition.length)
        fail("offset is past the end of the selected definitions.");
      return {
        success: true,
        message: listed.length
          ? `${listed.length} of ${stored.length} stored game test${stored.length === 1 ? "" : "s"}.`
          : stored.length
            ? "None of the named tests is stored."
            : "No game tests stored yet. Write one per puzzle with write_game_tests.",
        details:
          definition === null
            ? {
                tests: listed.map((test) => ({
                  name: test.name,
                  room: test.room,
                  steps: test.steps.length,
                  recorded: !!test.setup,
                })),
                stored: stored.length,
              }
            : {
                definition: definition.slice(offset, offset + DEFINITION_PAGE_CHARS),
                offset,
                nextOffset:
                  offset + DEFINITION_PAGE_CHARS < definition.length
                    ? offset + DEFINITION_PAGE_CHARS
                    : null,
                totalChars: definition.length,
                matched: listed.length,
                stored: stored.length,
                recordingSetup:
                  "Omitted from model output; merge preserves existing setup when setup is null or absent. Remove the test first to create a fresh-boot replacement.",
              },
      };
    }
    if (name === "run_game_tests") return runGameTests(session, namesArgument(args["names"]));
    // write_game_tests
    const mode = args["mode"] ?? "merge";
    if (!["merge", "replace", "remove"].includes(String(mode)))
      fail("mode must be merge, replace, remove or null.");
    // Replacement is also the recovery path for a malformed imported file.
    // Validate the replacement fully before assigning any new payload.
    const stored = mode === "replace" ? [] : readStoredTests(session);
    let next: GameTest[];
    let written: GameTest[] = [];
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
      written = tests.map((test, index) =>
        validateGameTest(test, `tests[${index}]`, session.profile),
      );
      let probe: ((command: string) => string | null) | null = null;
      for (const test of written)
        for (const step of test.steps) {
          if (step["action"] !== "command" || step["command"] == null) continue;
          probe ??= createParserProbe(session);
          const unknown = probe(String(step["command"]));
          if (unknown !== null) {
            const candidates = wordCandidates(session, unknown);
            fail(
              `${JSON.stringify(test.name)}: the command ${JSON.stringify(step["command"])} uses a word the dictionary does not know: ${unknown}.${candidates.length ? ` Registered words like: ${candidates.join(", ")}.` : ""} Register new words with write_words first.`,
            );
          }
        }
      const seen = new Set<string>();
      for (const test of written) {
        if (seen.has(test.name)) fail(`Duplicate test name ${JSON.stringify(test.name)} in tests.`);
        seen.add(test.name);
      }
      next =
        mode === "replace"
          ? written
          : [
              ...stored.filter((test) => !seen.has(test.name)),
              ...written.map((test) => {
                const previous = stored.find((entry) => entry.name === test.name);
                return !test.setup && previous?.setup ? { ...test, setup: previous.setup } : test;
              }),
            ];
      if (next.length > MAX_GAME_TESTS) fail(`A game holds at most ${MAX_GAME_TESTS} tests.`);
    }
    session.testsPayload = serializeGameTests(next);
    let runResult: AgentToolResult | undefined;
    if (mode !== "remove" && next.length > 0) {
      const namesToRun = written.map((test) => test.name);
      runResult = runGameTests(session, namesToRun);
    }
    const verdict = runResult ? ` Test verdict: ${runResult.message ?? runResult.error}` : "";
    return {
      success: true,
      message: `${next.length} game test${next.length === 1 ? "" : "s"} stored in ${GAME_TESTS_FILE}.${verdict}`,
      details: {
        stored: next.length,
        names: next.map((test) => test.name),
        ...(runResult?.details ? { run: runResult.details } : {}),
      },
      ...(runResult?.images ? { images: runResult.images } : {}),
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
