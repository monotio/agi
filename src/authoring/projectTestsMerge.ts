import { sameGameTestDefinition } from "../agent/gameTestComparison.ts";
/** Agent test changes merge by name; untouched names belong to the current document. */
import { parseGameTests, serializeGameTests } from "../agent/gameTestFormat.ts";
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

/** Object key ordering carries no editing intent. */

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
  const parse = (content: ProjectContent | null | undefined) =>
    parseGameTests(
      typeof content === "string" ? new TextEncoder().encode(content) : (content ?? undefined),
      profile,
    ).tests;
  const candidate = parse(offered.content);
  let before;
  try {
    before = parse(base["tests"]);
  } catch {
    if (sameProjectContent(base["tests"], current["tests"])) return changes;
    throw new Error(
      "The tests file changed while the Agent repaired it. Read the current tests and try again.",
    );
  }
  const latest = parse(current["tests"]);
  const changed = candidate.filter((test) => {
    const previous = before.find((entry) => entry.name === test.name);
    return !previous || !sameGameTestDefinition(previous, test);
  });
  const removed = before.filter((test) => !candidate.some((entry) => entry.name === test.name));
  const writtenNames = new Set(changed.map((test) => test.name));
  const removedNames = new Set(removed.map((test) => test.name));
  const merged = [
    ...latest
      .filter((test) => !removedNames.has(test.name))
      .map((test) => changed.find((entry) => entry.name === test.name) ?? test),
    ...changed.filter((test) => !latest.some((entry) => entry.name === test.name)),
  ];
  if ((!writtenNames.size && !removedNames.size) || sameGameTestDefinition(latest, merged))
    return changes.filter((change) => change.key !== "tests");
  const content =
    offered.content === null && !merged.length
      ? null
      : new TextDecoder().decode(serializeGameTests(merged));
  return changes.map((change) => (change.key === "tests" ? { key: "tests", content } : change));
}
