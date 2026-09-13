<script setup lang="ts">
/**
 * The history transport: while the live session is parked, this bar scrubs
 * and watches its recording. The timeline runs over the viewed segment's
 * recorded ticks; gold notches are room entries the tape marked, other
 * notches mark restarts, remixes, answered prompts and placed bookmarks.
 * Resume here adopts the viewed moment as the live session; Back to before
 * returns to the retained original it swapped away from.
 */
import { computed, onUnmounted, ref, useTemplateRef } from "vue";
import { useEngineApi } from "./engineContext.ts";
import type { HistoryViewMark } from "./useHistoryView.ts";

const engine = useEngineApi();
const { state, historyView } = engine;
const view = computed(() => state.historyView);

const timelineEl = useTemplateRef("timelineEl");
const hoverInfo = ref<{ percent: number; label: string; details?: string }>();
const isScrubbing = ref(false);
const scrubPercent = ref<number>();

const percent = computed(() =>
  view.value.totalTicks > 0 ? (view.value.tick / view.value.totalTicks) * 100 : 0,
);

/** The viewed segment's notches — marks on other segments stay off the lane. */
const marks = computed(() =>
  view.value.marks
    .filter((m) => m.segment === view.value.segment)
    .map((m) => ({
      ...m,
      percent: view.value.totalTicks > 0 ? (m.tick / view.value.totalTicks) * 100 : 0,
    })),
);

function getTimelinePercent(clientX: number): number {
  const el = timelineEl.value;
  if (!el) return 0;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  return (x / rect.width) * 100;
}

function tickAtPercent(pct: number): number {
  return Math.round((pct / 100) * view.value.totalTicks);
}

function markAtPercent(pct: number): (HistoryViewMark & { percent: number }) | null {
  let best: (HistoryViewMark & { percent: number }) | null = null;
  let bestDiff = Infinity;
  for (const m of marks.value) {
    const diff = Math.abs(m.percent - pct);
    if (diff < bestDiff && diff < 4) {
      bestDiff = diff;
      best = m;
    }
  }
  return best;
}

function updateHover(clientX: number): void {
  if (view.value.totalTicks <= 0) return;
  const pct = getTimelinePercent(clientX);
  const mark = markAtPercent(pct);
  hoverInfo.value = mark
    ? { percent: mark.percent, label: mark.label }
    : { percent: pct, label: `${Math.round(pct)}%` };
}

// Seeks are heavier than a walkthrough's: a backward scrub reopens the drive
// at an earlier anchor. Clicks seek at once; drags throttle (slower backward).
let hasDragged = false;
let scrubTimer: ReturnType<typeof setTimeout> | null = null;
let pendingScrubTick: number | null = null;

function scheduleScrubSeek(tick: number): void {
  pendingScrubTick = tick;
  if (scrubTimer !== null) return;
  const backward = tick < view.value.tick;
  scrubTimer = setTimeout(
    () => {
      scrubTimer = null;
      if (pendingScrubTick !== null) {
        const target = pendingScrubTick;
        pendingScrubTick = null;
        void historyView.seekTo(view.value.segment, target);
      }
    },
    backward ? 400 : 200,
  );
}

function onTimelinePointerDown(ev: PointerEvent): void {
  if (view.value.totalTicks <= 0 || view.value.seeking) return;
  hasDragged = false;
  isScrubbing.value = true;
  view.value.scrubbing = true;
  const pct = getTimelinePercent(ev.clientX);
  scrubPercent.value = pct;
  updateHover(ev.clientX);
  void historyView.seekTo(view.value.segment, tickAtPercent(pct));
  window.addEventListener("pointermove", onTimelinePointerMove);
  window.addEventListener("pointerup", onTimelinePointerUp);
  window.addEventListener("pointercancel", onTimelinePointerUp);
}

