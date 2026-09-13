<script setup lang="ts">
import { computed, nextTick, onWatcherCleanup, ref, useTemplateRef, watch } from "vue";
import AgentTaskControls from "./AgentTaskControls.vue";
import SoundPreview from "./SoundPreview.vue";
import { useEngineApi } from "./engineContext.ts";
import { usePresentation } from "./usePresentation.ts";
import { useShellBridge } from "./shellBridge.ts";
import { useAiSettings } from "./useAiSettings.ts";

const engine = useEngineApi();
const { state, openPowerUp, closePowerUp, submitPowerUp, stopAgent, continueAgent, discardAgent } =
  engine;
const { debugOpen } = usePresentation();
const bridge = useShellBridge();
const { aiConfigured, aiSettingsUnavailable, openAiSettings, llmConfig } = useAiSettings();

/**
 * The remix: one round button on the
 * game frame. Click it and the world freezes at the next cycle boundary while
 * the agent takes your instruction; the bubble streams its tool calls; its
 * closing sentence closes the bubble, the room re-enters if it was patched,
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

/** The power-up bubble is draggable by its head and collapsible to a strip. */
const bubblePos = ref<{ x: number; y: number }>();
const bubbleCollapsed = ref(false);
let bubbleDrag: { px: number; py: number; ox: number; oy: number } | null = null;

