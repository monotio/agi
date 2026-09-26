<script setup lang="ts">
import AgentLogPanel from "./AgentLogPanel.vue";
import AgentBubble from "./AgentBubble.vue";
import GameHeader from "./GameHeader.vue";
import AiSettingsDialog from "./AiSettings.vue";
import SoundPreview from "./SoundPreview.vue";
import WalkthroughBar from "./WalkthroughBar.vue";
import PlayArea from "./PlayArea.vue";
import CreateDock from "./shell/CreateDock.vue";
import UiButton from "./ui/UiButton.vue";
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  useTemplateRef,
  watch,
} from "vue";
import { useEngine, type AutosaveRecord } from "./useEngine.ts";
import { MODEL_OPTIONS } from "./agent/llmClient.ts";
import { reconcileGameIndex } from "./gameStorage.ts";
import { resolveGameHash } from "../../src/games/knownGames.ts";
import { findInstalledFolder, gameStorageKey } from "./gameTypes.ts";
import { useGameKeys } from "./useGameKeys.ts";

import { provideEngine } from "./engineContext.ts";
import { createShellBridge, provideShellBridge } from "./shellBridge.ts";
import { createAiSettings, provideAiSettings } from "./useAiSettings.ts";
import { createGameLibrary, provideGameLibrary } from "./useGameLibrary.ts";
import { createPresentation, providePresentation } from "./usePresentation.ts";
import SetupPanel from "./SetupPanel.vue";
import { nextViewportLayout } from "./viewportLayout.ts";
import ReferenceUpload from "./ReferenceUpload.vue";
import { createShell, provideShell } from "./shell/useShell.ts";
import { isGameRoute, parseGameHash } from "./shell/shellRoute.ts";
import { createCreateWorkspace, provideCreateWorkspace } from "./shell/useCreateWorkspace.ts";
import { useCreateMode } from "./shell/useCreateMode.ts";
import { createInspector, provideInspector } from "./inspector/useInspector.ts";

const testMode = import.meta.env.MODE === "test";
const touchControls = ref(
  localStorage.getItem("monotio_agi.touchControls") === "on" ||
    (localStorage.getItem("monotio_agi.touchControls") !== "off" &&
      matchMedia("(any-pointer: coarse)").matches),
);
const viewport = ref(
  nextViewportLayout(null, window.innerWidth, window.visualViewport?.height ?? window.innerHeight),
);
watch(touchControls, (enabled) =>
  localStorage.setItem("monotio_agi.touchControls", enabled ? "on" : "off"),
);
const crtEnabled = ref<boolean>(
  testMode
    ? localStorage.getItem("monotio_agi.crt") === "on"
    : localStorage.getItem("monotio_agi.crt") !== "off",
);

// A 320×200 frame filled a 4:3 monitor, so its pixels stood taller than
// wide; square pixels are the other choice. Display only: the frame, clicks
// and screenshots are 320×200 either way.
const originalAspect = ref<boolean>(
  testMode
    ? localStorage.getItem("monotio_agi.originalAspect") === "on"
    : localStorage.getItem("monotio_agi.originalAspect") !== "off",
);
watch(originalAspect, (on) =>
  localStorage.setItem("monotio_agi.originalAspect", on ? "on" : "off"),
);

const presentation = createPresentation();
providePresentation(presentation);
const { gpuBackend, debugOpen } = presentation;
const playArea = useTemplateRef("playArea");

watch(crtEnabled, (on) => {
  localStorage.setItem("monotio_agi.crt", on ? "on" : "off");
  presentation.setCrt(on);
});

function onMenuHashChange(): void {
  if (location.hash === "#create-adventure") shellBridge.openCreateSection(false);
}

const engine = useEngine(
  (frame) => {
    presentation.present(frame);
    engine.observeMapFrame(frame);
  },
  {
    onPromptType: (text) => {
      playArea.value?.handlePromptType(text);
    },
  },
);
provideEngine(engine);
provideInspector(createInspector(engine, presentation));

