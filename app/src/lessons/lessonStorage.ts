/**
 * Lesson state kept in this browser: the challenges completed (badges) and
 * the "Try this" cards folded away. Both are per-viewer conveniences, never
 * game score and never exported. The badge record is
 * `{ version: 1, completed: string[] }` under `monotio_agi.lessons`, the
 * folded cards `{ version: 1, folded: string[] }` under
 * `monotio_agi.lessonCards`; a record this build cannot read (another
 * version, or not a record at all) is ignored and left as it is, so a newer
 * build's state survives a visit from an older one. Blocked storage keeps
 * the page's own state for the session.
 */
import { shallowRef, type ShallowRef } from "vue";

export const LESSONS_STORAGE_KEY = "monotio_agi.lessons";
const LESSON_CARDS_STORAGE_KEY = "monotio_agi.lessonCards";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const defaultStorage = (): StorageLike | undefined =>
  typeof localStorage === "undefined" ? undefined : localStorage;

/**
 * The ids a version-1 `{ version: 1, [field]: string[] }` record under `key`
 * holds; null when the stored value is not one this build may rewrite.
 */
function readIds(
  storage: StorageLike | undefined,
  key: string,
  field: "completed" | "folded",
): string[] | null {
  let raw: string | null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return [];
  try {
    const record = JSON.parse(raw) as unknown;
    if (!record || typeof record !== "object") return null;
    const { version, [field]: ids } = record as Record<string, unknown>;
    if (version !== 1 || !Array.isArray(ids)) return null;
    return ids.filter((id): id is string => typeof id === "string");
  } catch {
    return null;
  }
}

/** The lesson ids completed in this browser. */
export function readCompletedLessons(storage: StorageLike | undefined): ReadonlySet<string> {
  return new Set(readIds(storage, LESSONS_STORAGE_KEY, "completed") ?? []);
}

export interface LessonBadges {
  readonly completed: Readonly<ShallowRef<ReadonlySet<string>>>;
  /** Mark a lesson's challenge complete, here and (when the record allows) in storage. */
  award(id: string): void;
}

export function createLessonBadges(storage = defaultStorage()): LessonBadges {
  const completed = shallowRef<ReadonlySet<string>>(readCompletedLessons(storage));

  function award(id: string): void {
    if (!completed.value.has(id)) completed.value = new Set([...completed.value, id]);
    const stored = readIds(storage, LESSONS_STORAGE_KEY, "completed");
    if (stored === null || stored.includes(id)) return;
    try {
      storage?.setItem(
        LESSONS_STORAGE_KEY,
        JSON.stringify({ version: 1, completed: [...stored, id] }),
      );
    } catch {
      /* the badge still shows for this page */
    }
  }

  return { completed, award };
}

let shared: LessonBadges | undefined;
/** The page's badges, read from this browser's storage once. */
export function useLessonBadges(): LessonBadges {
  shared ??= createLessonBadges();
  return shared;
}

/** The lessons whose "Try this" card was folded away. */
export function readFoldedCards(storage = defaultStorage()): ReadonlySet<string> {
  return new Set(readIds(storage, LESSON_CARDS_STORAGE_KEY, "folded") ?? []);
}

export function setCardFolded(id: string, folded: boolean, storage = defaultStorage()): void {
  const stored = readIds(storage, LESSON_CARDS_STORAGE_KEY, "folded");
  // A record this build cannot read is left as it is; the card still folds
  // for this page.
  if (stored === null) return;
  const ids = new Set(stored);
  if (folded) ids.add(id);
  else ids.delete(id);
  try {
    storage?.setItem(LESSON_CARDS_STORAGE_KEY, JSON.stringify({ version: 1, folded: [...ids] }));
  } catch {
    /* the card still folds for this page */
  }
}
