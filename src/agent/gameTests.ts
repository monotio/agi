/** Agent wording and schemas around shared test editing and execution. */
import { toolDescription, parameterDescriptions } from "../vocabulary.ts";
import { PLAYTEST_EXPECT_SCHEMA, PLAYTEST_STEPS_SCHEMA } from "./coreToolDefinitions.ts";
import type { AgentSessionState, AgentToolResult } from "./agentState.ts";
import type { ToolDefinition } from "./tools.ts";
import { GAME_TESTS_FILE } from "./gameTestFormat.ts";
import { editGameTests, GameTestsEditError } from "./gameTestsEdit.ts";
import { readStoredTests, runGameTests } from "./gameTestsRunner.ts";
const MAX_GAME_TESTS = 64;
const DEFINITION_PAGE_CHARS = 65536;
function fail(message: string): never {
  throw new Error(message);
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
    const edited = editGameTests(
      {
        document: session.getFiles().get(GAME_TESTS_FILE),
        profile: session.profile,
        words: session.getFiles().get("WORDS.TOK"),
      },
      mode === "remove"
        ? { kind: "remove", names: namesArgument(args["names"]) ?? [] }
        : { kind: mode as "merge" | "replace", tests: args["tests"], order: "append" },
    );
    const next = edited.tests;
    const written = edited.written;
    session.testsPayload = edited.payload;
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
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error:
        error instanceof GameTestsEditError && error.kind === "unknown_word"
          ? `${message} Register new words with write_words first.`
          : message,
    };
  }
}
