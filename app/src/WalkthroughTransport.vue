<script setup lang="ts">
import { onUnmounted, ref, useTemplateRef } from "vue";
import type { WalkthroughUiState } from "./useWalkthroughController.ts";
import type { WalkthroughCheckpoint } from "./walkthrough.ts";

const props = defineProps<{ walkthrough: WalkthroughUiState }>();
const emit = defineEmits<{
  togglePause: [];
  setSpeed: [speed: number];
  togglePauseOnDialog: [];
  seekTick: [tick: number];
  seekCheckpoint: [cp: WalkthroughCheckpoint];
  scrubbing: [active: boolean];
}>();

interface HoverInfo {
  percent: number;
  label: string;
  details?: string;
}

const timelineEl = useTemplateRef("timelineEl");
const hoverInfo = ref<HoverInfo>();
const isScrubbing = ref(false);
const scrubPercent = ref<number>();

function getTimelinePercent(clientX: number): number {
  const el = timelineEl.value;
  if (!el) return 0;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  return (x / rect.width) * 100;
}

function findNearbyCheckpoint(pct: number): WalkthroughCheckpoint | null {
  let closestCp: WalkthroughCheckpoint | null = null;
  let minDiff = Infinity;
  for (const cp of props.walkthrough.checkpoints) {
    const diff = Math.abs(cp.percent - pct);
    if (diff < minDiff && diff < 5) {
      minDiff = diff;
      closestCp = cp;
    }
  }
  return closestCp;
}

function updateHover(clientX: number): void {
  if (props.walkthrough.totalTicks <= 0) return;
  const pct = getTimelinePercent(clientX);
  const cp = findNearbyCheckpoint(pct);

  if (cp) {
    hoverInfo.value = {
      percent: cp.percent,
      label: cp.label,
      details: `Score: ${cp.score} · Room ${cp.room}`,
    };
  } else {
    hoverInfo.value = {
      percent: pct,
      label: `${Math.round(pct)}%`,
    };
  }
}

let hasDraggedDuringScrub = false;
let scrubRafId: number | null = null;
let pendingScrubTick: number | null = null;
let scrubBackwardTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleScrubSeek(tick: number): void {
  pendingScrubTick = tick;
  if (tick < props.walkthrough.tick) {
    if (scrubBackwardTimer !== null) clearTimeout(scrubBackwardTimer);
    scrubBackwardTimer = setTimeout(() => {
      scrubBackwardTimer = null;
      if (pendingScrubTick !== null) {
        const target = pendingScrubTick;
        pendingScrubTick = null;
        emit("seekTick", target);
      }
    }, 120);
  } else {
    if (scrubBackwardTimer !== null) {
      clearTimeout(scrubBackwardTimer);
      scrubBackwardTimer = null;
    }
    if (scrubRafId === null) {
      scrubRafId = requestAnimationFrame(() => {
        scrubRafId = null;
        if (pendingScrubTick !== null) {
          const target = pendingScrubTick;
          pendingScrubTick = null;
          emit("seekTick", target);
        }
      });
    }
  }
}

function onTimelinePointerDown(ev: PointerEvent): void {
  if (props.walkthrough.totalTicks <= 0) return;
  hasDraggedDuringScrub = false;
  isScrubbing.value = true;
  emit("scrubbing", true);
  if (scrubRafId !== null) {
    cancelAnimationFrame(scrubRafId);
    scrubRafId = null;
  }
  if (scrubBackwardTimer !== null) {
    clearTimeout(scrubBackwardTimer);
    scrubBackwardTimer = null;
  }
  pendingScrubTick = null;
  const pct = getTimelinePercent(ev.clientX);
  scrubPercent.value = pct;
  updateHover(ev.clientX);
  const targetTick = Math.round((pct / 100) * props.walkthrough.totalTicks);
  emit("seekTick", targetTick);

  window.addEventListener("pointermove", onTimelinePointerMove);
  window.addEventListener("pointerup", onTimelinePointerUp);
  window.addEventListener("pointercancel", onTimelinePointerUp);
}

function onTimelinePointerMove(ev: PointerEvent): void {
  if (isScrubbing.value) {
    hasDraggedDuringScrub = true;
    const pct = getTimelinePercent(ev.clientX);
    scrubPercent.value = pct;
    updateHover(ev.clientX);
    const targetTick = Math.round((pct / 100) * props.walkthrough.totalTicks);
    scheduleScrubSeek(targetTick);
  }
}

function onTimelineHover(ev: PointerEvent): void {
  if (!isScrubbing.value) {
    updateHover(ev.clientX);
  }
}

