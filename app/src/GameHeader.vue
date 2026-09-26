<script setup lang="ts">
/**
 * The top chrome. At the menu screen: the brand, Help, GitHub and Settings.
 * While a game runs: the PlayBar, then the notices that belong above the
 * stage (export and eject refusals, history retries, the test-recording bar,
 * the walkthrough bar passed in the default slot). It also owns the dialogs
 * those controls open: the settings sheet, the Help guide, Game controls and
 * the recorded-test save dialog. The engine API is injected, never passed.
 */
import HelpGuide from "./HelpGuide.vue";
import PlayBar from "./shell/PlayBar.vue";
import SettingsSheet from "./shell/SettingsSheet.vue";
import UiButton from "./ui/UiButton.vue";
import type { HelpAction } from "./helpContent.ts";
import { computed, ref, useTemplateRef } from "vue";
import { useEngineApi } from "./engineContext.ts";
import { useAiSettings } from "./useAiSettings.ts";
import { useShellBridge } from "./shellBridge.ts";
import { useShell } from "./shell/useShell.ts";
import { gameShortcuts } from "./gameControls.ts";
import {
  suggestAssertions,
  type AssertionSuggestion,
  type RecordingSnapshot,
} from "./gameRecording.ts";

const {
  touchControls,
  crtEnabled,
  originalAspect,
  gpuBackend,
  debugOpen,
  exportBusy,
  exportRefusal,
} = defineProps<{
  touchControls: boolean;
  crtEnabled: boolean;
  originalAspect: boolean;
  gpuBackend: string | undefined;
  debugOpen: boolean;
  exportBusy: boolean;
  exportRefusal: string;
}>();

const emit = defineEmits<{
  "update:touchControls": [value: boolean];
  "update:crtEnabled": [value: boolean];
  "update:originalAspect": [value: boolean];
  "update:debugOpen": [value: boolean];
  "trigger-key": [code: number];
  "export-zip": [project: boolean];
  "start-over": [];
  "start-walkthrough": [target: string];
}>();

const {
  state,
  resumeAudio,
  ejectGame,
  startTestRecording,
  stopTestRecording,
  cancelTestRecording,
  saveRecordedTest,
  roomMap,
  retryHistorySave,
} = useEngineApi();
const { aiSettingsUnavailable, openAiSettings, llmConfig } = useAiSettings();
const bridge = useShellBridge();
const shell = useShell();

const controlsDialog = useTemplateRef("controlsDialog");
const helpGuide = useTemplateRef("helpGuide");
const settingsSheet = useTemplateRef("settingsSheet");
const settingsOpen = computed(() => settingsSheet.value?.open ?? false);

function toggleSettings(trigger: HTMLElement): void {
  settingsSheet.value?.toggle(trigger);
}

/** The Help guide's "Show me" actions this screen can perform right now. */
const helpActions = computed<HelpAction[]>(() => {
  if (state.phase !== "running")
    return aiSettingsUnavailable.value
      ? ["create", "add-game"]
      : ["ai-settings", "create", "add-game"];
  const actions: HelpAction[] = ["controls", "map"];
  if (!state.powerUp.busy && !state.historyView.active) actions.push("hint");
  if (!state.powerUp.busy && shell.createAvailable.value) actions.push("remix");
  if (!aiSettingsUnavailable.value) actions.push("ai-settings");
  return actions;
});

function onHelpAction(kind: HelpAction): void {
  switch (kind) {
    case "controls":
      controlsDialog.value?.showModal();
      return;
    case "map":
      roomMap.openMap({ experience: "play" });
      return;
    case "hint":
      if (!state.powerUp.open) bridge.togglePowerUp("ask");
      return;
    case "remix":
      shell.openRemix();
      return;
    case "ai-settings":
      openAiSettings(null, "header");
      return;
    case "create":
      void bridge.openCreateSection();
      return;
    case "add-game": {
      const addGame = document.getElementById("open-game");
      addGame?.scrollIntoView({ block: "center" });
      addGame?.querySelector<HTMLElement>("[data-testid='open-game-menu']")?.focus();
      return;
    }
  }
}

function closeNavMenus(): void {
  if (controlsDialog.value?.open) controlsDialog.value.close();
  settingsSheet.value?.close("stay");
}
bridge.closeNavMenus = closeNavMenus;

/**
 * Game controls closes back into the game: its keyboard, not the Help menu
 * item that opened it. The close event arrives a task later, so focus the
 * player already moved elsewhere stays where it is.
 */
function onControlsClosed(): void {
  const active = document.activeElement;
  if (state.phase === "running" && (active === null || active === document.body))
    bridge.focusGameInput();
}

const shortcuts = computed(() => gameShortcuts(state.controls));
const shortcutsBlocked = computed(
  () => state.paused || state.modal !== null || state.prompt !== null || state.textMode,
);

function triggerKey(code: number): void {
  closeNavMenus();
  emit("trigger-key", code);
}

function onStartWalkthrough(targetGame: string): void {
  emit("start-walkthrough", targetGame);
}

/** Live exports only; the shell owns the export path and the refusal banner. */
function onExportAgiZip(project: boolean): void {
  emit("export-zip", project);
}

