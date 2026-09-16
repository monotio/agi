<script setup lang="ts">
/**
 * The one transport bar, under the CRT. Its model is a TransportModel: the
 * same timeline, thumb, marks and speed group whether the source is a
 * walkthrough artifact or the live session's recording. Pointer and key
 * events translate to lane percents and dispatch through the model — the
 * scrub/hover machinery lives in useTransport.
 */
import { onUnmounted, useTemplateRef } from "vue";
import type { TransportModel, TransportMark } from "./useTransport.ts";

const props = defineProps<{ model: TransportModel }>();

const timelineEl = useTemplateRef("timelineEl");

function getTimelinePercent(clientX: number): number {
  const el = timelineEl.value;
  if (!el) return 0;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  return (x / rect.width) * 100;
}

function onTimelinePointerDown(ev: PointerEvent): void {
  props.model.scrubDown(getTimelinePercent(ev.clientX));
  if (!props.model.isScrubbing) return;
  window.addEventListener("pointermove", onTimelinePointerMove);
  window.addEventListener("pointerup", onTimelinePointerUp);
  window.addEventListener("pointercancel", onTimelinePointerUp);
}

function onTimelinePointerMove(ev: PointerEvent): void {
  props.model.scrubMove(getTimelinePercent(ev.clientX));
}

function onTimelineHover(ev: PointerEvent): void {
  props.model.hoverMove(getTimelinePercent(ev.clientX));
}

function onTimelinePointerUp(ev: PointerEvent): void {
  window.removeEventListener("pointermove", onTimelinePointerMove);
  window.removeEventListener("pointerup", onTimelinePointerUp);
  window.removeEventListener("pointercancel", onTimelinePointerUp);
  props.model.scrubUp(getTimelinePercent(ev.clientX));
}

function onTimelinePointerLeave(): void {
  props.model.hoverEnd();
}

function onTimelineKeydown(ev: KeyboardEvent): void {
  if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
    // The window-level shortcut handles unfocused arrows; a focused timeline
    // handled it here — stop the bubble so the step doesn't run twice.
    ev.preventDefault();
    ev.stopPropagation();
    props.model.stepKey(ev.key === "ArrowRight" ? 1 : -1);
  } else if (ev.key === " ") {
    // The transport owns Space only while its timeline holds focus — a live
    // game's ordinary input never loses it.
    ev.preventDefault();
    ev.stopPropagation();
    props.model.togglePlay();
  }
}

function onMarkClick(mark: TransportMark, ev: MouseEvent): void {
  props.model.markClick(mark);
  releaseFocus(ev);
}

/**
 * A pointer click must not leave keyboard focus on the control: playback
 * owns the next keystroke ("Press Enter to continue", Space toggles), and a
 * focused button would swallow it or re-trigger itself. Keyboard-activated
 * clicks report detail 0 and keep focus so Tab/Enter navigation works.
 */
function releaseFocus(ev: MouseEvent): void {
  if (ev.detail > 0) (ev.currentTarget as HTMLElement).blur();
}

onUnmounted(() => {
  window.removeEventListener("pointermove", onTimelinePointerMove);
  window.removeEventListener("pointerup", onTimelinePointerUp);
  window.removeEventListener("pointercancel", onTimelinePointerUp);
});
</script>