function onBubbleHeadDown(ev: PointerEvent): void {
  const t = ev.target as HTMLElement;
  if (t.closest("button,input,textarea,select,a,summary")) return;
  const bubble = (ev.currentTarget as HTMLElement).closest(".agent-bubble");
  if (!(bubble instanceof HTMLElement)) return;
  const r = bubble.getBoundingClientRect();
  bubblePos.value = { x: r.left, y: r.top };
  bubbleDrag = { px: ev.clientX, py: ev.clientY, ox: r.left, oy: r.top };
  (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  ev.preventDefault();
}

function onBubbleHeadMove(ev: PointerEvent): void {
  if (!bubbleDrag) return;
  bubblePos.value = {
    x: Math.min(Math.max(bubbleDrag.ox + ev.clientX - bubbleDrag.px, -160), window.innerWidth - 80),
    y: Math.min(Math.max(bubbleDrag.oy + ev.clientY - bubbleDrag.py, 0), window.innerHeight - 40),
  };
}

function onBubbleHeadUp(): void {
  bubbleDrag = null;
}

async function onPowerUp(): Promise<void> {
  if (state.powerUp.busy) return;
  if (state.powerUp.open) {
    closePowerUp();
    bridge.focusGameInput();
    return;
  }
  powerUpLine.value = "";
  await openPowerUp(llmConfig());
  await nextTick();
  powerUpEl.value?.focus({ preventScroll: true });
}
bridge.togglePowerUp = () => void onPowerUp();
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
  <div
    v-if="state.powerUp.open"
    class="agent-bubble"
    :class="{ floating: bubblePos !== undefined, collapsed: bubbleCollapsed }"
    :style="bubblePos ? { left: `${bubblePos.x}px`, top: `${bubblePos.y}px` } : {}"
    data-testid="agent-bubble"
    @click.stop
    @pointerdown.stop
  >
    <div
      class="agent-bubble-head"
      data-testid="agent-bubble-head"
      title="Drag to move"
      @pointerdown="onBubbleHeadDown"
      @pointermove="onBubbleHeadMove"
      @pointerup="onBubbleHeadUp"
      @pointercancel="onBubbleHeadUp"
    >
      <span class="agent-bubble-grip">⠿</span>
      <span v-if="creatingRoom" class="agent-bubble-title">{{
        state.powerUp.error ? "Could not create this room" : "Creating the next room"
      }}</span>
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
        type="button"
        class="agent-inspect"
        :class="{ on: debugOpen }"
        data-testid="inspect-toggle"
        :aria-pressed="debugOpen"
        title="AGI inspector: priority views, objects, vars, flags, trace"
        @click="debugOpen = !debugOpen"
      >
        ◈ Inspect
      </button>
      <span class="agent-bubble-right">
        <span class="agent-bubble-room" data-testid="agent-bubble-room"
          >{{ asking ? "Read-only" : "Paused" }} ·
          {{ state.powerUp.room > 0 ? `room ${state.powerUp.room}` : "…" }}</span
        >
        <button
          type="button"
          class="bubble-icon"
          data-testid="agent-bubble-collapse"
          :title="bubbleCollapsed ? 'Expand' : 'Collapse to the title bar'"
          @click="bubbleCollapsed = !bubbleCollapsed"
        >
          {{ bubbleCollapsed ? "+" : "−" }}
        </button>
        <button
          v-if="!creatingRoom || !state.powerUp.busy"
          type="button"
          class="bubble-icon bubble-close remix-close"
          data-testid="agent-bubble-close"
          aria-label="Back to game"
          title="Back to game (Esc)"
          :disabled="state.powerUp.busy"
          @click="onPowerUp"
        >
          ×
        </button>
      </span>
    </div>
    <div v-if="!creatingRoom && !aiConfigured" class="ai-connect assistant-connect">
      <p>Connect your AI provider to ask about or remix this game.</p>
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
    <form
      v-if="!creatingRoom && !state.powerUp.needsConfig"
      class="agent-bubble-form"
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
        type="submit"
        class="ui-button ui-button--primary"
        data-testid="agent-bubble-send"
        :disabled="state.powerUp.busy || !powerUpLine.trim()"
      >
        {{ state.powerUp.busy ? "Working…" : asking ? "Ask" : "Remix" }}
      </button>
    </form>
    <p v-if="state.powerUp.error" class="agent-bubble-error" data-testid="agent-bubble-error">
      {{ state.powerUp.error }}
    </p>
  </div>
</template>

<style scoped>
/* Inspector entry inside the power-up header: same segmented control
   language, but a toggle (the dock outlives the bubble). */
.agent-inspect {
  background: #081217;
  border: 1px solid #38515b;
  border-radius: 8px;
  color: var(--ui-action);
  font: inherit;
  font-size: 12px;
  padding: 5px 10px;
  cursor: pointer;
  white-space: nowrap;
}

.agent-inspect:hover {
  border-color: var(--ui-action-hover);
  color: var(--ui-action-hover);
  background: var(--ui-action-surface-hover);
}

.agent-inspect.on {
  color: var(--ui-action-ink);
  background: var(--ui-action);
  border-color: var(--ui-action);
}

.agent-bubble {
  font-family: system-ui, sans-serif;
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  box-sizing: border-box;
  background: rgba(6, 12, 20, 0.96);
  border: 1px solid #55ffff;
  border-radius: 10px;
  padding: 16px;
  text-align: left;
  z-index: 4;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.6);
  transition:
    opacity 160ms ease-out,
    transform 160ms ease-out;
}

@starting-style {
  .agent-bubble {
    opacity: 0;
  }
}

/* Dragged free of its centred position, or collapsed to the title strip. */
.agent-bubble.floating {
  transform: none;
}

.agent-bubble.collapsed {
  width: auto;
  max-width: calc(100vw - 32px);
  padding-bottom: 10px;
}

.agent-bubble.collapsed > *:not(.agent-bubble-head) {
  display: none;
}

.agent-bubble.collapsed .agent-bubble-head {
  margin-bottom: 0;
}

.agent-bubble-grip {
  color: #3d5a6e;
  font-size: 10px;
  flex: none;
}

.bubble-icon {
  background: none;
  border: none;
  border-radius: 4px;
  color: #7e9aac;
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  white-space: nowrap;
}

.bubble-icon:hover {
  color: var(--ui-action-hover);
}

.bubble-icon.bubble-close:hover {
  color: var(--ui-danger-hover);
}

/* The close button keeps a 44px hit area at every pointer size; negative
   margins keep the compact header row from growing. */
