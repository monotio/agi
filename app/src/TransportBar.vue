<script setup lang="ts">
/**
 * The one transport, in the slim strip under the stage. Its model is a TransportModel: the
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
      <div class="transport-primary">
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
      </div>
      <div class="transport-secondary">
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
          :aria-label="
            model.storyPause.on ? 'Disable pause on dialogue' : 'Enable pause on dialogue'
          "
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
      </div>
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
/*
 * One row inside the play strip: play, the scrub bar and LIVE. The tape's
 * and walkthrough's secondary controls float just above the strip's right
 * end (the strip is their positioned ancestor), so opening the tape never
 * moves or resizes the timeline under the pointer. Errors and pending notes
 * wrap below the row.
 */
.transport {
  display: flex;
  flex: 1 1 360px;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-4);
  min-width: 0;
  user-select: none;
}
.transport-primary,
.transport-secondary {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-width: 0;
}
.transport-primary {
  flex: 1 1 240px;
}
.transport-secondary {
  position: absolute;
  right: var(--space-6);
  bottom: calc(100% + var(--space-2));
  z-index: var(--z-dock);
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-3);
  max-width: calc(100% - 2 * var(--space-6));
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
}
.transport-pos:empty,
.transport-secondary:not(:has(> :not(:empty))) {
  display: none;
}
.transport-btn,
.transport-play-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  min-width: var(--control-h-sm);
  height: var(--control-h-sm);
  padding: 0 var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius);
  color: var(--ink-2);
  background: transparent;
  cursor: pointer;
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.transport-play-btn {
  width: var(--control-h-sm);
  padding: 0;
}
.transport-btn:hover:not(:disabled),
.transport-play-btn:hover:not(:disabled) {
  color: var(--ink);
  background: var(--surface-3);
}
.transport-btn:disabled,
.transport-play-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
/* A fixed width: the label changes (Pause, Resume from here) but the
   timeline beside it must not move. */
