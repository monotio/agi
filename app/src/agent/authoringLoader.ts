/**
 * Loads the AI authoring stack (authoringStack.ts) on demand. A player who
 * never uses AI never downloads it; the shell prefetches it in idle time when
 * the player shows intent — opening Create or the Ask drawer, or booting a
 * created game that writes its rooms as they are reached.
 */
import type * as AuthoringStack from "./authoringStack.ts";

export type AuthoringStackModule = typeof AuthoringStack;
export type AuthoringLoader = () => Promise<AuthoringStackModule>;

export const AUTHORING_LOAD_FAILED =
  "Couldn't load the AI tools; check your connection and try again.";

/**
 * The stack's chunk did not arrive: offline, or a deploy replaced it
 * mid-session. It reads as its plain sentence wherever an error is shown.
 */
export class AuthoringLoadError extends Error {
  constructor(options?: ErrorOptions) {
    super(AUTHORING_LOAD_FAILED, options);
    this.name = "AuthoringLoadError";
  }

  override toString(): string {
    return this.message;
  }
}

let pending: Promise<AuthoringStackModule> | null = null;

/** The stack, loaded once; a failed load is forgotten so the next action retries. */
export function loadAuthoringStack(): Promise<AuthoringStackModule> {
  pending ??= import("./authoringStack.ts").catch((cause: unknown) => {
    pending = null;
    throw new AuthoringLoadError({ cause });
  });
  return pending;
}

/** Start loading the stack when the browser is idle; a failure waits for the action that needs it. */
export function prefetchAuthoringStack(): void {
  if (pending) return;
  const warm = () => void loadAuthoringStack().catch(() => {});
  if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 2000 });
  else setTimeout(warm, 500);
}
