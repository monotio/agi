<script setup lang="ts">
import { computed, nextTick, onWatcherCleanup, ref, useTemplateRef, watch } from "vue";
import AgentTaskControls from "./AgentTaskControls.vue";
import SoundPreview from "./SoundPreview.vue";
import { useEngineApi } from "./engineContext.ts";
import { usePresentation } from "./usePresentation.ts";
import { useShellBridge } from "./shellBridge.ts";
import { useAiSettings } from "./useAiSettings.ts";
import PendingReferences from "./PendingReferences.vue";
import UiIcon from "./ui/UiIcon.vue";

/**
 * Where the assistant is hosted: the Play drawer is Ask-only (remix lives in
 * Create), the Create dock carries the full Ask / Remix surface.
 */
const { surface } = defineProps<{ surface: "drawer" | "dock" }>();

const engine = useEngineApi();
const { state, openPowerUp, closePowerUp, submitPowerUp, stopAgent, continueAgent, discardAgent } =
  engine;
const { debugOpen } = usePresentation();
const bridge = useShellBridge();
const { aiConfigured, aiSettingsUnavailable, openAiSettings, llmConfig } = useAiSettings();

/**
 * The assistant. Opening it freezes the world at the next cycle boundary
 * while the agent takes your instruction; the panel streams its tool calls;
 * a remix's closing sentence closes it, the room re-enters if it was patched,
 * and the interpreter resumes on exactly the cycle it parked on.
 */
const powerUpLine = ref("");
const powerUpEl = useTemplateRef("powerUpEl");

/** The live tool-call feed for this remix turn: the transcript tail. */
const asking = computed(() => state.powerUp.mode === "ask");
const creatingRoom = computed(() => state.powerUp.mode === "room");
const powerUpFeed = computed(() => {
  if (state.powerUp.feedStartSeq !== undefined) {
    return state.agentLog.filter((entry) => (entry.seq ?? 0) >= state.powerUp.feedStartSeq!);
  }
  return state.agentLog.slice(state.powerUp.feedStart);
});
const powerUpAudio = computed(() => powerUpFeed.value.flatMap((entry) => entry.audio ?? []));

const conversationEl = useTemplateRef("conversationEl");
const followConversation = ref(true);
function onConversationScroll(): void {
  const el = conversationEl.value;
  if (el) followConversation.value = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
}
watch(
  [
    () => state.powerUp.open,
    () => state.powerUp.messages.length,
    () => state.agentTask?.progress?.text,
  ],
  ([open, count], [wasOpen, previousCount]) => {
    if (!open) return;
    if (!wasOpen || (count !== previousCount && state.powerUp.messages.at(-1)?.role === "user"))
      followConversation.value = true;
    const el = conversationEl.value;
    if (el && followConversation.value) el.scrollTop = el.scrollHeight;
  },
  { flush: "post" },
);
const progressFeedEl = useTemplateRef("progressFeedEl");
const followProgress = ref(true);
const REMIX_ACTIVITY: Record<string, string> = {
  read_state: "Inspecting the game…",
  read_objects: "Inspecting the characters…",
  read_frames: "Looking at the scene…",
  read_logic: "Reading the room’s behavior…",
  read_picture: "Examining the scenery…",
  read_words: "Reading the vocabulary…",
  list_resources: "Exploring the game’s resources…",
  inspect_world_bible: "Checking the world…",
  write_view: "Drawing sprites…",
  write_picture: "Drawing the scenery…",
  write_logic_source: "Updating the room’s behavior…",
  write_words: "Adding vocabulary…",
  write_inventory_objects: "Updating inventory…",
  write_sound: "Composing sound…",
  playtest_room: "Checking the updated room…",
};
const remixActivity = computed(() => {
  const latest = powerUpFeed.value.at(-1);
  const tool = (latest?.data as { tool?: string } | undefined)?.tool;
  if (latest?.kind === "error") return "Adjusting after a problem…";
  if (tool && latest?.kind === "request")
    return (
      REMIX_ACTIVITY[tool] ??
      (creatingRoom.value
        ? "Building the next room…"
        : asking.value
          ? "Investigating…"
          : "Working on your changes…")
    );
  if (tool && latest?.kind === "response") return "Reviewing results…";
  return creatingRoom.value
    ? "Imagining the next room…"
    : state.powerUp.needsConfig
      ? "Connecting to your model…"
      : asking.value
        ? "Thinking…"
        : "Thinking about your changes…";
});