function onTimelinePointerMove(ev: PointerEvent): void {
  if (!isScrubbing.value) return;
  hasDragged = true;
  const pct = getTimelinePercent(ev.clientX);
  scrubPercent.value = pct;
  updateHover(ev.clientX);
  scheduleScrubSeek(tickAtPercent(pct));
}

function onTimelineHover(ev: PointerEvent): void {
  if (!isScrubbing.value) updateHover(ev.clientX);
}

function onTimelinePointerUp(ev: PointerEvent): void {
  window.removeEventListener("pointermove", onTimelinePointerMove);
  window.removeEventListener("pointerup", onTimelinePointerUp);
  window.removeEventListener("pointercancel", onTimelinePointerUp);
  if (scrubTimer !== null) {
    clearTimeout(scrubTimer);
    scrubTimer = null;
  }
  if (isScrubbing.value) {
    const finalPct = scrubPercent.value ?? getTimelinePercent(ev.clientX);
    isScrubbing.value = false;
    view.value.scrubbing = false;
    scrubPercent.value = undefined;
    if (hasDragged) void historyView.seekTo(view.value.segment, tickAtPercent(finalPct));
  }
  pendingScrubTick = null;
}

function onTimelinePointerLeave(): void {
  if (!isScrubbing.value) hoverInfo.value = undefined;
}

function onTimelineKeydown(ev: KeyboardEvent): void {
  if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
    // The window-level shortcut handles unfocused arrows; a focused timeline
    // handled it here — stop the bubble so the mark doesn't step twice.
    ev.preventDefault();
    ev.stopPropagation();
    void historyView.stepMark(ev.key === "ArrowRight" ? 1 : -1);
  }
}

function onMarkClick(mark: HistoryViewMark): void {
  if (hasDragged) return;
  hoverInfo.value = undefined;
  void historyView.seekTo(mark.segment, mark.tick);
  historyView.highlightMark(mark);
}

function togglePlay(): void {
  if (view.value.playing) historyView.pauseHistory();
  else historyView.playHistory();
}

function stepSegment(dir: 1 | -1): void {
  const next = view.value.segment + dir;
  if (next >= 0 && next < view.value.segmentCount)
    void historyView.seekTo(next, dir > 0 ? 0 : view.value.totalTicks);
}

/** Pointer clicks release focus so Space keeps toggling play, not the button. */
function releaseFocus(ev: MouseEvent): void {
  if (ev.detail > 0) (ev.currentTarget as HTMLElement).blur();
}

onUnmounted(() => {
  window.removeEventListener("pointermove", onTimelinePointerMove);
  window.removeEventListener("pointerup", onTimelinePointerUp);
  window.removeEventListener("pointercancel", onTimelinePointerUp);
  if (scrubTimer !== null) clearTimeout(scrubTimer);
});
</script>