// The map's graph code loads only when the player opens it — never on boot.
const WorldMap = defineAsyncComponent(() => import("./WorldMap.vue"));
const RoomStudio = defineAsyncComponent(() => import("./studio/RoomStudio.vue"));
const mapOpen = engine.roomMap.open;
// A modal can swallow the keyup of a held direction; release it on open.
watch(mapOpen, (isOpen) => {
  if (isOpen) releaseMovement();
});
const {
  state,
  resumeAudio,
  discoverGames,
  startWalkthrough,
  stopWalkthrough,
  releaseAgentAudioPreviews,
  resumeLastGame,
  resumeFromRecord,
  flushAutosave,
  lastAutosaveRecord,
  shutdownEngine,
} = engine;

const shellBridge = createShellBridge();
provideShellBridge(shellBridge);
const aiSettingsDialog = useTemplateRef("aiSettingsDialog");
const ai = createAiSettings(engine, {
  dialog: aiSettingsDialog,
  releaseMovement,
  createButtonEl: () => shellBridge.createButtonEl(),
  assistantInputEl: () => shellBridge.assistantInputEl(),
});
provideAiSettings(ai);
const {
  taskBudget,
  aiSettings,
  aiSettingsSaving,
  aiSettingsError,
  applyAiSettings,
  onAiSettingsClosed,
  llmConfig,
} = ai;

const lib = createGameLibrary(engine, ai, shellBridge);
provideGameLibrary(lib);
const { exportBusy, exportRefusal } = lib;

/** Play or Create for the loaded game; the URL names both (shell/shellRoute.ts). */
const shell = createShell({
  engine,
  bridge: shellBridge,
  librarySource: (projectId) =>
    lib.savedGames.value.find((game) => game.projectId === projectId)?.library?.source,
  initialMode: parseGameHash(location.hash)?.mode ?? "play",
});
provideShell(shell);
const creating = computed(() => state.phase === "running" && shell.mode.value === "create");
/** A phone held upright: Create is one view-only sheet instead of two docks. */
const phone = computed(() => touchControls.value && viewport.value.height >= viewport.value.width);
/** The Create docks' tabs and folds, and the centre's Studio (shell/useCreateWorkspace.ts). */
const workspace = createCreateWorkspace({
  pauseEngine: engine.pauseEngine,
  resumeEngine: engine.resumeEngine,
  focusGame: () => shellBridge.focusGameInput(),
  viewOnly: () => phone.value,
});
provideCreateWorkspace(workspace);
const studio = workspace.studio;
const sheetOpen = workspace.sheetOpen;
const { onDockKey } = useCreateMode({
  state,
  workspace,
  creating,
  phone,
  debugOpen,
  gameInput: () => playArea.value?.inputEl,
});
const { onKeydown: onGlobalKeydown, onKeyup: onGlobalKeyup } = useGameKeys({
  engine,
  playArea: () => playArea.value,
  // Create's dock keys, and Studio holding the paused game: nothing reaches it.
  intercept: (ev) => onDockKey(ev) || studio.value !== null,
});
/** Create keeps Developer activity in its Activity tab while that shows. */
const activityDocked = computed(
  () =>
    creating.value &&
    !phone.value &&
    workspace.active.right === "activity" &&
    !workspace.collapsed.right,
);
const assistantShown = computed(() =>
  phone.value
    ? sheetOpen.value && workspace.active.sheet === "assistant"
    : workspace.active.right === "assistant" && !workspace.collapsed.right,
);

watch(shell.mode, (mode) => {
  releaseMovement();
  // The switch keeps focus otherwise, and a focused control swallows game keys.
  if (mode === "play" && !state.powerUp.open && !touchControls.value)
    nextTick(() => playArea.value?.focusInput());
});
// A walkthrough owns the stage and its own #watch route: it plays in Play.
watch(
  () => state.walkthrough.active,
  (active) => {
    if (active) shell.reset();
  },
);
// Remix lives in Create: an idle remix surface in Play steps back to Ask.
watch(
  () => [shell.mode.value, state.powerUp.open, state.powerUp.mode, state.powerUp.busy] as const,
  ([mode, open, surface, busy]) => {
    if (mode === "play" && open && surface === "remix" && !busy) state.powerUp.mode = "ask";
  },
);

/** Back and Forward between Play and Create; at the menu a stale game route is cleared. */
function onPopState(): void {
  if (state.phase === "running") shell.followRoute(location.hash);
  else if (state.phase === "idle" && isGameRoute(location.hash)) clearPlayHash();
}