function onProgressScroll(): void {
  const el = progressFeedEl.value;
  if (el) followProgress.value = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
}

function jumpToLatest(): void {
  followProgress.value = true;
  const el = progressFeedEl.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
    el.focus({ preventScroll: true });
  }
}

watch(
  [() => state.powerUp.open, () => state.powerUp.feedStart, () => powerUpFeed.value.at(-1)?.id],
  ([open, start], [wasOpen, previousStart]) => {
    if (!open) return;
    if (!wasOpen || start !== previousStart) followProgress.value = true;
    const el = progressFeedEl.value;
    if (followProgress.value && el) el.scrollTop = el.scrollHeight;
  },
  { flush: "post" },
);
watch(
  () => state.powerUp.open,
  async (open, wasOpen) => {
    await nextTick();
    if (open && creatingRoom.value) progressFeedEl.value?.focus({ preventScroll: true });
    else if (!open && wasOpen && creatingRoom.value) bridge.focusGameInput();
  },
);
watch(progressFeedEl, (el) => {
  if (!el) return;
  const observer = new ResizeObserver(() => {
    if (followProgress.value) el.scrollTop = el.scrollHeight;
  });
  observer.observe(el);
  onWatcherCleanup(() => observer.disconnect());
});

async function onPowerUp(mode?: "ask" | "remix"): Promise<void> {
  if (state.powerUp.busy) return;
  if (state.powerUp.open) {
    // An explicit mode from a menu switches the surface rather than closing.
    if (mode !== undefined && state.powerUp.mode !== mode && !creatingRoom.value) {
      state.powerUp.mode = mode;
      return;
    }
    closePowerUp();
    bridge.focusGameInput();
    return;
  }
  powerUpLine.value = "";
  if (mode !== undefined) state.powerUp.mode = mode;
  await openPowerUp(llmConfig());
  await nextTick();
  powerUpEl.value?.focus({ preventScroll: true });
}
bridge.togglePowerUp = (mode) => void onPowerUp(mode);
bridge.assistantInputEl = () => powerUpEl.value;

async function onPowerUpSubmit(): Promise<void> {
  const text = powerUpLine.value.trim();
  if (text.length === 0 || state.powerUp.busy) return;
  followProgress.value = true;
  powerUpLine.value = "";
  await submitPowerUp(text);
  if (!state.powerUp.open) bridge.focusGameInput();
  else {
    await nextTick();
    powerUpEl.value?.focus({ preventScroll: true });
  }
}

/** A playtest records live play — the bubble closes so the game unfreezes. */
function onRecordPlaytest(): void {
  closePowerUp();
  bridge.focusGameInput();
  bridge.startPlaytest();
}

function onPowerUpKey(ev: KeyboardEvent): void {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    void onPowerUpSubmit();
    return;
  }
  if (ev.key !== "Escape") return;
  ev.preventDefault();
  ev.stopPropagation();
  closePowerUp();
  bridge.focusGameInput();
}
</script>

