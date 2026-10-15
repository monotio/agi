import { sameGameTestDefinition } from "./gameTestComparison.ts";
/** Test changes get their own review lines so creators can see weakened checks. */
import { parseGameTests, type GameTest } from "./gameTestFormat.ts";
import { decodeRecordedReplay, recordedPlayerInputs } from "./recordedReplay.ts";
import { DIRECTION_NAMES } from "./gameTestSteps.ts";
import type { ProjectContent } from "../authoring/projectContent.ts";
import type { AgiProfile } from "../runtime/profile.ts";
interface GameTestChange {
  readonly kind: "added" | "deleted" | "expectation" | "changed" | "changedWithExpectation";
  readonly name: string;
}
export function gameTestChanges(
  before: ProjectContent | null | undefined,
  after: ProjectContent | null | undefined,
  profile: AgiProfile,
): readonly GameTestChange[] {
  const read = (content: ProjectContent | null | undefined) =>
    parseGameTests(
      typeof content === "string" ? new TextEncoder().encode(content) : (content ?? undefined),
      profile,
    ).tests;
  return gameTestDefinitionChanges(read(before), read(after));
}

/** Named changes between two parsed test lists, in the order review lists them. */
export function gameTestDefinitionChanges(
  previous: readonly GameTest[],
  next: readonly GameTest[],
): readonly GameTestChange[] {
  return [
    ...previous
      .filter((test) => !next.some((candidate) => candidate.name === test.name))
      .map((test) => ({ kind: "deleted" as const, name: test.name })),
    ...next.flatMap<GameTestChange>((test) => {
      const old = previous.find((candidate) => candidate.name === test.name);
      if (!old) return [{ kind: "added" as const, name: test.name }];
      const expectation = !sameGameTestDefinition(old.expect, test.expect);
      const rest = !sameGameTestDefinition({ ...old, expect: null }, { ...test, expect: null });
      if (!expectation && !rest) return [];
      return [
        {
          kind: expectation ? (rest ? "changedWithExpectation" : "expectation") : "changed",
          name: test.name,
        },
      ];
    }),
  ];
}

/** Plain words for one value: quoted text, numbers, and `field value` lists. */
function words(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return value.map(words).join(", ");
  if (value && typeof value === "object")
    return Object.entries(value)
      .filter(([, item]) => item != null)
      .map(([key, item]) => `${key} ${words(item)}`)
      .join(", ");
  return String(value);
}

const STEP_VERBS: Readonly<Record<string, string>> = {
  command: "type",
  key: "press key",
  answer: "answer",
  enter: "press Enter",
  move: "walk",
  direction: "walk",
  walkTo: "walk to",
  walkWaypoints: "walk through",
  walkPath: "walk to area",
};

/** The object of one step's verb: `type "look"`, `walk up`, `walk to 10, 20`. */
function stepObject(step: Readonly<Record<string, unknown>>): string {
  const { action, direction, x, y, waypoints } = step;
  if (action === "move" || action === "direction")
    return typeof direction === "number" ? (DIRECTION_NAMES[direction] ?? "") : String(direction);
  if (action === "walkTo") return `${words(x)}, ${words(y)}`;
  if (action === "walkWaypoints")
    return (waypoints as readonly (readonly number[])[]).map(([x, y]) => `(${x}, ${y})`).join(", ");
  const value = step[String(action)] ?? step["target"];
  return value == null ? "" : words(value);
}

/** What a test does, in plain words: each step, or a recording's input count. */
function gameTestStepsText(test: GameTest): string {
  if (!test.steps.length) {
    const replay = test.setup?.replay;
    if (!replay) return "None";
    const inputs = recordedPlayerInputs(decodeRecordedReplay(replay));
    return `Recorded play, ${inputs} ${inputs === 1 ? "input" : "inputs"}`;
  }
  return test.steps
    .map(
      (step) =>
        [
          STEP_VERBS[String(step["action"])] ?? String(step["action"]),
          stepObject(step),
          step["until"] ? `until ${words(step["until"])}` : "",
          step["ticks"] != null ? `for ${words(step["ticks"])} ticks` : "",
        ]
          .filter(Boolean)
          .join(" ") +
        (Array.isArray(step["captureTicks"]) && step["captureTicks"].length
          ? `, frames at ticks ${words(step["captureTicks"])}`
          : ""),
    )
    .join("; ");
}

