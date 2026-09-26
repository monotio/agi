/**
 * Lesson state kept in this browser: the challenges completed (badges) and
 * the "Try this" cards folded away. Both are per-viewer conveniences, never
 * game score and never exported. The badge record is
 * `{ version: 1, completed: string[] }` under `monotio_agi.lessons`; a record
 * this build cannot read (another version, or not a record at all) is
 * ignored and left as it is, so a newer build's badges survive a visit from
 * an older one. Blocked storage keeps the page's own state for the session.
 */
import { shallowRef, type ShallowRef } from "vue";

export const LESSONS_STORAGE_KEY = "monotio_agi.lessons";
export const LESSON_CARDS_STORAGE_KEY = "monotio_agi.lessonCards";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const defaultStorage = (): StorageLike | undefined =>
  typeof localStorage === "undefined" ? undefined : localStorage;

/** The version-1 record's ids; null when the stored value is not one this build may rewrite. */
function readRecord(storage: StorageLike | undefined): string[] | null {
  let raw: string | null;
  try {
    raw = storage?.getItem(LESSONS_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return [];
  try {
    const record = JSON.parse(raw) as unknown;
    if (!record || typeof record !== "object") return null;
    const { version, completed } = record as Record<string, unknown>;
    if (version !== 1 || !Array.isArray(completed)) return null;
    return completed.filter((id): id is string => typeof id === "string");
  } catch {
    return null;
  }
}

/** The lesson ids completed in this browser. */
export function readCompletedLessons(storage: StorageLike | undefined): ReadonlySet<string> {
  return new Set(readRecord(storage) ?? []);
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
    const stored = readRecord(storage);
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
  try {
    const ids = JSON.parse(storage?.getItem(LESSON_CARDS_STORAGE_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function setCardFolded(id: string, folded: boolean, storage = defaultStorage()): void {
  const ids = new Set(readFoldedCards(storage));
  if (folded) ids.add(id);
  else ids.delete(id);
  try {
    storage?.setItem(LESSON_CARDS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* the card still folds for this page */
  }
}