async function onStartWalkthrough(targetGame: string): Promise<void> {
  await resumeAudio();
  clearPlayHash();
  await startWalkthrough(targetGame);
}
shellBridge.startWalkthrough = (target) => void onStartWalkthrough(target);

const WATCH_HASH_PREFIX = "#watch/";

/** The walkthrough the URL names, plus the tick the tape had reached. */
function watchHashTarget(): { alias: string; tick: number } | null {
  if (!location.hash.startsWith(WATCH_HASH_PREFIX)) return null;
  try {
    const [alias, tick] = decodeURIComponent(location.hash.slice(WATCH_HASH_PREFIX.length)).split(
      "/",
    );
    if (!alias) return null;
    const t = Number(tick);
    return { alias, tick: Number.isFinite(t) && t > 0 ? Math.floor(t) : 0 };
  } catch {
    return null;
  }
}

/**
 * While a walkthrough runs the URL names it, so a reload re-enters playback.
 * The runner reports progress per tape action and the watcher below forwards
 * each one; at high speed that is one history navigation apiece, which trips
 * the browser's IPC flooding protection (crbug.com/1038223). The URL tick is
 * resume precision only — pagehide stamps the exact position — so in-flight
 * writes are throttled and the trailing write reads live state.
 */
const WATCH_HASH_INTERVAL_MS = 1_000;
let watchHashLastWrite = -WATCH_HASH_INTERVAL_MS;
let watchHashTimer: number | null = null;

function writeWatchHash(alias: string, tick: number): void {
  watchHashLastWrite = performance.now();
  const target = `${WATCH_HASH_PREFIX}${encodeURIComponent(alias)}${tick > 0 ? `/${tick}` : ""}`;
  if (location.hash !== target) history.replaceState(null, "", target);
}

function cancelWatchHash(): void {
  if (watchHashTimer !== null) {
    clearTimeout(watchHashTimer);
    watchHashTimer = null;
  }
}

/** The armed write or a teardown stamp: the live tick, never a queued one. */
function flushWatchHash(): void {
  cancelWatchHash();
  if (state.walkthrough.active && state.walkthrough.alias)
    writeWatchHash(state.walkthrough.alias, state.walkthrough.tick);
}

function updateWatchHash(): void {
  const remaining = WATCH_HASH_INTERVAL_MS - (performance.now() - watchHashLastWrite);
  if (remaining <= 0) flushWatchHash();
  else if (watchHashTimer === null) watchHashTimer = window.setTimeout(flushWatchHash, remaining);
}

/** Back at the picker the URL must not name a game any more. */
function clearPlayHash(): void {
  cancelWatchHash();
  if (isGameRoute(location.hash) || location.hash.startsWith(WATCH_HASH_PREFIX))
    history.replaceState(null, "", `${location.pathname}${location.search}`);
}

const latestAgentAudio = computed(
  () => [...state.agentLog].reverse().find((entry) => entry.audio?.length)?.audio ?? [],
);

function releaseMovement(): void {
  playArea.value?.releaseMovement();
}

function onTakeControl(): void {
  releaseMovement();
  stopWalkthrough(true);
  nextTick(() => {
    playArea.value?.focusInput();
  });
}

function resizeViewport(): void {
  const opened = !viewport.value.keyboard;
  viewport.value = nextViewportLayout(
    viewport.value,
    window.innerWidth,
    window.visualViewport?.height ?? window.innerHeight,
  );
  // Typing on a phone: bring the whole game screen, with the command line it
  // draws, to the top of what the keyboard leaves visible.
  if (opened && viewport.value.keyboard && state.phase === "running")
    nextTick(() => playArea.value?.revealScreen());
}

/**
 * The page is going away: ask for one last snapshot before it does. A reload
 * is the case this whole path exists for, and `visibilitychange` is the last
 * event that still reliably gets a turn of the event loop.
 */
function onPageHidden(): void {
  if (document.visibilityState === "hidden") {
    releaseMovement();
    flushWatchHash();
    void flushAutosave();
  }
}

function onPageHide(): void {
  flushWatchHash();
  void flushAutosave();
}

