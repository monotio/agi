/**
 * Lesson sets by catalog release, and the release a running game's lessons
 * come from: its own catalog entry, or the one its remix chain started from
 * (the first Keep of a catalog game forks a remix that should keep its lessons).
 * A set verifies one release's resources, so the key is the id and the
 * version: an older release players still have stored, and its remixes, get
 * no lessons written for another.
 */
import type { CachedGameMeta } from "../project/gameTypes.ts";
import type { LessonSet } from "./types.ts";

/** A catalog release, as the library records it (LibraryMetadata.catalog). */
export interface LessonRelease {
  readonly id: string;
  readonly version: string;
}

/**
 * The releases with lessons, each set loaded on first use: its checks bring
 * the Studio kernels and the game's own sources with them.
 */
export const LESSON_RELEASES: readonly (LessonRelease & { load(): Promise<LessonSet> })[] = [
  {
    id: "adventure-department",
    version: "1.2.0",
    load: async () =>
      (await import("../../../games/adventure-department/lessons.ts")).TUTORIAL_LESSONS,
  },
];

/** The lessons written for exactly this release, if any. */
export async function lessonSetFor(
  release: LessonRelease | undefined,
): Promise<LessonSet | undefined> {
  const entry =
    release &&
    LESSON_RELEASES.find(({ id, version }) => id === release.id && version === release.version);
  return entry?.load();
}

/** How far a remix chain is followed back to its catalog entry. */
const MAX_PARENTS = 8;

/** The catalog release a game's lessons come from: its own, or its remix chain's. */
export function lessonCatalogId(
  projectId: string | undefined,
  meta: (projectId: string) => Pick<CachedGameMeta, "library"> | null,
): LessonRelease | undefined {
  let id = projectId;
  for (let step = 0; id !== undefined && step <= MAX_PARENTS; step++) {
    const library = meta(id)?.library;
    if (library?.catalog) return { id: library.catalog.id, version: library.catalog.version };
    id = library?.source === "remix" ? library.parent?.project : undefined;
  }
  return undefined;
}
