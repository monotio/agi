/** Agent test changes merge by name; untouched names belong to the current document. */
import { mergeGameTestsByName, sameGameTestDefinition } from "../agent/gameTestComparison.ts";
import { parseGameTests, serializeGameTests, type GameTest } from "../agent/gameTestFormat.ts";
import { gameTestDefinitionChanges } from "../agent/gameTestReview.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import {
  diffProjectDocuments,
  sameProjectContent,
  type ProjectChange,
  type ProjectContent,
} from "./projectContent.ts";

/** Test saves never stale a game edit, restart or review. */
export function sameNonTestDocuments(
  base: Readonly<Record<string, ProjectContent>>,
  current: Readonly<Record<string, ProjectContent>>,
): boolean {
  return diffProjectDocuments(base, current).every((change) => change.key === "tests");
}

function parseTests(content: ProjectContent | null | undefined, profile: AgiProfile) {
  return parseGameTests(
    typeof content === "string" ? new TextEncoder().encode(content) : (content ?? undefined),
    profile,
  ).tests;
}

/** Apply only added, changed and removed names relative to the Agent's original base. */
export function mergeAgentTestChanges(
  base: Readonly<Record<string, ProjectContent>>,
  current: Readonly<Record<string, ProjectContent>>,
  changes: readonly ProjectChange[],
  profile: AgiProfile,
): readonly ProjectChange[] {
  const offered = changes.find((change) => change.key === "tests");
  if (!offered || sameProjectContent(base["tests"], offered.content))
    return changes.filter((change) => change.key !== "tests");
  const candidate = parseTests(offered.content, profile);
  let before;
  try {
    before = parseTests(base["tests"], profile);
  } catch {
    if (sameProjectContent(base["tests"], current["tests"])) return changes;
    throw new Error(
      "The tests file changed while the Agent repaired it. Read the current tests and try again.",
    );
  }
  const latest = parseTests(current["tests"], profile);
  const merged = mergeGameTestsByName(before, candidate, latest);
  if (sameGameTestDefinition(latest, merged))
    return changes.filter((change) => change.key !== "tests");
  const content =
    offered.content === null && !merged.length
      ? null
      : new TextDecoder().decode(serializeGameTests(merged));
  return changes.map((change) => (change.key === "tests" ? { key: "tests", content } : change));
}

export interface AgentTestReview {
  /** The current definition of each name the Agent's offer touches; null once the creator deleted it. */
  readonly touched: Readonly<Record<string, GameTest | null>>;
  /** The definition Apply leaves for each touched name; null when it deletes or leaves it absent. */
  readonly committed: Readonly<Record<string, GameTest | null>>;
  /** The creator's current tests. */
  readonly before: ProjectContent | undefined;
  /** The tests Apply commits now; the current tests when nothing is left to change. */
  readonly after: ProjectContent | null;
}

/**
 * The tests comparison review shows and Apply commits, from the same merge:
 * Before is the creator's current document, After its merged result, so a
 * late same-name save shows as a replacement. Undefined when the offer leaves
 * the tests alone or its base is unreadable.
 */
export function agentTestReview(
  base: Readonly<Record<string, ProjectContent>>,
  current: Readonly<Record<string, ProjectContent>>,
  changes: readonly ProjectChange[],
  profile: AgiProfile,
): AgentTestReview | undefined {
  const offered = changes.find((change) => change.key === "tests");
  if (!offered || sameProjectContent(base["tests"], offered.content)) return undefined;
  let before;
  try {
    before = parseTests(base["tests"], profile);
  } catch {
    return undefined;
  }
  const latest = parseTests(current["tests"], profile);
  const names = gameTestDefinitionChanges(before, parseTests(offered.content, profile));
  const merged = mergeAgentTestChanges(base, current, [offered], profile).find(
    (change) => change.key === "tests",
  );
  const left = merged ? parseTests(merged.content, profile) : latest;
  const byName = (tests: readonly GameTest[]) =>
    Object.fromEntries(
      names.map(({ name }) => [name, tests.find((test) => test.name === name) ?? null]),
    );
  return {
    touched: byName(latest),
    committed: byName(left),
    before: current["tests"],
    after: merged ? merged.content : (current["tests"] ?? null),
  };
}
