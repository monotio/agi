<script setup lang="ts">
import { computed, useTemplateRef, watchEffect } from "vue";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import { toLogical, type Viewport, type ViewportPoint } from "../../../src/studio/viewport.ts";
import {
  CONTROL_VALUES,
  paintLayer,
  type BandGuide,
  type ControlLabel,
  type PaneLayer,
} from "./studioView.ts";

export interface MaskPaths {
  fill: string;
  outline: string;
}

/**
 * One picture pane: the engine's pixels on a <canvas> at integer zoom (2:1
 * AGI pixels, backing store scaled by devicePixelRatio) under an SVG overlay
 * in logical coordinates for highlights, band guides and control labels.
 */
const {
  layer,
  visual,
  priority,
  viewport,
  dpr,
  label,
  highlight = null,
  selection = null,
  guides = null,
  labels = null,
} = defineProps<{
  layer: PaneLayer;
  visual: Uint8Array;
  priority: Uint8Array;
  viewport: Viewport;
  dpr: number;
  label: string;
  highlight?: MaskPaths | null;
  selection?: MaskPaths | null;
  guides?: readonly BandGuide[] | null;
  labels?: readonly ControlLabel[] | null;
}>();
const emit = defineEmits<{
  hover: [cell: ViewportPoint | undefined];
  pick: [cell: ViewportPoint];
}>();

const canvas = useTemplateRef("canvas");
const width = computed(() => SCREEN_WIDTH * viewport.pixelAspect * viewport.zoom);
const height = computed(() => SCREEN_HEIGHT * viewport.zoom);
const backingWidth = computed(() => Math.round(width.value * dpr));
const backingHeight = computed(() => Math.round(height.value * dpr));
/** Logical units per 1 CSS px vertically, for text and strokes drawn in the overlay. */
const unit = computed(() => 1 / viewport.zoom);

let image: ImageData | undefined;
let scratch: HTMLCanvasElement | undefined;

watchEffect(
  () => {
    const target = canvas.value;
    if (!target) return;
    image ??= new ImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
    scratch ??= document.createElement("canvas");
    scratch.width = SCREEN_WIDTH;
    scratch.height = SCREEN_HEIGHT;
    paintLayer(layer, visual, priority, image.data);
    scratch.getContext("2d")!.putImageData(image, 0, 0);
    // Reading the size here re-paints after a zoom or ratio change resets the canvas.
    if (target.width !== backingWidth.value) target.width = backingWidth.value;
    if (target.height !== backingHeight.value) target.height = backingHeight.value;
    const context = target.getContext("2d")!;
    context.imageSmoothingEnabled = false;
    context.drawImage(scratch, 0, 0, target.width, target.height);
  },
  { flush: "post" },
);

let last: ViewportPoint | undefined;
function cellAt(event: MouseEvent): ViewportPoint | undefined {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return toLogical(viewport, event.clientX - rect.left, event.clientY - rect.top) ?? undefined;
}
function onMove(event: PointerEvent): void {
  const cell = cellAt(event);
  if (cell?.x === last?.x && cell?.y === last?.y) return;
  last = cell;
  emit("hover", cell);
}
function onLeave(): void {
  last = undefined;
  emit("hover", undefined);
}
function onClick(event: MouseEvent): void {
  const cell = cellAt(event);
  if (cell) emit("pick", cell);
}
</script>

<template>
  <div
    class="studio-pane"
    :data-layer="layer"
    :style="{ width: `${width}px`, height: `${height}px` }"
    @pointermove="onMove"
    @pointerleave="onLeave"
    @click="onClick"
  >
    <canvas
      ref="canvas"
      class="studio-pane__pixels"
      role="img"
      :aria-label="label"
      :style="{ width: `${width}px`, height: `${height}px` }"
    ></canvas>
    <svg
      class="studio-pane__overlay"
      :viewBox="`0 0 ${SCREEN_WIDTH} ${SCREEN_HEIGHT}`"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g v-if="guides" class="studio-pane__guides" data-role="band-guides">
        <line
          v-for="guide in guides"
          :key="guide.y"
          x1="0"
          :x2="SCREEN_WIDTH"
          :y1="guide.y"
          :y2="guide.y"
          vector-effect="non-scaling-stroke"
        />
        <!-- Bands are 12 rows apart; below zoom 2 their numbers would overlap. -->
        <text
          v-for="guide in viewport.zoom >= 2 ? guides : []"
          :key="`t${guide.y}`"
          class="studio-pane__text"
          text-anchor="end"
          :font-size="10 * unit"
          :transform="`translate(${SCREEN_WIDTH - 1} ${guide.y - unit * 2}) scale(0.5 1)`"
        >
          {{ guide.band }}
        </text>
      </g>
      <g v-if="labels" data-role="control-labels">
        <text
          v-for="tag in labels"
          :key="`${tag.x},${tag.y}`"
          class="studio-pane__text studio-pane__text--control"
          text-anchor="middle"
          :font-size="11 * unit"
          :transform="`translate(${tag.x + 0.5} ${tag.y - unit * 3}) scale(0.5 1)`"
        >
          {{ CONTROL_VALUES[tag.value]?.name }}
        </text>
      </g>
      <g v-if="selection" data-role="selection">
        <path class="studio-pane__sel-fill" :d="selection.fill" />
        <path
          class="studio-pane__sel-line"
          :d="selection.outline"
          vector-effect="non-scaling-stroke"
        />
      </g>
      <g v-if="highlight" data-role="hover">
        <path class="studio-pane__hl-fill" data-role="hover-fill" :d="highlight.fill" />
        <path
          class="studio-pane__hl-line"
          :d="highlight.outline"
          vector-effect="non-scaling-stroke"
        />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.studio-pane {
  position: relative;
  flex: none;
  box-shadow: var(--shadow-stage);
  cursor: crosshair;
}
.studio-pane__pixels {
  display: block;
  image-rendering: pixelated;
}
.studio-pane__overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}
.studio-pane__guides line {
  stroke: var(--action);
  stroke-opacity: 0.35;
  stroke-width: 1px;
  stroke-dasharray: 3 3;
}
.studio-pane__text {
  font-family: var(--font-mono);
  fill: var(--ink-2);
  paint-order: stroke;
  stroke: var(--surface-0);
  stroke-width: 3px;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.studio-pane__text--control {
  fill: var(--ink);
  font-weight: var(--weight-semibold);
}
.studio-pane__hl-fill {
  fill: var(--ink);
  fill-opacity: 0.2;
}
.studio-pane__hl-line {
  fill: none;
  stroke: var(--ink);
  stroke-width: 1px;
  stroke-dasharray: 3 2;
}
.studio-pane__sel-fill {
  fill: var(--action);
  fill-opacity: 0.14;
}
.studio-pane__sel-line {
  fill: none;
  stroke: var(--action);
  stroke-width: 2px;
}
</style>
