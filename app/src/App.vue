<script setup lang="ts">
import AgentLogPanel from "./authoring/AgentLogPanel.vue";
import AgentBubble from "./authoring/AgentBubble.vue";
import GameHeader from "./shell/GameHeader.vue";
import AiSettingsDialog from "./settings/AiSettings.vue";
import SoundPreview from "./authoring/SoundPreview.vue";
import WalkthroughBar from "./walkthrough/WalkthroughBar.vue";
import PlayArea from "./play/PlayArea.vue";
import AssistantStart from "./shell/AssistantStart.vue";
import CreateDock from "./shell/CreateDock.vue";
import { createCommandRegistry } from "./shell/commands/commandRegistry.ts";
import { emptyCommandContext, provideCommands } from "./shell/commands/commandContext.ts";
import UiButton from "./ui/UiButton.vue";
import UiDialog from "./ui/UiDialog.vue";
import UiToast from "./ui/UiToast.vue";
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
import SetupPanel from "./home/SetupPanel.vue";
import { followEmptyProjectRoute } from "./home/emptyProjectRoute.ts";
import StaleTabNote from "./play/StaleTabNote.vue";
import StartOverNote from "./play/StartOverNote.vue";
import { nextViewportLayout } from "./play/viewportLayout.ts";
import ReferenceUpload from "./references/ReferenceUpload.vue";
import { createShell, provideShell } from "./shell/useShell.ts";
import { isGameRoute, parseGameHash } from "./shell/shellRoute.ts";
import { createCreateWorkspace, provideCreateWorkspace } from "./shell/useCreateWorkspace.ts";
import { useCreateMode } from "./shell/useCreateMode.ts";
import { usePlayHereFromStudio } from "./shell/usePlayHere.ts";
import { createInspector, provideInspector } from "./inspector/useInspector.ts";

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
const WorldMap = defineAsyncComponent(() => import("./world/WorldMap.vue"));
const RoomStudio = defineAsyncComponent(() => import("./studio/RoomStudio.vue"));
const SpriteStudio = defineAsyncComponent(() => import("./studio/sprite/SpriteStudio.vue"));
// Logic Studio — Monaco plus its analysis worker — loads only when the
// library's Edit asks for it; the Play boot path never sees it.
const LogicStudio = defineAsyncComponent(() => import("./studio/logic/LogicStudio.vue"));
// Sound Studio — the native cue workspace — loads on the same demand path.
const SoundStudio = defineAsyncComponent(() => import("./studio/sound/SoundStudio.vue"));
// The direct studio's creative dock host — image import, preparation and
// the board — loads with a Studio, which is the only place it mounts.
const StudioDockHost = defineAsyncComponent(() => import("./studio/creative/StudioDockHost.vue"));
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

/** A phone held upright: Create is one view-only sheet instead of two docks. */
const phone = computed(() => touchControls.value && viewport.value.height >= viewport.value.width);
/**
 * Room Studio needs a larger screen than the phone layouts give it: the touch
 * portrait and short-landscape layouts, and any window as narrow as a phone.
 */
const studioFits = computed(() => {
  const { width, height } = viewport.value;
  return width > 600 && !(touchControls.value && (height >= width || height <= 600));
});
/** The Create docks' tabs and folds, and the centre's Studio (shell/useCreateWorkspace.ts). */
const workspace = createCreateWorkspace({
  pauseEngine: engine.pauseEngine,
  resumeEngine: engine.resumeEngine,
  focusGame: () => shellBridge.focusGameInput(),
  viewOnly: () => phone.value,
  studioFits: () => studioFits.value,
});
provideCreateWorkspace(workspace);
/** Play or Create for the loaded game; the URL names both (shell/shellRoute.ts). */
const shell = createShell({
  engine,
  bridge: shellBridge,
  librarySource: (projectId) =>
    lib.savedGames.value.find((game) => game.projectId === projectId)?.library?.source,
  initialMode: parseGameHash(location.hash)?.mode ?? "play",
  createGuard: { unkept: workspace.studioUnkept, confirm: workspace.confirmStudioLeave },
});
provideShell(shell);
engine.setProjectMode(shell.mode.value);
const creating = computed(() => state.phase === "running" && shell.mode.value === "create");
const createKeyboard = useTemplateRef("createKeyboard");
const commands = createCommandRegistry(
  () => createKeyboard.value?.context() ?? emptyCommandContext(),
);
provideCommands(commands);
const studio = workspace.studio;
/** Room Studio takes the whole workspace; the docks wait hidden, still mounted, as they were. */
const studioOpen = computed(() => creating.value && studio.value !== null);

