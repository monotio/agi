import { decodeRecordedReplay } from "./recordedReplay.ts";
/**
 * The game-test step and expectation vocabulary shared by the stored
 * TESTS.JSON format (src/agent/gameTests.ts), the playtest simulation
 * (src/agent/playtest.ts) and the Node speedrun runner
 * (test/speedrun/runner.ts), plus the deterministic primitives both runners
 * use: one seeded random source, one PC direction-key table and one
 * delta-to-direction mapping, so a stored test and a speedrun proof can never
 * disagree about what a step means. No node:* imports: this module must run
 * in the browser worker and in Node.
 */

/** PC key words for the eight compass directions (index 1..8; 0 is unused). */
export const DIRECTION_KEYS: readonly number[] = [
  0, 0x4800, 0x4900, 0x4d00, 0x5100, 0x5000, 0x4f00, 0x4b00, 0x4700,
];

/** Repeatable random input, never a chosen result for an individual game branch. */
export function randomSource(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value >>> 16;
  };
}

/** The compass direction (1..8) for a unit step (dx, dy); 0 when there is no step. */
export function directionForDelta(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  if (dx === 0) return dy < 0 ? 1 : 5;
  if (dx > 0) return dy < 0 ? 2 : dy === 0 ? 3 : 4;
  return dy < 0 ? 8 : dy === 0 ? 7 : 6;
}

/** Every step kind a stored game test or playtest scenario can perform. */
export const STEP_ACTIONS = [
  "command",
  "move",
  "enter",
  "wait",
  "key",
  "direction",
  "walkTo",
  "answer",
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** Named directions a `move` step accepts. */
export const MOVE_DIRECTIONS = [
  "up",
  "up-right",
  "right",
  "down-right",
  "down",
  "down-left",
  "left",
  "up-left",
] as const;

export interface FlagAssertion {
  readonly id: number;
  readonly value: boolean;
}

/** A variable check: exact `value`, or an inclusive `min`/`max` range. */
export interface VarAssertion {
  readonly id: number;
  readonly value: number | null;
  readonly min: number | null;
  readonly max: number | null;
}

/** Conditions a `wait` step can poll; every non-null condition must hold. */
export interface UntilPredicate {
  readonly room: number | null;
  readonly flag: FlagAssertion | null;
  readonly var: VarAssertion | null;
}

export interface ObjectAssertion {
  readonly num: number;
  readonly view: number | null;
  readonly x0: number | null;
  readonly y0: number | null;
  readonly x1: number | null;
  readonly y1: number | null;
  readonly active: boolean | null;
}

export interface ReachableAssertion {
  readonly x: number;
  readonly y: number;
}

/** One stored step, normalized to the full shape (absent fields are null). A
 * type alias, not an interface, so a normalized step stays assignable to
 * Record<string, unknown> for the playtest simulation's argument shape. */
export type GameTestStep = {
  readonly action: StepAction;
  readonly command: string | null;
  /** Compass name for `move`, 0..8 for `direction`. */
  readonly direction: string | number | null;
  /** PC key word for `key`. */
  readonly key: number | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly answer: string | null;
  readonly until: UntilPredicate | null;
  readonly ticks: number | null;
  readonly captureTicks: readonly number[] | null;
};

/** One stored expectation set, normalized to the full shape (a type alias for
 * the same Record<string, unknown> assignability as GameTestStep). */
export type GameTestExpect = {
  readonly room: number | null;
  readonly carriedItems: readonly number[] | null;
  readonly flags: readonly FlagAssertion[] | null;
  readonly vars: readonly VarAssertion[] | null;
  readonly printed: string | null;
  readonly text: string | null;
  readonly score: number | null;
  readonly object: ObjectAssertion | null;
  readonly reachable: ReachableAssertion | null;
};

function fail(message: string): never {
  throw new Error(message);
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    fail(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}

function optionalInteger(value: unknown, label: string, min: number, max: number): number | null {
  return value == null ? null : integer(value, label, min, max);
}

function unknownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value))
    if (!known.includes(key)) fail(`${label}.${key} is not a known field.`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

const FLAG_FIELDS = ["id", "value"];

function validateFlagAssertion(value: unknown, label: string): FlagAssertion {
  const flag = object(value, label);
  unknownKeys(flag, FLAG_FIELDS, label);
  if (typeof flag["value"] !== "boolean") fail(`${label}.value must be boolean.`);
  return { id: integer(flag["id"], `${label}.id`, 0, 255), value: flag["value"] };
}

const VAR_FIELDS = ["id", "value", "min", "max"];

export function validateVarAssertion(value: unknown, label: string): VarAssertion {
  const variable = object(value, label);
  unknownKeys(variable, VAR_FIELDS, label);
  const id = integer(variable["id"], `${label}.id`, 0, 255);
  const equals = optionalInteger(variable["value"], `${label}.value`, 0, 255);
  const min = optionalInteger(variable["min"], `${label}.min`, 0, 255);
  const max = optionalInteger(variable["max"], `${label}.max`, 0, 255);
  if (equals === null && min === null && max === null)
    fail(`${label} needs an exact value or a min/max range.`);
  if (equals !== null && (min !== null || max !== null))
    fail(`${label} needs an exact value or a min/max range, not both.`);
  if (min !== null && max !== null && min > max) fail(`${label}.min must not exceed ${label}.max.`);
  return { id, value: equals, min, max };
}

const UNTIL_FIELDS = ["room", "flag", "var"];

export function validateUntilPredicate(value: unknown, label: string): UntilPredicate {
  const until = object(value, label);
  unknownKeys(until, UNTIL_FIELDS, label);
  const room = optionalInteger(until["room"], `${label}.room`, 0, 255);
  const flag = until["flag"] == null ? null : validateFlagAssertion(until["flag"], `${label}.flag`);
  const variable = until["var"] == null ? null : validateVarAssertion(until["var"], `${label}.var`);
  if (room === null && flag === null && variable === null)
    fail(`${label} needs at least one condition: room, flag or var.`);
  return { room, flag, var: variable };
}

const STEP_FIELDS = [
  "action",
  "command",
  "direction",
  "key",
  "x",
  "y",
  "answer",
  "until",
  "ticks",
  "captureTicks",
];

/** Fields (besides action/ticks/captureTicks) each step kind uses. */
const ACTION_FIELDS: Readonly<Record<StepAction, readonly string[]>> = {
  command: ["command"],
  move: ["direction"],
  enter: [],
  wait: ["until"],
  key: ["key"],
  direction: ["direction"],
  walkTo: ["x", "y"],
  answer: ["answer"],
};

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(`${label} must be nonempty text of at most ${max} characters.`);
  return value;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > max)
    fail(`${label} must be text of at most ${max} characters.`);
  return value;
}

