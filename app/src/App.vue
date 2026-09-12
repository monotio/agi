<script setup lang="ts">
import AgentLogPanel from "./AgentLogPanel.vue";
import AgentBubble from "./AgentBubble.vue";
import GameHeader from "./GameHeader.vue";
import AiSettingsDialog from "./AiSettings.vue";
import SoundPreview from "./SoundPreview.vue";
import WalkthroughBar from "./WalkthroughBar.vue";
import PlayArea from "./PlayArea.vue";
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useEngine, type AutosaveRecord, type ModalKind } from "./useEngine.ts";
import { MODEL_OPTIONS } from "./agent/llmClient.ts";
import { reconcileGameIndex } from "./gameStorage.ts";
import { FUNCTION_KEYS, registeredKey, pcKey } from "./gameControls.ts";

import { provideEngine } from "./engineContext.ts";
import { createShellBridge, provideShellBridge } from "./shellBridge.ts";
import { createAiSettings, provideAiSettings } from "./useAiSettings.ts";
import { createGameLibrary, provideGameLibrary } from "./useGameLibrary.ts";
import { createPresentation, providePresentation } from "./usePresentation.ts";
import SetupPanel from "./SetupPanel.vue";

const testMode = import.meta.env.MODE === "test";
const touchControls = ref(
  localStorage.getItem("monotio_agi.touchControls") === "on" ||
    (localStorage.getItem("monotio_agi.touchControls") !== "off" &&
      matchMedia("(any-pointer: coarse)").matches),
);
const viewportHeight = ref(window.visualViewport?.height ?? window.innerHeight);
watch(touchControls, (enabled) =>
  localStorage.setItem("monotio_agi.touchControls", enabled ? "on" : "off"),
);
const crtEnabled = ref<boolean>(
  testMode
    ? localStorage.getItem("monotio_agi.crt") === "on"
    : localStorage.getItem("monotio_agi.crt") !== "off",
);

const presentation = createPresentation();
providePresentation(presentation);
const { gpuBackend, debugOpen } = presentation;
const playArea = useTemplateRef<InstanceType<typeof PlayArea>>("playArea");

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
  },
  {
    onPromptType: (text) => {
      playArea.value?.handlePromptType(text);
    },
  },
);
provideEngine(engine);
const {
  state,
  resumeAudio,
  discoverGames,
  startWalkthrough,
  stopWalkthrough,
  toggleWalkthroughPause,
  advanceDialog,
  resumeWalkthrough,
  sendKey,
  currentGame,
  releaseAgentAudioPreviews,
  closePowerUp,
  resumeLastGame,
  resumeFromRecord,
  flushAutosave,
  lastAutosaveRecord,
  shutdownEngine,
} = engine;

const shellBridge = createShellBridge();
provideShellBridge(shellBridge);
const aiSettingsDialog = useTemplateRef<{ show(): void; close(): void }>("aiSettingsDialog");
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
const { exportBusy, exportRefusal, exportSavedProgressKey } = lib;

async function onStartWalkthrough(targetGame: string): Promise<void> {
  await resumeAudio();
  clearPlayHash();
  await startWalkthrough(targetGame);
}
shellBridge.startWalkthrough = (target) => void onStartWalkthrough(target);

const PLAY_HASH_PREFIX = "#play/";

/** The target key the URL says is being played, or null outside a game. */
function playHashGameKey(): string | null {
  if (!location.hash.startsWith(PLAY_HASH_PREFIX)) return null;
  try {
    return decodeURIComponent(location.hash.slice(PLAY_HASH_PREFIX.length));
  } catch {
    return null;
  }
}

/** The URL is the source of truth for "a game is running": name it. */
function markPlayHash(targetKey: string): void {
  const target = `${PLAY_HASH_PREFIX}${encodeURIComponent(targetKey)}`;
  if (location.hash !== target) history.replaceState(null, "", target);
}

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

/** While a walkthrough runs the URL names it, so a reload re-enters playback. */
function markWatchHash(alias: string, tick = 0): void {
  const target = `${WATCH_HASH_PREFIX}${encodeURIComponent(alias)}${tick > 0 ? `/${tick}` : ""}`;
  if (location.hash !== target) history.replaceState(null, "", target);
}

/** Back at the picker the URL must not name a game any more. */
function clearPlayHash(): void {
  if (location.hash.startsWith(PLAY_HASH_PREFIX) || location.hash.startsWith(WATCH_HASH_PREFIX))
    history.replaceState(null, "", `${location.pathname}${location.search}`);
}

const latestAgentAudio = computed(
  () => [...state.agentLog].reverse().find((entry) => entry.audio?.length)?.audio ?? [],
);

