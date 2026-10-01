<script setup lang="ts">
import { computed, useTemplateRef, watchEffect } from "vue";
import { EGA_PALETTE } from "../render/palette.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import type { LineHandle, LinePoint } from "../../../src/studio/editPoints.ts";
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

/** A press on the pane: the logical cell (unbounded while dragging) and the handle hit, if any. */
export interface PanePress {
  readonly event: PointerEvent;
  readonly cell: ViewportPoint;
  readonly handle: LineHandle | undefined;
}

/**
 * One picture pane: the engine's pixels on a <canvas> at integer zoom (2:1
 * AGI pixels, backing store scaled by devicePixelRatio) under an SVG overlay
 * in logical coordinates for highlights, band guides, control labels and the
 * selected item's handles. A press captures the pointer, so a drag keeps
 * reporting cells past the pane's edge; the slot holds overlays placed in
 * CSS pixels (the contextual toolbar).
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
  handles = null,
  ghost = null,
  flash = null,
  changed = null,
  spilled = null,
  underlay = null,
  movable = false,
  marquee = null,
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
  /** The selected item's points, drawn as draggable handles. */
  handles?: readonly LineHandle[] | null;
  /** Where an Alt+click adds a point to the selected line: a "+" mark. */
  ghost?: LinePoint | null;
  /** Cells an edit was refused for, highlighted briefly. */
  flash?: MaskPaths | null;
  /** Cells an AI proposal changes, outlined while it awaits a verdict. */
  changed?: MaskPaths | null;
  /** The proposal's side effects: cells of other items it changes, outside the selection. */
  spilled?: MaskPaths | null;
  /**
   * A prepared reference underlay (160x168 RGBA) below the picture marks.
   * It changes the drawing surface only; the PICTURE retains its native data.
   */
  underlay?: { pixels: Uint8Array; opacity: number } | null;
  /** The pointer is over the selection, which a drag moves: the move cursor. */
  movable?: boolean;
  /** A selection box being drawn, in logical cells (inclusive). */
  marquee?: { x1: number; y1: number; x2: number; y2: number } | null;
}>();
const emit = defineEmits<{
  hover: [cell: ViewportPoint | undefined];
  press: [press: PanePress];
  drag: [press: PanePress];
  release: [press: PanePress];
  abort: [];
  /** A right-click on the picture: its cell and where the menu opens (viewport pixels). */
  menu: [cell: ViewportPoint, at: { x: number; y: number }];
}>();

const canvas = useTemplateRef("canvas");
const width = computed(() => SCREEN_WIDTH * viewport.pixelAspect * viewport.zoom);
const height = computed(() => SCREEN_HEIGHT * viewport.zoom);
const backingWidth = computed(() => Math.round(width.value * dpr));
const backingHeight = computed(() => Math.round(height.value * dpr));
/** Logical units per 1 CSS px vertically, for text and strokes drawn in the overlay. */
const unit = computed(() => 1 / viewport.zoom);
/** Handle sizes in logical units: an 8 CSS px mark inside a 24 CSS px hit area, at any zoom. */
const handleBox = computed(() => {
  const x = 1 / (viewport.pixelAspect * viewport.zoom);
  const y = 1 / viewport.zoom;
  return { markW: 8 * x, markH: 8 * y, hitW: 24 * x, hitH: 24 * y };
});

/** Control label text size and a monospace glyph's advance, in CSS px. */
const LABEL_PX = 11;
const LABEL_ADVANCE = 0.6 * LABEL_PX;
/**
 * The control labels that read on their own at this zoom. Labels come
 * largest run first; one whose text would overlap another's columns within
 * two text lines of it would read as that label's second line, so it is
 * left out (the legend still names every value).
 */
const readableLabels = computed(() => {
  if (!labels) return null;
  const { pixelAspect, zoom } = viewport;
  const placed: { x0: number; x1: number; y: number }[] = [];
  return labels.filter((tag) => {
    const half = ((CONTROL_VALUES[tag.value]?.name.length ?? 0) * LABEL_ADVANCE) / 2;
    const x = (tag.x + 0.5) * pixelAspect * zoom;
    const box = { x0: x - half, x1: x + half, y: tag.y * zoom };
    const stacks = placed.some(
      (other) => box.x0 < other.x1 && other.x0 < box.x1 && Math.abs(box.y - other.y) < 2 * LABEL_PX,
    );
    if (!stacks) placed.push(box);
    return !stacks;
  });
});

