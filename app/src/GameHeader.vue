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
import BrandMark from "./ui/BrandMark.vue";
import PlayBar from "./shell/PlayBar.vue";
import SettingsSheet from "./shell/SettingsSheet.vue";
import UiButton from "./ui/UiButton.vue";
import UiDialog from "./ui/UiDialog.vue";
import type { HelpActionKind, HelpRequest } from "./helpContent.ts";
import { computed, ref, shallowRef, useTemplateRef, watch } from "vue";
import { useEngineApi } from "./engineContext.ts";
import { useAiSettings } from "./useAiSettings.ts";
import { useShellBridge } from "./shellBridge.ts";
import { useShell } from "./shell/useShell.ts";
import { useCreateWorkspace } from "./shell/useCreateWorkspace.ts";
import { useStudioLauncher } from "./shell/useStudioLauncher.ts";
import { getCachedGameMeta } from "./gameStorage.ts";
import { lessonCatalogId, lessonSetFor } from "./lessons/registry.ts";
import type { LessonSet, StudioLesson } from "./lessons/types.ts";
import { projectId } from "../../src/gameIdentity.ts";
import { gameShortcuts } from "./gameControls.ts";
import { HistoryUnsavedError } from "./useGameLifecycle.ts";
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
  "developer-activity": [];
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
  startNewTimeline,
  readOldTimeline,
  currentGame,
} = useEngineApi();
const { aiSettingsUnavailable, openAiSettings, llmConfig } = useAiSettings();
const bridge = useShellBridge();
const shell = useShell();
const workspace = useCreateWorkspace();

const controlsOpen = ref(false);
const helpGuide = useTemplateRef("helpGuide");
const settingsSheet = useTemplateRef("settingsSheet");
const settingsOpen = computed(() => settingsSheet.value?.open ?? false);

function toggleSettings(trigger: HTMLElement): void {
  settingsSheet.value?.toggle(trigger);
}

/** The Help guide's "Show me" actions this screen can perform right now. */
const studios = useStudioLauncher();
const helpActions = computed<HelpActionKind[]>(() => {
  if (state.phase !== "running")
    return aiSettingsUnavailable.value
      ? ["create", "add-game"]
      : ["ai-settings", "create", "add-game"];
  const actions: HelpActionKind[] = ["controls", "map"];
  if (!state.powerUp.busy && !state.historyView.active) actions.push("hint");
  if (!state.powerUp.busy && shell.createAvailable.value) actions.push("remix");
  if (!aiSettingsUnavailable.value) actions.push("ai-settings");
  if (studios.available.value) actions.push("openRoomStudio", "openSpriteStudio");
  return actions;
});

/**
 * The running game's Studio lessons: its catalog release's, or the one its
 * remix started from. The set loads with the guide open; a set for another
 * release never shows meanwhile.
 */
const helpLessons = shallowRef<LessonSet | undefined>();
let helpLessonsAsked = 0;
function openHelp(section?: string): void {
  const game = state.phase === "running" ? currentGame() : null;
  const release =
    game && !game.installed
      ? lessonCatalogId(game.projectId, (id) => {
          const project = projectId(id);
          return project === null ? null : getCachedGameMeta(project);
        })
      : undefined;
  const shown = helpLessons.value;
  if (shown && (shown.catalogId !== release?.id || shown.version !== release.version))
    helpLessons.value = undefined;
  const asked = ++helpLessonsAsked;
  void lessonSetFor(release)
    .catch(() => undefined)
    .then((set) => {
      if (asked === helpLessonsAsked) helpLessons.value = set;
    });
  helpGuide.value?.open(section);
}
bridge.openHelp = openHelp;

function onHelpLesson(lesson: StudioLesson): void {
  void studios.open(lesson.open, lesson);
}