function moveDirection(value: unknown, label: string): string {
  if (typeof value !== "string" || !(MOVE_DIRECTIONS as readonly string[]).includes(value))
    fail(`${label} must name one of the eight compass directions.`);
  return value;
}

/**
 * Strictly validate one stored step and return its normalized full shape.
 * Imported JSON gets no provider tool-schema validation, so this is the one
 * check shared by stored-file parsing and write_game_tests execution.
 */
export function validateGameTestStep(value: unknown, label: string): GameTestStep {
  const step = object(value, label);
  unknownKeys(step, STEP_FIELDS, label);
  const action = step["action"];
  if (typeof action !== "string" || !(STEP_ACTIONS as readonly string[]).includes(action))
    fail(`${label}.action must be one of ${STEP_ACTIONS.join(", ")}.`);
  const kind = action as StepAction;
  for (const field of ["command", "direction", "key", "x", "y", "answer", "until"] as const)
    if (!ACTION_FIELDS[kind].includes(field) && step[field] != null)
      fail(`${label}.${field} does not apply to a ${kind} step.`);
  const ticks = optionalInteger(step["ticks"], `${label}.ticks`, 1, 60000);
  if (
    kind === "answer" &&
    (ticks !== null || (Array.isArray(step["captureTicks"]) && step["captureTicks"].length))
  )
    fail(
      `${label}: answer queues a reply without advancing time; ticks and captureTicks must be null.`,
    );
  let captureTicks: readonly number[] | null = null;
  if (step["captureTicks"] != null) {
    if (!Array.isArray(step["captureTicks"]) || step["captureTicks"].length > 9)
      fail(`${label}.captureTicks must contain at most 9 ticks.`);
    const validated: number[] = [];
    for (const [index, tick] of step["captureTicks"].entries()) {
      const checked = integer(tick, `${label}.captureTicks[${index}]`, 1, 60000);
      if (ticks !== null && checked > ticks)
        fail(`${label}.captureTicks[${index}] exceeds the step's ticks.`);
      if (validated.length && checked <= validated[validated.length - 1]!)
        fail(`${label}.captureTicks must be strictly increasing.`);
      validated.push(checked);
    }
    captureTicks = validated;
  }
  return {
    action: kind,
    command: kind === "command" ? text(step["command"], `${label}.command`, 80) : null,
    direction:
      kind === "move"
        ? moveDirection(step["direction"], `${label}.direction`)
        : kind === "direction"
          ? integer(step["direction"], `${label}.direction`, 0, 8)
          : null,
    key: kind === "key" ? integer(step["key"], `${label}.key`, 0, 65535) : null,
    x: kind === "walkTo" ? integer(step["x"], `${label}.x`, 0, 159) : null,
    y: kind === "walkTo" ? integer(step["y"], `${label}.y`, 0, 167) : null,
    answer: kind === "answer" ? text(step["answer"], `${label}.answer`, 80) : null,
    until:
      kind === "wait" && step["until"] != null
        ? validateUntilPredicate(step["until"], `${label}.until`)
        : null,
    ticks,
    captureTicks,
  };
}