let image: ImageData | undefined;
let scratch: HTMLCanvasElement | undefined;
let underlayScratch: HTMLCanvasElement | undefined;

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
    context.fillStyle = `rgb(${EGA_PALETTE[15]!.join(" ")})`;
    context.fillRect(0, 0, target.width, target.height);
    // White is the PICTURE paper. The reference sits below its coloured marks.
    if (underlay !== null && underlay.opacity > 0) {
      underlayScratch ??= document.createElement("canvas");
      underlayScratch.width = SCREEN_WIDTH;
      underlayScratch.height = SCREEN_HEIGHT;
      const pixels = new ImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
      pixels.data.set(underlay.pixels);
      underlayScratch.getContext("2d")!.putImageData(pixels, 0, 0);
      context.globalAlpha = underlay.opacity;
      context.drawImage(underlayScratch, 0, 0, target.width, target.height);
      context.globalAlpha = 1;
      for (let i = 0; i < visual.length; i++) if (visual[i] === 15) image.data[i * 4 + 3] = 0;
      scratch.getContext("2d")!.putImageData(image, 0, 0);
    }
    context.drawImage(scratch, 0, 0, target.width, target.height);
  },
  { flush: "post" },
);

let last: ViewportPoint | undefined;
/** The pointer this pane captured on a press, until release or cancel. */
let captured: number | null = null;

function cellAt(event: MouseEvent): ViewportPoint | undefined {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return toLogical(viewport, event.clientX - rect.left, event.clientY - rect.top) ?? undefined;
}
/** The logical cell under the pointer, off the surface too (a drag may leave the pane). */
function rawCell(event: MouseEvent): ViewportPoint {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return {
    x: Math.floor((event.clientX - rect.left) / (viewport.pixelAspect * viewport.zoom)),
    y: Math.floor((event.clientY - rect.top) / viewport.zoom),
  };
}
function handleAt(event: PointerEvent): LineHandle | undefined {
  const hit = (event.target as Element | null)?.closest("[data-handle]");
  const index = hit === null || hit === undefined ? -1 : Number(hit.getAttribute("data-handle"));
  return index >= 0 ? handles?.[index] : undefined;
}
function onDown(event: PointerEvent): void {
  if (event.button !== 0 || captured !== null) return;
  const cell = rawCell(event);
  const handle = handleAt(event);
  if (!handle && !cellAt(event)) return;
  captured = event.pointerId;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  emit("press", { event, cell, handle });
}
function onMove(event: PointerEvent): void {
  if (event.pointerId === captured) {
    emit("drag", { event, cell: rawCell(event), handle: undefined });
    return;
  }
  const cell = cellAt(event);
  if (cell?.x === last?.x && cell?.y === last?.y) return;
  last = cell;
  emit("hover", cell);
}
function onUp(event: PointerEvent): void {
  if (event.pointerId !== captured) return;
  captured = null;
  emit("release", { event, cell: rawCell(event), handle: undefined });
}
/** The browser took the pointer (a cancel, or capture lost without a release). */
function onLost(event: PointerEvent): void {
  if (event.pointerId !== captured) return;
  captured = null;
  emit("abort");
}
function onMenu(event: MouseEvent): void {
  const cell = cellAt(event);
  if (!cell) return;
  event.preventDefault();
  emit("menu", cell, { x: event.clientX, y: event.clientY });
}
function onLeave(): void {
  last = undefined;
  emit("hover", undefined);
}
</script>

