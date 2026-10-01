<script setup lang="ts">
import { computed, useId, useTemplateRef } from "vue";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import { toLogical, toScreen, type Viewport } from "../../../src/studio/viewport.ts";
import { CONTROL_VALUES, maskFillPath, maskOutlinePath } from "./studioView.ts";
import type { GhostProbe } from "./useGhostProbe.ts";

/**
 * The ghost-actor overlay for one picture pane: the probe's cel drawn where
 * the engine would draw it (hidden pixels faint and hatched), its baseline and
 * footprint control hits, and a drag handle; nothing else lies on the art.
 * Its readout docks beside the canvas (GhostReadout.vue). It fills its
 * positioned parent exactly like StudioCanvas's own overlay, so it must sit
 * over a pane at the pane's origin. State lives in `useGhostProbe`.
 *
 * Mounting (the harness's `?probe=1` entry does the same): the host creates
 * `useGhostProbe({ views: listGameViews(files, profile), picture, profile,
 * priorityBase })`, wraps the art pane in a `position: relative` box with
 * this component beside the StudioCanvas, docks GhostReadout off the
 * picture, adds a pressed-state tool button calling `probe.toggle()`, and
 * routes its root keydown through
 * `probe.handleStudioKey` for G. Arrow keys on the focused ghost call
 * preventDefault, so a host that skips prevented keys keeps its own arrows.
 */
const { probe, viewport } = defineProps<{ probe: GhostProbe; viewport: Viewport }>();

const hatchId = `ghost-hatch-${useId()}`;
const root = useTemplateRef("root");
const width = computed(() => SCREEN_WIDTH * viewport.pixelAspect * viewport.zoom);
const height = computed(() => SCREEN_HEIGHT * viewport.zoom);

// The probe object is fixed for the component's life; its refs are the state.
const { result, pixels, cel, x, baselineY } = probe;

function colourMasks(hidden: boolean): { color: number; d: string }[] {
  const masks = new Map<number, Uint8Array>();
  for (const pixel of pixels.value) {
    if (pixel.hidden !== hidden) continue;
    let mask = masks.get(pixel.color);
    if (!mask) masks.set(pixel.color, (mask = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT)));
    mask[pixel.cell] = 1;
  }
  return [...masks].map(([color, mask]) => ({ color, d: maskFillPath(mask) }));
}
const drawnLayers = computed(() => colourMasks(false));
const hiddenLayers = computed(() => colourMasks(true));
const hiddenPath = computed(() => (result.value ? maskFillPath(result.value.hiddenMask) : ""));
const outline = computed(() => {
  const mask = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  for (const pixel of pixels.value) mask[pixel.cell] = 1;
  return maskOutlinePath(mask);
});

/** The cel's box in pane pixels; the probe keeps it on the surface, so the blit never shifts it. */
const box = computed(() => {
  const c = cel.value;
  if (!c) return null;
  const top = toScreen(viewport, x.value, baselineY.value - c.height + 1);
  if (!top) return null;
  return {
    left: `${top.x}px`,
    top: `${top.y}px`,
    width: `${c.width * viewport.pixelAspect * viewport.zoom}px`,
    height: `${c.height * viewport.zoom}px`,
  };
});

/** Whether the picture hides the ghost: its root says so for the host and tests. */
const verdict = computed(() => {
  const total = pixels.value.length;
  const hidden = pixels.value.filter((p) => p.hidden).length;
  return total === 0 ? "empty" : hidden === 0 ? "front" : hidden === total ? "hidden" : "behind";
});

let grab: { dx: number; dy: number } | undefined;
function logicalAt(event: PointerEvent) {
  const rect = root.value!.getBoundingClientRect();
  return toLogical(viewport, event.clientX - rect.left, event.clientY - rect.top, { clamp: true })!;
}
function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const at = logicalAt(event);
  grab = { dx: at.x - x.value, dy: at.y - baselineY.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  (event.currentTarget as HTMLElement).focus({ preventScroll: true });
  event.preventDefault();
}
function onPointerMove(event: PointerEvent): void {
  if (!grab) return;
  const at = logicalAt(event);
  probe.moveTo(at.x - grab.dx, at.y - grab.dy);
}
function onPointerUp(): void {
  grab = undefined;
}

