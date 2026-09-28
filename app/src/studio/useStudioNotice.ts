/**
 * A Studio's notice (StudioStatusNotice): one short sentence that says what
 * an edit did or why it was refused, with its technical detail and at most
 * one step to take (Unlock for now after a lock refusal). It lives in
 * the status line, off the picture, until it is dismissed, an edit clears
 * it, or the tool changes.
 */

import { shallowRef } from "vue";

/** The one step a notice offers: "Unlock for now" after a lock refusal. */
export interface NoticeAction {
  readonly label: string;
  readonly run: () => void;
}

export interface StudioNotice {
  readonly tone: "warn" | "ok";
  /** One short, plain sentence. */
  readonly text: string;
  /** The technical account, behind a Details disclosure. */
  readonly detail?: string | undefined;
  readonly action?: NoticeAction | undefined;
}

export function useStudioNotice() {
  const notice = shallowRef<StudioNotice | null>(null);

  /** Show a notice; null clears it. */
  function say(next: StudioNotice | null): void {
    notice.value = next;
  }

  return { notice, say, dismiss: () => say(null) };
}