/** What a test checks, in plain words; an empty expectation checks nothing. */
function gameTestExpectText(test: GameTest): string {
  return words(test.expect ?? {}) || "Nothing checked";
}

/** Where a recorded test starts: a fresh boot, or the saved game it restores. */
function gameTestStartText(test: GameTest): string {
  if (!test.setup) return "Fresh start";
  return test.setup.replay ? "Saved game and recorded play" : "Saved game";
}

/** One named review line per test change, with the old and new definition of a changed test. */
export function gameTestReviewChanges(
  before: ProjectContent | null | undefined,
  after: ProjectContent | null | undefined,
  profile: AgiProfile,
): readonly {
  readonly line: string;
  readonly rows: readonly {
    readonly label: string;
    readonly before: string;
    readonly after: string;
  }[];
}[] {
  const labels = {
    added: "Added test",
    deleted: "Deleted test",
    expectation: "Changed expectation of",
    changed: "Changed test",
    changedWithExpectation: "Changed test and expectation of",
  };
  const read = (content: ProjectContent | null | undefined) =>
    parseGameTests(
      typeof content === "string" ? new TextEncoder().encode(content) : (content ?? undefined),
      profile,
    ).tests;
  const previous = read(before);
  const next = read(after);
  return gameTestDefinitionChanges(previous, next).map((change) => {
    const line = `${labels[change.kind]} ${JSON.stringify(change.name)}`;
    const old = previous.find((test) => test.name === change.name);
    const now = next.find((test) => test.name === change.name);
    if (!old || !now) return { line, rows: [] };
    const spawn = (test: GameTest) =>
      test.spawnX == null && test.spawnY == null
        ? "Game default"
        : `x ${test.spawnX ?? "default"}, y ${test.spawnY ?? "default"}`;
    const budget = (test: GameTest) =>
      test.cycleBudget == null ? "Default" : `${test.cycleBudget} cycles`;
    const random = (test: GameTest) => `Version ${test.rngVersion ?? 2}`;
    const start = gameTestStartText(now);
    const rows = [
      { label: "Room", before: String(old.room), after: String(now.room) },
      { label: "Start position", before: spawn(old), after: spawn(now) },
      {
        label: "Start state",
        before: gameTestStartText(old),
        // The same words for another saved game still name the change.
        after:
          start === gameTestStartText(old) && !sameGameTestDefinition(old.setup, now.setup)
            ? `Different ${start.toLowerCase()}`
            : start,
      },
      { label: "Steps", before: gameTestStepsText(old), after: gameTestStepsText(now) },
      { label: "Checks", before: gameTestExpectText(old), after: gameTestExpectText(now) },
      { label: "Cycle budget", before: budget(old), after: budget(now) },
      { label: "Random numbers", before: random(old), after: random(now) },
    ].filter((row) => row.label === "Steps" || row.label === "Checks" || row.before !== row.after);
    return { line, rows };
  });
}

/** Visible named lines stay in their own Tests review section. */
export function gameTestReviewLines(
  before: ProjectContent | null | undefined,
  after: ProjectContent | null | undefined,
  profile: AgiProfile,
): readonly string[] {
  return gameTestReviewChanges(before, after, profile).map((change) => change.line);
}

/** Existing definitions and unreadable document repairs require the creator's review. */
export function gameTestsNeedCreatorReview(
  before: ProjectContent | null | undefined,
  after: ProjectContent | null | undefined,
  profile: AgiProfile,
): boolean {
  try {
    return gameTestChanges(before, after, profile).some((change) => change.kind !== "added");
  } catch {
    return true;
  }
}

/** Each review side exposes its parsing cause independently of the Apply action. */
export function readGameTestReviewSide(
  content: ProjectContent | null | undefined,
  profile: AgiProfile,
): { tests: readonly GameTest[]; cause: string | null } {
  try {
    return {
      tests: parseGameTests(
        typeof content === "string" ? new TextEncoder().encode(content) : (content ?? undefined),
        profile,
      ).tests,
      cause: null,
    };
  } catch (error) {
    return { tests: [], cause: error instanceof Error ? error.message : String(error) };
  }
}

/** What the player does in a test: its authored steps plus a recording's inputs. */
export function gameTestActionCount(test: GameTest): number {
  const replay = test.setup?.replay;
  return test.steps.length + (replay ? recordedPlayerInputs(decodeRecordedReplay(replay)) : 0);
}