/**
 * The running game's authored project — the creative dock host (a lazy
 * Studio chunk) gates its "Import image…" launch on it, so imported games
 * without a project offer none. `currentGame` reads non-reactive boot
 * state; the reactive phase flips to "running" when it lands, which is
 * what makes this computed re-evaluate.
 */
const studioProjectId = computed(() =>
  state.phase === "running" ? (engine.currentGame()?.projectId ?? null) : null,
);
/**
 * Logic Studio is a stored-project workspace, not a running-game mode: it
 * opens over whatever is mounted, holds its own pause while a run is hidden,
 * and closing hands the untouched game back. The URL keeps naming the run —
 * editing never adopts a play/create identity.
 */
const logicProjectId = ref<ProjectId>();
const logicStudioEl = useTemplateRef("logicStudio");
watch(logicProjectId, (id, previous) => {
  if (id !== undefined) {
    releaseMovement();
    if (state.phase === "running") engine.pauseEngine("logicStudio");
  } else if (previous !== undefined) {
    engine.resumeEngine("logicStudio");
  }
});
/**
 * Sound Studio is the same stored-project mount: it opens over whatever is
 * running, holds its own pause while a run is hidden, and closing hands the
 * untouched game back. Audible preview adds its own per-lease freeze.
 */
const soundProjectId = ref<ProjectId>();
const soundStudioEl = useTemplateRef("soundStudio");
watch(soundProjectId, (id, previous) => {
  if (id !== undefined) {
    releaseMovement();
    if (state.phase === "running") engine.pauseEngine("soundStudio");
  } else if (previous !== undefined) {
    engine.resumeEngine("soundStudio");
  }
});
const sheetOpen = workspace.sheetOpen;
/** Room Studio's Play here: leave Studio, show Play, jump the game to the spot. */
const playHereFromStudio = usePlayHereFromStudio({
  closeStudio: () => workspace.closeStudio(),
  showPlay: () => shell.setMode("play"),
  playHere: (target) => engine.playHere(target),
});
const { onDockKey } = useCreateMode({
  state,
  workspace,
  roomMap: engine.roomMap,
  creating,
  phone,
  debugOpen,
  gameInput: () => playArea.value?.inputEl,
});
const { onKeydown: onGlobalKeydown, onKeyup: onGlobalKeyup } = useGameKeys({
  engine,
  playArea: () => playArea.value,
  // Create's dock keys, Studio holding the paused game, and the stored-project
  // studios over a run: nothing typed there may reach the game.
  intercept: (ev) =>
    onDockKey(ev) ||
    (creating.value && (createKeyboard.value?.blocksGame(ev) ?? true)) ||
    studio.value !== null ||
    logicProjectId.value !== undefined ||
    soundProjectId.value !== undefined,
});
/** The stored-project studios' keyup gets the same isolation as its keydown. */
function onShellKeyup(ev: KeyboardEvent): void {
  if (logicProjectId.value !== undefined || soundProjectId.value !== undefined) return;
  onGlobalKeyup(ev);
}
/** Create keeps Developer activity in its Activity tab while that shows. */
const activityDocked = computed(
  () =>
    creating.value &&
    !phone.value &&
    workspace.active.right === "activity" &&
    !workspace.collapsed.right,
);
/**
 * Developer activity is off the page everywhere: Settings → Advanced opens
 * it, as a dialog — or, in Create on a desktop, as the Activity tab.
 */
const activitySheetOpen = ref(false);
function openDeveloperActivity(): void {
  if (creating.value && !phone.value) workspace.showPanel("activity");
  else activitySheetOpen.value = true;
}
const assistantShown = computed(() =>
  phone.value
    ? sheetOpen.value && workspace.active.sheet === "assistant"
    : workspace.active.right === "assistant" && !workspace.collapsed.right,
);

