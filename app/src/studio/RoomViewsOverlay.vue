<script setup lang="ts">
import { computed, ref, useTemplateRef } from "vue";
import type { RoomPlacement } from "../../../src/authoring/roomPlacements.ts";
import type { GhostView } from "./useGhostProbe.ts";
import type { Viewport } from "../../../src/studio/viewport.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import { selectViewCel, forEachPaintedPixel } from "../../../src/view/view.ts";
import { probeActor } from "../../../src/studio/probe.ts";
import { maskFillPath } from "./studioView.ts";

/**
 * The room's figures, drawn exactly as the game draws them (priority, no
 * boxes, no hover marks). A figure whose spot is a fixed number drags to edit
 * that line; one whose spot is computed drags a preview only (the panel
 * offers Reset and Copy position). A conditional figure shows its first
 * spot, and one with no known spot starts as a preview near the middle of
 * the floor, so every figure draws and drags.
 */
const {
  figures,
  views,
  viewport,
  opacity,
  picture,
  profile,
  priorityBase = undefined,
  previews = {},
  readOnly,
} = defineProps<{
  figures: readonly RoomPlacement[];
  views: readonly GhostView[];
  viewport: Viewport;
  opacity: number;
  picture: { visual: Uint8Array; priority: Uint8Array };
  profile: AgiProfile;
  priorityBase?: number | undefined;
  /** Previewed spots for computed or conditional placements, by object. */
  previews?: Readonly<Record<number, { x: number; y: number }>>;
  readOnly: boolean;
}>();
const emit = defineEmits<{
  place: [figure: RoomPlacement, x: number, y: number];
  preview: [figure: RoomPlacement, x: number, y: number];
}>();
const root = useTemplateRef("root");
const dragging = ref<{
  figure: RoomPlacement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  pointer: number;
}>();
/** Where a figure stands: the live drag, then the panel's preview, then its line. */
const spotOf = (figure: RoomPlacement) => previews[figure.object] ?? null;
/** A fixed figure's line holds plain numbers: dragging it edits that line. */
const fixed = (figure: RoomPlacement): boolean =>
  figure.reason === null && figure.x !== null && figure.y !== null;
