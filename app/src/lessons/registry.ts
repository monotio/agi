/**
 * Lesson sets by catalog id, and the catalog id a running game's lessons
 * come from: its own catalog entry, or the one its remix chain started from
 * (the first Keep of a catalog game forks a remix that should keep its lessons).
 */
import type { CachedGameMeta } from "../gameTypes.ts";
import { DEMO_LESSONS } from "./demoLessons.ts";
import type { LessonSet } from "./types.ts";

const LESSON_SETS: Record<string, LessonSet> = { [DEMO_LESSONS.catalogId]: DEMO_LESSONS };

export function lessonSetFor(catalogId: string | undefined): LessonSet | undefined {
  return catalogId !== undefined && Object.hasOwn(LESSON_SETS, catalogId)
    ? LESSON_SETS[catalogId]
    : undefined;
}

/** How far a remix chain is followed back to its catalog entry. */
const MAX_PARENTS = 8;

export function lessonCatalogId(
  projectId: string | undefined,
  meta: (projectId: string) => Pick<CachedGameMeta, "library"> | null,
): string | undefined {
  let id = projectId;
  for (let step = 0; id !== undefined && step <= MAX_PARENTS; step++) {
    const library = meta(id)?.library;
    if (library?.catalog) return library.catalog.id;
    id = library?.source === "remix" ? library.parent?.project : undefined;
  }
  return undefined;
}
