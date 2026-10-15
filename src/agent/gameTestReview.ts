import { sameGameTestDefinition } from "./gameTestComparison.ts";
/** Test changes get their own review lines so creators can see weakened checks. */
import { parseGameTests, type GameTest } from "./gameTestFormat.ts";
import { decodeRecordedReplay, recordedPlayerInputs } from "./recordedReplay.ts";
import type { ProjectContent } from "../authoring/projectContent.ts";
import type { AgiProfile } from "../runtime/profile.ts";
interface GameTestChange {
  readonly kind: "added" | "deleted" | "expectation" | "changed";
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
      if (!sameGameTestDefinition(old.expect, test.expect))
        return [{ kind: "expectation" as const, name: test.name }];
      return !sameGameTestDefinition(old, test)
        ? [{ kind: "changed" as const, name: test.name }]
        : [];
    }),
  ];
}

/** Visible named lines stay in their own Tests review section. */
export function gameTestReviewLines(
  before: ProjectContent | null | undefined,
  after: ProjectContent | null | undefined,
  profile: AgiProfile,
): readonly string[] {
  const labels = {
    added: "Added test",
    deleted: "Deleted test",
    expectation: "Changed expectation of",
    changed: "Changed test",
  };
  return gameTestChanges(before, after, profile).map(
    (change) => `${labels[change.kind]} ${JSON.stringify(change.name)}`,
  );
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
