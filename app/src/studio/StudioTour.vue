<script setup lang="ts">
import { nextTick, onScopeDispose, ref, shallowRef, useId, useTemplateRef, watch } from "vue";
import UiButton from "../ui/UiButton.vue";
import { placeMark, type Box, type MarkPlacement, type StudioTour } from "./useStudioTour.ts";

/**
 * The tour's mark on screen (useStudioTour.ts): a small non-modal dialog
 * beside the chrome it names, with a ring around that chrome. It sits on the
 * chrome when a spot next to its anchor allows, and always clear of the
 * picture or the cel; it follows the layout as the window changes. Focus
 * moves to its Next or Done and returns where it was when the tour ends;
 * Tab stays in the mark, Esc ends the tour, and no key reaches the Studio
 * beneath it. It renders inside the Studio's root, which positions it.
 */
const { tour, stage, name } = defineProps<{
  tour: StudioTour;
  /** The Studio's canvas area: the picture or cel is every canvas inside it. */
  stage: HTMLElement | null;
  /** "Room Studio" or "Sprite Studio". */
  name: string;
}>();

const card = useTemplateRef("card");
const primary = useTemplateRef("primary");
const titleId = useId();
const bodyId = useId();
const placement = shallowRef<MarkPlacement | null>(null);
const rings = ref<{ left: number; top: number; width: number; height: number }[]>([]);
let returnFocus: HTMLElement | null = null;

const MARGIN = 8;
const visible = (box: DOMRect) => box.width > 0 && box.height > 0;
function clip(a: Box, b: Box): Box | null {
  const box = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return box.right > box.left && box.bottom > box.top ? box : null;
}

function place(): void {
  const mark = tour.mark.value;
  const element = card.value;
  const root = element?.parentElement;
  if (!mark || !element || !root) return;
  const origin = root.getBoundingClientRect();
  const find = (id: string) =>
    root.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.getBoundingClientRect();
  const anchors = mark.anchors.map(find).filter((box): box is DOMRect => !!box && visible(box));
  rings.value = anchors.map((box) => ({
    left: box.left - origin.left,
    top: box.top - origin.top,
    width: box.width,
    height: box.height,
  }));
  const anchor = find(mark.place);
  const bounds = {
    left: origin.left + MARGIN,
    top: origin.top + MARGIN,
    right: origin.right - MARGIN,
    bottom: origin.bottom - MARGIN,
  };
  const view = stage?.getBoundingClientRect();
  const stageBoxes: Box[] = view && visible(view) ? [view] : [];
  const picture = view
    ? [...(stage?.querySelectorAll("canvas") ?? [])]
        .map((canvas) => clip(canvas.getBoundingClientRect(), view))
        .filter((box): box is Box => box !== null)
    : [];
  const spot =
    anchor && visible(anchor)
      ? placeMark(anchor, element.offsetWidth, element.offsetHeight, bounds, mark.side, {
          stage: stageBoxes,
          picture,
        })
      : { left: bounds.right - element.offsetWidth, top: bounds.top, side: mark.side, caret: null };
  placement.value = { ...spot, left: spot.left - origin.left, top: spot.top - origin.top };
}

let frame = 0;
function schedule(): void {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(place);
}
const observer = new ResizeObserver(schedule);
onScopeDispose(() => {
  cancelAnimationFrame(frame);
  observer.disconnect();
});

watch(
  () => tour.step.value,
  async (step, before) => {
    if (step === null) {
      if (before === null || before === undefined) return;
      observer.disconnect();
      placement.value = null;
      const target = returnFocus?.isConnected ? returnFocus : null;
      returnFocus = null;
      (target ?? stage?.closest<HTMLElement>("[role=region]"))?.focus({ preventScroll: true });
      return;
    }
    if (before === null || before === undefined)
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    // The Studio's root follows the window; the stage and canvases follow zoom and panels.
    const root = card.value?.parentElement;
    observer.disconnect();
    for (const element of [root, stage, ...(stage?.querySelectorAll("canvas") ?? [])])
      if (element) observer.observe(element);
    place();
    await nextTick();
    primary.value?.$el.focus({ preventScroll: true });
  },
  { immediate: true },
);

