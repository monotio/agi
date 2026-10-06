import { toolDescription, parameterDescriptions } from "../vocabulary.ts";
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
import { decodeBase64 } from "./gameTestSteps.ts";
import { playtestRoom } from "./playtest.ts";
import { resourceSetHint } from "./authoringState.ts";
import type { AgentSessionState, AgentToolResult } from "./agentState.ts";
import type { ToolDefinition } from "./tools.ts";
import { createContainer } from "../container/container.ts";
import { assembleLogic } from "../logic/assembler.ts";
import { disassembleLogic } from "../logic/disassembler.ts";
import { Engine, type EngineHost } from "../runtime/engine.ts";
import type { ResourceKind } from "../types.ts";
import {
  GAME_TESTS_FILE,
  parseGameTests,
  serializeGameTests,
  validateGameTest,
  type GameTest,
} from "./gameTestFormat.ts";

/**
 * Tests one write_game_tests or run_game_tests call may name. A game keeps
 * any number of tests; this only bounds a single call, which can repeat.
 */
const MAX_GAME_TESTS = 64;
/** Tests rerun after one patch; keeps a write tool's latency bounded. */
const RERUN_LIMIT = 8;
/** Whole ordinary definitions fit inline; larger suites retain character paging. */
const DEFINITION_PAGE_CHARS = 65536;

/** One resource a successful write touched; rerun selection considers every one of them. */
export interface TouchedResource {
  readonly kind: ResourceKind | "words" | "objects";
  readonly num: number;
}

function fail(message: string): never {
  throw new Error(message);
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
  /** True when the verdict came from the evidence cache, not a fresh simulation. */
  reused?: boolean | undefined;
}

/**
 * Cache key of one test verdict: the whole resource tree, the test's
 * serialized definition and setup, the interpreter profile, and the fixed
 * simulation seed. A verdict is reusable only when all of them match — a
 * byte-identical room number says nothing.
 */
function testEvidenceKey(session: AgentSessionState, test: GameTest): string {
  let hash = 0x811c9dc5;
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i++)
      hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ 0xff, 0x01000193) >>> 0;
  };
  feed(resourceSetHint(session));
  feed(JSON.stringify(test));
  feed(session.profile.id);
  feed("seed:123456789");
  feed(`rng:${test.rngVersion ?? 2}`);
  return hash.toString(16).padStart(8, "0");
}

function runOne(
  session: AgentSessionState,
  test: GameTest,
): { outcome: GameTestOutcome; result: AgentToolResult } {
  const key = testEvidenceKey(session, test);
  const cached = session.testEvidence.get(key);
  if (cached)
    return {
      outcome: { ...(cached.outcome as GameTestOutcome), reused: true },
      result: cached.result,
    };
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
          rngVersion: test.rngVersion ?? 2,
          setupImage: decodeBase64(test.setup.image, "setup.image"),
          ...(test.setup.replay ? { replay: decodeRecordedReplay(test.setup.replay) } : {}),
        }
      : { rngVersion: test.rngVersion ?? 2 },
  );
  const details = result.details ?? {};
  const outcome: GameTestOutcome = {
    name: test.name,
    room: test.room,
    status: String(details["simulation"] ?? (result.success ? "passed" : "failed")),
    passed: result.success,
    cycles: typeof details["cycles"] === "number" ? details["cycles"] : null,
    failure: result.success ? null : (result.error ?? "failed"),
    nextSteps: Array.isArray(details["nextSteps"]) ? (details["nextSteps"] as string[]) : [],
  };
  session.testEvidence.set(key, { outcome, result });
  return { result, outcome };
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
  limit = Infinity,
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
      reused: outcomes.filter((outcome) => outcome.reused).length,
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
  const reused = outcomes.filter((outcome) => outcome.reused).length;
  const notRun = stored.length - outcomes.length;
  const selection = touched.map(describeTouched).join(", ");
  const line = `${verdictLine(outcomes)} ${outcomes.length} of ${stored.length} game tests rerun (selection: ${selection})${reused ? `; ${reused} reused unchanged-tree verdict${reused === 1 ? "" : "s"}` : ""}${notRun ? `; ${notRun} not run` : ""}.`;
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
    description: toolDescription(
      "read_game_tests",
      "Read stored game tests (TESTS.JSON). Null names lists compact summaries. Specified names returns editable definitions as JSON text in bounded pages; concatenate definition chunks using nextOffset until null. offset is a character offset, null or omitted starts at zero. Opaque recording setup is omitted and preserved by write_game_tests merge edits.",
    ),
    parameters: parameterDescriptions("read_game_tests", {
      type: "object",
      additionalProperties: false,
      properties: {
        names: NAMES_SCHEMA,
        offset: { type: ["integer", "null"], minimum: 0 },
      },
      required: ["names", "offset"],
    }),
  },
  {
    name: "run_game_tests",
    description: toolDescription(
      "run_game_tests",
      "Replay stored game tests against current resources in the bounded simulation: pass count, first failure with room and cycle, per-test outcomes in details and the failing frame as an image. Null `names` runs every stored test. Write tools rerun the tests their change touches.",
    ),
    parameters: parameterDescriptions("run_game_tests", {
      type: "object",
      additionalProperties: false,
      properties: { names: NAMES_SCHEMA },
      required: ["names"],
    }),
  },
  {
    name: "write_game_tests",
    description: toolDescription(
      "write_game_tests",
      "Add or replace stored game tests by name (`mode` merge, default), replace the whole set (`mode` replace) or delete the tests listed in `names` (`mode` remove, `tests` null). Each test is a playtest_room scenario: `room`, optional `spawnX`/`spawnY`, `steps` and `expect`, optional `cycleBudget`, and an optional `setup` {image, replay}. the base64 host image and optional machine-generated recording JSON text, which a recorded test restores and replays before its steps. Merge preserves existing setup when null or omitted; replace uses only supplied setup (no setup boots fresh). Steps are command, move, enter, wait (cycles or an until predicate over room/flag/var), key (PC key word), direction (0..8; with until it walks that way until the predicate holds, as in right until room 2), walkTo (x, y) and answer (prompt text); expectations add score, var ranges, object and reachable to room, carriedItems, flags, vars, printed and text. Commands must use registered words.",
    ),
    parameters: parameterDescriptions("write_game_tests", {
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
              rngVersion: {
                type: ["integer", "null"],
                enum: [1, 2, null],
                description:
                  "1 keeps released RNG behavior. 2 advances deterministic entropy. Null keeps the existing version when merging.",
              },
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
              "rngVersion",
              "setup",
            ],
          },
        },
      },
      required: ["mode", "names", "tests"],
    }),
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
      written = tests.map((test, index) => {
        const validated = validateGameTest(test, `tests[${index}]`, session.profile);
        const requested = (test as Record<string, unknown>)["rngVersion"];
        const previous = stored.find((entry) => entry.name === validated.name);
        return mode === "merge" && requested == null && previous?.rngVersion === 1
          ? { ...validated, rngVersion: 1 as const }
          : validated;
      });
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
