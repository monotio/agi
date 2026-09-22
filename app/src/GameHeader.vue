<script setup lang="ts">
/**
 * The top chrome: title block, the game-nav menus (Help, Settings, Game,
 * Exit), the export/eject refusal banners, the test-recording bar
 * and its save dialog. The default slot sits where the walkthrough bar
 * renders. The engine API is injected, never passed as a prop.
 */
import ActionMenu from "./ActionMenu.vue";
import { computed, ref, useTemplateRef } from "vue";
import { useEngineApi } from "./engineContext.ts";
import { useAiSettings } from "./useAiSettings.ts";
import { useShellBridge } from "./shellBridge.ts";
import { gameShortcuts } from "./gameControls.ts";
import { hasWalkthrough } from "./walkthrough.ts";
import {
  suggestAssertions,
  type AssertionSuggestion,
  type RecordingSnapshot,
} from "./gameRecording.ts";

defineProps<{
  touchControls: boolean;
  crtEnabled: boolean;
  gpuBackend: string | undefined;
  debugOpen: boolean;
  exportBusy: boolean;
  exportRefusal: string;
}>();

const emit = defineEmits<{
  "update:touchControls": [value: boolean];
  "update:crtEnabled": [value: boolean];
  "update:debugOpen": [value: boolean];
  "trigger-key": [code: number];
  "export-zip": [project: boolean];
  "start-over": [];
  "start-walkthrough": [target: string];
}>();

const {
  state,
  resumeAudio,
  toggleMute,
  setAudioMode,
  currentGame,
  ejectGame,
  startTestRecording,
  stopTestRecording,
  cancelTestRecording,
  saveRecordedTest,
  roomMap,
  retryHistorySave,
} = useEngineApi();
const { aiModelLabel, aiSettingsUnavailable, openAiSettings, llmConfig } = useAiSettings();
const bridge = useShellBridge();

const controlsDialog = useTemplateRef("controlsDialog");

function closeNavMenus(restoreFocus = false): void {
  void restoreFocus;
  if (controlsDialog.value?.open) controlsDialog.value.close();
}
bridge.closeNavMenus = closeNavMenus;

const shortcuts = computed(() => gameShortcuts(state.controls));
const shortcutsBlocked = computed(
  () => state.paused || state.modal !== null || state.prompt !== null || state.textMode,
);

function triggerKey(code: number): void {
  closeNavMenus();
  emit("trigger-key", code);
}

/** The power-up toggle lives in AgentBubble; the shell bridge routes to it. */
function onPowerUp(mode?: "ask" | "remix"): void {
  bridge.togglePowerUp(mode);
}

function onStartOver(): void {
  emit("start-over");
}

function onStartWalkthrough(targetGame: string): void {
  emit("start-walkthrough", targetGame);
}

/** Live exports only; the shell owns the export path and the refusal banner. */
function onExportAgiZip(_live: boolean, project = false): void {
  emit("export-zip", project);
}

async function onEjectGame(abandonUnsaved = false): Promise<void> {
  ejectRefusal.value = "";
  try {
    await ejectGame(abandonUnsaved ? { abandonUnsaved: true } : undefined);
    ejectRefusal.value = "";
  } catch (error) {
    ejectRefusal.value = String(error).replace(/^Error: /, "");
  }
}
const ejectRefusal = ref<string>("");

/** Settings' Advanced disclosure: sound-chip and diagnostics live under it. */
const settingsAdvanced = ref(false);

/** Game-test recording: the worker captures; this dialog names and saves. */
const recordDialog = useTemplateRef("recordDialog");
const recordSnapshot = ref<RecordingSnapshot>();
const recordSuggestions = ref<AssertionSuggestion[]>([]);
const recordName = ref("");
const recordError = ref("");
const recordResult = ref("");
const recordSaving = ref(false);

async function onRecordStart(): Promise<void> {
  recordResult.value = "";
  resumeAudio();
  await startTestRecording();
}
bridge.startPlaytest = () => void onRecordStart();

async function onRecordStop(): Promise<void> {
  const snapshot = await stopTestRecording();
  if (!snapshot) return;
  if (snapshot.tainted) {
    recordResult.value = "";
    state.recording.error = `Recording discarded: ${snapshot.tainted}.`;
    return;
  }
  recordSnapshot.value = snapshot;
  recordSuggestions.value = suggestAssertions(
    snapshot.start.state,
    snapshot.endState,
    snapshot.printed,
  );
  recordName.value = "";
  recordError.value = "";
  recordDialog.value?.showModal();
}

