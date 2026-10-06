<script setup lang="ts">
import { VOCABULARY } from "../../src/vocabulary.ts";
import GameHeader from "./shell/GameHeader.vue";
import WalkthroughBar from "./walkthrough/WalkthroughBar.vue";
import { createWorkspaceEditor, provideWorkspaceEditor } from "./shell/workspaceEditor.ts";
import { createCommandRegistry } from "./shell/commands/commandRegistry.ts";
import { emptyCommandContext, provideCommands } from "./shell/commands/commandContext.ts";
import UiButton from "./ui/UiButton.vue";
import UiDialog from "./ui/UiDialog.vue";
import UiToast from "./ui/UiToast.vue";
import UiChip from "./ui/UiChip.vue";
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
import { useEngine, type AutosaveRecord } from "./engine/useEngine.ts";
import { MODEL_OPTIONS } from "../../src/agent/modelEffort.ts";
import { reconcileGameIndex } from "./project/gameStorage.ts";
import type { ProjectId } from "./project/gameTypes.ts";
import { useGameKeys } from "./play/useGameKeys.ts";

import { provideEngine } from "./engine/engineContext.ts";
import { createShellBridge, provideShellBridge } from "./shell/shellBridge.ts";
import { createAiSettings, provideAiSettings } from "./settings/useAiSettings.ts";
import { createGameLibrary, provideGameLibrary } from "./library/useGameLibrary.ts";
import { createPresentation, providePresentation } from "./play/usePresentation.ts";
import { readCrtAmount } from "./settings/crtPreference.ts";
import SetupPanel from "./home/SetupPanel.vue";
import { followEmptyProjectRoute } from "./home/emptyProjectRoute.ts";
import StartOverNote from "./play/StartOverNote.vue";
import { nextViewportLayout } from "./play/viewportLayout.ts";
import { createShell, provideShell } from "./shell/useShell.ts";
import { isGameRoute, parseGameHash } from "./shell/shellRoute.ts";
import { createCreateWorkspace, provideCreateWorkspace } from "./shell/useCreateWorkspace.ts";
import { useCreateMode } from "./shell/useCreateMode.ts";
import { createInspector, provideInspector } from "./inspector/useInspector.ts";
import { referenceUpload } from "./references/referenceUploadState.ts";

const AgentLogPanel = defineAsyncComponent(() => import("./authoring/AgentLogPanel.vue"));
const AgentBubble = defineAsyncComponent(() => import("./authoring/AgentBubble.vue"));
const AiSettingsDialog = defineAsyncComponent(() => import("./settings/AiSettings.vue"));
const SoundPreview = defineAsyncComponent(() => import("./authoring/SoundPreview.vue"));
const PlayArea = defineAsyncComponent(() => import("./play/PlayArea.vue"));
const ReferenceUpload = defineAsyncComponent(() => import("./references/ReferenceUpload.vue"));
const AgentDrawer = defineAsyncComponent(() => import("./agent/AgentDrawer.vue"));
const ProjectRestartNotice = defineAsyncComponent(
  () => import("./project/ProjectRestartNotice.vue"),
);
const CreateKeyboard = defineAsyncComponent(() => import("./shell/commands/CreateKeyboard.vue"));
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
// Display fixtures start crisp; an explicit preference also exercises CRT.
const crtAmount = ref(readCrtAmount(localStorage, testMode ? 0 : 1));

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

watch(crtAmount, (amount) => localStorage.setItem("monotio_agi.crtAmount", String(amount)));

function onMenuHashChange(): void {
  if (location.hash === "#create-adventure") shellBridge.openCreateSection(false);
}

const engine = useEngine(
  (frame) => {
    presentation.present(frame);
    engine.observeMapFrame(frame);
  },
  {
    pendingEditorChanges: () => workspaceEditor.pendingChanges.value,
    flushWorkspace: async () => {
      await workspaceEditor.flush.value?.();
    },
    onPromptType: (text) => {
      playArea.value?.handlePromptType(text);
    },
  },
);
provideEngine(engine);
provideInspector(createInspector(engine, presentation));

// The map's graph code loads only when the player opens it — never on boot.
const WorldMap = defineAsyncComponent(() => import("./world/WorldMap.vue"));
const CreateWorkspace = defineAsyncComponent(
  () => import("./studio/workspace/CreateWorkspace.vue"),
);
const mapOpen = computed(() => engine.roomMap?.open.value ?? false);
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
  resumeFromRecord,
  flushAutosave,
  lastAutosaveRecord,
  shutdownEngine,
} = engine;