watch(shell.mode, (mode) => {
  engine.setProjectMode(mode);
  releaseMovement();
  // The switch keeps focus otherwise, and a focused control swallows game keys.
  if (mode === "play" && !state.powerUp.open && !touchControls.value)
    nextTick(() => playArea.value?.focusInput());
});
// A game that starts from the keyboard (Enter on a Play button) takes the
// keyboard once its input line first accepts text: the button that had
// focus left with the menu. Focus another control or a dialog holds (the
// profile picker, AI settings) stays where it is.
let claimKeyboard = false;
watch(
  () => [state.phase, state.inputReady] as const,
  ([phase, ready], previous) => {
    if (phase !== "running") {
      claimKeyboard = false;
      return;
    }
    if (previous?.[0] !== "running") claimKeyboard = !touchControls.value;
    if (!claimKeyboard || !ready) return;
    claimKeyboard = false;
    void nextTick(() => {
      const focused = document.activeElement;
      if (state.walkthrough.active || (focused && focused !== document.body)) return;
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
  if (state.phase === "idle" && (await followEmptyProjectRoute())) return;
  if (state.phase === "running") shell.followRoute(location.hash);
  else if (state.phase === "idle" && isGameRoute(location.hash)) clearPlayHash();
}

async function onStartWalkthrough(targetGame: string): Promise<void> {
  if (!(await workspace.confirmStudioLeave())) return;
  await resumeAudio();
  clearPlayHash();
  await startWalkthrough(targetGame);
}
shellBridge.startWalkthrough = (target) => void onStartWalkthrough(target);
shellBridge.openLogicProject = (projectId) => {
  logicProjectId.value = projectId;
};
shellBridge.openSoundProject = (projectId) => {
  soundProjectId.value = projectId;
};

// Dev/e2e handle: open the stored-project workspace and read the caret, so a
// scripted run can exercise Edit over a running game and check definition
// navigation without reaching into the component tree.
if (import.meta.env?.DEV) {
  (
    window as unknown as {
      __AGI_LOGIC__?: {
        open(projectId: string): void;
        cursor(): { line: number; column: number } | undefined;
      };
    }
  ).__AGI_LOGIC__ = {
    open: (projectId) => shellBridge.openLogicProject(projectId as ProjectId),
    cursor: () => logicStudioEl.value?.cursor() as { line: number; column: number } | undefined,
  };
  (
    window as unknown as {
      __AGI_SOUND__?: {
        open(projectId: string): void;
        cursor(): { eventId: string | null; lane: number; index: number } | undefined;
      };
    }
  ).__AGI_SOUND__ = {
    open: (projectId) => shellBridge.openSoundProject(projectId as ProjectId),
    cursor: () =>
      soundStudioEl.value?.cursor() as
        { eventId: string | null; lane: number; index: number } | undefined,
  };
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

onMounted(async () => {
  // An unreadable game route can never resume: drop it before anything waits.
  if (isGameRoute(location.hash) && !parseGameHash(location.hash)) clearPlayHash();
  window.addEventListener("blur", releaseMovement);
  window.visualViewport?.addEventListener("resize", resizeViewport);
  window.addEventListener("resize", resizeViewport);
  window.addEventListener("keydown", onGlobalKeydown);
  window.addEventListener("keyup", onShellKeyup);
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
  else if (await followEmptyProjectRoute()) {
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
});

/** Home's note about the link it was opened with; cleared once any game runs. */
const routeNote = ref("");

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
  if (navigation instanceof PerformanceNavigationTiming && navigation.type === "reload") return;
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
  window.removeEventListener("keyup", onShellKeyup);
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
      routeNote.value = "";
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
      'studio-open': studioOpen,
    }"
    :style="{ '--layout-height': `${viewport.height}px` }"
  >
    <div class="shell" :inert="logicProjectId !== undefined || soundProjectId !== undefined">
      <CreateKeyboard
        v-if="creating"
        ref="createKeyboard"
        :registry="commands"
        @focus-game="playArea?.focusInput()"
        @zone-change="releaseMovement"
      />
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
        :class="{
          'shell-body--create': creating,
          'shell-body--studio': studioOpen,
          'shell-body--sheet': creating && phone,
          'shell-body--fold-left': creating && !phone && workspace.collapsed.left,
          'shell-body--fold-right': creating && !phone && workspace.collapsed.right,
          'shell-body--asking': !creating && state.phase === 'running' && state.powerUp.open,
          'assistant-open': state.phase === 'running' && state.powerUp.open,
        }"
      >
        <CreateDock
          v-if="creating && !phone"
          v-show="!studioOpen"
          v-model:active="workspace.active.left"
          side="left"
          class="shell-dock shell-dock--left"
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
            <UiToast
              v-if="playHereFromStudio.note.value"
              tone="warn"
              dismissible
              data-testid="play-here-note"
              @dismiss="playHereFromStudio.dismiss()"
            >
              {{ playHereFromStudio.note.value }}
            </UiToast>
            <ProjectRestartNotice v-if="creating && engine.pendingProjectRestart.value" />
            <StaleTabNote />
          </template>
          <template #screen-notes>
            <StartOverNote />
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
              :title="state.powerUp.open ? 'Back to game (Esc)' : 'Ask about this game'"
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
        <StudioDockHost
          v-if="studioOpen && studio"
          class="shell-center"
          :studio="studio"
          :project-id="studioProjectId"
        >
          <template #default="{ launch, underlay }">
            <RoomStudio
              v-if="studio.kind === 'picture'"
              :picture-number="studio.pictureNumber"
              :bytes="studio.bytes"
              :authored-source="studio.authoredSource"
              :profile="studio.profile"
              :title="studio.title"
              :subtitle="studio.subtitle"
              :base-revision="studio.baseRevision"
              :base-authoring="studio.baseAuthoring"
              :files="studio.files"
              :walk="studio.walk"
              :underlay="underlay"
              :creative-launch="launch"
              @close="workspace.closeStudio()"
              @reopen="(fromStorage) => void workspace.reopenStudio(fromStorage)"
              @play-here="(target) => void playHereFromStudio.play(target)"
            />
            <SpriteStudio
              v-else-if="studio.kind === 'sprite'"
              :key="`${studio.viewNumber}:${studio.baseRevision}:${studio.stagedReference ?? ''}`"
              :view-number="studio.viewNumber"
              :bytes="studio.bytes"
              :profile="studio.profile"
              :title="studio.title"
              :base-revision="studio.baseRevision"
              :base-authoring="studio.baseAuthoring"
              :files="studio.files"
              :usage="studio.usage"
              :rooms="studio.rooms"
              :speed="studio.speed"
              :cyclers="studio.cyclers"
              :priority-base="studio.priorityBase"
              :staged-reference="studio.stagedReference"
              :creative-launch="launch"
              @close="workspace.closeStudio()"
              @reopen="(fromStorage) => void workspace.reopenStudio(fromStorage)"
            />
          </template>
        </StudioDockHost>
        <aside
          v-show="!studioOpen"
          class="shell-side"
          :class="{ 'shell-side--sheet': creating && phone, 'shell-side--open': sheetOpen }"
          :aria-label="creating ? 'Assistant panels' : 'Ask'"
          data-shell-keys
        >
          <CreateDock
            v-if="creating && phone"
            v-model:active="workspace.active.sheet"
            side="sheet"
            :built-in="['assistant']"
            :collapsed="!sheetOpen"
            @toggle="workspace.sheetOpen.value = !workspace.sheetOpen.value"
          />
          <CreateDock
            v-else-if="creating"
            v-model:active="workspace.active.right"
            side="right"
            :built-in="['assistant']"
            :collapsed="workspace.collapsed.right"
            @toggle="workspace.toggleDock('right')"
          />
          <div v-show="!creating || assistantShown" class="assistant-host">
            <!-- Mounted through the turn, so it sees the panel open and close. -->
            <AssistantStart v-if="creating" v-show="!state.powerUp.open" :phone />
            <AgentBubble :surface="creating && !phone ? 'dock' : 'drawer'" />
          </div>
        </aside>
      </div>
    </div>

    <!-- The stored-project workspace sits above the shell; the mounted run
         stays mounted and inert behind it, never replaced or re-identified. -->
    <LogicStudio
      v-if="logicProjectId"
      ref="logicStudio"
      :project-id="logicProjectId"
      @update:project-id="logicProjectId = $event"
      @close="logicProjectId = undefined"
    />
    <SoundStudio
      v-if="soundProjectId"
      ref="soundStudio"
      :project-id="soundProjectId"
      :acquire-pause-lease="engine.acquireRuntimePauseLease"
      @update:project-id="soundProjectId = $event"
      @close="soundProjectId = undefined"
    />

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

    <SetupPanel :route-note="routeNote" />

    <!-- Below the fold: while Studio holds the page still they wait hidden,
         out of Tab's reach. -->
    <SoundPreview
      v-if="!state.powerUp.open && latestAgentAudio.length"
      v-show="!studioOpen"
      :audio="latestAgentAudio"
      data-testid="latest-sound-preview"
    />

    <UiDialog
      v-if="!activityDocked"
      v-model:open="activitySheetOpen"
      title="Developer activity"
      size="lg"
      data-testid="developer-activity-sheet"
    >
      <AgentLogPanel @booted="activitySheetOpen = false" />
    </UiDialog>

    <ReferenceUpload v-if="state.phase === 'running'" />

    <WorldMap v-if="mapOpen" />
  </div>
</template>
