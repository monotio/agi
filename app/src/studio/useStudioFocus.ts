/**
 * Room Studio keeps the keyboard: its root takes focus when it opens, and
 * after a key or click inside it has taken effect, a focused control may
 * have gone (a lens change hides Planes and Bands, Keep disables itself) or
 * never taken focus (Safari leaves clicked buttons unfocused). Focus then
 * returns to the root, so the studio shortcuts keep working instead of the
 * keys landing on the page.
 */

import { nextTick, onMounted, type ShallowRef } from "vue";

export function useStudioFocus(root: Readonly<ShallowRef<HTMLElement | null>>): () => void {
  onMounted(() => root.value?.focus({ preventScroll: true }));
  return function keepFocus(): void {
    void nextTick(() => {
      const element = root.value;
      const active = document.activeElement;
      if (element?.isConnected && (active === null || active === document.body))
        element.focus({ preventScroll: true });
    });
  };
}