/**
 * Vite HMR (development only; the whole block is dead code in a build).
 *
 * A dev reload is a reload like any other, but it is one we get told about in
 * advance — and Vite awaits both of these hooks, so the flush is real rather
 * than best-effort:
 *
 * - `vite:beforeFullReload` fires before `location.reload()` and its listeners
 *   are awaited (`Promise.allSettled` in the client's `notifyListeners`), so a
 *   bounded flush lands in localStorage before the page goes. Editing anything
 *   the engine imports (useEngine.ts, engine.worker.ts, src/) takes this path.
 * - `dispose` is awaited before the replacement module is imported. Editing
 *   THIS component hot-reloads it without a page reload, which re-runs setup
 *   and builds a new engine, so the freshest image is handed over in memory
 *   through `import.meta.hot.data` and the resume needs no storage round trip
 *   and no reload at all. The old instance's worker is terminated in
 *   `onUnmounted` rather than here: a template-only update disposes the module
 *   but keeps the running instance, and killing its engine would be wrong.
 * - `vite:beforeUpdate` is belt and braces for the updates that do neither.
 */
if (import.meta.hot) {
  import.meta.hot.on("vite:beforeFullReload", async () => {
    await flushAutosave(500);
  });
  import.meta.hot.on("vite:beforeUpdate", async () => {
    await flushAutosave(300);
  });
  import.meta.hot.dispose(async (data: Record<string, unknown>) => {
    await flushAutosave(500);
    data["monotio_agi_resume"] = lastAutosaveRecord();
  });
}

onMounted(async () => {
  // An unreadable game route can never resume: drop it before anything waits.
  if (isGameRoute(location.hash) && !parseGameHash(location.hash)) clearPlayHash();
  window.addEventListener("blur", releaseMovement);
  window.visualViewport?.addEventListener("resize", resizeViewport);
  window.addEventListener("resize", resizeViewport);
  window.addEventListener("keydown", onGlobalKeydown);
  window.addEventListener("keyup", onGlobalKeyup);
  window.addEventListener("hashchange", onMenuHashChange);
  window.addEventListener("popstate", onPopState);
  document.addEventListener("visibilitychange", onPageHidden);
  window.addEventListener("pagehide", onPageHide);
  try {
    await reconcileGameIndex();
    lib.refreshLibrary();
  } catch (error) {
    lib.libraryActionError.value = `Your saved game library could not be refreshed: ${String(error).replace(/^Error: /, "")}`;
  }
  lib.mountCatalog();
  onMenuHashChange();
  await discoverGames();
  // Nobody loses progress to a reload: while a game runs the URL names it
  // (`#play/<aliasOrProjectId>`), and only a reload carrying that hash boots straight back
  // into the autosave. A reload from the picker lands on the picker, which
  // keeps offering the Resume card from the pending autosave.
  // A hot module update hands the running game over in memory: no reload
  // happened, so there is nothing to read back and the resume is instant.
  const handover = import.meta.hot?.data?.["monotio_agi_resume"] as AutosaveRecord | undefined;
  if (import.meta.hot?.data) delete import.meta.hot.data["monotio_agi_resume"];
  lib.refreshPendingAutosave();
  const playKey = parseGameHash(location.hash)?.key ?? null;
  const watchTarget = watchHashTarget();
  if (handover) await resumeFromRecord(handover, llmConfig());
  else if (watchTarget)
    // startWalkthrough drives the tape to completion: await would suspend the
    // rest of mount — including the GPU stage the walkthrough paints into.
    void startWalkthrough(watchTarget.alias, { initialTick: watchTarget.tick }).catch((e) => {
      state.phase = "error";
      state.error = e instanceof Error ? e.message : String(e);
    });
  else if (
    playKey &&
    (() => {
      const pending = lib.pendingAutosave.value?.game;
      if (!pending) return false;
      if (playKey === pending.identity.project) return true;
      // The URL names an installed edition by any of its query spellings
      // (alias, folder, hash); the record keys on its storage key.
      return (
        pending.installed &&
        gameStorageKey({
          installed: true,
          folder: findInstalledFolder(state.installedGames, playKey),
          hash: resolveGameHash(playKey) ?? undefined,
        }) === pending.identity.project
      );
    })()
  )
    await resumeLastGame(llmConfig());
  if (state.phase === "idle") {
    shell.reset();
    clearPlayHash();
  }
});