async function onEjectGame(abandonUnsaved = false): Promise<void> {
  ejectRefusal.value = "";
  closeNavMenus();
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
  <header v-if="state.phase !== 'running'" class="header">
    <a
      v-if="state.phase === 'idle' || state.phase === 'error'"
      class="publisher"
      href="https://monotio.com"
      >MONOTIO <span>/ AGI</span></a
    >
    <span v-else class="publisher">MONOTIO <span>/ AGI</span></span>
    <nav
      v-if="state.phase === 'idle' || state.phase === 'error'"
      class="game-nav"
      aria-label="App options"
    >
      <UiButton
        variant="ghost"
        size="sm"
        icon="help"
        aria-label="Help"
        data-testid="btn-help"
        @click="helpGuide?.open()"
      >
        Help
      </UiButton>
      <a
        class="repo-link"
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
      <UiButton
        variant="ghost"
        size="sm"
        icon="settings"
        aria-label="Settings"
        data-testid="settings-menu"
        aria-haspopup="dialog"
        :aria-expanded="settingsOpen"
        @click="toggleSettings($event.currentTarget as HTMLElement)"
      >
        Settings
      </UiButton>
    </nav>
  </header>
  <PlayBar
    v-else
    :settings-open="settingsOpen"
    @exit="onEjectGame(false)"
    @settings="toggleSettings"
    @help-guide="helpGuide?.open()"
    @controls="controlsDialog?.showModal()"
    @trigger-key="triggerKey"
    @start-walkthrough="onStartWalkthrough"
  />
  <div class="shell-notices">
    <div v-if="exportRefusal" class="export-refusal" data-testid="export-refusal" role="alert">
      <p>{{ exportRefusal }}</p>
    </div>
    <div v-if="ejectRefusal" class="export-refusal" data-testid="eject-refusal" role="alert">
      <p>{{ ejectRefusal }}</p>
      <div class="notice-actions">
        <UiButton
          variant="primary"
          size="sm"
          data-testid="eject-retry"
          :disabled="state.leaving"
          @click="onEjectGame(false)"
        >
          Try again
        </UiButton>
        <UiButton
          size="sm"
          data-testid="eject-download-project"
          :disabled="exportBusy"
          @click="onExportAgiZip(true)"
        >
          Download project
        </UiButton>
        <UiButton
          size="sm"
          data-testid="eject-leave-anyway"
          :disabled="state.leaving"
          @click="onEjectGame(true)"
        >
          Leave anyway
        </UiButton>
        <UiButton size="sm" data-testid="eject-dismiss" @click="ejectRefusal = ''">
          Back to game
        </UiButton>
      </div>
    </div>
    <div
      v-if="state.historyUnsaved"
      class="history-unsaved"
      data-testid="history-unsaved"
      role="status"
    >
      <p>Play keeps recording; saving is retrying in the background.</p>
      <UiButton
        size="sm"
        data-testid="history-retry"
        :title="`Not saved since ${new Date(state.historyUnsaved.since).toLocaleTimeString()}`"
        @click="retryHistorySave()"
      >
        Try now
      </UiButton>
    </div>
    <div
      v-if="state.recording.active"
      class="recording-bar"
      data-testid="recording-bar"
      role="status"
    >
      <span class="recording-dot" aria-hidden="true"></span>
      <span>Recording game test</span>
      <UiButton variant="primary" size="sm" data-testid="record-stop" @click="onRecordStop">
        Stop and name
      </UiButton>
      <UiButton size="sm" data-testid="record-cancel" @click="cancelTestRecording">
        Cancel
      </UiButton>
    </div>
    <slot />
    <p v-if="state.recording.error" class="export-refusal" data-testid="record-error" role="alert">
      {{ state.recording.error }}
    </p>
    <p v-if="recordResult" class="record-result" data-testid="record-result" role="status">
      {{ recordResult }}
    </p>
  </div>
  <SettingsSheet
    ref="settingsSheet"
    :touch-controls="touchControls"
    :crt-enabled="crtEnabled"
    :original-aspect="originalAspect"
    :gpu-backend="gpuBackend"
    :debug-open="debugOpen"
    :export-busy="exportBusy"
    @update:touch-controls="emit('update:touchControls', $event)"
    @update:crt-enabled="emit('update:crtEnabled', $event)"
    @update:original-aspect="emit('update:originalAspect', $event)"
    @update:debug-open="emit('update:debugOpen', $event)"
    @export-zip="onExportAgiZip"
    @start-over="emit('start-over')"
  />
  <HelpGuide ref="helpGuide" :available="helpActions" @action="onHelpAction" />
  <dialog
    ref="controlsDialog"
    class="controls-dialog"
    aria-labelledby="controls-dialog-title"
    data-testid="game-controls"
    @close="onControlsClosed"
  >
    <header>
      <h2 id="controls-dialog-title">Game controls</h2>
      <UiButton size="sm" data-testid="controls-close" @click="controlsDialog?.close()">
        Close
      </UiButton>
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
        <UiButton
          data-testid="record-save-cancel"
          :disabled="recordSaving"
          @click="recordDialog?.close()"
        >
          Discard
        </UiButton>
        <UiButton
          type="submit"
          variant="primary"
          data-testid="record-save"
          :disabled="recordSaving"
        >
          {{ recordSaving ? "Saving…" : "Save test" }}
        </UiButton>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
/* The Home nav: the wordmark left, quiet ghost actions right, full width. */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  align-self: stretch;
  box-sizing: border-box;
  min-height: 56px;
  margin-bottom: var(--space-8);
  padding: 0 var(--space-8);
  border-bottom: 1px solid var(--hairline);
}
.game-nav {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.publisher {
  color: var(--ink);
  font: var(--weight-bold) var(--text-md) / var(--leading) var(--font-mono);
  letter-spacing: 0.12em;
  text-decoration: none;
  white-space: nowrap;
}
.publisher span {
  color: var(--ink-3);
}
/* GitHub is a link, drawn as the ghost small button beside it. */
.repo-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-h-sm);
  box-sizing: border-box;
  padding: 0 var(--space-4);
  border-radius: var(--radius);
  color: var(--ink-2);
  font: var(--weight-semibold) var(--text-sm) / var(--leading-tight) var(--font-sans);
  text-decoration: none;
  transition:
    background-color var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}
