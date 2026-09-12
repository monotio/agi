<script setup lang="ts">
/**
 * The top chrome: title block, the game-nav menus (Controls, Settings, Game
 * actions, Menu), the export/eject refusal banners, the test-recording bar
 * and its save dialog. The default slot sits where the walkthrough bar
 * renders. The engine API is injected, never passed as a prop.
 */
import ActionMenu from "./ActionMenu.vue";
import UiIcon from "./UiIcon.vue";
import { computed, onMounted, onUnmounted, ref, useTemplateRef } from "vue";
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
  exportSavedProgressKey: string | undefined;
}>();

const emit = defineEmits<{
  "update:touchControls": [value: boolean];
  "update:crtEnabled": [value: boolean];
  "update:debugOpen": [value: boolean];
  "trigger-key": [code: number];
  "export-zip": [project: boolean, savedProgress: boolean];
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
} = useEngineApi();
const { aiModelLabel, aiSettingsUnavailable, openAiSettings, llmConfig } = useAiSettings();
const bridge = useShellBridge();

const controlsEl = useTemplateRef("controlsEl");

function closeNavMenus(restoreFocus = false): void {
  for (const menu of [controlsEl.value]) {
    if (!menu?.open) continue;
    menu.open = false;
    if (restoreFocus) menu.querySelector("summary")?.focus();
  }
}
bridge.closeNavMenus = closeNavMenus;

function onNavToggle(event: Event): void {
  const current = event.target as HTMLDetailsElement;
  if (!current.open) return;
  for (const menu of [controlsEl.value]) {
    if (menu && menu !== current) menu.open = false;
  }
}
const shortcuts = computed(() => gameShortcuts(state.controls));
const shortcutsBlocked = computed(
  () => state.paused || state.modal !== null || state.prompt !== null || state.textMode,
);

function onOutsideControls(event: PointerEvent): void {
  for (const menu of [controlsEl.value]) {
    if (event.target instanceof Node && menu && !menu.contains(event.target)) menu.open = false;
  }
}

function triggerKey(code: number): void {
  closeNavMenus();
  emit("trigger-key", code);
}

/** The power-up toggle lives in AgentBubble; the shell bridge routes to it. */
function onPowerUp(): void {
  bridge.togglePowerUp();
}

function onStartOver(): void {
  emit("start-over");
}

function onStartWalkthrough(targetGame: string): void {
  emit("start-walkthrough", targetGame);
}