onUnmounted(() => {
  lib.unmountCatalog();
  cancelWatchHash();
  releaseMovement();
  window.removeEventListener("blur", releaseMovement);
  window.visualViewport?.removeEventListener("resize", resizeViewport);
  window.removeEventListener("resize", resizeViewport);
  presentation.dispose();
  window.removeEventListener("keydown", onGlobalKeydown);
  window.removeEventListener("keyup", onGlobalKeyup);
  window.removeEventListener("hashchange", onMenuHashChange);
  window.removeEventListener("popstate", onPopState);
  document.removeEventListener("visibilitychange", onPageHidden);
  window.removeEventListener("pagehide", onPageHide);
  releaseAgentAudioPreviews();
  // Development only: this instance is being replaced by a hot update, and its
  // worker would otherwise keep ticking (and autosaving) behind the new one.
  if (import.meta.hot) shutdownEngine();
});
// The URL is the source of truth for "a game is running": name it, and its
// mode, while the game runs. A remix can turn the running game into a new
// game without leaving the running phase, so the unpause after a remix turn
// re-asserts the hash from whatever is booted then. Back at the picker (the
// player ejected, or a boot failed) the hash is cleared, the next game opens
// in Play, and the autosave slot is re-read so the offer below matches storage.
watch(
  () => [state.phase, state.paused, state.walkthrough.active, state.walkthrough.tick] as const,
  ([phase, paused, watching]) => {
    if (phase === "running") {
      if (!paused) {
        if (watching) updateWatchHash();
        else shell.markRoute();
      }
      return;
    }
    if (phase === "idle" || phase === "error") {
      shell.reset();
      clearPlayHash();
      lib.syncMenuPhase();
    }
  },
);
</script>

