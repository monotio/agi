/**
 * A window too short for Sprite Studio's side panel at full size (1024×600,
 * a landscape tablet): the previews shrink and In room shows its verdict with
 * the room itself behind Show, so the panel fits without a scroll.
 */

import { onScopeDispose, shallowRef } from "vue";

const SHORT = "(max-height: 720px)";

export function useShortWindow() {
  const query = globalThis.matchMedia?.(SHORT);
  const short = shallowRef(query?.matches === true);
  const update = (event: MediaQueryListEvent) => (short.value = event.matches);
  query?.addEventListener("change", update);
  onScopeDispose(() => query?.removeEventListener("change", update));
  return short;
}
