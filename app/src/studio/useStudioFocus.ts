/**
 * Editors focus their roots on opening while text fields, menus and dialogs
 * keep their focus. After an editor action removes or disables its focused
 * control, focus returns to the root so its keyboard shortcuts keep working.
 */

import { nextTick, onMounted, type ShallowRef } from "vue";

export function useStudioFocus(root: Readonly<ShallowRef<HTMLElement | null>>): () => void {
  onMounted(() => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      (active.matches("input, textarea, select") ||
        active.isContentEditable ||
        active.closest('[role="menu"], [role="dialog"]'))
    )
      return;
    root.value?.focus({ preventScroll: true });
  });
  return function keepFocus(): void {
    void nextTick(() => {
      const element = root.value;
      const active = document.activeElement;
      if (element?.isConnected && (active === null || active === document.body))
        element.focus({ preventScroll: true });
    });
  };
}