async function onRecordSave(): Promise<void> {
  const snapshot = recordSnapshot.value;
  const name = recordName.value.trim();
  if (!snapshot) return;
  if (!name) {
    recordError.value = "Name the test before saving it.";
    return;
  }
  recordSaving.value = true;
  recordError.value = "";
  try {
    const result = await saveRecordedTest(
      snapshot,
      name,
      recordSuggestions.value.filter((suggestion) => suggestion.selected),
      llmConfig(),
    );
    if (!result.ok) {
      recordError.value = result.message;
      return;
    }
    recordDialog.value?.close();
    recordResult.value = result.message;
  } finally {
    recordSaving.value = false;
  }
}
</script>
<template>
  <header class="header">
    <div class="header-brand">
      <a
        v-if="state.phase === 'idle' || state.phase === 'error'"
        class="publisher"
        href="https://monotio.com"
        >MONOTIO <span>/ AGI</span></a
      >
      <h1 v-else>AGI IS HERE</h1>
      <span v-if="state.phase === 'running'" class="tagline">Play. Create. Remix.</span>
    </div>
    <nav
      v-if="['idle', 'error', 'running'].includes(state.phase)"
      class="game-nav"
      aria-label="App options"
    >
      <ActionMenu v-if="state.phase === 'running'" label="Help" test-id="help-menu">
        <button
          type="button"
          role="menuitem"
          data-testid="btn-game-controls"
          @click="controlsDialog?.showModal()"
        >
          <span>Game controls<small>Movement, input and this game's keys</small></span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="btn-world-map"
          @click="roomMap.openMap({ experience: 'play' })"
        >
          <span>Map<small>Rooms you have walked</small></span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="menu-assistant"
          :disabled="state.powerUp.busy || state.historyView.active"
          @click="onPowerUp('ask')"
        >
          <span>Ask for a hint…<small>Answers without changing the game</small></span>
        </button>
        <button
          v-if="hasWalkthrough(currentGame()?.revision ?? '') && !state.walkthrough.active"
          type="button"
          role="menuitem"
          data-testid="btn-run-walkthrough"
          @click="onStartWalkthrough(currentGame()!.alias!)"
        >
          <span
            >Watch walkthrough<small
              >A recorded playthrough — it shows puzzle solutions</small
            ></span
          >
        </button>
      </ActionMenu>
      <a
        v-if="state.phase === 'idle' || state.phase === 'error'"
        class="ui-button ui-button--secondary repo-link"
        href="https://github.com/monotio/agi"
        target="_blank"
        rel="noopener"
        aria-label="Source on GitHub"
        data-testid="github-link"
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
          />
        </svg>
        <span>GitHub</span>
      </a>
      <ActionMenu label="Settings" test-id="settings-menu">
        <button
          role="menuitemcheckbox"
          data-testid="toggle-mute"
          :aria-checked="!state.soundMuted"
          @click="
            resumeAudio();
            toggleMute();
          "
        >
          <span
            >Sound<small
              >{{ state.soundMuted ? "Off" : "On" }} — linked to the game’s sound setting</small
            ></span
          >
          <span class="setting-value">{{ state.soundMuted ? "Off" : "On" }}</span>
        </button>
        <button
          v-if="gpuBackend"
          type="button"
          role="menuitemcheckbox"
          :aria-checked="crtEnabled"
          data-testid="toggle-crt"
          @click="$emit('update:crtEnabled', !crtEnabled)"
        >
          <span>Display<small>CRT scanlines, glow and curved glass</small></span>
          <span class="setting-value">{{ crtEnabled ? "On" : "Off" }}</span>
        </button>
        <button
          type="button"
          role="menuitemcheckbox"
          :aria-checked="touchControls"
          data-testid="toggle-touch-controls"
          @click="$emit('update:touchControls', !touchControls)"
        >
          <span>On-screen controls<small>Directions, keyboard and game keys</small></span>
          <span class="setting-value">{{ touchControls ? "On" : "Off" }}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="open-ai-settings"
          :disabled="aiSettingsUnavailable"
          @click="openAiSettings($event, 'header')"
        >
          <span
            >AI settings…<small>{{ aiModelLabel }}</small></span
          >
          <span class="setting-value">Change</span>
        </button>
        <div role="separator"></div>
        <button
          type="button"
          role="menuitem"
          data-testid="settings-advanced"
          data-keep-open
          :aria-expanded="settingsAdvanced"
          @click="settingsAdvanced = !settingsAdvanced"
        >
          <span>Advanced…<small>Sound chip emulation and diagnostics</small></span>
        </button>
        <template v-if="settingsAdvanced">
          <button
            role="menuitem"
            data-testid="toggle-sound-mode"
            data-keep-open
            @click="
              resumeAudio();
              setAudioMode(
                state.soundMode === 'tandy'
                  ? 'pc-speaker'
                  : state.soundMode === 'pc-speaker'
                    ? 'amiga'
                    : state.soundMode === 'amiga'
                      ? 'iigs'
                      : 'tandy',
              );
            "
          >
            <span
              >Sound chip<small>{{
                state.soundMode === "tandy"
                  ? "Tandy 4-Voice"
                  : state.soundMode === "pc-speaker"
                    ? "PC Speaker"
                    : state.soundMode === "amiga"
                      ? "Amiga Paula"
                      : "Apple IIgs Ensoniq"
              }}</small></span
            >
            <span class="setting-value">Change</span>
          </button>
          <button
            v-if="state.phase === 'running'"
            type="button"
            role="menuitemcheckbox"
            :aria-checked="debugOpen"
            data-testid="settings-inspect"
            @click="$emit('update:debugOpen', !debugOpen)"
          >
            <span>Inspector<small>Priority layers, state and trace</small></span>
            <span class="setting-value">{{ debugOpen ? "On" : "Off" }}</span>
          </button>
        </template>
      </ActionMenu>
      <ActionMenu v-if="state.phase === 'running'" label="Game" test-id="game-menu">
        <button
          type="button"
          role="menuitem"
          data-testid="btn-edit-game"
          :disabled="state.powerUp.busy || state.historyView.active"
          @click="onPowerUp('remix')"
        >
          <span>Edit game…<small>Rooms, art and playtests</small></span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="btn-download-game"
          :disabled="exportBusy || state.powerUp.busy"
          @click="onExportAgiZip(true, true)"
        >
          <span
            >Download game…<small
              >For development: editing work, saved progress and history — a ZIP file</small
            ></span
          >
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="btn-export-game"
          :disabled="exportBusy || state.powerUp.busy"
          @click="onExportAgiZip(true)"
        >
          <span
            >Export game…<small
              >For publishing: playable game without private editing work or play history — a ZIP
              file</small
            ></span
          >
        </button>
        <div role="separator"></div>
        <button type="button" role="menuitem" data-testid="btn-start-over" @click="onStartOver">
          Start over
        </button>
      </ActionMenu>
      <button
        v-if="state.phase === 'running'"
        class="ui-button ui-button--secondary audio-btn"
        data-testid="btn-exit"
        :disabled="state.powerUp.busy || state.leaving"
        title="Exit to game selection"
        aria-label="Exit to game selection"
        @click="onEjectGame(false)"
      >
        {{ state.leaving ? "Saving…" : "Exit" }}
      </button>
    </nav>
  </header>
  <div v-if="exportRefusal" class="export-refusal" data-testid="export-refusal" role="alert">
    <p>{{ exportRefusal }}</p>
  </div>
  <div v-if="ejectRefusal" class="export-refusal" data-testid="eject-refusal" role="alert">
    <p>{{ ejectRefusal }}</p>
    <div style="display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap">
      <button
        type="button"
        class="ui-button ui-button--primary"
        data-testid="eject-retry"
        :disabled="state.leaving"
        @click="onEjectGame(false)"
      >
        Try again
      </button>
      <button
        type="button"
        class="ui-button ui-button--secondary"
        data-testid="eject-download-project"
        :disabled="exportBusy"
        @click="onExportAgiZip(true, true)"
      >
        Download project
      </button>
      <button
        type="button"
        class="ui-button ui-button--secondary"
        data-testid="eject-leave-anyway"
        :disabled="state.leaving"
        @click="onEjectGame(true)"
      >
        Leave anyway
      </button>
      <button
        type="button"
        class="ui-button ui-button--secondary"
        data-testid="eject-dismiss"
        @click="ejectRefusal = ''"
      >
        Back to game
      </button>
    </div>
  </div>
  <div
    v-if="state.historyUnsaved"
    class="history-unsaved"
    data-testid="history-unsaved"
    role="status"
  >
    <p>Play keeps recording; saving is retrying in the background.</p>
    <button
      type="button"
      class="ui-button ui-button--secondary"
      data-testid="history-retry"
      :title="`Not saved since ${new Date(state.historyUnsaved.since).toLocaleTimeString()}`"
      @click="retryHistorySave()"
    >
      Try now
    </button>
  </div>
  <div
    v-if="state.recording.active"
    class="recording-bar"
    data-testid="recording-bar"
    role="status"
  >
    <span class="recording-dot" aria-hidden="true"></span>
    <span>Recording game test</span>
    <button
      type="button"
      class="ui-button ui-button--primary"
      data-testid="record-stop"
      @click="onRecordStop"
    >
      Stop and name
    </button>
    <button
      type="button"
      class="ui-button ui-button--secondary"
      data-testid="record-cancel"
      @click="cancelTestRecording"
    >
      Cancel
    </button>
  </div>
  <slot />
  <p v-if="state.recording.error" class="export-refusal" data-testid="record-error" role="alert">
    {{ state.recording.error }}
  </p>
  <p v-if="recordResult" class="record-result" data-testid="record-result" role="status">
    {{ recordResult }}
  </p>
  <dialog
    ref="controlsDialog"
    class="controls-dialog"
    aria-labelledby="controls-dialog-title"
    data-testid="game-controls"
  >
    <header>
      <h2 id="controls-dialog-title">Game controls</h2>
      <button
        type="button"
        class="ui-button ui-button--secondary"
        data-testid="controls-close"
        @click="controlsDialog?.close()"
      >
        Close
      </button>
    </header>
    <p class="controls-hint">
      Arrow keys move. Type a command and press Enter. Escape opens the game's own menu.
    </p>
    <p v-if="!shortcuts.length" class="controls-hint">
      Shortcuts appear here when the game registers them.
    </p>
    <template v-else>
      <p class="controls-hint">
        Shortcuts from this game. Actions can depend on the current scene.
      </p>
      <p v-if="shortcutsBlocked" class="controls-hint">Return to the game to use shortcuts.</p>
      <div class="shortcut-list">
        <button
          v-for="shortcut in shortcuts"
          :key="shortcut.key"
          :data-key="shortcut.key"
          type="button"
          class="game-shortcut"
          :disabled="shortcut.disabled || shortcutsBlocked"
          :title="shortcut.disabled ? 'Disabled in the game menu' : shortcut.heading || undefined"
          @click="triggerKey(shortcut.key)"
        >
          <span>{{ shortcut.label }}</span>
          <kbd v-if="shortcut.hasLabel && shortcut.keyLabel">{{ shortcut.keyLabel }}</kbd>
        </button>
      </div>
    </template>
  </dialog>
  <dialog
    ref="recordDialog"
    class="record-dialog"
    aria-labelledby="record-dialog-title"
    data-testid="record-dialog"
  >
    <form method="dialog" @submit.prevent="onRecordSave">
      <header>
        <h2 id="record-dialog-title">Save as game test</h2>
      </header>
      <label for="record-name">Name</label>
      <input
        id="record-name"
        v-model="recordName"
        data-testid="record-name"
        maxlength="60"
        autocomplete="off"
        placeholder="what this playthrough proves"
      />
      <fieldset v-if="recordSuggestions.length" class="record-assertions">
        <legend>Assertions from this playthrough</legend>
        <label
          v-for="suggestion in recordSuggestions"
          :key="suggestion.id"
          class="record-assertion"
        >
          <input
            v-model="suggestion.selected"
            type="checkbox"
            :data-testid="`record-check-${suggestion.id}`"
          />
          {{ suggestion.label }}
        </label>
      </fieldset>
      <p v-if="recordError" class="dialog-error" role="alert" data-testid="record-save-error">
        {{ recordError }}
      </p>
      <footer>
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="record-save-cancel"
          :disabled="recordSaving"
          @click="recordDialog?.close()"
        >
          Discard
        </button>
        <button
          type="submit"
          class="ui-button ui-button--primary"
          data-testid="record-save"
          :disabled="recordSaving"
        >
          {{ recordSaving ? "Saving…" : "Save test" }}
        </button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.recording-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 6px 0 0;
  padding: 6px 10px;
  border: 1px solid #7a2a2a;
  border-radius: 8px;
  background: #2a1515;
  color: #ffd9d9;
  font-size: 13px;
}
.recording-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #ff4444;
  animation: recording-pulse 1.2s ease-in-out infinite;
}
@keyframes recording-pulse {
  50% {
    opacity: 0.25;
  }
}
.record-result {
  color: #9fe6a0;
  font-size: 12px;
  margin: 6px 0 0;
}
.record-dialog {
  background: #101d22;
  color: #e3ecee;
  border: 1px solid #2a4048;
  border-radius: 10px;
  padding: 18px 20px;
  width: min(480px, 92vw);
}
.record-dialog::backdrop {
  background: rgba(0, 0, 0, 0.55);
}
.record-dialog h2 {
  margin: 0 0 10px;
  font-size: 18px;
}
.record-dialog input[id="record-name"] {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin: 4px 0 12px;
  padding: 6px 8px;
  background: #0a1418;
  color: inherit;
  border: 1px solid #2a4048;
  border-radius: 6px;
}
.record-assertions {
  border: 1px solid #2a4048;
  border-radius: 8px;
  margin: 0 0 12px;
  max-height: 220px;
  overflow-y: auto;
}
.record-assertion {
  display: block;
  font-size: 13px;
  margin: 4px 0;
}
.dialog-error {
  color: #ff9b9b;
  font-size: 13px;
}
.record-dialog footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.header {
  width: var(--shell-width);
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.25rem;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.header-brand {
  display: flex;
  flex-direction: column;
}
.game-nav {
  margin-left: auto;
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.settings-panel {
  display: grid;
  gap: 0.35rem;
}
.game-shortcut small {
  display: block;
  margin-top: 0.25rem;
  color: #a7bec3;
  font-size: 12px;
  line-height: 1.4;
}
.setting-value {
  flex: none;
  margin-left: auto;
  color: #88e5eb;
  font-size: 12px;
  white-space: nowrap;
}
@media (max-width: 600px) {
  .game-nav {
    width: 100%;
    justify-content: space-between;
    gap: 0.25rem;
  }
  .game-nav :deep(.ui-button) {
    padding-inline: 6px;
    gap: 4px;
  }
  .game-nav :deep(.ui-icon) {
    width: 16px;
    height: 16px;
  }
  .at-menu .game-nav {
    width: auto;
  }
  .at-menu .repo-link {
    width: 44px;
    padding: 0;
  }
  .at-menu .repo-link span {
    display: none;
  }
}

h1 {
  font-size: 1.4rem;
  letter-spacing: 0.25em;
  margin: 0;
  color: #eee;
}

.tagline {
  font-size: 12px;
  color: #aaa;
  letter-spacing: 0.02em;
}

.publisher {
  color: #deeeee;
  text-decoration: none;
  font: 700 13px/1.5 monospace;
  letter-spacing: 0.16em;
}
.publisher span {
  color: #739193;
}
.repo-link svg {
  flex: none;
}

.controls-dialog {
  background: #0b171d;
  color: #e3ecee;
  border: 1px solid #6bafb5;
  border-radius: 10px;
  box-shadow: 0 12px 36px #000a;
  padding: 0.75rem 1rem;
  width: min(24rem, calc(100vw - 2rem));
  max-height: min(70vh, 32rem);
  overflow-y: auto;
  box-sizing: border-box;
}
.controls-dialog::backdrop {
  background: rgba(0, 0, 0, 0.55);
}
.controls-dialog header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  margin-bottom: 0.5rem;
}
.controls-dialog h2 {
  margin: 0;
  font-size: 16px;
}
.controls-hint {
  margin: 0.2rem 0.25rem 0.75rem;
  font:
    13px/1.5 system-ui,
    sans-serif;
  color: #a7bec3;
}
.shortcut-list {
  display: grid;
  gap: 0.25rem;
}
.game-shortcut {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  min-height: 44px;
  width: 100%;
  padding: 0.65rem 0.75rem;
  border: 1px solid transparent;
  border-radius: 5px;
  color: #e5f2f2;
  background: #13242c;
  cursor: pointer;
  text-align: left;
  font:
    15px/1.3 system-ui,
    sans-serif;
}
.game-shortcut:hover:not(:disabled) {
  background: #203a43;
  border-color: #59939b;
}
.game-shortcut:disabled {
  opacity: 0.45;
  cursor: default;
}
.game-shortcut kbd {
  color: #88e5eb;
  font: 12px monospace;
  white-space: nowrap;
}
@media (max-width: 600px) {
  .header {
    gap: 16px;
  }
}
</style>
