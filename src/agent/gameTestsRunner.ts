/** Stored tests run through the same detached interpreter as Agent playtests. */
import { createContainer } from "../container/container.ts";
import { assembleLogic } from "../logic/assembler.ts";
import { parseWordsTok } from "../logic/words.ts";
import { Engine, type EngineHost } from "../runtime/engine.ts";
import { readInventoryObjects } from "./inventory.ts";
import { testSetupReferences } from "../authoring/renumberTestSetup.ts";
import { decodeRecordedReplay } from "./recordedReplay.ts";
import { decodeBase64 } from "./gameTestSteps.ts";
import { playtestRoom, type PlaytestFailure } from "./playtest.ts";
import { resourceSetHint } from "./authoringState.ts";
import type { AgentSessionState, AgentToolResult } from "./agentState.ts";
import { disassembleLogic } from "../logic/disassembler.ts";
import type { ResourceKind } from "../types.ts";
import { GAME_TESTS_FILE, parseGameTests, type GameTest } from "./gameTestFormat.ts";
const RERUN_LIMIT = 8;
/** One resource a successful write touched; rerun selection considers every one of them. */
export interface TouchedResource {
  readonly kind: ResourceKind | "words" | "objects";
  readonly num: number;
}

export function readStoredTests(session: AgentSessionState): readonly GameTest[] {
  return parseGameTests(session.getFiles().get(GAME_TESTS_FILE), session.profile).tests;
}

function readRunTests(session: AgentSessionState): readonly GameTest[] {
  const content = session.readCommittedTests
    ? session.readCommittedTests()
    : session.getFiles().get(GAME_TESTS_FILE);
  return parseGameTests(
    typeof content === "string" ? new TextEncoder().encode(content) : content,
    session.profile,
  ).tests;
}

/** A standalone parser uses the engine's normalization and dictionary matching. */
function createCommandProbe(session: AgentSessionState) {
  const words = session.getFiles().get("WORDS.TOK");
  const dictionary = new Map((words ? parseWordsTok(words) : []).map(({ word, id }) => [word, id]));
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic("accept.input();", { dictionary, profile: session.profile }).payload,
  );
  let line: string | null = null;
  const host: EngineHost = {
    print: () => {},
    displayAt: () => {},
    statusLine: () => {},
    takeKeys: () => [],
    takeInputLine: () => {
      const taken = line;
      line = null;
      return taken;
    },
  };
  const engine = new Engine(container, host, dictionary, { profile: session.profile });
  engine.tick();
  return (command: string): string | null => {
    line = command;
    engine.tick();
    return engine.vars[9] === 0 ? null : (engine.parsedWordTexts.at(-1) ?? command);
  };
}

/** Tests can be written first; running them names every missing game reference. */
function missingReference(session: AgentSessionState, test: GameTest): string | null {
  const rooms = [
    test.room,
    test.expect?.["room"],
    ...test.steps.map((step) => (step["until"] as Record<string, unknown> | undefined)?.["room"]),
  ];
  for (const room of rooms)
    if (typeof room === "number" && !session.container.getResource("logic", room))
      return `Room ${room} is missing. Add this room before running the test.`;
  let probe: ReturnType<typeof createCommandProbe> | undefined;
  for (const step of test.steps) {
    if (step["action"] !== "command") continue;
    probe ??= createCommandProbe(session);
    const unknown = probe(String(step["command"]));
    if (unknown !== null)
      return `Word ${JSON.stringify(unknown)} is missing from the dictionary. Add this word before running the test.`;
  }
  const inventory = readInventoryObjects(session.getFiles().get("OBJECT"), session.profile);
  for (const id of (test.expect?.["carriedItems"] as number[] | undefined) ?? [])
    if (!inventory[id])
      return `Object ${id} is missing from the inventory. Add this object before running the test.`;
  if (test.setup)
    for (const { kind, num } of testSetupReferences(test.setup, session.profile, {
      activeOnly: true,
    }))
      if (!session.container.getResource(kind, num))
        return `The recorded setup needs missing ${kind} ${num}. Add this resource before running the test.`;
  return null;
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

export interface GameTestOutcome {
  name: string;
  room: number;
  status: string;
  passed: boolean;
  cycles: number | null;
  failure: string | null;
  nextSteps: readonly string[];
  failures: readonly PlaytestFailure[];
  failingStepIndex: number | null;
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
  let missing: string | null;
  try {
    missing = missingReference(session, test);
  } catch (error) {
    missing = `The test could not read its game references: ${error instanceof Error ? error.message : String(error)}`;
  }
  let result: AgentToolResult = missing
    ? { success: false, error: missing }
    : playtestRoom(
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
  if (result.details?.["simulation"] === "reached_planned_room") {
    result = {
      ...result,
      success: false,
      error: `Room ${String(result.details["plannedRoom"])} is missing. Add this room before running the test.`,
    };
  }
  const details = result.details ?? {};
  const outcome: GameTestOutcome = {
    name: test.name,
    room: test.room,
    status: String(details["simulation"] ?? (result.success ? "passed" : "failed")),
    passed: result.success,
    cycles: typeof details["cycles"] === "number" ? details["cycles"] : null,
    failure: result.success ? null : (result.error ?? "failed"),
    failures: (details["failures"] as PlaytestFailure[] | undefined) ?? [],
    failingStepIndex:
      typeof details["failingStepIndex"] === "number" ? details["failingStepIndex"] : null,
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
    stored = readRunTests(session);
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
    stored = readRunTests(session);
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
