<script setup lang="ts">
import { computed, useTemplateRef, watchEffect } from "vue";
import type { SpriteCel } from "../../../../src/studio/sprite/spriteDocument.ts";
import { celRgba, type CelPoint, type CelRect } from "./spriteView.ts";

/** An onion skin: a neighbouring cel drawn faint and tinted under the edited one. */
export interface OnionSkin {
  readonly cel: SpriteCel;
  /** Before the edited cel (−) or after it (+). */
  readonly side: "prev" | "next";
  /** 1 for the nearest neighbour; farther ones are fainter. */
  readonly distance: number;
}

/** A press on the canvas: the cel cell (unbounded while dragging) and whether Alt was held. */
export interface CelPress {
  readonly point: CelPoint;
  readonly alt: boolean;
}

/**
 * The pixel canvas: one cel at integer zoom with AGI's 2:1 pixels (backing
 * store scaled by devicePixelRatio), a checker where it is transparent, the
 * onion skins of its neighbours under it, and the grid, the selection and
 * the keyboard cursor over it. The baseline under it marks the cel's bottom
 * row, where the game stands an actor's feet. A press captures the pointer,
 * so a stroke keeps reporting cells past the edge.
 */
const {
  cel,
  onion = [],
  zoom,
  dpr,
  grid = true,
  baseline = true,
  overlay,
  label,
} = defineProps<{
  cel: SpriteCel;
  onion?: readonly OnionSkin[];
  /** CSS pixels per cel row; a cel pixel is twice as wide. */
  zoom: number;
  dpr: number;
  grid?: boolean;
  baseline?: boolean;
  overlay: {
    readonly marquee: CelRect | null;
    readonly selection: CelRect | null;
    readonly cursor: CelPoint | null;
  };
  label: string;
}>();
const emit = defineEmits<{
  hover: [point: CelPoint | undefined];
  press: [press: CelPress];
  drag: [point: CelPoint];
  release: [point: CelPoint];
  abort: [];
}>();

/** Onion tints, blended into each skin's colours: warm before, cool after. */
const TINTS = {
  prev: [0xff, 0x55, 0x55],
  next: [0x55, 0xff, 0xff],
} as const;

const canvas = useTemplateRef("canvas");
const width = computed(() => cel.width * 2 * zoom);
const height = computed(() => cel.height * zoom);

let scratch: HTMLCanvasElement | undefined;

/** Draw `pixels` (logical RGBA, `w`×`h`) scaled onto the context, bottom-left aligned. */
function blit(context: CanvasRenderingContext2D, source: SpriteCel, tint?: OnionSkin): void {
  scratch ??= document.createElement("canvas");
  scratch.width = source.width;
  scratch.height = source.height;
  const image = new ImageData(source.width, source.height);
  celRgba(
    source,
    image.data,
    tint && {
      rgb: TINTS[tint.side],
      alpha: tint.distance === 1 ? 0.45 : tint.distance === 2 ? 0.28 : 0.18,
    },
  );
  scratch.getContext("2d")!.putImageData(image, 0, 0);
  const unitX = 2 * zoom * dpr;
  const unitY = zoom * dpr;
  // Cels stand on the same baseline and left edge: the object's x and y.
  const top = (cel.height - source.height) * unitY;
  context.drawImage(scratch, 0, top, source.width * unitX, source.height * unitY);
}