<template>
  <section
    v-if="state.powerUp.open"
    class="agent-bubble"
    :class="[`agent-bubble--${surface}`]"
    data-testid="agent-bubble"
    aria-label="Assistant"
    @click.stop
    @pointerdown.stop
  >
    <header class="agent-bubble-head" data-testid="agent-bubble-head">
      <h2 v-if="creatingRoom" class="agent-bubble-title">
        {{ state.powerUp.error ? "Could not create this room" : "Creating the next room" }}
      </h2>
      <h2 v-else-if="surface === 'drawer'" class="agent-bubble-title">
        <UiIcon name="sparkles" :size="16" />Ask
      </h2>
      <div v-else class="agent-mode-switch" role="group" aria-label="Agent mode">
        <button
          type="button"
          data-testid="agent-mode-ask"
          :aria-pressed="asking"
          :disabled="state.powerUp.busy"
          title="Ask questions without changing the game"
          @click="state.powerUp.mode = 'ask'"
        >
          Ask
        </button>
        <button
          type="button"
          data-testid="agent-mode-remix"
          :aria-pressed="!asking"
          :disabled="state.powerUp.busy"
          title="Make changes to this game"
          @click="state.powerUp.mode = 'remix'"
        >
          Remix
        </button>
      </div>
      <button
        v-if="surface === 'dock'"
        type="button"
        class="agent-inspect"
        :class="{ on: debugOpen }"
        data-testid="inspect-toggle"
        :aria-pressed="debugOpen"
        title="AGI inspector: priority views, objects, vars, flags, trace"
        @click="debugOpen = !debugOpen"
      >
        <UiIcon name="inspect" :size="16" />Inspect
      </button>
      <span class="agent-bubble-right">
        <span class="agent-bubble-room" data-testid="agent-bubble-room"
          >{{ asking ? "Read-only" : "Paused" }} ·
          {{ state.powerUp.room > 0 ? `room ${state.powerUp.room}` : "…" }}</span
        >
        <button
          v-if="!creatingRoom || !state.powerUp.busy"
          type="button"
          class="bubble-close remix-close"
          data-testid="agent-bubble-close"
          aria-label="Back to game"
          title="Back to game (Esc)"
          :disabled="state.powerUp.busy"
          @click="onPowerUp()"
        >
          <UiIcon name="x" :size="18" />
        </button>
      </span>
    </header>
    <div v-if="!creatingRoom && !aiConfigured" class="ai-connect assistant-connect">
      <p>
        Connect your AI provider to ask about{{ surface === "dock" ? " or remix" : "" }} this game.
      </p>
      <button
        type="button"
        class="ui-button ui-button--primary"
        data-testid="connect-assistant-ai"
        :disabled="aiSettingsUnavailable"
        @click="openAiSettings($event, 'assistant')"
      >
        Connect AI
      </button>
    </div>
    <div
      v-if="!creatingRoom && state.powerUp.messages.length"
      ref="conversationEl"
      class="agent-conversation"
      data-testid="agent-conversation"
      @scroll="onConversationScroll"
      role="log"
      aria-label="Conversation"
      aria-live="polite"
    >
      <div
        v-for="(message, index) in state.powerUp.messages"
        :key="index"
        class="agent-message"
        :class="message.role"
      >
        {{ message.text }}
      </div>
      <div
        v-if="asking && state.powerUp.busy && state.agentTask?.progress?.text"
        class="agent-message assistant"
        data-testid="agent-stream-text"
        aria-live="off"
      >
        {{ state.agentTask.progress.text }}
      </div>
    </div>
    <div
      v-if="
        state.powerUp.busy && state.agentTask?.status !== 'paused' && !state.agentTask?.progress
      "
      class="remix-progress"
    >
      <span role="status" aria-live="polite" aria-atomic="true" data-testid="remix-progress-status">
        {{ remixActivity }}
      </span>
      <progress
        :aria-label="
          creatingRoom
            ? 'Room generation in progress'
            : asking
              ? 'Investigation in progress'
              : 'Remix in progress'
        "
      ></progress>
    </div>
    <AgentTaskControls
      :task="state.agentTask"
      :show-text="!asking"
      @stop="stopAgent"
      @resume="continueAgent"
      @discard="discardAgent"
    />
    <details class="agent-activity" :open="creatingRoom || state.powerUp.busy">
      <summary>Activity</summary>
      <div
        ref="progressFeedEl"
        class="agent-bubble-feed"
        data-testid="agent-bubble-feed"
        role="region"
        :aria-label="creatingRoom ? 'Room generation activity' : 'Agent activity'"
        tabindex="0"
        @scroll.passive="onProgressScroll"
      >
        <div
          v-for="entry in powerUpFeed"
          :key="entry.id"
          class="agent-bubble-line"
          :class="entry.kind"
        >
          {{ entry.detail }}
          <SoundPreview v-if="entry.audio?.length" :audio="entry.audio" />
        </div>
      </div>
      <div v-if="!followProgress" class="remix-follow-controls">
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="remix-jump-latest"
          @click="jumpToLatest"
        >
          Jump to latest
        </button>
      </div>
    </details>
    <SoundPreview
      v-if="!state.powerUp.busy && powerUpAudio.length"
      :audio="powerUpAudio"
      data-testid="agent-bubble-sound-preview"
    />
    <PendingReferences
      v-if="!creatingRoom && !state.powerUp.needsConfig"
      :busy="state.powerUp.busy"
      :room="state.powerUp.room"
      :allow-attach="!asking"
    />
    <form
      v-if="!creatingRoom && !state.powerUp.needsConfig"
      class="agent-bubble-form"
      :class="{ 'agent-bubble-form--remix': !asking }"
      @submit.prevent="onPowerUpSubmit"
    >
      <textarea
        rows="2"
        ref="powerUpEl"
        v-model="powerUpLine"
        data-testid="agent-bubble-input"
        :aria-label="asking ? 'Ask about this game' : 'What would you like to change?'"
        autocomplete="off"
        spellcheck="false"
        :disabled="state.powerUp.busy"
        :placeholder="asking ? 'Ask about this game…' : 'What would you like to change?'"
        @keydown="onPowerUpKey"
      ></textarea>
      <button
        v-if="!asking"
        type="button"
        class="ui-button ui-button--secondary"
        data-testid="btn-record-test"
        title="Record a playtest — check that this part still works after changes"
        :disabled="state.powerUp.busy || state.recording.active || state.recording.starting"
        @click="onRecordPlaytest"
      >
        Playtest
      </button>
      <button
        type="submit"
        class="ui-button ui-button--primary"
        data-testid="agent-bubble-send"
        :disabled="state.powerUp.busy || !powerUpLine.trim()"
      >
        {{ state.powerUp.busy ? "Working…" : asking ? "Ask" : "Remix" }}
      </button>
    </form>
    <!-- Playtest recording is editing tooling but needs no AI connection —
         it stays reachable while the provider prompt is all the bubble shows. -->
    <div v-if="!asking && !creatingRoom && state.powerUp.needsConfig" class="agent-bubble-tools">
      <button
        type="button"
        class="ui-button ui-button--secondary"
        data-testid="btn-record-test"
        title="Record a playtest — check that this part still works after changes"
        :disabled="state.powerUp.busy || state.recording.active || state.recording.starting"
        @click="onRecordPlaytest"
      >
        Playtest
      </button>
    </div>
    <p v-if="state.powerUp.error" class="agent-bubble-error" data-testid="agent-bubble-error">
      {{ state.powerUp.error }}
    </p>
  </section>
