/**
 * Ambient globals for the app shell.
 *
 * The engine mirrors its test/debug hooks onto the window every frame; the
 * Playwright specs read them (app/e2e/engineProbe.ts). Declaring them here is
 * what lets useEngine.ts publish them without an `any` cast.
 */
import type { AgentLogEntry, TextHook } from "../useEngine.ts";

declare global {
  interface Window {
    /** Latest engine frame state. */
    __AGI_TEXT__?: TextHook;
    /** Agent bridge trace. */
    __AGI_TRACE__?: AgentLogEntry[];
  }
}