.transport-play-btn--labeled {
  justify-content: flex-start;
  width: 160px;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  color: var(--action);
  border-color: var(--action-line);
}
.transport-play-label {
  font: var(--weight-semibold) var(--text-xs) / 1 var(--font-sans);
  white-space: nowrap;
}
.transport-live-tick {
  position: absolute;
  right: 0;
  top: 50%;
  z-index: 2;
  width: 3px;
  height: 12px;
  border-radius: var(--radius-sm);
  background: var(--action);
  transform: translateY(-50%);
  pointer-events: none;
}
.transport-live-btn {
  padding: 0 var(--space-3);
  border-color: var(--hairline-strong);
  border-radius: var(--radius-pill);
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / 1 var(--font-sans);
  letter-spacing: var(--tracking-caps);
}
.transport-live-btn--here {
  color: var(--action);
  border-color: var(--action-line);
  background: var(--action-soft);
}
.transport-timeline {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 96px;
  height: var(--control-h-sm);
  cursor: pointer;
  touch-action: none;
  outline: none;
}
.transport-timeline:focus-visible .transport-track {
  box-shadow: 0 0 0 2px var(--focus);
}
.transport-track {
  position: relative;
  width: 100%;
  height: 4px;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  transition: height var(--duration) var(--ease-out);
}
.transport-timeline:hover .transport-track {
  height: 6px;
}
.transport-progress-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: var(--radius-sm);
  background: linear-gradient(90deg, var(--action-line), var(--action));
  pointer-events: none;
}
.transport-marker {
  position: absolute;
  top: 50%;
  z-index: 2;
  width: 4px;
  height: 10px;
  padding: 0;
  border: 1px solid var(--surface-0);
  border-radius: var(--radius-sm);
  background: var(--warn);
  transform: translate(-50%, -50%);
  /* Dense checkpoint clusters overlap: pointer resolution happens on the
     timeline (nearest mark wins); the button stays for keyboard activation. */
  pointer-events: none;
  cursor: pointer;
}
.transport-marker--restart {
  background: var(--agi-12);
}
.transport-marker--remix {
  background: var(--agi-13);
}
.transport-marker--prompt {
  background: var(--agi-9);
}
.transport-marker--bookmark {
  background: var(--ok);
}
.transport-marker--passed {
  opacity: 0.7;
}
.transport-thumb {
  position: absolute;
  top: 50%;
  z-index: 3;
  width: 14px;
  height: 14px;
  border-radius: var(--radius-pill);
  background: var(--action);
  transform: translate(-50%, -50%);
  pointer-events: none;
  transition: transform var(--duration-fast) var(--ease-out);
}
.transport-timeline:hover .transport-thumb {
  transform: translate(-50%, -50%) scale(1.2);
}
.transport-tooltip {
  position: absolute;
  bottom: calc(100% + 6px);
  z-index: var(--z-dock);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: var(--space-0) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  background: var(--surface-2);
  box-shadow: var(--shadow-pop);
  transform: translateX(-50%);
  white-space: nowrap;
  pointer-events: none;
}
.transport-tooltip-label {
  color: var(--ink);
  font: var(--weight-semibold) var(--text-2xs) / 1.4 var(--font-sans);
}
.transport-tooltip-details {
  color: var(--ok);
  font: var(--text-2xs) / 1.4 var(--font-mono);
}
.transport-speed-group {
  display: inline-flex;
  gap: var(--space-1);
}
.transport-speed-btn {
  min-height: 24px;
  padding: var(--space-0) var(--space-3);
  font-size: var(--text-xs);
  line-height: 1;
}
.transport-speed-btn--active {
  color: var(--action-ink);
  background: var(--action);
}
.transport-story-pause {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.transport-story-pause-icon {
  flex-shrink: 0;
}
.transport-pos {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--ink-3);
  font-size: var(--text-2xs);
  white-space: nowrap;
}
.transport-readout {
  min-width: 96px;
  font-family: var(--font-mono);
  text-align: right;
}
.transport-action {
  min-height: 28px;
  padding: var(--space-0) var(--space-4);
  font-size: var(--text-xs);
  white-space: nowrap;
}
.transport-note {
  margin-left: var(--space-3);
  color: var(--warn);
  font-size: var(--text-2xs);
  white-space: nowrap;
}
.transport-pending {
  display: inline-flex;
  flex-basis: 100%;
  align-items: center;
  gap: var(--space-2);
}
.transport-status {
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.transport-error {
  flex-basis: 100%;
  margin: 0;
  color: var(--danger);
  font-size: var(--text-xs);
}
.transport-error-details {
  display: inline;
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.transport-error-details summary {
  display: inline;
  cursor: pointer;
  text-decoration: underline;
}
@media (max-width: 600px) {
  .transport {
    gap: var(--space-2);
  }
  .transport-primary {
    flex-basis: 100%;
    gap: var(--space-3);
  }
  /* A phone has no room above the strip: the controls wrap under the row. */
  .transport-secondary {
    position: static;
    justify-content: flex-start;
    max-width: none;
    padding: 0;
    border: 0;
    background: none;
    box-shadow: none;
  }
  .transport-play-btn,
  .transport-btn,
  .transport-speed-btn,
  .transport-timeline {
    min-height: var(--control-h-touch);
  }
  .transport-play-btn,
  .transport-btn,
  .transport-speed-btn {
    min-width: var(--control-h-touch);
  }
  .transport-play-btn--labeled {
    flex-shrink: 0;
    width: 88px;
    padding: 0 var(--space-2);
  }
  .transport-play-btn svg {
    flex-shrink: 0;
  }
  .transport-play-label {
    white-space: normal;
    text-align: left;
  }
  .transport-pos {
    flex-wrap: wrap;
    white-space: normal;
  }
  .transport-readout {
    text-align: left;
  }
  .transport-pending {
    flex-wrap: wrap;
  }
}
</style>