/** Where a figure with no known spot starts: centred, standing low on the picture. */
const START_Y = 130;
function startSpot(width: number): { x: number; y: number } {
  return { x: Math.max(0, Math.round((160 - width) / 2)), y: START_Y };
}
const drawn = computed(() =>
  figures.flatMap((figure) => {
    const entry = views.find((v) => v.number === figure.view);
    const cel =
      entry && figure.loop !== null && figure.cel !== null
        ? selectViewCel(entry.view, figure.loop, figure.cel)
        : undefined;
    if (!cel) return [];
    const known =
      figure.x === null || figure.y === null ? figure.spots[0] : { x: figure.x, y: figure.y };
    const spot = spotOf(figure) ?? known ?? startSpot(cel.width);
    const grab = dragging.value?.figure.object === figure.object ? dragging.value : null;
    const x = grab?.x ?? spot.x;
    const y = grab?.y ?? Math.max(cel.height - 1, spot.y);
    const result = probeActor({
      picture,
      cel,
      x,
      baselineY: y,
      priority: "band",
      profile,
      priorityBase,
    });
    const masks: Record<number, Uint8Array> = {};
    forEachPaintedPixel(picture, cel, x, y, result.drawPriority, (at, colour) => {
      (masks[colour] ??= new Uint8Array(160 * 168))[at] = 1;
    });
    const label = `o${figure.object} · VIEW ${figure.view} · ${figure.reason ?? `(${x}, ${y})`}`;
    return [
      {
        figure,
        cel,
        x,
        y,
        label,
        preview: spotOf(figure) !== null || !fixed(figure),
        paths: Object.entries(masks).map(([colour, mask]) => ({ colour, d: maskFillPath(mask) })),
        style: {
          left: `${x * viewport.pixelAspect * viewport.zoom}px`,
          top: `${(y - cel.height + 1) * viewport.zoom}px`,
          width: `${cel.width * viewport.pixelAspect * viewport.zoom}px`,
          height: `${cel.height * viewport.zoom}px`,
        },
      },
    ];
  }),
);
function point(event: PointerEvent) {
  const rect = root.value!.getBoundingClientRect();
  return {
    x: Math.floor((event.clientX - rect.left) / (viewport.pixelAspect * viewport.zoom)),
    y: Math.floor((event.clientY - rect.top) / viewport.zoom),
  };
}
function down(event: PointerEvent, figure: RoomPlacement): void {
  if (event.button !== 0 || readOnly) return;
  const spot = drawn.value.find((row) => row.figure.object === figure.object);
  if (!spot) return;
  const at = point(event);
  dragging.value = {
    figure,
    startX: spot.x,
    startY: spot.y,
    x: spot.x,
    y: spot.y,
    dx: at.x - spot.x,
    dy: at.y - spot.y,
    pointer: event.pointerId,
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}
function move(event: PointerEvent): void {
  const grab = dragging.value;
  if (!grab || event.pointerId !== grab.pointer) return;
  const at = point(event);
  const cel = drawn.value.find((d) => d.figure.object === grab.figure.object)!.cel;
  grab.x = Math.max(0, Math.min(160 - cel.width, at.x - grab.dx));
  grab.y = Math.max(cel.height - 1, Math.min(167, at.y - grab.dy));
}
/** A fixed line's drag edits the line; anything else moves the preview. */
function settle(figure: RoomPlacement, x: number, y: number): void {
  if (fixed(figure) && spotOf(figure) === null) emit("place", figure, x, y);
  else emit("preview", figure, x, y);
}
function up(event: PointerEvent): void {
  const grab = dragging.value;
  if (!grab || event.pointerId !== grab.pointer) return;
  move(event);
  dragging.value = undefined;
  if (grab.x === grab.startX && grab.y === grab.startY) return;
  settle(grab.figure, grab.x, grab.y);
}
function cancel(): void {
  dragging.value = undefined;
}
function nudge(event: KeyboardEvent, figure: RoomPlacement): void {
  const steps: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const step = steps[event.key];
  const row = drawn.value.find((d) => d.figure.object === figure.object);
  if (!step || !row || readOnly) return;
  event.preventDefault();
  settle(
    figure,
    Math.max(0, Math.min(160 - row.cel.width, row.x + step[0])),
    Math.max(row.cel.height - 1, Math.min(167, row.y + step[1])),
  );
}
</script>
<template>
  <div ref="root" class="room-views" data-testid="room-views" :style="{ opacity }">
    <svg viewBox="0 0 160 168" preserveAspectRatio="none" aria-hidden="true">
      <g v-for="row in drawn" :key="row.figure.object">
        <path
          v-for="path in row.paths"
          :key="path.colour"
          :d="path.d"
          :style="{ fill: `var(--agi-${path.colour})` }"
        />
      </g>
    </svg>
    <div
      v-for="row in drawn"
      :key="row.figure.object"
      class="room-views__figure"
      :class="{ 'is-preview': row.preview }"
      :style="row.style"
      role="button"
      tabindex="0"
      :aria-label="row.label"
      :aria-disabled="readOnly"
      :data-object="row.figure.object"
      :data-x="row.x"
      :data-y="row.y"
      :data-preview="row.preview || undefined"
      @pointerdown="down($event, row.figure)"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="cancel"
      @lostpointercapture="cancel"
      @keydown="nudge($event, row.figure)"
    ></div>
  </div>
</template>
<style scoped>
.room-views {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.room-views > svg {
  width: 100%;
  height: 100%;
}
.room-views__figure {
  position: absolute;
  pointer-events: auto;
  touch-action: none;
  cursor: grab;
}
/* The figure draws as in the game: only keyboard focus marks it. */
.room-views__figure:focus-visible {
  outline: 1px solid var(--focus);
  outline-offset: 1px;
}
</style>