const EXPECT_FIELDS = [
  "room",
  "carriedItems",
  "flags",
  "vars",
  "printed",
  "text",
  "score",
  "object",
  "reachable",
];

const OBJECT_FIELDS = ["num", "view", "x0", "y0", "x1", "y1", "active"];

export function validateObjectAssertion(value: unknown, label: string): ObjectAssertion {
  const assertion = object(value, label);
  unknownKeys(assertion, OBJECT_FIELDS, label);
  const x0 = optionalInteger(assertion["x0"], `${label}.x0`, 0, 159);
  const x1 = optionalInteger(assertion["x1"], `${label}.x1`, 0, 159);
  const y0 = optionalInteger(assertion["y0"], `${label}.y0`, 0, 167);
  const y1 = optionalInteger(assertion["y1"], `${label}.y1`, 0, 167);
  if (x0 !== null && x1 !== null && x0 > x1) fail(`${label}.x0 must not exceed ${label}.x1.`);
  if (y0 !== null && y1 !== null && y0 > y1) fail(`${label}.y0 must not exceed ${label}.y1.`);
  if (assertion["active"] != null && typeof assertion["active"] !== "boolean")
    fail(`${label}.active must be boolean or null.`);
  return {
    num: integer(assertion["num"], `${label}.num`, 0, 255),
    view: optionalInteger(assertion["view"], `${label}.view`, 0, 255),
    x0,
    y0,
    x1,
    y1,
    active: (assertion["active"] as boolean | null | undefined) ?? null,
  };
}

const REACHABLE_FIELDS = ["x", "y"];