const shellBridge = createShellBridge();
provideShellBridge(shellBridge);
shellBridge.togglePowerUp = (mode) => {
  if (state.powerUp.busy) return;
  if (state.powerUp.open) {
    if (mode !== undefined && state.powerUp.mode !== mode && state.powerUp.mode !== "room") {
      state.powerUp.mode = mode;
      return;
    }
    engine.closePowerUp();
    shellBridge.focusGameInput();
    return;
  }
  if (mode !== undefined) state.powerUp.mode = mode;
  void engine.openPowerUp(ai.llmConfig());
};
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

/** A phone held upright: Create is one view-only sheet instead of two docks. */
const phone = computed(() => touchControls.value && viewport.value.height >= viewport.value.width);
const workspacePhone = computed(() => viewport.value.width <= 600);
const workspaceEditor = createWorkspaceEditor(engine);
provideWorkspaceEditor(workspaceEditor);
/** The Create docks' tabs and folds (shell/useCreateWorkspace.ts). */
const workspace = createCreateWorkspace({
  panelDock: (id) => workspaceEditor.panelDock(id),
  viewOnly: () => phone.value,
});
provideCreateWorkspace(workspace);
/** Play or Create for the loaded game; the URL names both (shell/shellRoute.ts). */
const shell = createShell({
  engine,
  bridge: shellBridge,
  librarySource: (projectId) =>
    lib.savedGames.value.find((game) => game.projectId === projectId)?.library?.source,
  initialMode: parseGameHash(location.hash)?.mode ?? "play",
  awaitingLatest: () => lib.latestVersion.value !== undefined,
});
provideShell(shell);
engine.setProjectMode(shell.mode.value);
const creating = computed(() => state.phase === "running" && shell.mode.value === "create");
watch(
  () => state.phase,
  (phase) => {
    if (phase === "loading") {
      // Load the surface alongside the worker. The async component owns mount and errors.
      void import("./play/PlayArea.vue").catch(() => {});
    }
  },
);
/** CRT is a Play presentation; editing always shows the crisp frame. */
const crtShown = computed(() => (creating.value ? 0 : crtAmount.value));
watch(crtShown, (amount) => presentation.setCrtAmount(amount));
const createKeyboard = useTemplateRef("createKeyboard");
const commands = createCommandRegistry(
  () => createKeyboard.value?.context() ?? emptyCommandContext(),
);
provideCommands(commands);
async function exportWorkspaceGame(project: boolean): Promise<void> {
  try {
    await lib.onExportAgiZip(true, project);
  } catch (cause) {
    exportRefusal.value = cause instanceof Error ? cause.message : String(cause);
  }
}
watch(
  () => state.phase,
  (phase) => {
    if (phase === "idle") workspaceEditor.reset();
  },
);
const { onDockKey } = useCreateMode({
  state,
  workspace,
  roomMap: () => engine.roomMap,
  creating,
  phone,
  debugOpen,
  gameInput: () => playArea.value?.inputEl,
});
const { onKeydown: onGlobalKeydown, onKeyup: onGlobalKeyup } = useGameKeys({
  engine,
  creating: () => creating.value,
  playArea: () => playArea.value,
  // Workspace keys reach MAIN only while the game zone owns focus.
  intercept: (ev) =>
    onDockKey(ev) ||
    (creating.value &&
      (createKeyboard.value?.blocksGame(ev) ?? ev.target !== playArea.value?.inputEl)),
});
/**
 * Developer activity is off the page everywhere: Settings → Advanced opens
 * it as a dialog.
 */
