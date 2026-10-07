<script setup lang="ts">
import { computed, useTemplateRef, watchEffect } from "vue";
import { EGA_PALETTE } from "../render/palette.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import type { LineHandle, LinePoint } from "../../../src/studio/editPoints.ts";
import { toLogical, type Viewport, type ViewportPoint } from "../../../src/studio/viewport.ts";
import { paintLayer, type BandGuide, type PaneLayer } from "./studioView.ts";

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
 * in logical coordinates for highlights, band guides and the
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
   * A prepared reference (160x168 RGBA) blended above art, or behind its marks.
   * It changes the drawing surface only; the PICTURE retains its native data.
   */
  underlay?: { pixels: Uint8Array; opacity: number; behindArt?: boolean } | null;
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
/** Handle sizes in logical units: an 8 CSS px mark inside a 24 CSS px hit area, at any zoom. */
const handleBox = computed(() => {
  const x = 1 / (viewport.pixelAspect * viewport.zoom);
  const y = 1 / viewport.zoom;
  return { markW: 8 * x, markH: 8 * y, hitW: 24 * x, hitH: 24 * y };
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
    if (!underlay?.behindArt) context.drawImage(scratch, 0, 0, target.width, target.height);
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
      if (underlay.behindArt) {
        // White is the PICTURE paper; coloured marks cover a reference placed behind art.
        for (let i = 0; i < visual.length; i++) if (visual[i] === 15) image.data[i * 4 + 3] = 0;
        scratch.getContext("2d")!.putImageData(image, 0, 0);
      }
    }
    if (underlay?.behindArt) context.drawImage(scratch, 0, 0, target.width, target.height);
  },
  { flush: "post" },
);

let last: ViewportPoint | undefined;
/** The pointer this pane captured on a press, until release or cancel. */
let captured: number | null = null;
/** The pane's screen origin at the press: a reflow during the drag must not move its cells. */
let anchor: { left: number; top: number } | undefined;

function cellAt(
  rect: { left: number; top: number },
  x: number,
  y: number,
): ViewportPoint | undefined {
  return toLogical(viewport, x - rect.left, y - rect.top) ?? undefined;
}
/** The logical cell under the pointer, off the surface too (a drag may leave the pane). */
function rawCell(event: PointerEvent): ViewportPoint {
  const rect =
    event.pointerId === captured && anchor !== undefined
      ? anchor
      : (event.currentTarget as HTMLElement).getBoundingClientRect();
  return {
    x: Math.floor((event.clientX - rect.left) / (viewport.pixelAspect * viewport.zoom)),
    y: Math.floor((event.clientY - rect.top) / viewport.zoom),
  };
}
/**
 * The handle under a press. A hit box is a fixed 24 CSS px square, so at a
 * fractional zoom neighbouring points' boxes overlap: the press belongs to
 * the nearest handle centre, not to whichever box the DOM finds on top.
 */
function handleAt(
  event: PointerEvent,
  rect: { left: number; top: number },
): LineHandle | undefined {
  if (!handles?.length) return undefined;
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  const { pixelAspect, zoom } = viewport;
  let best: LineHandle | undefined;
  let dist = Infinity;
  for (const handle of handles) {
    const dx = px - (handle.x + 0.5) * pixelAspect * zoom;
    const dy = py - (handle.y + 0.5) * zoom;
    const square = dx * dx + dy * dy;
    if (Math.abs(dx) <= 12 && Math.abs(dy) <= 12 && square < dist) {
      dist = square;
      best = handle;
    }
  }
  return best;
}
function onDown(event: PointerEvent): void {
  if (event.button !== 0 || captured !== null) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const handle = handleAt(event, rect);
  if (!handle && cellAt(rect, event.clientX, event.clientY) === undefined) return;
  captured = event.pointerId;
  anchor = { left: rect.left, top: rect.top };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  emit("press", { event, cell: rawCell(event), handle });
}
function onMove(event: PointerEvent): void {
  if (event.pointerId === captured) {
    emit("drag", { event, cell: rawCell(event), handle: undefined });
    return;
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const cell = cellAt(rect, event.clientX, event.clientY);
  if (cell?.x === last?.x && cell?.y === last?.y) return;
  last = cell;
  emit("hover", cell);
}
function onUp(event: PointerEvent): void {
  if (event.pointerId !== captured) return;
  const cell = rawCell(event);
  captured = null;
  anchor = undefined;
  emit("release", { event, cell, handle: undefined });
}
/** The browser took the pointer (a cancel, or capture lost without a release). */
function onLost(event: PointerEvent): void {
  if (event.pointerId !== captured) return;
  captured = null;
  anchor = undefined;
  emit("abort");
}
function onMenu(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const cell = cellAt(rect, event.clientX, event.clientY);
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
