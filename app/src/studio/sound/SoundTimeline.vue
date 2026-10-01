<script setup lang="ts">
import { computed, ref } from "vue";
import type { SoundDocument, SoundEvent } from "../../../../src/sound/document.ts";
import { eventOnset, LANE_NAMES, describeEvent } from "./soundEdits.ts";

/**
 * The four native lanes: tone voices 0-2 and the noise voice 3. Event blocks
 * are positioned by onset and duration ticks; the tick ruler stays the source
 * of truth (a musical grid is only an editing aid and deliberately not drawn).
 */
const props = defineProps<{
  document: SoundDocument | null;
  /** Selected event id, or null. */
  selectedId: string | null;
  /** Keyboard cursor: lane + insertion index. */
  cursorLane: number;
  cursorIndex: number;
  /** Audition playhead in ticks, or null when not running. */
  positionTicks: number | null;
  /** Per-lane presentation mute; never a document change. */
  laneMuted: readonly boolean[];
  laneSolo: number | null;
  /** Lane audition support from the service: "four", "single", "unsupported". */
  laneControls: string | null;
}>();

const emit = defineEmits<{
  select: [id: string, lane: number, index: number];
  cursor: [lane: number, index: number];
  laneMute: [lane: number, muted: boolean];
  laneSolo: [lane: number | null];
}>();

/** Pixels per tick; zoom only reshapes the view, never the document. */
const zoom = ref(4);
const MAX_TICKS_PAD = 120;

const lanes = computed<readonly (readonly SoundEvent[])[]>(() => {
  return props.document?.tracks() ?? [[], [], [], []];
});

const extent = computed(() => {
  const authored = props.document?.extentTicks() ?? 0;
  return Math.max(authored, 1) + MAX_TICKS_PAD;
});

function zoomBy(factor: number): void {
  zoom.value = Math.max(0.25, Math.min(32, zoom.value * factor));
}

function onset(lane: number, index: number): number {
  return eventOnset(lanes.value[lane]!, index);
}

function eventStyle(lane: number, event: SoundEvent) {
  const muted = props.laneSolo !== null ? props.laneSolo !== lane : props.laneMuted[lane] === true;
  return {
    left: `${(onset(lane, lanes.value[lane]!.indexOf(event)) * zoom.value).toFixed(1)}px`,
    width: `${Math.max(2, event.durationTicks * zoom.value).toFixed(1)}px`,
    opacity: muted ? 0.35 : 1,
  };
}

function eventClass(event: SoundEvent): string {
  return `sound-event sound-event--${event.data.kind}`;
}

function clickTrack(lane: number, event: MouseEvent): void {
  const el = event.currentTarget as HTMLElement;
  el.focus();
  const rect = el.getBoundingClientRect();
  const tick = Math.max(0, (event.clientX - rect.left + el.scrollLeft) / zoom.value);
  // Walk to the insertion index at that tick.
  const track = lanes.value[lane]!;
  let onsetTick = 0;
  let index = track.length;
  for (let i = 0; i < track.length; i++) {
    if (tick < onsetTick + track[i]!.durationTicks) {
      index = i;
      break;
    }
    onsetTick += track[i]!.durationTicks;
  }
  emit("cursor", lane, index);
}

defineExpose({ zoomBy });
</script>