<template>
  <div
    class="app-container"
    :class="{
      'at-menu': state.phase === 'idle' || state.phase === 'error',
      'in-game': state.phase === 'running',
      'touch-layout': touchControls,
      'layout-portrait': viewport.height >= viewport.width,
      'layout-landscape-short': viewport.width > viewport.height && viewport.height <= 600,
      'original-aspect': originalAspect,
    }"
    :style="{ '--layout-height': `${viewport.height}px` }"
  >
    <div class="shell">
      <GameHeader
        :touch-controls="touchControls"
        :crt-enabled="crtEnabled"
        :original-aspect="originalAspect"
        :gpu-backend="gpuBackend"
        :debug-open="debugOpen"
        :export-busy="exportBusy"
        :export-refusal="exportRefusal"
        @update:touch-controls="touchControls = $event"
        @update:crt-enabled="crtEnabled = $event"
        @update:original-aspect="originalAspect = $event"
        @update:debug-open="debugOpen = $event"
        @trigger-key="(code) => playArea?.triggerKey(code)"
        @export-zip="(project) => lib.onExportAgiZip(true, project)"
        @start-over="lib.onStartOver"
        @start-walkthrough="onStartWalkthrough"
      >
        <WalkthroughBar
          v-if="state.walkthrough.active"
          :walkthrough="state.walkthrough"
          @take-control="onTakeControl"
        />
        <p
          v-if="!state.walkthrough.active && state.walkthrough.error"
          class="export-refusal"
          data-testid="walkthrough-error"
          role="alert"
        >
          {{ state.walkthrough.error }}
        </p>
      </GameHeader>

      <!-- One grid for both modes, so the live stage (and its GPU canvas) is
           never remounted: Create adds docks around it, Play's Ask drawer
           takes the right column. -->
      <div
        class="shell-body"
        :class="{
          'shell-body--create': creating,
          'shell-body--sheet': creating && phone,
          'shell-body--fold-left': creating && !phone && workspace.collapsed.left,
          'shell-body--fold-right': creating && !phone && workspace.collapsed.right,
          'shell-body--asking': !creating && state.phase === 'running' && state.powerUp.open,
          'assistant-open': state.phase === 'running' && state.powerUp.open,
        }"
      >
        <CreateDock
          v-if="creating && !phone"
          v-model:active="workspace.active.left"
          side="left"
          class="shell-dock shell-dock--left"
          :read-only="shell.readOnly.value"
          :collapsed="workspace.collapsed.left"
          data-shell-keys
          @toggle="workspace.toggleDock('left')"
        />
        <PlayArea
          v-show="!studio"
          ref="playArea"
          :touch-controls="touchControls"
          :crt-enabled="crtEnabled"
          :original-aspect="originalAspect"
          :inspector-docked="creating"
        >
          <template #stage-actions>
            <UiButton
              v-if="state.phase === 'running' && !creating"
              icon="sparkles"
              size="sm"
              class="ask-button"
              aria-label="Ask"
              data-testid="menu-assistant"
              :aria-expanded="state.powerUp.open"
              :title="
                state.powerUp.open
                  ? 'Back to game (Esc)'
                  : 'Ask about this game — answers without changing it'
              "
              :disabled="
                (state.powerUp.mode === 'room' && state.powerUp.open) ||
                state.recording.active ||
                state.historyView.active
              "
              @click="shell.toggleAsk()"
            >
              Ask
            </UiButton>
          </template>
        </PlayArea>
        <RoomStudio
          v-if="creating && studio"
          class="shell-center"
          :picture-number="studio.pictureNumber"
          :bytes="studio.bytes"
          :authored-source="studio.authoredSource"
          :profile="studio.profile"
          :title="studio.title"
          :subtitle="studio.subtitle"
          @close="workspace.closeStudio()"
        />
        <aside
          class="shell-side"
          :class="{ 'shell-side--sheet': creating && phone, 'shell-side--open': sheetOpen }"
          :aria-label="creating ? 'Assistant panels' : 'Ask'"
          data-shell-keys
        >
          <CreateDock
            v-if="creating && phone"
            v-model:active="workspace.active.sheet"
            side="sheet"
            :read-only="shell.readOnly.value"
            :built-in="['assistant']"
            :collapsed="!sheetOpen"
            @toggle="workspace.sheetOpen.value = !workspace.sheetOpen.value"
          />
          <CreateDock
            v-else-if="creating"
            v-model:active="workspace.active.right"
            side="right"
            :read-only="shell.readOnly.value"
            :built-in="['assistant']"
            :collapsed="workspace.collapsed.right"
            @toggle="workspace.toggleDock('right')"
          />
          <div v-show="!creating || assistantShown" class="assistant-host">
            <div v-if="creating && !state.powerUp.open" class="assistant-start">
              <p class="dock-note">
                {{
                  phone
                    ? "Ask about this game. Editing needs a larger screen."
                    : "Describe a change and the assistant edits this game’s real AGI resources. The game pauses while it works."
                }}
              </p>
              <p
                v-if="shell.readOnly.value && !phone"
                class="dock-note"
                data-testid="create-read-only"
              >
                This edition is read-only: your first edit makes your own remix copy.
              </p>
              <UiButton
                variant="primary"
                icon="sparkles"
                data-testid="power-up"
                :disabled="state.recording.active || state.historyView.active"
                @click="shellBridge.togglePowerUp(phone ? 'ask' : 'remix')"
              >
                {{ phone ? "Ask" : "Ask or remix" }}
              </UiButton>
            </div>
            <AgentBubble :surface="creating && !phone ? 'dock' : 'drawer'" />
          </div>
        </aside>
      </div>
    </div>

    <AiSettingsDialog
      ref="aiSettingsDialog"
      :settings="aiSettings"
      :budget-usd="taskBudget"
      :models="MODEL_OPTIONS"
      :allow-stub="testMode"
      :saving="aiSettingsSaving"
      :error="aiSettingsError"
      @save="applyAiSettings"
      @closed="onAiSettingsClosed"
    />

    <SetupPanel />

    <SoundPreview
      v-if="!state.powerUp.open && latestAgentAudio.length"
      :audio="latestAgentAudio"
      data-testid="latest-sound-preview"
    />

    <AgentLogPanel v-if="!activityDocked" />

    <ReferenceUpload v-if="state.phase === 'running'" />

    <WorldMap v-if="mapOpen" />
  </div>
</template>