function onHelpAction(request: HelpRequest): void {
  switch (request.kind) {
    case "openRoomStudio":
      void studios.open({ studio: "room", picture: request.picture });
      return;
    case "openSpriteStudio":
      void studios.open({ studio: "sprite", view: request.view });
      return;
    case "controls":
      controlsOpen.value = true;
      return;
    case "map":
      if (shell.mode.value === "create") workspace.showPanel("world");
      else roomMap.openMap({ experience: "play" });
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
  controlsOpen.value = false;
  settingsSheet.value?.close("stay");
}
bridge.closeNavMenus = closeNavMenus;

/**
 * Game controls closes back into the game: its keyboard, not the Help menu
 * item that opened it. The close event can arrive while focus still sits on
 * the closing dialog's button, which then drops to the body; focus the player
 * already moved elsewhere stays where it is.
 */
function onControlsClosed(): void {
  const active = document.activeElement;
  const dropped =
    active === null || active === document.body || active.closest("dialog:not([open])") !== null;
  if (state.phase === "running" && dropped) bridge.focusGameInput();
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

async function onEjectGame(
  leave: "save" | "abandonUnsaved" | "abandonHistory" = "save",
): Promise<void> {
  ejectRefusal.value = "";
  historyExit.value = false;
  closeNavMenus();
  // Room Studio's unkept changes are kept or thrown away before the game is left.
  if (!(await workspace.confirmStudioLeave())) return;
  try {
    await ejectGame(
      leave === "abandonUnsaved"
        ? { abandonUnsaved: true }
        : leave === "abandonHistory"
          ? { abandonHistory: true }
          : undefined,
    );
  } catch (error) {
    // Only the timeline is still owed: its own question, not a refusal.
    if (error instanceof HistoryUnsavedError) historyExit.value = true;
    else ejectRefusal.value = String(error).replace(/^Error: /, "");
  }
}
const ejectRefusal = ref<string>("");
/** Exit waits on this session's timeline: leave without it, or stay. */
const historyExit = ref(false);

/**
 * The timeline notices. A tape this version cannot extend offers a new
 * timeline (confirmed first; the old one is kept as it is) and the old
 * one's download. Try now's "Saved." clears itself after a moment.
 */
const confirmNewTimeline = ref(false);
async function onStartNewTimeline(): Promise<void> {
  confirmNewTimeline.value = false;
  await startNewTimeline();
}
async function onDownloadOldTimeline(): Promise<void> {
  const json = await readOldTimeline();
  if (json === null) return;
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${currentGame()?.projectId ?? "game"}-old-timeline.json`;
  link.click();
  URL.revokeObjectURL(url);
}
watch(
  () => state.historyRetry?.status,
  (status) => {
    if (status === "saved")
      setTimeout(() => {
        if (state.historyRetry?.status === "saved") state.historyRetry = null;
      }, 4000);
  },
);

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
      >MONOTIO <span>/ AGI</span><BrandMark
    /></a>
    <span v-else class="publisher">MONOTIO <span>/ AGI</span><BrandMark /></span>
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
        @click="openHelp()"
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
    @exit="onEjectGame()"
    @settings="toggleSettings"
    @help-guide="openHelp()"
    @controls="controlsOpen = true"
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
          @click="onEjectGame()"
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
          @click="onEjectGame('abandonUnsaved')"
        >
          Leave anyway
        </UiButton>
        <UiButton size="sm" data-testid="eject-dismiss" @click="ejectRefusal = ''">
          Back to game
        </UiButton>
      </div>
    </div>
    <div v-if="historyExit" class="export-refusal" data-testid="eject-history" role="alert">
      <p>This session's rewind timeline is not saved yet.</p>
      <div class="notice-actions">
        <UiButton
          size="sm"
          data-testid="eject-leave-without-timeline"
          :disabled="state.leaving"
          @click="onEjectGame('abandonHistory')"
        >
          Leave without this session's timeline
        </UiButton>
        <UiButton variant="primary" size="sm" data-testid="eject-stay" @click="historyExit = false">
          Stay
        </UiButton>
        <UiButton
          variant="ghost"
          size="sm"
          data-testid="eject-keep-backup"
          :disabled="exportBusy"
          @click="onExportAgiZip(true)"
        >
          Keep a backup first
        </UiButton>
      </div>
    </div>
    <div
      v-if="state.historyBlocked"
      class="history-unsaved"
      data-testid="history-blocked"
      role="status"
    >
      <p>{{ state.historyBlocked.message }}</p>
      <template v-if="confirmNewTimeline">
        <p>The old timeline stays in this browser exactly as it is.</p>
        <UiButton size="sm" data-testid="history-new-timeline-confirm" @click="onStartNewTimeline">
          Start the new timeline
        </UiButton>
        <UiButton size="sm" variant="ghost" @click="confirmNewTimeline = false">Cancel</UiButton>
      </template>
      <template v-else>
        <UiButton size="sm" data-testid="history-new-timeline" @click="confirmNewTimeline = true">
          Start a new timeline
        </UiButton>
        <UiButton
          size="sm"
          variant="ghost"
          data-testid="history-old-download"
          @click="onDownloadOldTimeline"
        >
          Download the old timeline
        </UiButton>
      </template>
    </div>
    <div
      v-else-if="state.historyUnsaved || state.historyRetry"
      class="history-unsaved"
      data-testid="history-unsaved"
      role="status"
    >
      <p v-if="state.historyRetry?.status === 'saving'">Saving…</p>
      <p v-else-if="state.historyRetry?.status === 'saved'">Saved.</p>
      <p v-else-if="state.historyRetry?.status === 'failed'">
        Not saved yet: {{ state.historyRetry.reason }}. Saving keeps retrying in the background.
      </p>
      <p v-else>Play keeps recording; saving is retrying in the background.</p>
      <UiButton
        v-if="state.historyUnsaved"
        size="sm"
        data-testid="history-retry"
        :disabled="state.historyRetry?.status === 'saving'"
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
    @developer-activity="emit('developer-activity')"
  />
  <HelpGuide
    ref="helpGuide"
    :available="helpActions"
    :lessons="helpLessons"
    @action="onHelpAction"
    @lesson="onHelpLesson"
  />
  <UiDialog
    v-model:open="controlsOpen"
    title="Game controls"
    size="sm"
    close-testid="controls-close"
    :restore-focus="false"
    data-testid="game-controls"
    @closed="onControlsClosed"
  >
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
  </UiDialog>
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
.publisher > span {
  color: var(--ink-3);
}
a.publisher:hover > span {
  color: var(--ink-2);
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

.record-dialog {
  box-sizing: border-box;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  color: var(--ink);
  background: var(--surface-1);
  box-shadow: var(--shadow-dialog);
  font: var(--text-md) / var(--leading) var(--font-sans);
}
.record-dialog::backdrop {
  background: var(--scrim);
}
.record-dialog {
  width: min(480px, 92vw);
  padding: var(--space-5) var(--space-6);
}
.record-dialog h2 {
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