<template>
  <div
    v-if="view.active || view.loading || view.error"
    class="history-transport"
    data-testid="history-transport"
  >
    <template v-if="view.active">
      <button
        type="button"
        class="history-btn history-back"
        data-testid="btn-back-to-live"
        title="Back to live (Esc) — the parked session resumes where you left it"
        aria-label="Back to live"
        @click="
          historyView.closeHistory();
          releaseFocus($event);
        "
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
        </svg>
      </button>

      <button
        type="button"
        class="history-btn"
        data-testid="btn-history-play"
        :title="view.playing ? 'Pause the tape (Space)' : 'Watch the tape unfold (Space)'"
        :aria-label="view.playing ? 'Pause' : 'Watch'"
        :disabled="view.seeking"
        @click="
          togglePlay();
          releaseFocus($event);
        "
      >
        <svg
          v-if="view.playing"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 5v14l11-7z" />
        </svg>
      </button>

      <div
        ref="timelineEl"
        class="history-timeline"
        data-testid="history-timeline"
        role="slider"
        tabindex="0"
        aria-label="History timeline"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="Math.round(scrubPercent ?? percent)"
        @pointerdown="onTimelinePointerDown"
        @pointermove="onTimelineHover"
        @pointerleave="onTimelinePointerLeave"
        @keydown="onTimelineKeydown"
      >
        <div class="history-track">
          <div
            class="history-progress-fill"
            data-testid="history-progress-fill"
            :style="{ width: `${scrubPercent ?? percent}%` }"
          ></div>
          <button
            v-for="(mark, i) in marks"
            :key="i"
            type="button"
            class="history-marker"
            :class="[
              `history-marker--${mark.kind}`,
              { 'history-marker--passed': (scrubPercent ?? percent) >= mark.percent },
            ]"
            :style="{ left: `${mark.percent}%` }"
            :title="mark.label"
            @click.stop="
              onMarkClick(mark);
              releaseFocus($event);
            "
          ></button>
          <div
            class="history-thumb"
            data-testid="history-thumb"
            :style="{ left: `${scrubPercent ?? percent}%` }"
          ></div>
        </div>
        <div v-if="hoverInfo" class="history-tooltip" :style="{ left: `${hoverInfo.percent}%` }">
          <span class="history-tooltip-label">{{ hoverInfo.label }}</span>
          <span v-if="hoverInfo.details" class="history-tooltip-details">{{
            hoverInfo.details
          }}</span>
        </div>
      </div>

      <div class="history-speed-group" role="group" aria-label="Playback speed">
        <button
          v-for="s in [1, 2, 4, 8]"
          :key="s"
          type="button"
          class="history-btn history-speed-btn"
          :class="{ 'history-speed-btn--active': view.speed === s }"
          :data-testid="`history-speed-${s}`"
          :title="`Watch at ${s}×`"
          @click="
            historyView.setHistorySpeed(s);
            releaseFocus($event);
          "
        >
          {{ s }}×
        </button>
      </div>

      <span class="history-pos" data-testid="history-pos">
        <template v-if="view.segmentCount > 1">
          <button
            type="button"
            class="history-btn history-seg-btn"
            data-testid="history-seg-prev"
            :disabled="view.segment === 0"
            title="Previous session"
            @click="
              stepSegment(-1);
              releaseFocus($event);
            "
          >
            ‹
          </button>
          <span data-testid="history-segment">{{ view.segment + 1 }}/{{ view.segmentCount }}</span>
          <button
            type="button"
            class="history-btn history-seg-btn"
            data-testid="history-seg-next"
            :disabled="view.segment + 1 >= view.segmentCount"
            title="Next session"
            @click="
              stepSegment(1);
              releaseFocus($event);
            "
          >
            ›
          </button>
        </template>
        <span class="history-readout"
          >Room {{ view.room }} · {{ Math.round(percent) }}%<template v-if="view.seeking">
            · replaying…</template
          ></span
        >
      </span>

      <button
        type="button"
        class="history-btn"
        data-testid="btn-history-bookmark"
        title="Pin this moment on the tape"
        aria-label="Bookmark this moment"
        @click="
          historyView.addBookmark();
          releaseFocus($event);
        "
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z" />
        </svg>
      </button>

      <button
        v-if="view.retained"
        type="button"
        class="ui-button ui-button--secondary history-action"
        data-testid="btn-back-to-before"
        title="Swap back to the session kept before Resume here"
        @click="
          void historyView.backToBefore();
          releaseFocus($event);
        "
      >
        Back to before
      </button>
      <button
        type="button"
        class="ui-button ui-button--primary history-action"
        data-testid="btn-resume-here"
        :disabled="!view.canResume || view.diverged !== null || view.seeking"
        title="Continue playing from this moment; the current session is kept as Back to before"
        @click="
          void historyView.resumeHere();
          releaseFocus($event);
        "
      >
        Resume here
      </button>
    </template>

    <span v-else-if="view.loading" class="history-status">Opening the tape…</span>

    <p v-if="view.error" class="history-error" data-testid="history-error" role="alert">
      {{ view.error }}
    </p>
    <p v-if="view.diverged" class="history-error" data-testid="history-diverged" role="alert">
      The tape stops agreeing with itself here: {{ view.diverged.detail }}
    </p>
  </div>
