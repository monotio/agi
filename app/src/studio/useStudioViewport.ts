/**
 * Canvas sizing for the Room Studio: the largest integer zoom at which every
 * pane fits the stage (or the user's own zoom), and the device pixel ratio
 * for a crisp backing store. The transform itself is src/studio/viewport.ts.
 */

import {
  computed,
  onWatcherCleanup,
  ref,
  toValue,
  watch,
  watchEffect,
  type MaybeRefOrGetter,
} from "vue";
import { fitZoom, type Viewport } from "../../../src/studio/viewport.ts";

export const MAX_ZOOM = 12;
/** Space the stage keeps around the canvases and between split panes, in CSS pixels. */
export const STAGE_INSET = 24;
export const PANE_GAP = 16;

/** The integer zoom that fits `panes` side by side in a stage of the given size. */
export function paneFitZoom(stageW: number, stageH: number, panes: number): number {
  const width = (stageW - 2 * STAGE_INSET - PANE_GAP * (panes - 1)) / panes;
  return fitZoom(Math.max(0, width), Math.max(0, stageH - 2 * STAGE_INSET));
}

export function useStudioViewport(
  stage: MaybeRefOrGetter<HTMLElement | null | undefined>,
  panes: MaybeRefOrGetter<number>,
) {
  const size = ref({ width: 0, height: 0 });
  const dpr = ref(globalThis.devicePixelRatio || 1);
  /** The user's zoom; undefined fits the stage. */
  const override = ref<number>();

  watch(
    () => toValue(stage),
    (element) => {
      if (!element) return;
      const measure = (): void => {
        size.value = { width: element.clientWidth, height: element.clientHeight };
        dpr.value = globalThis.devicePixelRatio || 1;
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      onWatcherCleanup(() => observer.disconnect());
    },
    { immediate: true },
  );

  // A window moved to another screen changes the ratio without a resize.
  watchEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(`(resolution: ${dpr.value}dppx)`);
    const update = (): void => {
      dpr.value = globalThis.devicePixelRatio || 1;
    };
    query.addEventListener("change", update);
    onWatcherCleanup(() => query.removeEventListener("change", update));
  });

  const fit = computed(() => paneFitZoom(size.value.width, size.value.height, toValue(panes)));
  const zoom = computed(() => override.value ?? fit.value);
  const viewport = computed<Viewport>(() => ({
    zoom: zoom.value,
    pixelAspect: 2,
    offsetX: 0,
    offsetY: 0,
  }));

  function zoomBy(step: 1 | -1): void {
    override.value = Math.min(MAX_ZOOM, Math.max(1, zoom.value + step));
  }
  function zoomToFit(): void {
    override.value = undefined;
  }

  return {
    viewport,
    zoom,
    fit,
    dpr,
    fitted: computed(() => override.value === undefined),
    zoomBy,
    zoomToFit,
  };
}