function onTimelinePointerUp(ev: PointerEvent): void {
  window.removeEventListener("pointermove", onTimelinePointerMove);
  window.removeEventListener("pointerup", onTimelinePointerUp);
  window.removeEventListener("pointercancel", onTimelinePointerUp);

  if (scrubRafId !== null) {
    cancelAnimationFrame(scrubRafId);
    scrubRafId = null;
  }
  if (scrubBackwardTimer !== null) {
    clearTimeout(scrubBackwardTimer);
    scrubBackwardTimer = null;
  }
  pendingScrubTick = null;

  if (isScrubbing.value) {
    const finalPct = scrubPercent.value ?? getTimelinePercent(ev.clientX);
    isScrubbing.value = false;
    emit("scrubbing", false);
    scrubPercent.value = undefined;
    if (hasDraggedDuringScrub) {
      const targetTick = Math.round((finalPct / 100) * props.walkthrough.totalTicks);
      emit("seekTick", targetTick);
    }
  }
}

function onTimelinePointerLeave(): void {
  if (!isScrubbing.value) {
    hoverInfo.value = undefined;
  }
}

function onTimelineKeydown(ev: KeyboardEvent): void {
  if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
    ev.preventDefault();
    const delta = ev.key === "ArrowRight" ? 0.05 : -0.05;
    const currentPct = scrubPercent.value ?? props.walkthrough.percent;
    const newPct = Math.max(0, Math.min(100, currentPct + delta * 100));
    const targetTick = Math.round((newPct / 100) * props.walkthrough.totalTicks);
    emit("seekTick", targetTick);
  }
}

function onMarkerClick(cp: WalkthroughCheckpoint): void {
  if (hasDraggedDuringScrub) return;
  hoverInfo.value = undefined;
  emit("seekCheckpoint", cp);
}

onUnmounted(() => {
  window.removeEventListener("pointermove", onTimelinePointerMove);
  window.removeEventListener("pointerup", onTimelinePointerUp);
  window.removeEventListener("pointercancel", onTimelinePointerUp);
  if (scrubRafId !== null) cancelAnimationFrame(scrubRafId);
  if (scrubBackwardTimer !== null) clearTimeout(scrubBackwardTimer);
});
</script>

<template>
  <!-- Walkthrough Transport Bar (Directly below the CRT screen) -->
  <div class="walkthrough-transport" data-testid="walkthrough-transport">
    <button
      type="button"
      class="walkthrough-transport-play-btn"
      data-testid="btn-walkthrough-pause"
      :title="
        walkthrough.status === 'paused'
          ? 'Play (Space)'
          : walkthrough.status === 'completed'
            ? 'Replay from start'
            : 'Pause (Space)'
      "
      :aria-label="
        walkthrough.status === 'paused'
          ? 'Play'
          : walkthrough.status === 'completed'
            ? 'Replay'
            : 'Pause'
      "
      @click="emit('togglePause')"
    >
      <svg
        v-if="walkthrough.status === 'paused'"
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M8 5v14l11-7z" />
      </svg>
      <svg
        v-else-if="walkthrough.status === 'completed'"
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"
        />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
      </svg>
    </button>

    <!-- Scrubbable Timeline Track -->
    <div
      ref="timelineEl"
      class="walkthrough-timeline"
      data-testid="walkthrough-timeline"
      role="slider"
      tabindex="0"
      aria-label="Walkthrough timeline"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="Math.round(scrubPercent ?? walkthrough.percent)"
      @pointerdown="onTimelinePointerDown"
      @pointermove="onTimelineHover"
      @pointerleave="onTimelinePointerLeave"
      @keydown="onTimelineKeydown"
    >
      <div class="walkthrough-track">
        <!-- Progress Fill -->
        <div
          class="walkthrough-progress-fill"
          data-testid="walkthrough-progress-fill"
          :style="{ width: `${scrubPercent ?? walkthrough.percent}%` }"
        ></div>

        <!-- Chapter Marker Notches -->
        <button
          v-for="cp in walkthrough.checkpoints"
          :key="cp.index"
          type="button"
          class="walkthrough-marker"
          :class="{
            'walkthrough-marker--passed': (scrubPercent ?? walkthrough.percent) >= cp.percent,
          }"
          :style="{ left: `${cp.percent}%` }"
          :data-testid="`walkthrough-marker-${cp.index}`"
          :title="`${cp.label} (Score: ${cp.score} · Room ${cp.room})`"
          @click.stop="onMarkerClick(cp)"
        ></button>

        <!-- Thumb / Scrubber Handle -->
        <div
          class="walkthrough-thumb"
          data-testid="walkthrough-thumb"
          :style="{ left: `${scrubPercent ?? walkthrough.percent}%` }"
        ></div>
      </div>

      <!-- Hover / Scrub Tooltip -->
      <div v-if="hoverInfo" class="walkthrough-tooltip" :style="{ left: `${hoverInfo.percent}%` }">
        <span class="walkthrough-tooltip-label">{{ hoverInfo.label }}</span>
        <span v-if="hoverInfo.details" class="walkthrough-tooltip-details">{{
          hoverInfo.details
        }}</span>
      </div>
    </div>

    <!-- Playback Speed Controls -->
    <div class="walkthrough-speed-group" role="group" aria-label="Playback speed">
      <button
        v-for="s in [1, 2, 4, 8]"
        :key="s"
        type="button"
        class="ui-button ui-button--secondary walkthrough-speed-btn"
        :class="{ 'walkthrough-speed-btn--active': walkthrough.speed === s }"
        :data-testid="`walkthrough-speed-${s}`"
        :title="`Set playback speed to ${s}×`"
        @click="emit('setSpeed', s)"
      >
        {{ s }}×
      </button>
    </div>

    <!-- Auto-pause on story dialogue toggle -->
    <button
      type="button"
      class="ui-button ui-button--secondary walkthrough-speed-btn walkthrough-dialog-pause-btn"
      :class="{ 'walkthrough-speed-btn--active': walkthrough.pauseOnDialog }"
      data-testid="btn-walkthrough-pause-on-dialog"
      :title="
        walkthrough.pauseOnDialog
          ? 'Story pause: enabled (pauses on dialogue)'
          : 'Story pause: disabled (auto-advances with reading dwell)'
      "
      :aria-label="
        walkthrough.pauseOnDialog ? 'Disable pause on dialogue' : 'Enable pause on dialogue'
      "
      @click="emit('togglePauseOnDialog')"
    >
      <svg
        viewBox="0 0 24 24"
        width="13"
        height="13"
        fill="currentColor"
        aria-hidden="true"
        class="walkthrough-dialog-pause-icon"
      >
        <path
          d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"
        />
      </svg>
      Story pause
    </button>
  </div>