</template>

<style scoped>
.history-transport {
  display: flex;
  align-items: center;
  gap: 10px;
  width: var(--game-width);
  box-sizing: border-box;
  margin-top: -6px;
  padding: 6px 12px;
  background: #0b171b;
  border: 1px solid #4a3b6e;
  border-radius: 8px;
  user-select: none;
}
.history-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 30px;
  padding: 0 6px;
  border: 1px solid #5a4a85;
  border-radius: 6px;
  background: #221a38;
  color: #c9b8ff;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background-color 0.15s,
    border-color 0.15s,
    color 0.15s,
    transform 0.1s;
}
.history-btn:hover:not(:disabled) {
  background: #2c2247;
  border-color: #c9b8ff;
  color: #ffffff;
}
.history-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.history-btn:active:not(:disabled) {
  transform: scale(0.95);
}
.history-back {
  color: #ffb0b0;
  border-color: #7a4a4a;
  background: #331b1b;
}
.history-back:hover:not(:disabled) {
  background: #452222;
  border-color: #ffb0b0;
}
.history-timeline {
  position: relative;
  flex: 1;
  height: 26px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
  outline: none;
}
.history-timeline:focus-visible .history-track {
  box-shadow: 0 0 0 2px #c9b8ff;
}
.history-track {
  position: relative;
  width: 100%;
  height: 6px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  transition: height 0.15s ease;
}
.history-timeline:hover .history-track {
  height: 8px;
}
.history-progress-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: linear-gradient(90deg, #6a4fd0, #c9b8ff);
  border-radius: 3px;
  pointer-events: none;
}
.history-marker {
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
}
.history-marker--restart {
  background: #ff7a7a;
}
.history-marker--remix {
  background: #b98cff;
}
.history-marker--prompt {
  background: #7ab8ff;
}
.history-marker--bookmark {
  background: #7affb0;
}
.history-marker:hover {
  transform: translate(-50%, -50%) scale(1.6);
  background: #ffffff;
  z-index: 4;
}
.history-marker--passed {
  filter: brightness(1.25);
}
.history-thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #c9b8ff;
  box-shadow: 0 0 6px rgba(201, 184, 255, 0.7);
  z-index: 3;
  pointer-events: none;
  transition: transform 0.1s ease;
}
.history-timeline:hover .history-thumb {
  transform: translate(-50%, -50%) scale(1.2);
}
.history-tooltip {
  position: absolute;
  bottom: calc(100% + 6px);
  transform: translateX(-50%);
  background: #191224;
  border: 1px solid #5a4a85;
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
.history-tooltip-label {
  font-size: 11px;
  font-weight: 600;
  color: #ffffff;
}
.history-tooltip-details {
  font-size: 10px;
  color: #c9b8ff;
  font-family: var(--font-mono, monospace);
}
.history-speed-group {
  display: inline-flex;
  gap: 4px;
}
.history-speed-btn {
  min-width: 30px;
  height: 24px;
  font-size: 12px;
}
.history-speed-btn--active {
  background: #4a3b6e;
  border-color: #c9b8ff;
  color: #ffffff;
  font-weight: 600;
}
.history-pos {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #9aa7b8;
  white-space: nowrap;
}
.history-seg-btn {
  min-width: 20px;
  height: 20px;
  padding: 0 4px;
  font-size: 13px;
}
.history-readout {
  min-width: 96px;
  text-align: right;
}
.history-action {
  padding: 3px 10px;
  font-size: 12px;
  min-height: 28px;
  white-space: nowrap;
}
.history-status {
  font-size: 12px;
  color: #9aa7b8;
}
.history-error {
  margin: 0;
  font-size: 12px;
  color: #ff9b9b;
}
</style>