.bubble-icon.bubble-close {
  min-width: 44px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: -11px -7px;
}

.bubble-icon:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Finger-sized targets on touch devices. */
@media (any-pointer: coarse) {
  .bubble-icon {
    min-width: 44px;
    min-height: 44px;
    padding: 10px;
    font-size: 18px;
  }
}

.agent-bubble-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  cursor: grab;
  touch-action: none;
  user-select: none;
  font-size: 12px;
  letter-spacing: 0.02em;
  color: #55ffff;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid #1d3a46;
}

.agent-bubble-right {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  align-self: flex-start;
}

.agent-bubble-head:active {
  cursor: grabbing;
}

.agent-bubble-head button {
  cursor: pointer;
}

.agent-bubble-room {
  color: #aaaaaa;
}

.agent-bubble-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: stretch;
  gap: 8px;
  margin-top: 12px;
}
.agent-mode-switch {
  display: flex;
  padding: 3px;
  background: #081217;
  border: 1px solid #38515b;
  border-radius: 8px;
}
.agent-mode-switch button {
  min-height: 44px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #a9bac0;
  padding: 7px 12px;
  font:
    700 14px/1.4 system-ui,
    sans-serif;
  cursor: pointer;
}

/* Desktop: the switch shares the header row with small icon buttons — keep
   the 44px target but tighten padding and type so the head stays compact. */
@media (any-pointer: fine) {
  .agent-mode-switch button {
    padding: 5px 10px;
    font-size: 12px;
  }
}
.agent-mode-switch button[aria-pressed="true"] {
  background: #20454e;
  color: #a5ffff;
}
.agent-bubble.collapsed .agent-bubble-head {
  border-bottom: none;
  padding-bottom: 0;
}
.agent-conversation {
  max-height: min(32dvh, 260px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 0;
  font:
    14px/1.55 system-ui,
    sans-serif;
}
.agent-message {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.agent-message.user {
  align-self: flex-end;
  max-width: 90%;
  background: #173039;
  padding: 8px 12px;
  border-radius: 10px 10px 2px 10px;
}
.agent-message.assistant {
  color: #e3ecee;
}
.agent-activity {
  font-size: 12px;
  color: #8da4ac;
  margin-top: 10px;
}
.agent-activity summary {
  cursor: pointer;
}
.agent-bubble button:disabled {
  opacity: 0.5;
  cursor: default;
}
.agent-bubble-form textarea {
  box-sizing: border-box;
  resize: none;
  margin: 0;
  flex: 1;
  min-width: 0;
  background: #04080c;
  border: 1px solid #2a4a55;
  color: #e8e8e8;
  padding: 10px 12px;
  font: inherit;
  font-size: 14px;
  border-radius: 4px;
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
  gap: 12px;
  padding: 10px 0 8px;
  color: #a8eeee;
  font-size: 12px;
  border-bottom: 1px solid #294047;
}

.remix-progress progress {
  width: 48px;
  height: 4px;
  flex-shrink: 0;
  accent-color: #55ffff;
}

.agent-bubble-feed {
  margin-top: 8px;
  max-height: 160px;
  min-height: 0;
  overflow-y: auto;
  overflow-anchor: none;
  overscroll-behavior: contain;
  scrollbar-color: #48666e transparent;
  scrollbar-width: thin;
  font-size: 12px;
  line-height: 1.5;
}

.remix-follow-controls {
  display: flex;
  justify-content: flex-end;
  padding-top: 6px;
}

.agent-bubble-line {
  color: #c8d6d9;
  white-space: pre-wrap;
  word-break: break-word;
}

.agent-bubble-line.error {
  color: #ff5555;
}

.agent-bubble-line.hint {
  color: #b4c8cc;
}

.agent-bubble-error {
  color: #ff5555;
  font-size: 11px;
  margin: 6px 0 0;
}

.assistant-connect {
  margin-top: 12px;
}
</style>
