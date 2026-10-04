/**
 * Canvas sizing for a Studio: the largest integer zoom at which every pane
 * fits the stage (or the user's own zoom), and the device pixel ratio for a
 * crisp backing store. Room Studio's panes are the 160×168 picture; Sprite
 * Studio's one pane is the edited cel, with room kept for its baseline. The
 * transform itself is src/studio/viewport.ts.
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
import { layoutDragging } from "../play/layoutDrag.ts";
import { fitZoom, type Viewport } from "../../../src/studio/viewport.ts";

const MAX_ZOOM = 12;
/** Space the stage keeps around the canvases and between split panes, in CSS pixels. */
const STAGE_INSET = 24;
const PANE_GAP = 16;

/** The integer zoom that fits `panes` side by side in a stage of the given size. */
export function paneFitZoom(stageW: number, stageH: number, panes: number): number {
  const width = (stageW - 2 * STAGE_INSET - PANE_GAP * (panes - 1)) / panes;
  return fitZoom(Math.max(0, width), Math.max(0, stageH - 2 * STAGE_INSET));
}

/** What a pane holds in logical pixels (2:1), and CSS pixels kept free below it. */
export interface PaneContent {
  readonly width: number;
  readonly height: number;
  readonly below?: number;
}

/** The integer zoom (CSS pixels per row, 1..`max`) that fits `content` in a stage of the given size. */
export function contentFitZoom(
  stageW: number,
  stageH: number,
  content: PaneContent,
  max: number,
): number {
  const zoom = Math.min(
    Math.floor((stageW - 2 * STAGE_INSET) / (content.width * 2)),
    Math.floor((stageH - 2 * STAGE_INSET - (content.below ?? 0)) / content.height),
  );
  return Math.min(max, Math.max(1, zoom));
}

export function useStudioViewport(
  stage: MaybeRefOrGetter<HTMLElement | null | undefined>,
  panes: MaybeRefOrGetter<number>,
  /** One pane of other content than the picture (Sprite Studio's cel), and its largest zoom. */
  content?: { readonly size: MaybeRefOrGetter<PaneContent>; readonly max: number },
) {
  const maxZoom = content?.max ?? MAX_ZOOM;
  const size = ref({ width: 0, height: 0 });
  const dpr = ref(globalThis.devicePixelRatio || 1);
  /** The user's zoom; undefined fits the stage. */
  const override = ref<number>();

  watch(
    () => toValue(stage),
    (element) => {
      if (!element) return;
      const measure = (): void => {
        if (layoutDragging.value) return;
        size.value = { width: element.clientWidth, height: element.clientHeight };
        dpr.value = globalThis.devicePixelRatio || 1;
      };
      const stop = watch(
        layoutDragging,
        (dragging) => {
          if (!dragging) measure();
        },
        { flush: "post" },
      );
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      onWatcherCleanup(() => {
        observer.disconnect();
        stop();
      });
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

  const fit = computed(() =>
    content
      ? contentFitZoom(size.value.width, size.value.height, toValue(content.size), maxZoom)
      : paneFitZoom(size.value.width, size.value.height, toValue(panes)),
  );
  const zoom = computed(() => override.value ?? fit.value);
  const viewport = computed<Viewport>(() => ({
    zoom: zoom.value,
    pixelAspect: 2,
    offsetX: 0,
    offsetY: 0,
  }));

  function zoomBy(step: 1 | -1): void {
    override.value = Math.min(maxZoom, Math.max(1, zoom.value + step));
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
    /** The stage's width in CSS pixels. */
    stageWidth: computed(() => size.value.width),
    zoomBy,
    zoomToFit,
  };
}