watchEffect(
  () => {
    const target = canvas.value;
    if (!target) return;
    const backingWidth = Math.round(width.value * dpr);
    const backingHeight = Math.round(height.value * dpr);
    if (target.width !== backingWidth) target.width = backingWidth;
    if (target.height !== backingHeight) target.height = backingHeight;
    const context = target.getContext("2d")!;
    context.imageSmoothingEnabled = false;
    const style = getComputedStyle(target);
    const token = (name: string) => style.getPropertyValue(name).trim();
    const unitX = 2 * zoom * dpr;
    const unitY = zoom * dpr;
    // The transparent colour's checker: one square per cel pixel.
    const light = token("--surface-3");
    const dark = token("--surface-2");
    for (let y = 0; y < cel.height; y++)
      for (let x = 0; x < cel.width; x++) {
        context.fillStyle = (x + y) % 2 === 0 ? dark : light;
        context.fillRect(x * unitX, y * unitY, unitX, unitY);
      }
    for (const skin of [...onion].sort((a, b) => b.distance - a.distance))
      blit(context, skin.cel, skin);
    blit(context, cel);
    if (grid && zoom >= 4) {
      context.strokeStyle = token("--hairline");
      context.lineWidth = 1;
      context.beginPath();
      for (let x = 1; x < cel.width; x++) {
        context.moveTo(Math.round(x * unitX) + 0.5, 0);
        context.lineTo(Math.round(x * unitX) + 0.5, target.height);
      }
      for (let y = 1; y < cel.height; y++) {
        context.moveTo(0, Math.round(y * unitY) + 0.5);
        context.lineTo(target.width, Math.round(y * unitY) + 0.5);
      }
      context.stroke();
    }
    const outline = (rect: CelRect, color: string, dashed: boolean) => {
      context.save();
      context.strokeStyle = color;
      context.lineWidth = Math.max(1, Math.round(dpr * 1.5));
      if (dashed) context.setLineDash([4 * dpr, 3 * dpr]);
      context.strokeRect(
        rect.x * unitX + 1,
        rect.y * unitY + 1,
        rect.width * unitX - 2,
        rect.height * unitY - 2,
      );
      context.restore();
    };
    if (overlay.selection) outline(overlay.selection, token("--action"), true);
    if (overlay.marquee) outline(overlay.marquee, token("--action"), true);
    if (overlay.cursor)
      outline({ ...overlay.cursor, width: 1, height: 1 }, token("--focus"), false);
  },
  { flush: "post" },
);

let last: CelPoint | undefined;
/** The pointer this canvas captured on a press, until release or cancel. */
let captured: number | null = null;

function cellAt(event: MouseEvent): CelPoint {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return {
    x: Math.floor((event.clientX - rect.left) / (2 * zoom)),
    y: Math.floor((event.clientY - rect.top) / zoom),
  };
}
const onCel = ({ x, y }: CelPoint): boolean => x >= 0 && y >= 0 && x < cel.width && y < cel.height;

function onDown(event: PointerEvent): void {
  if (event.button !== 0 || captured !== null) return;
  const point = cellAt(event);
  if (!onCel(point)) return;
  captured = event.pointerId;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  emit("press", { point, alt: event.altKey });
}
function onMove(event: PointerEvent): void {
  const point = cellAt(event);
  if (event.pointerId === captured) {
    emit("drag", point);
    return;
  }
  const hovered = onCel(point) ? point : undefined;
  if (hovered?.x === last?.x && hovered?.y === last?.y) return;
  last = hovered;
  emit("hover", hovered);
}
function onUp(event: PointerEvent): void {
  if (event.pointerId !== captured) return;
  captured = null;
  emit("release", cellAt(event));
}
function onLost(event: PointerEvent): void {
  if (event.pointerId !== captured) return;
  captured = null;
  emit("abort");
}
function onLeave(): void {
  last = undefined;
  emit("hover", undefined);
}
</script>

<template>
  <div class="sprite-canvas">
    <canvas
      ref="canvas"
      class="sprite-canvas__pixels"
      role="img"
      :aria-label="label"
      data-testid="sprite-canvas"
      :data-width="cel.width"
      :data-height="cel.height"
      :data-zoom="zoom"
      :style="{ width: `${width}px`, height: `${height}px` }"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onLost"
      @lostpointercapture="onLost"
      @pointerleave="onLeave"
    ></canvas>
    <div v-if="baseline" class="sprite-canvas__baseline" data-testid="sprite-baseline">
      <span>baseline · feet</span>
    </div>
  </div>
</template>

<style scoped>
.sprite-canvas {
  position: relative;
  display: grid;
  justify-items: center;
}
.sprite-canvas__pixels {
  display: block;
  cursor: crosshair;
  touch-action: none;
  image-rendering: pixelated;
}
.sprite-canvas__baseline {
  justify-self: stretch;
  margin: 0 calc(-1 * var(--space-5));
  border-top: 2px solid var(--warn);
  color: var(--warn);
  font: var(--text-2xs) var(--font-mono);
  text-align: right;
}
.sprite-canvas__baseline span {
  display: inline-block;
  padding-top: var(--space-1);
}
</style>