/** Live exports only; the shell owns the export path and the refusal banner. */
function onExportAgiZip(_live: boolean, project = false, savedProgress = false): void {
  emit("export-zip", project, savedProgress);
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

onMounted(() => {
  document.addEventListener("pointerdown", onOutsideControls);
});
onUnmounted(() => {
  document.removeEventListener("pointerdown", onOutsideControls);
});
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
      <details
        v-if="state.phase === 'running'"
        ref="controlsEl"
        class="game-controls nav-menu"
        data-testid="game-controls"
        @keydown.esc.prevent.stop="closeNavMenus(true)"
        @toggle="onNavToggle"
      >
        <summary class="ui-button ui-button--secondary audio-btn">
          Controls <UiIcon name="chevron" />
        </summary>
        <div class="game-controls-panel">
          <p v-if="!shortcuts.length" class="controls-hint">
            Shortcuts appear here when the game registers them.
          </p>
          <template v-else>
            <p class="controls-hint">
              Shortcuts from this game. Actions can depend on the current scene.
            </p>
            <p v-if="shortcutsBlocked" class="controls-hint">
              Return to the game to use shortcuts.
            </p>
            <div class="shortcut-list">
              <button
                v-for="shortcut in shortcuts"
                :key="shortcut.key"
                :data-key="shortcut.key"
                type="button"
                class="game-shortcut"
                :disabled="shortcut.disabled || shortcutsBlocked"
                :title="
                  shortcut.disabled ? 'Disabled in the game menu' : shortcut.heading || undefined
                "
                @click="triggerKey(shortcut.key)"
              >
                <span>{{ shortcut.label }}</span>
                <kbd v-if="shortcut.hasLabel && shortcut.keyLabel">{{ shortcut.keyLabel }}</kbd>
              </button>
            </div>
          </template>
        </div>
      </details>
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
          type="button"
          role="menuitem"
          data-testid="open-ai-settings"
          :disabled="aiSettingsUnavailable"
          @click="openAiSettings($event, 'header')"
        >
          <span
            >AI provider<small>{{ aiModelLabel }}</small></span
          >
          <span class="setting-value">Change</span>
        </button>
        <button
          type="button"
          role="menuitemcheckbox"
          :aria-checked="touchControls"
          data-testid="toggle-touch-controls"
          @click="$emit('update:touchControls', !touchControls)"
        >
          <span>Touch controls<small>Directions, keyboard and game keys</small></span>
          <span class="setting-value">{{ touchControls ? "On" : "Off" }}</span>
        </button>
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
            >Sound {{ state.soundMuted ? "off" : "on"
            }}<small>Linked to the game’s sound setting</small></span
          >
          <span class="setting-value">{{ state.soundMuted ? "Off" : "On" }}</span>
        </button>
        <button
          role="menuitem"
          data-testid="toggle-sound-mode"
          data-keep-open
          @click="
            resumeAudio();
            setAudioMode(state.soundMode === 'tandy' ? 'pc-speaker' : 'tandy');
          "
        >
          <span
            >Sound chip<small>{{
              state.soundMode === "tandy" ? "Tandy 4-Voice" : "PC Speaker"
            }}</small></span
          >
          <span class="setting-value">Change</span>
        </button>
        <button
          v-if="gpuBackend"
          type="button"
          role="menuitemcheckbox"
          :aria-checked="crtEnabled"
          data-testid="toggle-crt"
          @click="$emit('update:crtEnabled', !crtEnabled)"
        >
          <span>CRT display<small>Scanlines, glow and curved glass</small></span>
          <span class="setting-value">{{ crtEnabled ? "On" : "Off" }}</span>
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
      </ActionMenu>
      <ActionMenu
        v-if="state.phase === 'running'"
        label="Game actions"
        icon="more"
        icon-only
        test-id="game-actions-menu"
      >
        <button
          type="button"
          role="menuitem"
          data-testid="menu-assistant"
          :disabled="state.powerUp.busy"
          @click="onPowerUp"
        >
          <span>Assistant<small>Ask about or remix this game</small></span>
          <span class="setting-value">✦</span>
        </button>
        <button
          v-if="hasWalkthrough(currentGame()?.alias ?? '') && !state.walkthrough.active"
          type="button"
          role="menuitem"
          data-testid="btn-run-walkthrough"
          @click="onStartWalkthrough(currentGame()!.alias!)"
        >
          <span>Run walkthrough<small>Watch real-time playthrough</small></span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="btn-world-map"
          @click="
            closeNavMenus();
            roomMap.openMap();
          "
        >
          <span>World map<small>Rooms you have seen, planned and found in logic</small></span>
        </button>
        <button type="button" role="menuitem" data-testid="btn-start-over" @click="onStartOver">
          Start over
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="btn-record-test"
          :disabled="state.recording.active || state.recording.starting || state.powerUp.busy"
          @click="onRecordStart"
        >
          <span>Record as game test<small>Replayable project regression test</small></span>
        </button>
        <div role="separator"></div>
        <button
          type="button"
          role="menuitem"
          data-testid="btn-export-live-zip"
          :disabled="exportBusy || state.powerUp.busy"
          @click="onExportAgiZip(true)"
        >
          <span>Game export<small>Playable game</small></span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="btn-save-live-project"
          :disabled="exportBusy || state.powerUp.busy"
          @click="onExportAgiZip(true, true)"
        >
          <span>Project<small>Game, editing history and world map</small></span>
        </button>
      </ActionMenu>
      <button
        v-if="state.phase === 'running'"
        class="ui-button ui-button--secondary audio-btn"
        data-testid="btn-eject"
        :disabled="state.powerUp.busy || state.leaving"
        title="Return to adventure selection menu"
        @click="onEjectGame(false)"
      >
        {{ state.leaving ? "Saving…" : "Menu" }}
      </button>
    </nav>
  </header>
  <div v-if="exportRefusal" class="export-refusal" data-testid="export-refusal" role="alert">
    <p>{{ exportRefusal }}</p>
    <button
      v-if="
        exportSavedProgressKey !== undefined &&
        exportSavedProgressKey === (currentGame()?.projectId ?? currentGame()?.hash)
      "
      type="button"
      class="ui-button ui-button--secondary"
      data-testid="export-saved-progress"
      :disabled="exportBusy"
      @click="onExportAgiZip(true, true, true)"
    >
      Download without current progress
    </button>
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
      <p v-if="recordSnapshot?.usedGetnum" class="record-warning" data-testid="record-warning">
        This recording answered a get.number prompt, which stored tests cannot replay yet; the saved
        test will need editing.
      </p>
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
.record-warning {
  color: #ffd977;
  font-size: 12px;
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
.nav-menu[open] > summary {
  border-color: #7fe8ee;
  color: #e5f2f2;
}
@media (max-width: 600px) {
  .game-nav {
    width: 100%;
    justify-content: space-between;
    gap: 0.25rem;
  }
  .game-nav .nav-menu {
    position: static;
  }
  .game-nav :deep(.ui-button),
  .game-nav .nav-menu summary {
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
  .game-nav .game-controls-panel {
    left: 0;
    right: auto;
    width: 100%;
    max-height: min(60vh, 28rem);
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

.nav-menu {
  position: static;
  color: #dce8e9;
}
.nav-menu summary {
  min-height: 44px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  list-style: none;
}
.nav-menu summary::-webkit-details-marker {
  display: none;
}
.game-controls-panel {
  position: absolute;
  z-index: 20;
  top: calc(100% + 0.6rem);
  right: 0;
  width: min(24rem, calc(100vw - 2rem));
  max-height: min(60vh, 28rem);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0.75rem;
  box-sizing: border-box;
  border: 1px solid #6bafb5;
  border-radius: 10px;
  background: #0b171df5;
  box-shadow: 0 12px 36px #000a;
  text-align: left;
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
</style>
