<script setup lang="ts">
import { computed, ref, useTemplateRef } from "vue";
import UiIconButton from "../ui/UiIconButton.vue";
import type { DrawStop } from "./useStudioReadout.ts";

/**
 * The draw-order transport: one stop per shape (its state lines fold into
 * it), a draggable marker that lands on stops, and step buttons that move
 * shape to shape. The model is still the number of steps drawn, 0..total,
 * so the inspector's command list can stand the playhead inside a stop.
 * Beside the track the position reads "Drawing before Cottage".
 */
const { stops, total, marked, position } = defineProps<{
  /** The shapes in draw order. */
  stops: readonly DrawStop[];
  /** Total drawing steps (commands); the playhead counts them. */
  total: number;
  /** Row ids of the selected items: their stops light up. */
  marked: readonly string[];
  /** Where new shapes draw: "Drawing before Cottage". */
  position: string;
}>();
const playhead = defineModel<number>({ required: true });

/** Where the marker may land: each stop's first step, then the end. */
const places = computed(() => [...stops.map((stop) => stop.index), total]);
const track = useTemplateRef("track");
const dragging = ref(false);

function clamp(k: number): number {
  return Math.min(total, Math.max(0, Math.round(k)));
}
/** The stop boundary nearest `k`. */
function snap(k: number): number {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (const place of places.value) {
    const gap = Math.abs(place - k);
    if (gap < distance) {
      distance = gap;
      best = place;
    }
  }
  return best;
}
/** The boundary just before `k` (or the first). */
function back(k: number): number {
  return places.value.reduce((last, place) => (place < k ? place : last), 0);
}
/** The boundary just past `k` (or the end). */
function ahead(k: number): number {
  return places.value.find((place) => place > k) ?? total;
}

function seek(k: number): void {
  playhead.value = snap(clamp(k));
}
function fromPointer(event: PointerEvent): void {
  const rect = track.value!.getBoundingClientRect();
  seek(((event.clientX - rect.left) / rect.width) * total);
}
function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  dragging.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  fromPointer(event);
}
function onPointerMove(event: PointerEvent): void {
  if (dragging.value) fromPointer(event);
}
function onPointerUp(event: PointerEvent): void {
  dragging.value = false;
  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
}
const KEYS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowDown: -1,
  ArrowRight: 1,
  ArrowUp: 1,
  PageDown: -5,
  PageUp: 5,
};
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Home") {
    event.preventDefault();
    playhead.value = 0;
    return;
  }
  if (event.key === "End") {
    event.preventDefault();
    playhead.value = total;
    return;
  }
  const step = KEYS[event.key];
  if (step === undefined) return;
  event.preventDefault();
  let k = playhead.value;
  for (let i = 0; i < Math.abs(step); i++) k = step > 0 ? ahead(k) : back(k);
  playhead.value = k;
}
</script>

<template>
  <section class="scrubber" aria-label="Draw order">
    <div class="scrubber__transport">
      <UiIconButton icon="skip-back" label="First" size="sm" @click="playhead = 0" />
      <UiIconButton
        icon="chevron-left"
        label="Earlier shape"
        size="sm"
        @click="playhead = back(playhead)"
      />
      <UiIconButton
        icon="chevron-right"
        label="Later shape"
        size="sm"
        @click="playhead = ahead(playhead)"
      />
      <UiIconButton
        icon="skip-forward"
        label="Back to the end"
        size="sm"
        @click="playhead = total"
      />
    </div>
    <div
      ref="track"
      class="scrubber__track"
      :class="{ 'is-dragging': dragging }"
      role="slider"
      tabindex="0"
      aria-label="Draw order"
      aria-valuemin="0"
      :aria-valuemax="total"
      :aria-valuenow="playhead"
      :aria-valuetext="position"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onKeydown"
    >
      <svg
        class="scrubber__ticks"
        :viewBox="`0 0 ${Math.max(total, 1)} 100`"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect
          v-for="stop in stops"
          :key="stop.index"
          class="scrubber__tick"
          :class="{
            'is-after': stop.index >= playhead,
            'is-neutral': stop.colour === null,
            'is-black': stop.colour === 0,
            'is-marked': marked.includes(stop.rowId),
            'is-fill': stop.fill,
          }"
          :x="stop.index + 0.1"
          :y="stop.fill ? 20 : 38"
          :width="Math.max(stop.end - stop.index - 0.2, 0.3)"
          :height="stop.fill ? 80 : 62"
          :style="stop.colour === null ? undefined : { fill: `var(--agi-${stop.colour})` }"
        >
          <title>{{ stop.label }}</title>
        </rect>
      </svg>
      <div
        class="scrubber__playhead"
        :style="{ left: `${(playhead / Math.max(total, 1)) * 100}%` }"
      ></div>
    </div>
    <div class="scrubber__label" aria-live="off">
      <span class="scrubber__position" data-testid="scrubber-position">{{ position }}</span>
    </div>
  </section>
</template>

<style scoped>
.scrubber {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 220px;
  align-items: center;
  gap: var(--space-4);
  height: 100%;
  padding: var(--space-3) var(--space-5);
  border-top: 1px solid var(--hairline);
  background: var(--surface-1);
  box-sizing: border-box;
}
.scrubber__transport {
  display: flex;
  gap: var(--space-0);
}
.scrubber__track {
  position: relative;
  height: 48px;
  cursor: ew-resize;
  touch-action: none;
  outline: 0;
  border-radius: var(--radius-sm);
}
.scrubber__track:focus-visible {
  box-shadow: 0 0 0 2px var(--focus);
}
.scrubber__ticks {
  position: absolute;
  inset: 0 0 6px;
  width: 100%;
  height: calc(100% - 6px);
}
.scrubber__tick {
  opacity: 0.9;
}
.scrubber__tick.is-neutral {
  fill: var(--hairline-strong);
}
.scrubber__tick.is-black {
  stroke: var(--hairline-strong);
  stroke-width: 1px;
  vector-effect: non-scaling-stroke;
}
.scrubber__tick.is-after {
  opacity: 0.2;
}
.scrubber__tick.is-marked {
  stroke: var(--action);
  stroke-width: 1px;
  vector-effect: non-scaling-stroke;
}
.scrubber__tick.is-marked.is-after {
  opacity: 0.5;
}
.scrubber__playhead {
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 2px;
  margin-left: -1px;
  border-radius: var(--radius-sm);
  background: var(--action);
  pointer-events: none;
}
.scrubber__playhead::before {
  content: "";
  position: absolute;
  top: -3px;
  left: -4px;
  width: 10px;
  height: 10px;
  border-radius: var(--radius-sm);
  background: var(--action);
}
.scrubber__label {
  margin: 0;
  overflow: hidden;
  color: var(--ink-2);
  font: var(--text-2xs) / var(--leading) var(--font-mono);
  text-align: right;
}
.scrubber__position {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
</style>