.repo-link:hover {
  color: var(--ink);
  background: var(--surface-3);
}
.repo-link svg {
  flex: none;
}
@media (pointer: coarse) {
  .repo-link {
    min-height: var(--control-h-touch);
  }
}
@media (max-width: 600px) {
  .header {
    padding: 0 var(--space-4);
    margin-bottom: var(--space-5);
  }
  .repo-link {
    width: var(--control-h-touch);
    justify-content: center;
    padding: 0;
  }
  .repo-link span {
    display: none;
  }
}
/* The narrowest phones keep the wordmark and three icon buttons on one row. */
@media (max-width: 420px) {
  .game-nav :deep(.ui-btn__label) {
    display: none;
  }
}

/* Notices sit between the bar and the stage; the stage re-fits around them. */
.shell-notices {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}
.shell-notices:not(:empty) {
  padding: var(--space-2) var(--space-4);
}
.notice-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: var(--space-3);
}
.recording-bar {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--danger-line);
  border-radius: var(--radius-lg);
  color: var(--ink);
  background: var(--danger-soft);
  font-size: var(--text-sm);
}
.recording-dot {
  width: 10px;
  height: 10px;
  border-radius: var(--radius-pill);
  background: var(--danger);
  animation: recording-pulse 1.2s ease-in-out infinite;
}
@keyframes recording-pulse {
  50% {
    opacity: 0.25;
  }
}
.record-result {
  margin: 0;
  color: var(--ok);
  font-size: var(--text-xs);
}

.record-dialog,
.controls-dialog {
  box-sizing: border-box;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  color: var(--ink);
  background: var(--surface-1);
  box-shadow: var(--shadow-dialog);
  font: var(--text-md) / var(--leading) var(--font-sans);
}
.record-dialog::backdrop,
.controls-dialog::backdrop {
  background: var(--scrim);
}
.record-dialog {
  width: min(480px, 92vw);
  padding: var(--space-5) var(--space-6);
}
.record-dialog h2,
.controls-dialog h2 {
  margin: 0 0 var(--space-3);
  font: var(--weight-semibold) var(--text-lg) / var(--leading-tight) var(--font-sans);
}
.record-dialog input[id="record-name"] {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin: var(--space-1) 0 var(--space-4);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: inherit;
  background: var(--surface-0);
}
.record-assertions {
  max-height: 220px;
  margin: 0 0 var(--space-4);
  overflow-y: auto;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
}
.record-assertion {
  display: block;
  margin: var(--space-1) 0;
  font-size: var(--text-sm);
}
.dialog-error {
  color: var(--danger);
  font-size: var(--text-sm);
}
.record-dialog footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
}

.controls-dialog {
  width: min(24rem, calc(100vw - 2rem));
  max-height: min(70vh, 32rem);
  padding: var(--space-4) var(--space-5);
  overflow-y: auto;
}
.controls-dialog header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-5);
  margin-bottom: var(--space-3);
}
.controls-dialog h2 {
  margin: 0;
}
.controls-hint {
  margin: var(--space-1) var(--space-1) var(--space-4);
  color: var(--ink-2);
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.shortcut-list {
  display: grid;
  gap: var(--space-1);
}
.game-shortcut {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-5);
  width: 100%;
  min-height: var(--control-h-touch);
  padding: var(--space-3) var(--space-4);
  border: 1px solid transparent;
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-2);
  font: var(--text-md) / var(--leading-tight) var(--font-sans);
  text-align: left;
  cursor: pointer;
}
.game-shortcut:hover:not(:disabled) {
  border-color: var(--hairline-strong);
  background: var(--surface-3);
}
.game-shortcut:disabled {
  opacity: 0.45;
  cursor: default;
}
.game-shortcut kbd {
  color: var(--action);
  font: var(--text-xs) var(--font-mono);
  white-space: nowrap;
}
</style>