/**
 * Whole-page keyboard trapping: the browser chrome should disappear. Arrows
 * always steer ego (even while the input line is focused — the classic AGI
 * feel); any printable keystroke jumps into the input line; Enter dismisses
 * the print modal first, then submits.
 */
function onGlobalKeydown(ev: KeyboardEvent): void {
  resumeAudio();
  const isInputReady = state.walkthrough.active ? true : state.inputReady;
  if (state.phase !== "running" || !isInputReady) return;
  if (
    state.walkthrough.active &&
    (state.walkthrough.status === "playing" ||
      state.walkthrough.status === "paused" ||
      state.walkthrough.status === "completed")
  ) {
    // The walkthrough drives the game; human keys own playback shortcuts only.
    if (ev.key === " " && !state.powerUp.open) {
      ev.preventDefault();
      toggleWalkthroughPause();
      return;
    }
    if (ev.key === "Enter" && !state.powerUp.open) {
      ev.preventDefault();
      if (state.walkthrough.status === "paused") {
        resumeWalkthrough();
        return;
      }
      if (advanceDialog()) return;
    }
    return;
  }
  if (ev.isComposing || ev.keyCode === 229) return;
  if (ev.target instanceof Element && ev.target.closest("dialog[open]")) return;
  // The bubble owns the keyboard while it is open: the world is frozen and
  // nothing typed here may reach the interpreter's input line.
  if (state.powerUp.open) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closePowerUp();
      if (!state.powerUp.open) playArea.value?.focusInput();
    }
    return;
  }
  // Page controls keep native keyboard behavior. The invisible input owns
  // game keys; Shift+Tab lets a player leave it even during a game modal.
  const target = ev.target;
  if (
    (target instanceof Element &&
      target !== playArea.value?.inputEl &&
      target.closest("button, input, textarea, select, a, audio, summary, dialog")) ||
    (ev.key === "Tab" && ev.shiftKey)
  ) {
    return;
  }
  if (ev.key === "ScrollLock") {
    ev.preventDefault();
    sendKey(0x4600);
    return;
  }
  if (state.prompt) {
    playArea.value?.onPromptKey(ev);
    return;
  }
  const activeModal =
    state.walkthrough.active && window.__AGI_REPLAY__?.latest?.state.modalKind
      ? (window.__AGI_REPLAY__?.latest?.state.modalKind as ModalKind)
      : state.modal;
  if (activeModal !== null) {
    playArea.value?.onModalKey(ev);
    return;
  }

  // Text screens can ask a specific question: preserve the actual key.
  if (
    state.textMode ||
    state.waitingForKey ||
    (state.walkthrough.active && window.__AGI_REPLAY__?.latest?.blocked === "waitkey")
  ) {
    const key = pcKey(ev);
    if (key !== undefined) {
      ev.preventDefault();
      sendKey(key);
    }
    return;
  }

  // Intercept Function Keys F1..F10 (prevent browser reload, help, devtools)
  if (ev.key in FUNCTION_KEYS && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
    ev.preventDefault();
    playArea.value?.triggerKey(FUNCTION_KEYS[ev.key]!);
    return;
  }

  if (playArea.value?.movementKeyDown(ev)) return;

  const shortcut = registeredKey(ev, state.controls);
  if (shortcut !== undefined) {
    ev.preventDefault();
    playArea.value?.triggerKey(shortcut);
    return;
  }

  if (!state.inputEnabled) {
    const code = pcKey(ev);
    if (code !== undefined) {
      ev.preventDefault();
      sendKey(code);
    }
    return;
  }

  if (ev.key === "Escape") {
    ev.preventDefault();
    sendKey(0x001b);
    return;
  }

  const input = playArea.value?.inputEl;
  // When input field is NOT focused:
  if (!input || ev.target !== input) {
    // If Enter or Space pressed while not typing, forward raw key event to wake have.key() (e.g. title screens)
    if (ev.key === "Enter" || ev.key === " ") {
      sendKey(ev.key === "Enter" ? 0x000d : 0x0020);
      ev.preventDefault();
      return;
    }
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      playArea.value?.mirrorPrintableChar(ev.key);
      ev.preventDefault();
    }
    return;
  }

  // When input field IS focused:
  if (ev.key === "Enter") {
    ev.preventDefault();
    playArea.value?.submit();
  }
}

function onGlobalKeyup(ev: KeyboardEvent): void {
  playArea.value?.movementKeyUp(ev);
}

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
  viewportHeight.value = window.visualViewport?.height ?? window.innerHeight;
}