/** Arrows cycle cel (left/right) and loop (up/down); with Shift they nudge by one pixel. */
function onKeydown(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const nudge: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const step = nudge[event.key];
  if (!step) return;
  if (event.shiftKey) probe.moveTo(x.value + step[0], baselineY.value + step[1]);
  else if (step[0] !== 0) probe.cycleCel(step[0] as 1 | -1);
  else probe.cycleLoop(step[1] as 1 | -1);
  event.preventDefault();
}
</script>

<template>
  <div
    v-if="probe.active.value"
    ref="root"
    class="ghost"
    data-testid="ghost-probe"
    :data-verdict="verdict"
    :style="{ width: `${width}px`, height: `${height}px` }"
  >
    <svg
      class="ghost__svg"
      :viewBox="`0 0 ${SCREEN_WIDTH} ${SCREEN_HEIGHT}`"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <pattern
          :id="hatchId"
          width="1.5"
          height="1.5"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="1.5" class="ghost__hatch" />
        </pattern>
      </defs>
      <line
        class="ghost__baseline-guide"
        x1="0"
        :x2="SCREEN_WIDTH"
        :y1="baselineY + 0.5"
        :y2="baselineY + 0.5"
        vector-effect="non-scaling-stroke"
      />
      <path
        v-for="layer in drawnLayers"
        :key="`d${layer.color}`"
        data-role="ghost-drawn"
        :d="layer.d"
        :style="{ fill: `var(--agi-${layer.color})` }"
      />
      <g class="ghost__hidden">
        <path
          v-for="layer in hiddenLayers"
          :key="`h${layer.color}`"
          :d="layer.d"
          :style="{ fill: `var(--agi-${layer.color})` }"
        />
      </g>
      <path data-role="ghost-hidden" :d="hiddenPath" :fill="`url(#${hatchId})`" />
      <path class="ghost__outline" :d="outline" vector-effect="non-scaling-stroke" />
      <line
        v-if="cel"
        class="ghost__baseline"
        data-role="ghost-baseline"
        :x1="x"
        :x2="x + cel.width"
        :y1="baselineY + 0.5"
        :y2="baselineY + 0.5"
        vector-effect="non-scaling-stroke"
      />
      <template v-for="hit in result?.controlHits ?? []" :key="hit.value">
        <rect
          v-for="cell in hit.cells"
          :key="cell.x"
          class="ghost__hit"
          data-role="ghost-control"
          :data-value="hit.value"
          :x="cell.x"
          :y="cell.y"
          width="1"
          height="1"
          :style="{ stroke: `var(--agi-${CONTROL_VALUES[hit.value]!.colour})` }"
          vector-effect="non-scaling-stroke"
        />
      </template>
    </svg>

    <div
      v-if="box"
      class="ghost__handle"
      data-testid="ghost-probe-handle"
      data-role="drag-handle"
      tabindex="0"
      role="application"
      :aria-label="`Stand-in at x ${x}, feet row ${baselineY}. Drag to move; arrows change cel and loop; Shift+arrows nudge.`"
      :style="box"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onKeydown"
    ></div>
  </div>
</template>

<style scoped>
.ghost {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}
.ghost__svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.ghost__hidden {
  opacity: 0.3;
}
.ghost__hatch {
  stroke: var(--ink);
  stroke-width: 0.4;
  stroke-opacity: 0.7;
}
.ghost__outline {
  fill: none;
  stroke: var(--action);
  stroke-width: 1px;
  stroke-dasharray: 2 2;
}
.ghost__baseline-guide {
  stroke: var(--action);
  stroke-opacity: 0.35;
  stroke-width: 1px;
  stroke-dasharray: 4 3;
}
.ghost__baseline {
  stroke: var(--action);
  stroke-width: 2px;
}
.ghost__hit {
  fill: none;
  stroke-width: 2px;
}
.ghost__handle {
  position: absolute;
  pointer-events: auto;
  cursor: grab;
  touch-action: none;
  border-radius: var(--radius-sm);
}
.ghost__handle:active {
  cursor: grabbing;
}
.ghost__handle:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
</style>
