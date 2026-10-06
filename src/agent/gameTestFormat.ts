/**
 * The stored game-test format: TESTS.JSON's shape, its strict parser and its
 * serializer. The runner and the write_game_tests tool live in gameTests.ts;
 * this half stays light so the map and the Studios can read a game's tests
 * without loading the playtest simulation.
 */
import {
  decodeBase64,
  validateGameTestExpect,
  validateGameTestSetup,
  validateGameTestStep,
  type GameTestSetup,
} from "./gameTestSteps.ts";
import { decodeHostImage, decodeSave } from "../runtime/persistence.ts";
import type { AgiProfile } from "../runtime/profile.ts";

export const GAME_TESTS_FILE = "TESTS.JSON";
export const GAME_TESTS_FORMAT = "monotio.agi.tests.v2";
const RELEASED_GAME_TESTS_FORMAT = "monotio.agi.tests.v1";
/** TESTS.JSON is bounded on reading and writing by a game archive entry (gameZip MAX_ENTRY_BYTES). */
export const GAME_TESTS_MAX_BYTES = 64 * 1024 * 1024;

export interface GameTest {
  readonly rngVersion?: 1 | 2;
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
  readonly format: typeof GAME_TESTS_FORMAT | typeof RELEASED_GAME_TESTS_FORMAT;
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
/** Top-level fields of one stored test; anything else is a typo, not an option. */
const TEST_FIELDS = [
  "name",
  "room",
  "spawnX",
  "spawnY",
  "steps",
  "expect",
  "cycleBudget",
  "setup",
  "rngVersion",
];

/**
 * Strictly shape-check one stored test, including every step and expectation,
 * and return the normalized full shape. Stored-file parsing and the
 * write_game_tests tool share this one path; provider tool-schema validation
 * does not protect imported JSON. When the game's profile is known, a setup
 * image is also decoded through the runtime persistence layer (decodeSave):
 * a malformed image fails here, loudly, never mid-replay.
 */
export function validateGameTest(
  value: unknown,
  label: string,
  profile?: AgiProfile,
  version: 1 | 2 = 2,
): GameTest {
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
  if (test["rngVersion"] != null && test["rngVersion"] !== 1 && test["rngVersion"] !== 2)
    fail(`${label}.rngVersion must be 1 or 2.`);
  return {
    ...(test["rngVersion"] === 1 || (test["rngVersion"] == null && version === 1)
      ? { rngVersion: 1 as const }
      : {}),
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
  if (bytes.length > GAME_TESTS_MAX_BYTES) fail(`${GAME_TESTS_FILE} is larger than 64 MiB.`);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(`${GAME_TESTS_FILE} is not valid JSON.`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    fail(`${GAME_TESTS_FILE} must hold an object.`);
  const doc = raw as Record<string, unknown>;
  if (doc["format"] !== GAME_TESTS_FORMAT && doc["format"] !== RELEASED_GAME_TESTS_FORMAT)
    fail(`${GAME_TESTS_FILE} format must be ${GAME_TESTS_FORMAT}.`);
  if (!Array.isArray(doc["tests"])) fail(`${GAME_TESTS_FILE} must list its tests.`);
  const tests = doc["tests"].map((test, index) =>
    validateGameTest(
      test,
      `tests[${index}]`,
      profile,
      doc["format"] === RELEASED_GAME_TESTS_FORMAT ? 1 : 2,
    ),
  );
  const names = new Set<string>();
  for (const test of tests) {
    if (names.has(test.name)) fail(`Game test names must be unique: ${JSON.stringify(test.name)}.`);
    names.add(test.name);
  }
  return { format: doc["format"], tests };
}
export function serializeGameTests(tests: readonly GameTest[]): Uint8Array {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ format: GAME_TESTS_FORMAT, tests }, null, 2) + "\n",
  );
  if (bytes.length > GAME_TESTS_MAX_BYTES)
    fail(
      `${GAME_TESTS_FILE} would be ${bytes.length} bytes, over the 64 MiB a game archive entry may hold. Remove or shorten tests.`,
    );
  return bytes;
}
