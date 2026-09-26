<script setup lang="ts">
import { computed, ref, useTemplateRef } from "vue";
import UiIconButton from "../ui/UiIconButton.vue";
import type { Tick } from "./studioView.ts";

/**
 * The draw-order scrubber: one tick per picture command in its drawing
 * colour (state lines short, fills tall), a draggable playhead and step
 * buttons. The model is the number of commands drawn, 0..ticks.length.
 */
const { ticks, marked, command } = defineProps<{
  ticks: readonly Tick[];
  /** Timeline indices of the selected item's commands. */
  marked: readonly number[];
  /** Source text of the last drawn command, or "" before the first. */
  command: string;
}>();
const playhead = defineModel<number>({ required: true });

const HEIGHT: Record<Tick["kind"], number> = { state: 30, draw: 62, fill: 100 };
const total = computed(() => ticks.length);
const track = useTemplateRef("track");
const dragging = ref(false);
const valueText = computed(() =>
  playhead.value === 0
    ? `Nothing drawn, 0 of ${total.value}`
    : `Drawn up to #${playhead.value} of ${total.value}: ${command}`,
);

function seek(k: number): void {
  playhead.value = Math.min(total.value, Math.max(0, Math.round(k)));
}
function fromPointer(event: PointerEvent): void {
  const rect = track.value!.getBoundingClientRect();
  seek(((event.clientX - rect.left) / rect.width) * total.value);
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
const STEPS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowDown: -1,
  ArrowRight: 1,
  ArrowUp: 1,
  PageDown: -10,
  PageUp: 10,
};
function onKeydown(event: KeyboardEvent): void {
  const step = STEPS[event.key];
  if (step === undefined) return;
  event.preventDefault();
  seek(playhead.value + step);
}
</script>

<template>
  <section class="scrubber" aria-label="Draw order">
    <div class="scrubber__transport">
      <UiIconButton
        icon="skip-back"
        label="First command"
        shortcut="Home"
        size="sm"
        @click="seek(0)"
      />
      <UiIconButton
        icon="chevron-left"
        label="Step back"
        shortcut=","
        size="sm"
        @click="seek(playhead - 1)"
      />
      <UiIconButton
        icon="chevron-right"
        label="Step forward"
        shortcut="."
        size="sm"
        @click="seek(playhead + 1)"
      />
      <UiIconButton
        icon="skip-forward"
        label="Last command"
        shortcut="End"
        size="sm"
        @click="seek(total)"
      />
    </div>
    <div
      ref="track"
      class="scrubber__track"
      :class="{ 'is-dragging': dragging }"
      role="slider"
      tabindex="0"
      aria-label="Draw order playhead"
      aria-valuemin="0"
      :aria-valuemax="total"
      :aria-valuenow="playhead"
      :aria-valuetext="valueText"
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
          v-for="(tick, k) in ticks"
          :key="k"
          class="scrubber__tick"
          :class="{
            'is-after': k >= playhead,
            'is-neutral': tick.colour === null,
            'is-black': tick.colour === 0,
          }"
          :x="k + 0.12"
          :y="100 - HEIGHT[tick.kind]"
          width="0.76"
          :height="HEIGHT[tick.kind]"
          :style="tick.colour === null ? undefined : { fill: `var(--agi-${tick.colour})` }"
        />
      </svg>
      <svg
        class="scrubber__marks"
        :viewBox="`0 0 ${Math.max(total, 1)} 1`"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect v-for="k in marked" :key="k" :x="k" y="0" width="1" height="1" />
      </svg>
      <div
        class="scrubber__playhead"
        :style="{ left: `${(playhead / Math.max(total, 1)) * 100}%` }"
      ></div>
    </div>
    <p class="scrubber__label" aria-live="off">
      <template v-if="playhead === 0">Nothing drawn · <b>0</b> of {{ total }}</template>
      <template v-else>
        Drawn up to <b>#{{ playhead }}</b> of {{ total }}<br /><b class="scrubber__command">{{
          command
        }}</b>
      </template>
    </p>
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
.scrubber__marks {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 3px;
}
.scrubber__marks rect {
  fill: var(--action);
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
.scrubber__label b {
  color: var(--ink);
  font-weight: var(--weight-semibold);
}
.scrubber__command {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
</style>
