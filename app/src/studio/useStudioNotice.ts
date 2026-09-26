/**
 * A Studio's stage notice (StudioStageNotes): one short sentence that says
 * what an edit did or why it was refused, with its technical detail. It
 * clears itself after a while, except while its details are open.
 */

import { onScopeDispose, shallowRef } from "vue";

/** How long a notice stays up. */
const NOTICE_MS = 5000;

export interface StudioNotice {
  readonly tone: "warn" | "ok";
  /** One short, plain sentence. */
  readonly text: string;
  /** The technical account, behind a Details disclosure. */
  readonly detail?: string | undefined;
}

export function useStudioNotice() {
  const notice = shallowRef<StudioNotice | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onScopeDispose(() => clearTimeout(timer));

  function say(next: StudioNotice | null): void {
    clearTimeout(timer);
    notice.value = next;
    if (next) timer = setTimeout(() => (notice.value = null), NOTICE_MS);
  }

  /** Keep the notice up while its details are open; the countdown restarts when they close. */
  function hold(open: boolean): void {
    if (open) clearTimeout(timer);
    else say(notice.value);
  }

  return { notice, say, hold };
}