</template>

<style scoped>
/*
 * The assistant fills its host: the Play drawer or the Create dock. Neither
 * floats over the game — the stage resizes beside it, or the drawer overlays
 * on narrow screens (App.vue owns the host geometry).
 */
.agent-bubble {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4) var(--space-5) var(--space-5);
  color: var(--ink);
  background: var(--surface-1);
  font: var(--text-md) / var(--leading) var(--font-sans);
  text-align: left;
}

.agent-bubble-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0 0 var(--space-3);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--hairline);
  color: var(--ink-2);
  font-size: var(--text-xs);
}

.agent-bubble-title {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--ink);
  font: var(--weight-semibold) var(--text-md) / var(--leading-tight) var(--font-sans);
}
.agent-bubble-title .ui-icon {
  color: var(--action);
}

.agent-bubble-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}

.agent-bubble-room {
  color: var(--ink-3);
  white-space: nowrap;
}

/* The close button keeps a 44px hit area at every pointer size; negative
   margins keep the compact header row from growing. */
.bubble-close {
  display: inline-grid;
  place-items: center;
  min-width: var(--control-h-touch);
  min-height: var(--control-h-touch);
  margin: calc(var(--space-4) * -1) calc(var(--space-3) * -1) calc(var(--space-4) * -1) 0;
  padding: 0;
  border: 0;
  border-radius: var(--radius);
  color: var(--ink-2);
  background: none;
  cursor: pointer;
}
.bubble-close:hover:not(:disabled) {
  color: var(--ink);
  background: var(--surface-3);
}