const activitySheetOpen = ref(false);
function openDeveloperActivity(): void {
  activitySheetOpen.value = true;
}
async function restartPlay(): Promise<void> {
  if (await engine.setProjectMode("play", true)) shell.setMode("play");
}
let modeChange = 0;
let claimKeyboard = false;
let modeKeyboard = false;
watch(shell.mode, async (mode, previous) => {
  const change = ++modeChange;
  releaseMovement();
  if (!(await engine.setProjectMode(mode))) {
    if (change === modeChange) shell.setMode(previous);
    return;
  }
  if (change !== modeChange) return;
  // A cold return enables input when its opening LOGIC finishes.
  if (mode === "play" && !state.powerUp.open && !touchControls.value) {
    claimKeyboard = !state.inputReady;
    modeKeyboard = claimKeyboard;
    if (!claimKeyboard) nextTick(() => playArea.value?.focusInput());
  }
});
// A game that starts from the keyboard (Enter on a Play button) takes the
// keyboard once its input line first accepts text: the button that had
// focus left with the menu. Focus another control or a dialog holds (the
// profile picker, AI settings) stays where it is.
watch(
  () => [state.phase, state.inputReady] as const,
  ([phase, ready], previous) => {
    if (phase !== "running") {
      claimKeyboard = false;
      modeKeyboard = false;
      return;
    }
    if (previous?.[0] !== "running") claimKeyboard = !touchControls.value;
    if (!claimKeyboard || !ready) return;
    claimKeyboard = false;
    const fromMode = modeKeyboard;
    modeKeyboard = false;
    void nextTick(() => {
      const focused = document.activeElement;
      if (
        state.walkthrough.active ||
        (focused &&
          focused !== document.body &&
          !(fromMode && focused.closest('[role="radiogroup"][aria-label="Mode"]')))
      )
        return;
      playArea.value?.focusInput();
    });
  },
);
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
async function onPopState(): Promise<void> {
  if (state.phase === "idle" && followUnsupportedProjectRoute()) {
    clearPlayHash();
    return;
  }
  if (state.phase === "idle" && (await followEmptyProjectRoute())) return;
  if (state.phase === "running") shell.followRoute(location.hash);
  else if (state.phase === "idle" && isGameRoute(location.hash)) clearPlayHash();
}

async function onStartWalkthrough(targetGame: string): Promise<void> {
  await resumeAudio();
  clearPlayHash();
  await startWalkthrough(targetGame);
}
shellBridge.startWalkthrough = (target) => void onStartWalkthrough(target);
async function openLogicProject(projectId: ProjectId): Promise<void> {
  engine.setProjectMode("create");
  if (engine.currentGame()?.projectId !== projectId) {
    const stored = lib.savedGames.value.find((game) => game.projectId === projectId);
    if (!stored) return;
    shell.expectCreate(projectId);
    await lib.onPlayLibraryGame(stored);
    shell.expectCreate(projectId);
  } else shell.setMode("create");
  const { loadAuthoredGame } = await import("./project/gameStorage.ts");
  const data = await loadAuthoredGame(projectId);
  const { inspectEditableProject } = await import("./project/projectWorkspaceSource.ts");
  const keys = data
    ? Object.keys(inspectEditableProject(data).documents)
        .filter((key) => key.startsWith("logic:"))
        .sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]))
    : [];
  workspaceEditor.open(keys.includes("logic:1") ? "logic:1" : (keys[0] ?? "logic:1"));
}
shellBridge.openLogicProject = (id) => {
  void openLogicProject(id);
};

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
  // A paused walkthrough hands over a paused game: the play bar's Resume starts it.
  const paused = state.walkthrough.status === "paused";
  releaseMovement();
  void stopWalkthrough(true);
  if (paused) engine.historyView.pauseAtLive();
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

// Resolve a game link before Home starts previews of unrelated library cards.
const initialRoutePending = ref(parseGameHash(location.hash) !== null);
async function mountApplication(): Promise<void> {
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
    await lib.refreshUnsupportedProjects();
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
  const finish = import.meta.hot?.data?.["monotio_agi_resume"] as AutosaveRecord | undefined;
  if (import.meta.hot?.data) delete import.meta.hot.data["monotio_agi_resume"];
  lib.refreshPendingAutosave();
  const playKey = parseGameHash(location.hash)?.key ?? null;
  const watchTarget = watchHashTarget();
  if (finish) await resumeFromRecord(finish, llmConfig());
  else if (watchTarget)
    // startWalkthrough drives the tape to completion: await would suspend the
    // rest of mount — including the GPU stage the walkthrough paints into.
    void startWalkthrough(watchTarget.alias, { initialTick: watchTarget.tick }).catch((e) => {
      state.phase = "error";
      state.error = e instanceof Error ? e.message : String(e);
    });
  else if (followUnsupportedProjectRoute()) {
    shell.reset();
  } else if (await followEmptyProjectRoute()) {
    return;
  } else if (playKey) {
    // Only a routed key that proves no resume offer takes the ordinary routed
    // open. An offer that was attempted and refused stays the runtime's own
    // visible result — never retried and never booted over by this caller.
    if ((await lib.routedResume(playKey)) === "absent") await openRoutedGame(playKey);
  }
  if (state.phase === "idle") {
    shell.reset();
    clearPlayHash();
  }
}
onMounted(() =>
  mountApplication().finally(() => {
    initialRoutePending.value = false;
  }),
);