<template>
  <div v-if="model.visible" class="transport" :data-testid="model.testid">
    <template v-if="model.controls">
      <button
        v-for="btn in model.leading"
        :key="btn.testid"
        type="button"
        class="transport-btn"
        :class="{ 'transport-btn--danger': btn.variant === 'danger' }"
        :data-testid="btn.testid"
        :title="btn.title"
        :aria-label="btn.aria"
        :disabled="btn.disabled"
        @click="
          btn.run();
          releaseFocus($event);
        "
      >
        <svg
          v-if="btn.icon === 'back'"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
        </svg>
        <template v-else>{{ btn.label }}</template>
      </button>

      <button
        type="button"
        class="transport-play-btn"
        :class="{ 'transport-play-btn--labeled': model.play.label !== undefined }"
        :data-testid="model.play.testid"
        :title="model.play.title"
        :aria-label="model.play.aria"
        :disabled="model.play.disabled"
        @click="
          model.play.run();
          releaseFocus($event);
        "
      >
        <svg
          v-if="model.play.icon === 'play'"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 5v14l11-7z" />
        </svg>
        <svg
          v-else-if="model.play.icon === 'replay'"
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
        <svg
          v-else
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
        </svg>
        <span v-if="model.play.label" class="transport-play-label">{{ model.play.label }}</span>
      </button>

      <div
        ref="timelineEl"
        class="transport-timeline"
        :data-testid="model.timelineTestid"
        role="slider"
        tabindex="0"
        :aria-label="model.timelineLabel"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="Math.round(model.scrubPercent ?? model.percent)"
        @pointerdown="onTimelinePointerDown"
        @pointermove="onTimelineHover"
        @pointerleave="onTimelinePointerLeave"
        @keydown="onTimelineKeydown"
      >
        <div class="transport-track">
          <div
            class="transport-progress-fill"
            :data-testid="model.fillTestid"
            :style="{ width: `${model.scrubPercent ?? model.percent}%` }"
          ></div>
          <button
            v-for="mark in model.marks"
            :key="mark.key"
            type="button"
            class="transport-marker"
            :class="[
              model.markerClass,
              mark.kind ? `transport-marker--${mark.kind}` : '',
              mark.kind ? `${model.markerClass}--${mark.kind}` : '',
              {
                'transport-marker--passed': (model.scrubPercent ?? model.percent) >= mark.percent,
                [`${model.markerClass}--passed`]:
                  (model.scrubPercent ?? model.percent) >= mark.percent,
              },
            ]"
            :style="{ left: `${mark.percent}%` }"
            :data-testid="mark.testid"
            :title="mark.details ? `${mark.label} (${mark.details})` : mark.label"
            @click.stop="onMarkClick(mark, $event)"
          ></button>
          <div
            class="transport-thumb"
            :data-testid="model.thumbTestid"
            :style="{ left: `${model.scrubPercent ?? model.percent}%` }"
          ></div>
          <div v-if="model.live" class="transport-live-tick" aria-hidden="true"></div>
        </div>
        <div
          v-if="model.hover"
          class="transport-tooltip"
          :class="model.tooltipClass"
          :style="{ left: `${model.hover.percent}%` }"
        >
          <span class="transport-tooltip-label">{{ model.hover.label }}</span>
          <span v-if="model.hover.details" class="transport-tooltip-details">{{
            model.hover.details
          }}</span>
        </div>
      </div>

      <button
        v-if="model.live"
        type="button"
        class="transport-btn transport-live-btn"
        :class="{ 'transport-live-btn--here': model.live.here }"
        :data-testid="model.live.testid"
        :aria-pressed="model.live.here"
        :title="
          model.live.here
            ? 'The current game'
            : 'Back to the current game — it stays paused until you resume'
        "
        @click="
          model.live!.run();
          releaseFocus($event);
        "
      >
        LIVE
      </button>

      <div
        v-if="model.speedGroup"
        class="transport-speed-group"
        role="group"
        aria-label="Playback speed"
      >
        <button
          v-for="s in [1, 2, 4, 8]"
          :key="s"
          type="button"
          class="ui-button ui-button--secondary transport-speed-btn"
          :class="{
            'transport-speed-btn--active': model.speed === s,
            [model.speedActiveClass]: model.speed === s,
          }"
          :data-testid="`${model.speedTestid}${s}`"
          :title="model.speedTitle(s)"
          @click="
            model.setSpeed(s);
            releaseFocus($event);
          "
        >
          {{ s }}×
        </button>
      </div>

      <span v-if="model.posTestid" class="transport-pos" :data-testid="model.posTestid">
        <template v-if="model.segments && model.segments.count > 1">
          <button
            type="button"
            class="transport-btn transport-seg-btn"
            :data-testid="model.segments.prevTestid"
            :disabled="model.segments.index === 0"
            title="Previous session"
            @click="
              model.segments!.step(-1);
              releaseFocus($event);
            "
          >
            ‹
          </button>
          <span :data-testid="model.segments.labelTestid"
            >{{ model.segments.index + 1 }}/{{ model.segments.count }}</span
          >
          <button
            type="button"
            class="transport-btn transport-seg-btn"
            :data-testid="model.segments.nextTestid"
            :disabled="model.segments.index + 1 >= model.segments.count"
            title="Next session"
            @click="
              model.segments!.step(1);
              releaseFocus($event);
            "
          >
            ›
          </button>
        </template>
        <span v-if="model.readout" class="transport-readout">{{ model.readout }}</span>
        <span
          v-if="model.dropped > 0"
          class="transport-note"
          data-testid="history-dropped"
          title="The tape outgrew its storage bound — playback starts at the oldest kept session"
          >earlier tape dropped</span
        >
      </span>

      <button
        v-for="btn in model.trailing"
        :key="btn.testid"
        type="button"
        class="transport-btn"
        :class="{
          'transport-action': btn.variant !== undefined,
          'ui-button ui-button--primary': btn.variant === 'primary',
          'ui-button ui-button--secondary': btn.variant === 'secondary',
        }"
        :data-testid="btn.testid"
        :title="btn.title"
        :aria-label="btn.aria"
        :disabled="btn.disabled"
        @click="
          btn.run();
          releaseFocus($event);
        "
      >
        <svg
          v-if="btn.icon === 'bookmark'"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z" />
        </svg>
        <template v-if="btn.label">{{ btn.label }}</template>
      </button>

      <button
        v-if="model.storyPause"
        type="button"
        class="ui-button ui-button--secondary transport-speed-btn transport-story-pause"
        :class="{
          'transport-speed-btn--active': model.storyPause.on,
          [model.speedActiveClass]: model.storyPause.on,
        }"
        :data-testid="model.storyPause.testid"
        :title="
          model.storyPause.on
            ? 'Pause on dialogue: enabled (pauses on dialogue)'
            : 'Pause on dialogue: disabled (auto-advances with reading dwell)'
        "
        :aria-label="model.storyPause.on ? 'Disable pause on dialogue' : 'Enable pause on dialogue'"
        @click="
          model.storyPause!.toggle();
          releaseFocus($event);
        "
      >
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="currentColor"
          aria-hidden="true"
          class="transport-story-pause-icon"
        >
          <path
            d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"
          />
        </svg>
        Pause on dialogue
      </button>
    </template>

    <span v-else-if="model.loadingText" class="transport-status">{{ model.loadingText }}</span>

    <div
      v-if="model.pending"
      class="transport-pending"
      :data-testid="model.pending.testid"
      role="group"
      aria-label="Interrupted kept session"
    >
      <span class="transport-note">{{ model.pending.text }}</span>
      <button
        v-for="btn in model.pending.buttons"
        :key="btn.testid"
        type="button"
        class="ui-button ui-button--secondary transport-action"
        :data-testid="btn.testid"
        :title="btn.title"
        @click="
          btn.run();
          releaseFocus($event);
        "
      >
        {{ btn.label }}
      </button>
    </div>

    <div
      v-for="err in model.errors"
      :key="err.testid"
      class="transport-error"
      :data-testid="err.testid"
      role="alert"
    >
      {{ err.text }}
      <details v-if="err.details" class="transport-error-details">
        <summary>Details</summary>
        {{ err.details }}
      </details>
    </div>
  </div>