/** Keys stay in the mark: Esc ends the tour, Tab cycles its buttons. */
function onKeydown(event: KeyboardEvent): void {
  event.stopPropagation();
  if (event.key === "Escape") {
    event.preventDefault();
    tour.end();
    return;
  }
  if (event.key !== "Tab") return;
  const buttons = [...(card.value?.querySelectorAll<HTMLElement>("button") ?? [])];
  const first = buttons[0];
  const last = buttons.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
</script>

<template>
  <template v-if="tour.mark.value">
    <div
      v-for="(ring, index) in rings"
      :key="index"
      class="studio-tour-ring"
      aria-hidden="true"
      :style="{
        left: `${ring.left}px`,
        top: `${ring.top}px`,
        width: `${ring.width}px`,
        height: `${ring.height}px`,
      }"
    ></div>
    <div
      ref="card"
      class="studio-tour"
      :class="placement ? `is-${placement.side}` : null"
      role="dialog"
      :aria-labelledby="titleId"
      :aria-describedby="bodyId"
      data-testid="studio-tour"
      :data-placed="placement !== null"
      :style="placement ? { left: `${placement.left}px`, top: `${placement.top}px` } : undefined"
      @keydown="onKeydown"
      @keyup.stop
      @keypress.stop
      @click.stop
    >
      <p class="studio-tour__eyebrow">
        {{ name }} ·
        <span data-testid="studio-tour-step"
          >{{ (tour.step.value ?? 0) + 1 }} of {{ tour.marks.length }}</span
        >
      </p>
      <h3 :id="titleId" class="studio-tour__title">{{ tour.mark.value.title }}</h3>
      <p :id="bodyId" class="studio-tour__body">{{ tour.mark.value.body }}</p>
      <div class="studio-tour__actions">
        <UiButton ref="primary" variant="primary" size="sm" @click="tour.next()">{{
          tour.last.value ? "Done" : "Next"
        }}</UiButton>
        <UiButton v-if="!tour.last.value" variant="ghost" size="sm" @click="tour.end()"
          >Skip tour</UiButton
        >
      </div>
      <i
        v-if="placement && placement.caret !== null"
        class="studio-tour__caret"
        aria-hidden="true"
        :style="
          placement.side === 'below' || placement.side === 'above'
            ? { left: `${placement.caret}px` }
            : { top: `${placement.caret}px` }
        "
      ></i>
    </div>
  </template>
</template>

<style scoped>
.studio-tour {
  position: absolute;
  z-index: var(--z-popover);
  top: 0;
  left: 0;
  box-sizing: border-box;
  width: 280px;
  padding: var(--space-4) var(--space-5) var(--space-4);
  border: 1px solid var(--action-line);
  border-radius: var(--radius-lg);
  color: var(--ink-2);
  background: var(--surface-2);
  box-shadow: var(--shadow-pop);
  font: var(--text-sm) / var(--leading) var(--font-sans);
  visibility: hidden;
}
.studio-tour[data-placed="true"] {
  visibility: visible;
  animation: studio-tour-in var(--duration) var(--ease-out);
}
@keyframes studio-tour-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .studio-tour[data-placed="true"] {
    animation: none;
  }
}
.studio-tour__eyebrow {
  margin: 0 0 var(--space-1);
  color: var(--action);
  font-weight: var(--weight-semibold);
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.studio-tour__title {
  margin: 0 0 var(--space-1);
  color: var(--ink);
  font-size: var(--text-md);
  font-weight: var(--weight-semibold);
}
.studio-tour__body {
  margin: 0;
}
.studio-tour__actions {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin-top: var(--space-4);
}
/* A small square turned 45°, half of it outside the edge that faces the anchor. */
.studio-tour__caret {
  position: absolute;
  width: 10px;
  height: 10px;
  border: 1px solid var(--action-line);
  background: var(--surface-2);
  transform: translate(-50%, -50%) rotate(45deg);
}
.studio-tour.is-below .studio-tour__caret {
  top: 0;
  border-right: 0;
  border-bottom: 0;
}
.studio-tour.is-above .studio-tour__caret {
  top: 100%;
  border-top: 0;
  border-left: 0;
}
.studio-tour.is-right .studio-tour__caret {
  left: 0;
  border-top: 0;
  border-right: 0;
}
.studio-tour.is-left .studio-tour__caret {
  left: 100%;
  border-bottom: 0;
  border-left: 0;
}
.studio-tour-ring {
  position: absolute;
  z-index: var(--z-popover);
  box-sizing: border-box;
  border: 2px solid var(--action);
  border-radius: var(--radius);
  pointer-events: none;
}
</style>