.agent-mode-switch {
  display: flex;
  gap: var(--space-0);
  padding: 3px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  background: var(--surface-0);
}
.agent-mode-switch button {
  min-height: var(--control-h-touch);
  padding: 0 var(--space-4);
  border: 0;
  border-radius: var(--radius);
  color: var(--ink-2);
  background: transparent;
  font: var(--weight-semibold) var(--text-sm) / 1 var(--font-sans);
  cursor: pointer;
}
.agent-mode-switch button[aria-pressed="true"] {
  color: var(--ink);
  background: var(--surface-3);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}

/* Inspector entry beside the mode switch: a toggle (the dock outlives the panel). */
.agent-inspect {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink-2);
  background: transparent;
  font: var(--weight-semibold) var(--text-xs) / 1 var(--font-sans);
  white-space: nowrap;
  cursor: pointer;
}
.agent-inspect:hover {
  color: var(--ink);
  background: var(--surface-3);
}
.agent-inspect.on {
  color: var(--action);
  border-color: var(--action-line);
  background: var(--action-soft);
}

.agent-conversation {
  flex: 1 1 auto;
  min-height: 96px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4) 0;
  font: var(--text-md) / 1.55 var(--font-sans);
}
.agent-message {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.agent-message.user {
  align-self: flex-end;
  max-width: 90%;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
}
.agent-message.assistant {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  color: var(--ink-2);
  background: var(--surface-2);
}
.agent-activity {
  margin-top: var(--space-3);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.agent-activity summary {
  cursor: pointer;
}
.agent-bubble button:disabled {
  opacity: 0.5;
  cursor: default;
}
.agent-bubble-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: stretch;
  gap: var(--space-3);
  margin-top: auto;
  padding-top: var(--space-4);
}
.agent-bubble-form--remix textarea {
  grid-column: 1 / -1;
}
.agent-bubble-form textarea {
  box-sizing: border-box;
  min-width: 0;
  margin: 0;
  padding: var(--space-3) var(--space-4);
  resize: none;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-0);
  font: var(--text-md) / var(--leading) var(--font-sans);
}
.agent-bubble-form button {
  margin: 0;
  min-width: 72px;
  align-self: stretch;
}

.remix-progress {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--hairline);
  color: var(--action);
  font-size: var(--text-xs);
}
.remix-progress progress {
  flex-shrink: 0;
  width: 48px;
  height: 4px;
  accent-color: var(--action);
}

.agent-bubble-feed {
  margin-top: var(--space-3);
  max-height: 160px;
  min-height: 0;
  overflow-y: auto;
  overflow-anchor: none;
  overscroll-behavior: contain;
  scrollbar-color: var(--hairline-strong) transparent;
  scrollbar-width: thin;
  font-size: var(--text-xs);
  line-height: var(--leading);
}
.remix-follow-controls {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--space-2);
}
.agent-bubble-line {
  color: var(--ink-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.agent-bubble-line.error {
  color: var(--danger);
}
.agent-bubble-line.hint {
  color: var(--ink-3);
}
.agent-bubble-error {
  margin: var(--space-2) 0 0;
  color: var(--danger);
  font-size: var(--text-xs);
}
.agent-bubble-tools {
  margin-top: var(--space-4);
}
.assistant-connect {
  margin-top: var(--space-4);
}
</style>