</template>

<style scoped>
.transport {
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
.transport-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 30px;
  padding: 0 6px;
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
.transport-btn:hover:not(:disabled) {
  background: #1c4d56;
  border-color: #5ce1e6;
  color: #ffffff;
}
.transport-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.transport-btn:active:not(:disabled) {
  transform: scale(0.95);
}
.transport-btn--danger {
  color: #ffb0b0;
  border-color: #7a4a4a;
  background: #331b1b;
}
.transport-btn--danger:hover:not(:disabled) {
  background: #452222;
  border-color: #ffb0b0;
}
.transport-play-btn {
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
.transport-play-btn:hover:not(:disabled) {
  background: #1c4d56;
  border-color: #5ce1e6;
  color: #ffffff;
}
.transport-play-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.transport-play-btn:active:not(:disabled) {
  transform: scale(0.95);
}
.transport-play-btn--labeled {
  width: auto;
  padding: 0 10px;
  gap: 6px;
}
.transport-play-label {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.transport-live-tick {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 14px;
  border-radius: 1px;
  background: #5ce1e6;
  z-index: 2;
  pointer-events: none;
}
.transport-live-btn {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 0 10px;
}
.transport-live-btn--here {
  background: #1a5259;
  border-color: #5ce1e6;
  color: #ffffff;
}
.transport-timeline {
  position: relative;
  flex: 1;
  height: 26px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
  outline: none;
}
.transport-timeline:focus-visible .transport-track {
  box-shadow: 0 0 0 2px #5ce1e6;
}
.transport-track {
  position: relative;
  width: 100%;
  height: 6px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  transition: height 0.15s ease;
}
.transport-timeline:hover .transport-track {
  height: 8px;
}
.transport-progress-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: linear-gradient(90deg, #1fa2a6, #5ce1e6);
  border-radius: 3px;
  pointer-events: none;
}
.transport-marker {
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
.transport-marker--restart {
  background: #ff7a7a;
}
.transport-marker--remix {
  background: #b98cff;
}
.transport-marker--prompt {
  background: #7ab8ff;
}
.transport-marker--bookmark {
  background: #7affb0;
}
.transport-marker:hover {
  transform: translate(-50%, -50%) scale(1.6);
  background: #ffffff;
  z-index: 4;
}
.transport-marker--passed {
  background: #fff080;
}
.transport-marker--passed.transport-marker--restart {
  background: #ff9b9b;
}
.transport-marker--passed.transport-marker--remix {
  background: #cfaaff;
}
.transport-marker--passed.transport-marker--prompt {
  background: #9ccaff;
}
.transport-marker--passed.transport-marker--bookmark {
  background: #9fffc6;
}
.transport-thumb {
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
.transport-timeline:hover .transport-thumb {
  transform: translate(-50%, -50%) scale(1.2);
}
.transport-tooltip {
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
.transport-tooltip-label {
  font-size: 11px;
  font-weight: 600;
  color: #ffffff;
}
.transport-tooltip-details {
  font-size: 10px;
  color: #9fe6a0;
  font-family: var(--font-mono, monospace);
}
.transport-speed-group {
  display: inline-flex;
  gap: 4px;
}
.transport-speed-btn {
  padding: 2px 8px;
  font-size: 12px;
  min-height: 24px;
  line-height: 1;
}
.transport-speed-btn--active {
  background: #1a5259;
  border-color: #5ce1e6;
  color: #ffffff;
  font-weight: 600;
}
.transport-story-pause {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.transport-story-pause-icon {
  flex-shrink: 0;
}
.transport-pos {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #9aa7b8;
  white-space: nowrap;
}
.transport-seg-btn {
  min-width: 20px;
  height: 20px;
  padding: 0 4px;
  font-size: 13px;
}
.transport-readout {
  min-width: 96px;
  text-align: right;
}
.transport-action {
  padding: 3px 10px;
  font-size: 12px;
  min-height: 28px;
  white-space: nowrap;
}
.transport-note {
  margin-left: 8px;
  font-size: 11px;
  color: #e0c98a;
  white-space: nowrap;
}
.transport-pending {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.transport-status {
  font-size: 12px;
  color: #9aa7b8;
}
.transport-error {
  margin: 0;
  font-size: 12px;
  color: #ff9b9b;
}
.transport-error-details {
  display: inline;
  font-size: 11px;
  color: #9aa7b8;
}
.transport-error-details summary {
  display: inline;
  cursor: pointer;
  text-decoration: underline;
}
</style>
