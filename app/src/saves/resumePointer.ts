/**
 * The resume pointer: which game's checkpoint Home offers to continue.
 *
 * Two storage keys, deliberately disjoint:
 * - `monotio_agi.resumeTarget` — the pointer this release writes. Its value
 *   is a physical progress locator (`installed:<digest>` or
 *   `project:<id>:<epoch>`) captured from the game's bound target, so the
 *   pointer names one exact game incarnation and dies with it.
 * - `monotio_agi.lastGame` — the released key. Read as legacy context only:
 *   a bare project id, folder, hash or alias that a released build wrote.
 *   New boots and checkpoints never write it, so an older tab's write can
 *   never impersonate a physical locator or move the pointer this release
 *   owns.
 *
 * The new key takes precedence whenever it is present: an old tab's
 * lastGame write cannot move a pointer already bound. A cleared or absent
 * new key falls back to the legacy value, so checkpoints taken before this
 * release still resume.
 */
export const RESUME_POINTER_KEY = "monotio_agi.resumeTarget";
export const LEGACY_LAST_GAME_KEY = "monotio_agi.lastGame";

/** One pointer read, with the provenance its value carries. */
export interface ResumePointer {
  /** The stored value: a physical locator, or a released storage key. */
  readonly value: string;
  /**
   * True when the value came from the released `lastGame` key — legacy
   * read context that selects nothing physically.
   */
  readonly legacy: boolean;
}

type ResumePointerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The pointer Home may offer: the dedicated physical locator when one is
 * stored, else the released lastGame value as legacy context. Null when
 * neither exists or storage cannot be read.
 */
export function readResumePointer(storage: ResumePointerStorage): ResumePointer | null {
  try {
    const current = storage.getItem(RESUME_POINTER_KEY);
    if (current !== null) return { value: current, legacy: false };
    const legacy = storage.getItem(LEGACY_LAST_GAME_KEY);
    return legacy !== null ? { value: legacy, legacy: true } : null;
  } catch {
    return null;
  }
}

/**
 * Point the offer at `locator` — a bound target's physical address. The
 * released key is left untouched: it stays another release's value, and its
 * later writes never outrank this one. False when storage refused.
 */
export function writeResumePointer(storage: ResumePointerStorage, locator: string): boolean {
  try {
    storage.setItem(RESUME_POINTER_KEY, locator);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the pointer, or only when it still names `locator` — the clear a
 * selected checkpoint's removal performs. The released key stays: it is
 * another release's value and a routine physical clear never deletes it.
 */
export function clearResumePointer(storage: ResumePointerStorage, locator?: string): void {
  try {
    if (locator === undefined || storage.getItem(RESUME_POINTER_KEY) === locator) {
      storage.removeItem(RESUME_POINTER_KEY);
    }
  } catch {
    /* nothing to clear in a store we cannot reach */
  }
}
