<script setup lang="ts">
import { computed, ref, useTemplateRef } from "vue";
import type { RoomPlacement } from "../../../src/authoring/roomPlacements.ts";
import type { GhostView } from "./useGhostProbe.ts";
import type { Viewport } from "../../../src/studio/viewport.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import { selectViewCel, forEachPaintedPixel } from "../../../src/view/view.ts";
import { probeActor } from "../../../src/studio/probe.ts";
import { maskFillPath } from "./studioView.ts";

const {
  figures,
  views,
  viewport,
  opacity,
  picture,
  profile,
  priorityBase = undefined,
  readOnly,
} = defineProps<{
  figures: readonly RoomPlacement[];
  views: readonly GhostView[];
  viewport: Viewport;
  opacity: number;
  picture: { visual: Uint8Array; priority: Uint8Array };
  profile: AgiProfile;
  priorityBase?: number | undefined;
  readOnly: boolean;
}>();
const emit = defineEmits<{ place: [figure: RoomPlacement, x: number, y: number] }>();
const root = useTemplateRef("root");
const dragging = ref<{
  figure: RoomPlacement;
  x: number;
  y: number;
  dx: number;
  dy: number;
  pointer: number;
}>();
const drawn = computed(() =>
  figures.flatMap((figure) => {
    const entry = views.find((v) => v.number === figure.view);
    const cel =
      entry && figure.loop !== null && figure.cel !== null
        ? selectViewCel(entry.view, figure.loop, figure.cel)
        : undefined;
    if (!cel || figure.x === null || figure.y === null) return [];
    const grab = dragging.value?.figure.object === figure.object ? dragging.value : null;
    const x = grab?.x ?? figure.x;
    const y = grab?.y ?? figure.y;
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
  if (event.button !== 0 || figure.reason || readOnly || figure.x === null || figure.y === null)
    return;
  const at = point(event);
  dragging.value = {
    figure,
    x: figure.x,
    y: figure.y,
    dx: at.x - figure.x,
    dy: at.y - figure.y,
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
function up(event: PointerEvent): void {
  const grab = dragging.value;
  if (!grab || event.pointerId !== grab.pointer) return;
  move(event);
  dragging.value = undefined;
  if (grab.x !== grab.figure.x || grab.y !== grab.figure.y)
    emit("place", grab.figure, grab.x, grab.y);
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
  if (!step || !row || figure.reason || readOnly) return;
  event.preventDefault();
  emit(
    "place",
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
      :class="{ 'is-locked': !!row.figure.reason }"
      :style="row.style"
      role="button"
      tabindex="0"
      :aria-label="row.label"
      :aria-disabled="!!row.figure.reason || readOnly"
      :data-object="row.figure.object"
      :data-x="row.x"
      :data-y="row.y"
      :title="row.label"
      @pointerdown="down($event, row.figure)"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="cancel"
      @lostpointercapture="cancel"
      @keydown="nudge($event, row.figure)"
    >
      <span :style="row.x > 80 ? { left: 'auto', right: 0 } : {}">{{ row.label }}</span>
    </div>
    <div
      v-if="
        figures.some(
          (f) =>
            f.x === null || f.y === null || f.view === null || f.loop === null || f.cel === null,
        )
      "
      class="room-views__unknown"
    >
      <span
        v-for="figure in figures.filter(
          (f) =>
            f.x === null || f.y === null || f.view === null || f.loop === null || f.cel === null,
        )"
        :key="figure.object"
        >o{{ figure.object }} · {{ figure.reason ?? "Position is chosen at run time" }}</span
      >
    </div>
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
  border: 1px solid var(--action);
  box-sizing: border-box;
}
.room-views__figure.is-locked {
  border-style: dashed;
  cursor: help;
}
.room-views__figure:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.room-views__figure > span {
  position: absolute;
  bottom: 100%;
  left: 0;
  padding: 2px 4px;
  background: var(--surface-overlay);
  color: var(--ink);
  font-size: var(--text-2xs);
  white-space: nowrap;
}
.room-views__unknown {
  position: absolute;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  color: var(--ink);
  background: var(--surface-overlay);
  font-size: var(--text-xs);
  padding: var(--space-2);
}
</style>