<template>
  <div class="sound-timeline" data-testid="sound-timeline">
    <div class="sound-timeline__scroll">
      <div class="sound-timeline__inner" :style="{ width: `${extent * zoom}px` }">
        <div
          v-for="(lane, laneIndex) in lanes"
          :key="laneIndex"
          class="sound-lane"
          :class="{ 'sound-lane--cursor': laneIndex === cursorLane }"
          :data-testid="`sound-lane-${laneIndex}`"
        >
          <div class="sound-lane__head">
            <span class="sound-lane__name">{{ LANE_NAMES[laneIndex] }}</span>
            <template v-if="laneControls === 'four'">
              <button
                type="button"
                class="sound-lane__gate"
                :class="{ 'sound-lane__gate--on': laneMuted[laneIndex] }"
                :aria-pressed="laneMuted[laneIndex]"
                :aria-label="`Mute ${LANE_NAMES[laneIndex]} in preview`"
                :title="`Mute ${LANE_NAMES[laneIndex]} in preview`"
                :data-testid="`sound-mute-${laneIndex}`"
                @click="emit('laneMute', laneIndex, !laneMuted[laneIndex])"
              >
                M
              </button>
              <button
                type="button"
                class="sound-lane__gate"
                :class="{ 'sound-lane__gate--on': laneSolo === laneIndex }"
                :aria-pressed="laneSolo === laneIndex"
                :aria-label="`Solo ${LANE_NAMES[laneIndex]} in preview`"
                :title="`Solo ${LANE_NAMES[laneIndex]} in preview`"
                :data-testid="`sound-solo-${laneIndex}`"
                @click="emit('laneSolo', laneSolo === laneIndex ? null : laneIndex)"
              >
                S
              </button>
            </template>
          </div>
          <div
            class="sound-lane__track"
            role="group"
            :aria-label="`${LANE_NAMES[laneIndex]} timeline`"
            tabindex="0"
            :data-testid="`sound-lane-track-${laneIndex}`"
            @click="clickTrack(laneIndex, $event)"
          >
            <button
              v-for="(event, index) in lane"
              :key="event.id"
              type="button"
              :class="[eventClass(event), { 'sound-event--selected': event.id === selectedId }]"
              :style="eventStyle(laneIndex, event)"
              :title="describeEvent(event)"
              :aria-label="`${LANE_NAMES[laneIndex]} event ${index + 1}: ${describeEvent(event)}`"
              :data-testid="`sound-event-${event.id}`"
              @click.stop="emit('select', event.id, laneIndex, index)"
            ></button>
            <span
              v-if="laneIndex === cursorLane"
              class="sound-lane__cursor"
              :style="{ left: `${(onset(laneIndex, cursorIndex) * zoom).toFixed(1)}px` }"
              aria-hidden="true"
            ></span>
            <span
              v-if="positionTicks !== null"
              class="sound-lane__playhead"
              :style="{ left: `${(positionTicks * zoom).toFixed(1)}px` }"
              aria-hidden="true"
            ></span>
          </div>
        </div>
      </div>
    </div>
    <p class="sound-timeline__zoom">
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        data-testid="sound-zoom-out"
        @click="zoomBy(0.5)"
      >
        −
      </button>
      <span>{{ Math.round(zoom * 25) }}%</span>
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        data-testid="sound-zoom-in"
        @click="zoomBy(2)"
      >
        +
      </button>
    </p>
  </div>
</template>

<style scoped>
.sound-timeline {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  border-bottom: 1px solid var(--hairline-strong);
  background: var(--surface-0);
}
.sound-timeline__scroll {
  flex: 1;
  overflow: auto;
  min-height: 0;
}
.sound-timeline__inner {
  min-width: 100%;
  padding: var(--space-2) 0;
}
.sound-lane {
  display: flex;
  align-items: stretch;
  min-height: 44px;
}
.sound-lane__head {
  position: sticky;
  left: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 120px;
  flex: none;
  padding: 0 var(--space-2);
  border-right: 1px solid var(--hairline-strong);
  background: var(--surface-1);
}
.sound-lane__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-2);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
}
.sound-lane__gate {
  width: 24px;
  height: 24px;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--ink-3);
  background: transparent;
  font: var(--weight-semibold) var(--text-2xs) / 1 var(--font-sans);
  cursor: pointer;
}
.sound-lane__gate--on {
  color: var(--surface-0);
  background: var(--action);
  border-color: var(--action);
}
.sound-lane__track {
  position: relative;
  flex: 1;
  min-height: 44px;
}
.sound-lane__track:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.sound-lane--cursor .sound-lane__track {
  background: color-mix(in srgb, var(--action) 4%, transparent);
}
.sound-lane__cursor {
  position: absolute;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: var(--action);
}
.sound-lane__playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--warn);
}
.sound-event {
  position: absolute;
  top: 7px;
  height: 30px;
  box-sizing: border-box;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  padding: 0;
  cursor: pointer;
}
.sound-event--tone {
  background: color-mix(in srgb, var(--action) 22%, var(--surface-1));
}
.sound-event--noise {
  background: color-mix(in srgb, var(--warn) 28%, var(--surface-1));
}
.sound-event--rest {
  background: repeating-linear-gradient(
    135deg,
    var(--surface-1),
    var(--surface-1) 4px,
    var(--surface-sunken) 4px,
    var(--surface-sunken) 8px
  );
}
.sound-event--raw {
  background: repeating-linear-gradient(
    45deg,
    var(--surface-1),
    var(--surface-1) 3px,
    color-mix(in srgb, var(--danger) 18%, var(--surface-1)) 3px,
    color-mix(in srgb, var(--danger) 18%, var(--surface-1)) 6px
  );
}
.sound-event--selected {
  outline: 2px solid var(--action);
  outline-offset: 1px;
}
.sound-event:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.sound-timeline__zoom {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-1) var(--space-3);
  color: var(--ink-3);
  font: var(--text-2xs) / var(--leading) var(--font-sans);
}
.sound-timeline__zoom button {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  background: var(--surface-1);
  cursor: pointer;
}
</style>
