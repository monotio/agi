/**
 * Leaving Room Studio with unkept changes: every way out (Back, switching to
 * Play, Exit, Start over, Back/Forward) asks one question — Keep, Discard or
 * Cancel — through StudioKeepDialog, and waits for the answer. A page unload
 * cannot wait, so while changes are unkept the browser's own prompt guards it.
 */

import { computed, onScopeDispose, shallowRef, watch } from "vue";

export type LeaveAnswer = "keep" | "discard" | "cancel";

export interface StudioLeaveOptions {
  /** The draft differs from what the game holds, and could still be kept or thrown away. */
  readonly unkept: () => boolean;
  /** Keep the draft; resolves whether it was kept. */
  readonly keep: () => Promise<boolean>;
  readonly discard: () => void;
  /** Where the unload guard is installed; none outside a browser. */
  readonly target?: Pick<Window, "addEventListener" | "removeEventListener"> | undefined;
}

export function useStudioLeave(options: StudioLeaveOptions) {
  /** The question is open. */
  const asking = shallowRef(false);
  /** The top bar's Discard asks on its own. */
  const discarding = shallowRef(false);
  /** StudioKeepDialog's question: "close" while a way out waits on it, "discard" for Discard. */
  const ask = computed<"close" | "discard" | undefined>({
    get: () => (asking.value ? "close" : discarding.value ? "discard" : undefined),
    set: (next) => {
      if (next !== undefined) return;
      discarding.value = false;
      if (asking.value) void answer("cancel");
    },
  });
  let settle: ((leave: boolean) => void) | null = null;

  /** Resolves true when the way is clear: nothing unkept, or kept or discarded on request. */
  function confirm(): Promise<boolean> {
    if (!options.unkept()) return Promise.resolve(true);
    settle?.(false);
    asking.value = true;
    return new Promise((resolve) => (settle = resolve));
  }

  async function answer(choice: LeaveAnswer): Promise<void> {
    const done = settle;
    settle = null;
    asking.value = false;
    if (!done) return;
    if (choice === "cancel") return done(false);
    if (choice === "discard") {
      options.discard();
      return done(true);
    }
    done(await options.keep());
  }

  const target = options.target ?? (typeof window === "undefined" ? undefined : window);
  function onBeforeUnload(event: BeforeUnloadEvent): void {
    event.preventDefault();
    // Older engines show the prompt only for a return value.
    event.returnValue = "";
  }
  // Listening only while there is something to lose keeps the page eligible for the back/forward cache.
  const stop = watch(
    options.unkept,
    (unkept) => {
      if (unkept) target?.addEventListener("beforeunload", onBeforeUnload);
      else target?.removeEventListener("beforeunload", onBeforeUnload);
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    stop();
    target?.removeEventListener("beforeunload", onBeforeUnload);
    settle?.(false);
    settle = null;
  });

  return { asking, discarding, ask, confirm, answer, unkept: options.unkept };
}

export type StudioLeave = ReturnType<typeof useStudioLeave>;
