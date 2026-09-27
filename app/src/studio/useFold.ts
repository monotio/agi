import { nextTick, onWatcherCleanup, shallowRef, watch, type Ref, type ShallowRef } from "vue";

/**
 * A bar that folds what it cannot fit: level 0 shows everything, and each
 * level up folds one more group (into a More menu, or away when another
 * place shows it). On every resize of `box` it starts from 0 and folds one
 * level at a time until `fits` holds for the laid-out bar, so the folds
 * follow the real widths of its words and controls, never a guessed
 * breakpoint. Call `refit` when the content changes without a resize.
 */
export function useFold(
  box: Readonly<Ref<HTMLElement | null | undefined>>,
  levels: number,
  fits: (box: HTMLElement) => boolean,
): { level: ShallowRef<number>; refit: () => Promise<void> } {
  const level = shallowRef(0);
  let fitting: Promise<void> | null = null;
  let again = false;

  async function run(): Promise<void> {
    do {
      again = false;
      level.value = 0;
      await nextTick();
      while (level.value < levels && box.value && !fits(box.value)) {
        level.value++;
        await nextTick();
      }
    } while (again);
  }
  function refit(): Promise<void> {
    if (fitting) {
      again = true;
      return fitting;
    }
    fitting = run().finally(() => (fitting = null));
    return fitting;
  }

  watch(
    box,
    (element) => {
      if (!element || typeof ResizeObserver === "undefined") return;
      let width = -1;
      const observer = new ResizeObserver(([entry]) => {
        // Folding changes the bar's content, never its width: only a new width refits.
        const next = entry?.contentRect.width ?? -1;
        if (next === width) return;
        width = next;
        void refit();
      });
      observer.observe(element);
      onWatcherCleanup(() => observer.disconnect());
    },
    { immediate: true },
  );
  return { level, refit };
}
