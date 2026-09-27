/**
 * The calm canvas: what keeps help and panels off the picture. The `?` key
 * sheet's open state; focus mode (⌘\ or Ctrl+\), which hides the side
 * panels for a full-width canvas; and a one-time tip in the status bar the
 * first time focus mode hides them, remembered per viewer. Viewer
 * preferences live in localStorage and every access is guarded: a private
 * window or blocked storage just shows the tip again.
 */

import { onScopeDispose, ref, shallowRef } from "vue";

/** A per-viewer preference string, or null when unset or storage is blocked. */
export function readViewerPref(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
export function writeViewerPref(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Blocked storage: the preference lasts this session only.
  }
}

const FOCUS_TIP_KEY = "monotio_agi.studioFocusTip";
const FOCUS_TIP = "Side panels hidden · ⌘\\ or Ctrl+\\ brings them back";
/** How long the tip stays in the status bar. */
const TIP_MS = 5000;

export function useStudioCalm() {
  const sheetOpen = ref(false);
  const focus = ref(false);
  const tip = shallowRef<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onScopeDispose(() => clearTimeout(timer));

  function toggleFocus(): void {
    focus.value = !focus.value;
    if (!focus.value) {
      tip.value = null;
      return;
    }
    if (readViewerPref(FOCUS_TIP_KEY) === "seen") return;
    writeViewerPref(FOCUS_TIP_KEY, "seen");
    tip.value = FOCUS_TIP;
    clearTimeout(timer);
    timer = setTimeout(() => (tip.value = null), TIP_MS);
  }

  return { sheetOpen, focus, tip, toggleFocus };
}