</template>

<style scoped>
.walkthrough-speed-group {
  display: inline-flex;
  gap: 4px;
}
.walkthrough-speed-btn {
  padding: 2px 8px;
  font-size: 12px;
  min-height: 24px;
  line-height: 1;
}
.walkthrough-speed-btn--active {
  background: #1a5259;
  border-color: #5ce1e6;
  color: #ffffff;
  font-weight: 600;
}
.walkthrough-dialog-pause-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.walkthrough-dialog-pause-icon {
  flex-shrink: 0;
}
.walkthrough-transport {
  display: flex;
  align-items: center;
  gap: 12px;
  width: var(--game-width);
  box-sizing: border-box;
  margin-top: -6px;
  padding: 6px 12px;
  background: #0b171b;
  border: 1px solid #1a5259;
  border-radius: 8px;
  user-select: none;
}
.walkthrough-transport-play-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid #2e717b;
  border-radius: 6px;
  background: #163b42;
  color: #5ce1e6;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background-color 0.15s,
    border-color 0.15s,
    color 0.15s,
    transform 0.1s;
}
.walkthrough-transport-play-btn:hover {
  background: #1c4d56;
  border-color: #5ce1e6;
  color: #ffffff;
}
.walkthrough-transport-play-btn:active {
  transform: scale(0.95);
}
.walkthrough-timeline {
  position: relative;
  flex: 1;
  height: 26px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
  outline: none;
}
.walkthrough-timeline:focus-visible .walkthrough-track {
  box-shadow: 0 0 0 2px #5ce1e6;
}
.walkthrough-track {
  position: relative;
  width: 100%;
  height: 6px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  transition: height 0.15s ease;
}
.walkthrough-timeline:hover .walkthrough-track {
  height: 8px;
}
.walkthrough-progress-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: linear-gradient(90deg, #1fa2a6, #5ce1e6);
  border-radius: 3px;
  pointer-events: none;
}
.walkthrough-marker {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 4px;
  height: 10px;
  padding: 0;
  border: 1px solid #0b171b;
  border-radius: 1px;
  background: #ffd700;
  z-index: 2;
  cursor: pointer;
  transition:
    transform 0.15s ease,
    background-color 0.15s ease;
}
.walkthrough-marker:hover {
  transform: translate(-50%, -50%) scale(1.6);
  background: #ffffff;
  z-index: 4;
}
.walkthrough-marker--passed {
  background: #fff080;
}
.walkthrough-thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #5ce1e6;
  box-shadow: 0 0 6px rgba(92, 225, 230, 0.7);
  z-index: 3;
  pointer-events: none;
  transition: transform 0.1s ease;
}
.walkthrough-timeline:hover .walkthrough-thumb {
  transform: translate(-50%, -50%) scale(1.2);
}
.walkthrough-tooltip {
  position: absolute;
  bottom: calc(100% + 6px);
  transform: translateX(-50%);
  background: #0f2428;
  border: 1px solid #2e717b;
  border-radius: 6px;
  padding: 3px 8px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 10;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
}
.walkthrough-tooltip-label {
  font-size: 11px;
  font-weight: 600;
  color: #ffffff;
}
.walkthrough-tooltip-details {
  font-size: 10px;
  color: #9fe6a0;
  font-family: var(--font-mono, monospace);
}
</style>