/** Strictly validate one stored expectation object and return its normalized full shape. */
export function validateGameTestExpect(value: unknown, label: string): GameTestExpect {
  const expect = object(value, label);
  unknownKeys(expect, EXPECT_FIELDS, label);
  const carriedItems = expect["carriedItems"];
  if (carriedItems != null) {
    if (!Array.isArray(carriedItems) || carriedItems.length > 256)
      fail(`${label}.carriedItems must be an array of at most 256 item IDs.`);
    for (const [index, item] of carriedItems.entries())
      integer(item, `${label}.carriedItems[${index}]`, 0, 255);
  }
  const flags = expect["flags"];
  if (flags != null && (!Array.isArray(flags) || flags.length > 256))
    fail(`${label}.flags must be an array of at most 256 assertions.`);
  const vars = expect["vars"];
  if (vars != null && (!Array.isArray(vars) || vars.length > 256))
    fail(`${label}.vars must be an array of at most 256 assertions.`);
  const reachable = expect["reachable"];
  if (reachable != null) {
    const target = object(reachable, `${label}.reachable`);
    unknownKeys(target, REACHABLE_FIELDS, `${label}.reachable`);
  }
  return {
    room: optionalInteger(expect["room"], `${label}.room`, 0, 255),
    carriedItems: carriedItems == null ? null : (carriedItems as number[]).map((item) => item),
    flags:
      flags == null
        ? null
        : (flags as unknown[]).map((flag, index) =>
            validateFlagAssertion(flag, `${label}.flags[${index}]`),
          ),
    vars:
      vars == null
        ? null
        : (vars as unknown[]).map((variable, index) =>
            validateVarAssertion(variable, `${label}.vars[${index}]`),
          ),
    printed: optionalText(expect["printed"], `${label}.printed`, 200),
    text: optionalText(expect["text"], `${label}.text`, 200),
    score: optionalInteger(expect["score"], `${label}.score`, 0, 255),
    object:
      expect["object"] == null
        ? null
        : validateObjectAssertion(expect["object"], `${label}.object`),
    reachable:
      reachable == null
        ? null
        : {
            x: integer((reachable as Record<string, unknown>)["x"], `${label}.reachable.x`, 0, 159),
            y: integer((reachable as Record<string, unknown>)["y"], `${label}.reachable.y`, 0, 167),
          },
  };
}

/**
 * The interpreter state a recorded test replays from: an AGI save image or
 * host recording envelope, base64 for JSON storage. Machine-generated replay
 * JSON text retains exact host operations and transient state. A test without
 * `setup` keeps the fresh-boot room simulation; with one, the stored-test
 * runner restores the image into a fresh engine built from the CURRENT staged
 * resources — the interpreter's own save/restore contract, so the image only
 * ever supplies interpreter state, never resources.
 */
export interface GameTestSetup {
  readonly image: string;
  readonly replay?: string;
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_REVERSE: readonly number[] = (() => {
  const table = Array<number>(128).fill(-1);
  for (let i = 0; i < BASE64_CHARS.length; i++) table[BASE64_CHARS.charCodeAt(i)] = i;
  return table;
})();

/** Strict RFC 4648 decoding without Node or browser globals; rejects all else. */
export function decodeBase64(text: string, label: string): Uint8Array {
  if (text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text))
    fail(`${label} must be standard padded base64.`);
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = BASE64_REVERSE[text.charCodeAt(i)]!;
    const b = BASE64_REVERSE[text.charCodeAt(i + 1)]!;
    const c = text[i + 2] === "=" ? 0 : BASE64_REVERSE[text.charCodeAt(i + 2)]!;
    const d = text[i + 3] === "=" ? 0 : BASE64_REVERSE[text.charCodeAt(i + 3)]!;
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    if (at < out.length) out[at++] = (triple >> 16) & 0xff;
    if (at < out.length) out[at++] = (triple >> 8) & 0xff;
    if (at < out.length) out[at++] = triple & 0xff;
  }
  return out;
}

const SETUP_FIELDS = ["image", "replay"];
/**
 * One setup image can never exceed the 256 KiB TESTS.JSON cap it shares with
 * every test in the file, so anything longer is rejected before decoding.
 */
const SETUP_IMAGE_MAX_CHARS = 262144;

/**
 * Strictly validate the optional setup block of a stored test. Shape and
 * base64 checks need no profile; the profile-specific save-image decode is
 * the caller's job (validateGameTest runs it whenever a profile is known).
 */
export function validateGameTestSetup(value: unknown, label: string): GameTestSetup {
  const setup = object(value, label);
  unknownKeys(setup, SETUP_FIELDS, label);
  const image = setup["image"];
  if (typeof image !== "string" || image.length > SETUP_IMAGE_MAX_CHARS)
    fail(`${label}.image must be base64 text of at most ${SETUP_IMAGE_MAX_CHARS} characters.`);
  decodeBase64(image, `${label}.image`);
  const replay = setup["replay"];
  if (replay != null) {
    if (typeof replay !== "string") fail(`${label}.replay must be machine-generated JSON text.`);
    decodeRecordedReplay(replay);
  }
  return { image, ...(typeof replay === "string" ? { replay } : {}) };
}