/** Home's note about the link it was opened with; cleared once any game runs. */
const routeNote = ref("");
const unsupportedRouteId = ref("");
const unsupportedRouteProject = computed(() =>
  lib.unsupportedProjects.value.find((game) => game.projectId === unsupportedRouteId.value),
);

/** A future project link opens its recovery actions before any playable reader runs. */
function followUnsupportedProjectRoute(): boolean {
  const key = parseGameHash(location.hash)?.key;
  const game = lib.unsupportedProjects.value.find((entry) => entry.projectId === key);
  if (!game) return false;
  unsupportedRouteId.value = game.projectId;
  return true;
}

/**
 * A cold `#play/<target>` or `#create/<target>` whose game has no pending
 * autosave: a link opened or pasted opens the stored library project or
 * installed edition it names (its own autosave, or a fresh boot). A reload
 * keeps landing on Home, which offers the game, as it always has. A game
 * this browser does not hold gets a note either way.
 */
async function openRoutedGame(key: string): Promise<void> {
  const stored = lib.savedGames.value.find((game) => game.projectId === key);
  const norm = key.toLowerCase();
  const installed = (state.installedGames ?? []).some((game) =>
    [game.hash, game.alias, game.folder, game.wordsSha256].some(
      (spelling) => spelling?.toLowerCase() === norm,
    ),
  );
  if (!stored && !installed) {
    routeNote.value = "That game isn't in this browser.";
    return;
  }
  const navigation = performance.getEntriesByType("navigation")[0];
  if (
    navigation instanceof PerformanceNavigationTiming &&
    navigation.type === "reload" &&
    parseGameHash(location.hash)?.mode !== "create"
  )
    return;
  if (stored) return lib.onPlayLibraryGame(stored);
  try {
    await lib.onPlayLocalGame(key);
  } catch (error) {
    lib.libraryActionError.value = String(error).replace(/^Error: /, "");
  }
}

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
  () =>
    [
      state.phase,
      state.paused,
      state.walkthrough.active,
      state.walkthrough.tick,
      state.patchTick,
    ] as const,
  ([phase, paused, watching]) => {
    if (phase === "running") {
      routeNote.value = "";
      if (!paused || (!watching && !state.historyView.active)) {
        if (watching) updateWatchHash();
        else shell.markRoute();
      }
      return;
    }
    if (phase === "idle" || phase === "error") {
      if (phase !== "error" || lib.latestVersion.value === undefined) shell.reset();
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
      'workspace-focus': creating && workspaceEditor.focus.value,
    }"
    :style="{ '--layout-height': `${viewport.height}px` }"
  >
    <div class="shell">
      <CreateKeyboard
        v-if="creating"
        ref="createKeyboard"
        :registry="commands"
        @focus-game="playArea?.focusInput()"
        @zone-change="releaseMovement"
      />
      <GameHeader
        :touch-controls="touchControls"
        :crt-amount="crtAmount"
        :original-aspect="originalAspect"
        :gpu-backend="gpuBackend"
        :debug-open="debugOpen"
        :export-busy="exportBusy"
        :export-refusal="exportRefusal"
        @update:touch-controls="touchControls = $event"
        @update:crt-amount="crtAmount = $event"
        @update:original-aspect="originalAspect = $event"
        @update:debug-open="debugOpen = $event"
        @trigger-key="(code) => playArea?.triggerKey(code)"
        @export-zip="exportWorkspaceGame"
        @start-walkthrough="onStartWalkthrough"
        @developer-activity="openDeveloperActivity"
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
        :style="
          creating
            ? {
                '--workspace-game': `minmax(0, ${workspaceEditor.effectiveSplit.value}fr)`,
                '--workspace-edit': `minmax(0, ${100 - workspaceEditor.effectiveSplit.value}fr)`,
              }
            : undefined
        "
        :class="{
          'shell-body--create': creating,
          'shell-body--workspace': creating,
          'shell-body--no-editor': creating && !workspaceEditor.selected.value,
          'shell-body--logic': creating && workspaceEditor.kind.value === 'logic',
          'shell-body--sound': creating && workspaceEditor.kind.value === 'sound',
          'shell-body--stacked': creating && workspaceEditor.stackedLayout.value,
          'shell-body--focus':
            creating && workspaceEditor.focus.value && !!workspaceEditor.selected.value,
          'shell-body--sheet': creating && phone,
          'shell-body--fold-left': creating && !phone && workspace.collapsed.left,
          'shell-body--fold-right': creating && !phone && workspace.collapsed.right,
          'shell-body--asking': !creating && state.phase === 'running' && state.powerUp.open,
          'assistant-open': state.phase === 'running' && state.powerUp.open,
        }"
      >
        <CreateWorkspace
          v-if="
            state.phase === 'running' && (creating || workspaceEditor.retained.value.length > 0)
          "
          :creating="creating"
        />
        <PlayArea
          v-if="state.phase === 'running'"
          v-show="
            !creating ||
            (!workspaceEditor.stagePaused.value &&
              (!workspaceEditor.selected.value ||
                (workspacePhone
                  ? workspaceEditor.phonePlaytest.value
                  : !workspaceEditor.focus.value)))
          "
          ref="playArea"
          :touch-controls="touchControls"
          :crt-amount="crtShown"
          :original-aspect="originalAspect"
          :inspector-docked="creating"
        >
          <template #stage-actions>
            <UiChip
              v-if="creating"
              :tone="workspaceEditor.pendingAdmission.value ? 'warn' : 'ok'"
              dot
              data-testid="workspace-live"
              :title="
                workspaceEditor.pendingAdmission.value ? undefined : 'Timeline: present moment'
              "
              :aria-label="
                workspaceEditor.pendingAdmission.value ? undefined : 'Timeline: present moment'
              "
              >{{
                workspaceEditor.pendingAdmission.value ? VOCABULARY.waitingUpdate.label : "Now"
              }}</UiChip
            >
            <ProjectRestartNotice v-if="creating && engine.pendingProjectRestart.value" />
          </template>
          <template #screen-notes>
            <StartOverNote />
            <UiToast v-if="state.entryProblem" tone="warn" data-testid="entry-notice">
              {{ state.entryProblem }}
            </UiToast>
            <UiToast v-if="state.otherTab" tone="warn" data-testid="other-tab-notice">
              <span>This game is open in another tab.</span>
              <UiButton size="sm" @click="engine.takePlayBack()">Take back</UiButton>
            </UiToast>
            <UiToast v-if="state.returnProblem" tone="warn" data-testid="return-notice">
              <span>{{ state.returnProblem }}</span>
              <UiButton size="sm" @click="restartPlay">Restart</UiButton>
            </UiToast>
          </template>
          <template #strip-actions>
            <UiButton
              v-if="state.phase === 'running' && !creating"
              icon="sparkles"
              size="sm"
              class="ask-button"
              :class="{ 'ask-button--away': state.powerUp.open }"
              data-testid="menu-assistant"
              :aria-expanded="state.powerUp.open"
              :title="VOCABULARY.agent.help"
              :disabled="
                (state.powerUp.mode === 'room' && state.powerUp.open) ||
                state.recording.active ||
                state.historyView.active
              "
              @click="shell.toggleAsk()"
            >
              {{ VOCABULARY.agent.label }}
            </UiButton>
          </template>
        </PlayArea>
        <aside
          v-show="!creating && state.powerUp.open"
          class="shell-side"
          aria-label="Agent"
          data-shell-keys
        >
          <div class="assistant-host">
            <AgentBubble v-if="!creating && state.powerUp.open" surface="drawer" />
          </div>
        </aside>
      </div>
    </div>

    <!-- The agent drawer overlays the workspace; it never takes a column. -->
    <AgentDrawer />

    <AiSettingsDialog
      v-if="ai.dialogRequested.value"
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

    <SetupPanel
      :route-note="routeNote"
      :route-pending="initialRoutePending"
      :unsupported-project="unsupportedRouteProject"
    />

    <!-- Below the fold: while Focus holds the page still they wait hidden,
         out of Tab's reach. -->
    <SoundPreview
      v-if="!state.powerUp.open && latestAgentAudio.length"
      :audio="latestAgentAudio"
      data-testid="latest-sound-preview"
    />

    <UiDialog
      v-model:open="activitySheetOpen"
      title="Developer activity"
      size="lg"
      data-testid="developer-activity-sheet"
    >
      <AgentLogPanel v-if="activitySheetOpen" @booted="activitySheetOpen = false" />
    </UiDialog>

    <ReferenceUpload v-if="referenceUpload.open" />

    <WorldMap v-if="mapOpen" />
  </div>
</template>