/**
 * The page is going away: ask for one last snapshot before it does. A reload
 * is the case this whole path exists for, and `visibilitychange` is the last
 * event that still reliably gets a turn of the event loop.
 */
function onPageHidden(): void {
  if (document.visibilityState === "hidden") {
    releaseMovement();
    if (state.walkthrough.active && state.walkthrough.alias)
      markWatchHash(state.walkthrough.alias, state.walkthrough.tick);
    void flushAutosave();
  }
}

function onPageHide(): void {
  if (state.walkthrough.active && state.walkthrough.alias)
    markWatchHash(state.walkthrough.alias, state.walkthrough.tick);
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
  window.addEventListener("blur", releaseMovement);
  window.visualViewport?.addEventListener("resize", resizeViewport);
  window.addEventListener("resize", resizeViewport);
  window.addEventListener("keydown", onGlobalKeydown);
  window.addEventListener("keyup", onGlobalKeyup);
  window.addEventListener("hashchange", onMenuHashChange);
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
  const playKey = playHashGameKey();
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
    (playKey === lib.pendingAutosave.value?.game.projectId ||
      (lib.pendingAutosave.value?.game.installed &&
        (playKey === lib.pendingAutosave.value?.game.folder ||
          playKey === lib.pendingAutosave.value?.game.hash ||
          playKey === lib.pendingAutosave.value?.game.alias)))
  )
    await resumeLastGame(llmConfig());
  if (state.phase === "idle") clearPlayHash();
});

onUnmounted(() => {
  lib.unmountCatalog();
  releaseMovement();
  window.removeEventListener("blur", releaseMovement);
  window.visualViewport?.removeEventListener("resize", resizeViewport);
  window.removeEventListener("resize", resizeViewport);
  presentation.dispose();
  window.removeEventListener("keydown", onGlobalKeydown);
  window.removeEventListener("keyup", onGlobalKeyup);
  window.removeEventListener("hashchange", onMenuHashChange);
  document.removeEventListener("visibilitychange", onPageHidden);
  window.removeEventListener("pagehide", onPageHide);
  releaseAgentAudioPreviews();
  // Development only: this instance is being replaced by a hot update, and its
  // worker would otherwise keep ticking (and autosaving) behind the new one.
  if (import.meta.hot) shutdownEngine();
});
// The URL is the source of truth for "a game is running": name it while the
// game runs. A remix can turn the running game into a new game without
// leaving the running phase, so the unpause after a remix turn re-asserts the
// hash from whatever is booted then. Back at the picker (the player ejected,
// or a boot failed) the hash is cleared and the autosave slot is re-read so
// the offer below matches storage.
watch(
  () => [state.phase, state.paused, state.walkthrough.active, state.walkthrough.tick] as const,
  ([phase, paused, watching]) => {
    if (phase === "running") {
      if (!paused) {
        if (watching && state.walkthrough.alias) {
          markWatchHash(state.walkthrough.alias, state.walkthrough.tick);
        } else {
          const game = currentGame();
          const playIdentifier = game?.installed
            ? (game.folder ?? game.hash ?? game.alias)
            : game?.projectId;
          if (playIdentifier) markPlayHash(playIdentifier);
        }
      }
      return;
    }
    if (phase === "idle" || phase === "error") {
      clearPlayHash();
      lib.syncMenuPhase();
    }
  },
);
</script>

<template>
  <div
    class="app-container"
    :class="{ 'at-menu': state.phase === 'idle' || state.phase === 'error' }"
    :style="{ '--visible-height': `${viewportHeight}px` }"
  >
    <GameHeader
      :touch-controls="touchControls"
      :crt-enabled="crtEnabled"
      :gpu-backend="gpuBackend"
      :debug-open="debugOpen"
      :export-busy="exportBusy"
      :export-refusal="exportRefusal"
      :export-saved-progress-key="exportSavedProgressKey"
      @update:touch-controls="touchControls = $event"
      @update:crt-enabled="crtEnabled = $event"
      @update:debug-open="debugOpen = $event"
      @trigger-key="(code) => playArea?.triggerKey(code)"
      @export-zip="(project, savedProgress) => lib.onExportAgiZip(true, project, savedProgress)"
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

    <!-- Screen Area (Hidden until game is running) -->
    <PlayArea ref="playArea" :touch-controls="touchControls" :crt-enabled="crtEnabled">
      <AgentBubble />
    </PlayArea>

    <SoundPreview
      v-if="!state.powerUp.open && latestAgentAudio.length"
      :audio="latestAgentAudio"
      data-testid="latest-sound-preview"
    />

    <AgentLogPanel />
  </div>
</template>