<template>
  <div
    class="studio-pane"
    :data-layer="layer"
    :class="{ 'is-movable': movable }"
    :style="{ width: `${width}px`, height: `${height}px` }"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onLost"
    @lostpointercapture="onLost"
    @pointerleave="onLeave"
    @contextmenu="onMenu"
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
      <g v-if="readableLabels" data-role="control-labels">
        <text
          v-for="tag in readableLabels"
          :key="`${tag.x},${tag.y}`"
          class="studio-pane__text studio-pane__text--control"
          text-anchor="middle"
          :font-size="LABEL_PX * unit"
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
      <rect
        v-if="marquee"
        class="studio-pane__marquee"
        data-role="marquee"
        :x="marquee.x1"
        :y="marquee.y1"
        :width="marquee.x2 - marquee.x1 + 1"
        :height="marquee.y2 - marquee.y1 + 1"
        vector-effect="non-scaling-stroke"
      />
      <g v-if="changed" data-role="changed">
        <path class="studio-pane__changed-fill" :d="changed.fill" />
        <path
          class="studio-pane__changed-line"
          :d="changed.outline"
          vector-effect="non-scaling-stroke"
        />
      </g>
      <g v-if="spilled" data-role="spilled">
        <path class="studio-pane__spilled-fill" :d="spilled.fill" />
        <path
          class="studio-pane__spilled-line"
          :d="spilled.outline"
          vector-effect="non-scaling-stroke"
        />
      </g>
      <g v-if="flash" data-role="refused">
        <path class="studio-pane__flash-fill" :d="flash.fill" />
        <path
          class="studio-pane__flash-line"
          :d="flash.outline"
          vector-effect="non-scaling-stroke"
        />
      </g>
      <g v-if="handles" data-role="handles">
        <g
          v-for="(handle, k) in handles"
          :key="`${handle.line}:${handle.index}`"
          class="studio-pane__handle"
          :class="`is-${handle.kind}`"
          :data-handle="k"
          :data-point="`${handle.line}:${handle.index}`"
        >
          <rect
            class="studio-pane__handle-hit"
            :x="handle.x + 0.5 - handleBox.hitW / 2"
            :y="handle.y + 0.5 - handleBox.hitH / 2"
            :width="handleBox.hitW"
            :height="handleBox.hitH"
          />
          <rect
            class="studio-pane__handle-mark"
            :x="handle.x + 0.5 - handleBox.markW / 2"
            :y="handle.y + 0.5 - handleBox.markH / 2"
            :width="handleBox.markW"
            :height="handleBox.markH"
            vector-effect="non-scaling-stroke"
          />
        </g>
      </g>
      <g
        v-if="ghost"
        class="studio-pane__ghost"
        data-role="insert-ghost"
        :data-point="`${ghost.x},${ghost.y}`"
      >
        <ellipse
          class="studio-pane__ghost-dot"
          :cx="ghost.x + 0.5"
          :cy="ghost.y + 0.5"
          :rx="handleBox.markW * 0.8"
          :ry="handleBox.markH * 0.8"
          vector-effect="non-scaling-stroke"
        />
        <path
          class="studio-pane__ghost-plus"
          :d="`M${ghost.x + 0.5 - handleBox.markW * 0.45} ${ghost.y + 0.5}h${handleBox.markW * 0.9}M${ghost.x + 0.5} ${ghost.y + 0.5 - handleBox.markH * 0.45}v${handleBox.markH * 0.9}`"
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
    <slot />
  </div>
</template>

<style scoped>
.studio-pane {
  position: relative;
  flex: none;
  box-shadow: var(--shadow-stage);
  cursor: default;
}
.studio-pane.is-movable {
  cursor: move;
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
.studio-pane__marquee {
  fill: var(--action);
  fill-opacity: 0.08;
  stroke: var(--action);
  stroke-width: 1px;
  stroke-dasharray: 4 3;
}
.studio-pane__changed-fill {
  fill: var(--ok);
  fill-opacity: 0.12;
}
.studio-pane__changed-line {
  fill: none;
  stroke: var(--ok);
  stroke-width: 2px;
  stroke-dasharray: 4 2;
}
.studio-pane__spilled-fill {
  fill: var(--warn);
  fill-opacity: 0.12;
}
.studio-pane__spilled-line {
  fill: none;
  stroke: var(--warn);
  stroke-width: 2px;
  stroke-dasharray: 4 2;
}
.studio-pane__flash-fill {
  fill: var(--warn);
  fill-opacity: 0.7;
}
.studio-pane__flash-line {
  fill: none;
  stroke: var(--warn);
  stroke-width: 2px;
}
.studio-pane__handle {
  cursor: grab;
  pointer-events: all;
}
.studio-pane__handle-hit {
  fill: transparent;
}
.studio-pane__handle-mark {
  fill: var(--surface-0);
  stroke: var(--action);
  stroke-width: 1.5px;
}
.studio-pane__ghost-dot {
  fill: var(--action);
  stroke: var(--surface-0);
  stroke-width: 1.5px;
}
.studio-pane__ghost-plus {
  fill: none;
  stroke: var(--action-ink);
  stroke-width: 2px;
}
.studio-pane__handle.is-seed .studio-pane__handle-mark {
  stroke: var(--warn);
  stroke-dasharray: 2 1;
}
.studio-pane__handle:hover .studio-pane__handle-mark {
  fill: var(--action);
}
</style>
