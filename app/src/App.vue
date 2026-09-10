<script setup lang="ts">
import AgentTaskControls from "./AgentTaskControls.vue";
import ActionMenu from "./ActionMenu.vue";
import UiIcon from "./UiIcon.vue";
import AiSettingsDialog from "./AiSettings.vue";
import SoundPreview from "./SoundPreview.vue";
import TouchControls from "./TouchControls.vue";
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  onWatcherCleanup,
  ref,
  useTemplateRef,
  watch,
} from "vue";
import {
  useEngine,
  readAutosave,
  lastGameKey,
  lastGameId,
  removeLibraryGame,
  type Frame,
  type AutosaveRecord,
  type ModalKind,
  type InstalledGameDescriptor,
  type ProjectId,
} from "./useEngine.ts";
import { AgiStage } from "./three/AgiStage.ts";
import { FRAME_HEIGHT, FRAME_WIDTH, compositeFrame } from "./composite.ts";
import { GLYPH_CURSOR, TEXT_COLS } from "../../src/runtime/textSurface.ts";
import { BUILTIN_TEMPLATES, parseCustomTemplate, type GameTemplate } from "./gameTemplates.ts";
import {
  DEFAULT_MODELS,
  MODEL_OPTIONS,
  type LlmConfig,
  type ProviderType,
} from "./agent/llmClient.ts";
import {
  getCachedGameMeta,
  loadAuthoredGame,
  listCachedGames,
  renameAuthoredGame,
  reconcileGameIndex,
  updateGamePreview,
  type CachedGameMeta,
} from "./gameStorage.ts";
import { buildProjectZip, buildPublicGameZip } from "./projectArchive.ts";
import { MAX_GAME_ZIP_BYTES, readGameFiles, readGameZip, type OpenedGame } from "./gameZip.ts";
import { readGameProgress, type ImportStorageReport } from "./gameProgress.ts";
import { captureGameDrop } from "./gameDrop.ts";
import { GAME_CATALOG, type GameCatalogEntry } from "./gameCatalog.ts";
import { loadHostedCatalog } from "./hostedCatalog.ts";
import { hasWalkthrough, type WalkthroughCheckpoint } from "./walkthrough.ts";
import { previewGame } from "./gamePreview.ts";
import { addLibraryGame, copyLibraryGame, type CheckedOpening } from "./gameLibrary.ts";
import { gameRevision } from "./gameMetadata.ts";
import {
  FUNCTION_KEYS,
  gameShortcuts,
  registeredKey,
  pcKey,
  movementDirection,
} from "./gameControls.ts";
import { AGI_KEY, DIRECTION_KEYS } from "../../src/runtime/keys.ts";
import { copyAiSettings, loadAiSettings, saveAiSettings, type AiSettings } from "./aiSettings.ts";
import {
  suggestAssertions,
  type AssertionSuggestion,
  type RecordingSnapshot,
} from "./gameRecording.ts";

const canvas = useTemplateRef("canvas");
const testMode = import.meta.env.MODE === "test";
const gpuCanvas = useTemplateRef("gpuCanvas");
const inputLine = ref("");
const promptLine = ref("");
const composing = ref(false);
const touchControls = ref(
  localStorage.getItem("monotio_agi.touchControls") === "on" ||
    (localStorage.getItem("monotio_agi.touchControls") !== "off" &&
      matchMedia("(any-pointer: coarse)").matches),
);
const viewportHeight = ref(window.visualViewport?.height ?? window.innerHeight);
watch(touchControls, (enabled) =>
  localStorage.setItem("monotio_agi.touchControls", enabled ? "on" : "off"),
);
const gpuBackend = ref<string>();
const crtEnabled = ref<boolean>(
  testMode
    ? localStorage.getItem("monotio_agi.crt") === "on"
    : localStorage.getItem("monotio_agi.crt") !== "off",
);
let stage: AgiStage | null = null;
let lastFrame: Frame | null = null;
/** Composed 320x200 RGBA frame shared by the probe canvas and the GPU stage. */
const composed = new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 4);

watch(crtEnabled, (on) => {
  localStorage.setItem("monotio_agi.crt", on ? "on" : "off");
  if (stage) {
    stage.crt = on;
    stage.flush();
  }
});
const heldMovementKeys = new Set<string>();
let touchMovementActive = false;

// Game and LLM state
const initialGames = listCachedGames();
const initialGameId = lastGameId() ?? initialGames[0]?.projectId ?? "knights-trial";
const savedGames = ref<CachedGameMeta[]>(initialGames);
const selectedGameId = ref<string>(initialGameId);
const zipInput = useTemplateRef("zipInput");
const folderInput = useTemplateRef("folderInput");
const importBusy = ref(false);
const importNotice = ref("");
const libraryActionBusy = ref(false);
const importError = ref("");
const libraryActionError = ref("");
const catalogOpenings = ref<Record<string, CheckedOpening | undefined>>(Object.create(null));
const catalogErrors = ref<Record<string, string | undefined>>(Object.create(null));
const catalogBusy = ref<Record<string, boolean | undefined>>(Object.create(null));
const catalogGames = new Map<string, OpenedGame>();
const featuredCatalog = GAME_CATALOG[0]!;
const catalogEntries = ref<GameCatalogEntry[]>([...GAME_CATALOG]);
const hostedCatalogError = ref("");
const hostedCatalogBusy = ref(false);
const availableCatalogEntries = computed(() =>
  catalogEntries.value.filter(
    (entry) =>
      entry.id !== featuredCatalog.id &&
      !savedGames.value.some(
        (game) =>
          game.library?.catalog?.id === entry.id && game.library.catalog.version === entry.version,
      ),
  ),
);
let catalogObserver: IntersectionObserver | null = null;
const catalogCardIds = new WeakMap<Element, string>();
function observeCatalogCard(element: unknown, id: string): void {
  if (
    !(element instanceof Element) ||
    catalogOpenings.value[id] ||
    catalogBusy.value[id] ||
    catalogErrors.value[id]
  )
    return;
  catalogCardIds.set(element, id);
  catalogObserver?.observe(element);
}
const selectedTemplateId = ref("");
const adventureDrafts = ref<Record<string, { title: string; brief: string; frontmatter: string }>>({
  ...Object.fromEntries(
    BUILTIN_TEMPLATES.map((tmpl) => {
      const frontmatter = tmpl.rawMarkdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0] ?? "";
      return [
        tmpl.id,
        {
          title: tmpl.title,
          brief: tmpl.rawMarkdown.slice(frontmatter.length).trimStart(),
          frontmatter,
        },
      ];
    }),
  ),
  custom: { title: "", brief: "", frontmatter: "---\nname: custom\n---\n" },
});
const adventureDraft = computed(
  () => adventureDrafts.value[selectedTemplateId.value] ?? adventureDrafts.value["custom"]!,
);
const cachedMeta = ref<CachedGameMeta | null>(getCachedGameMeta(initialGameId));
const renaming = ref(false);
const expandedGameId = ref<string>();
const gameTitle = ref("");
const renameError = ref("");
const titleInput = ref<HTMLInputElement>();
const createDetails = useTemplateRef("createDetails");
const createSummary = useTemplateRef("createSummary");
const createButton = useTemplateRef("createButton");
const CREATE_SECTION_KEY = "monotio_agi.createAdventure";
let storedCreatePreference: "open" | "closed" | null = null;
try {
  const stored = localStorage.getItem(CREATE_SECTION_KEY);
  if (stored === "open" || stored === "closed") storedCreatePreference = stored;
} catch {
  /* A blocked store leaves the section on its context-sensitive default. */
}
const createPreference = ref<"open" | "closed" | null>(storedCreatePreference);

const libraryAutosaves = computed<Record<string, AutosaveRecord>>(() =>
  Object.fromEntries(
    [
      ...savedGames.value.map((game) => game.projectId),
      ...(state.installedGames ?? []).flatMap((item) => [
        item.hash,
        item.alias,
        ...(item.folder ? [item.folder] : []),
      ]),
    ].flatMap((key) => {
      const autosave = readAutosave(key);
      return autosave ? [[key, autosave]] : [];
    }),
  ),
);

/** Play now adds the release to the library; from then on the shelf offers its checkpoint. */
function catalogHasProgress(entry: GameCatalogEntry): boolean {
  const game = savedGames.value.find(
    (item) =>
      item.library?.catalog?.id === entry.id && item.library.catalog.version === entry.version,
  );
  return game !== undefined && libraryAutosaves.value[game.projectId] !== undefined;
}

function selectLibraryGame(game: CachedGameMeta): void {
  selectedGameId.value = game.projectId;
  cachedMeta.value = game;
}

async function beginRename(game?: CachedGameMeta): Promise<void> {
  if (game) selectLibraryGame(game);
  gameTitle.value = cachedMeta.value?.title ?? "";
  renameError.value = "";
  renaming.value = true;
  await nextTick();
  titleInput.value?.focus();
  titleInput.value?.select();
}

function setTitleInput(element: unknown): void {
  titleInput.value = element instanceof HTMLInputElement ? element : undefined;
}

async function saveGameTitle(): Promise<void> {
  if (!(await renameAuthoredGame(selectedGameId.value, gameTitle.value))) {
    renameError.value = "Could not save the name. Use 1–100 characters and try again.";
    return;
  }
  cachedMeta.value = getCachedGameMeta(selectedGameId.value);
  savedGames.value = listCachedGames();
  renaming.value = false;
}

function saveCreatePreference(open: boolean): void {
  createPreference.value = open ? "open" : "closed";
  try {
    localStorage.setItem(CREATE_SECTION_KEY, createPreference.value);
  } catch {
    /* The live choice still applies when persistence is unavailable. */
  }
}

function onCreateSummaryActivate(): void {
  const opening = !createDetails.value?.open;
  saveCreatePreference(opening);
  if (!opening && location.hash === "#create-adventure")
    history.replaceState(null, "", `${location.pathname}${location.search}`);
}

async function openCreateSection(updateHash = true): Promise<void> {
  saveCreatePreference(true);
  if (createDetails.value) createDetails.value.open = true;
  if (updateHash && location.hash !== "#create-adventure")
    history.pushState(null, "", "#create-adventure");
  await nextTick();
  createSummary.value?.focus({ preventScroll: true });
  createDetails.value?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function onMenuHashChange(): void {
  if (location.hash === "#create-adventure") void openCreateSection(false);
}

function onGameDetailsToggle(projectId: ProjectId, event: Event): void {
  const details = event.currentTarget as HTMLDetailsElement;
  if (details.open) {
    expandedGameId.value = projectId;
    const game = savedGames.value.find((entry) => entry.projectId === projectId);
    if (game) selectLibraryGame(game);
  } else if (expandedGameId.value === projectId) {
    expandedGameId.value = undefined;
    renaming.value = false;
  }
}

const savedBudget = Number(localStorage.getItem("monotio_agi.taskBudget") ?? 5);
const taskBudget = ref(Number.isFinite(savedBudget) && savedBudget > 0 ? savedBudget : 5);
watch(taskBudget, (value) => {
  if (Number.isFinite(value) && value > 0)
    localStorage.setItem("monotio_agi.taskBudget", String(value));
});
const initialAiSettings = loadAiSettings(localStorage, DEFAULT_MODELS, testMode);
const initialProfile = initialAiSettings.profiles[initialAiSettings.provider];
const aiSettings = ref(initialAiSettings);
const aiModelLabel = computed(() => {
  const { provider: current, profiles } = aiSettings.value;
  const model = profiles[current].model;
  return MODEL_OPTIONS[current].find((option) => option.id === model)?.label ?? model;
});
const provider = ref<ProviderType>(initialAiSettings.provider);
const apiKey = ref(initialProfile.apiKey);
const model = ref(initialProfile.model);
const effort = ref(initialProfile.effort);
const aiConfigured = computed(() => provider.value === "stub" || apiKey.value.trim().length > 0);

watch(selectedGameId, (gameId) => {
  cachedMeta.value = getCachedGameMeta(gameId);
  renaming.value = false;
});

const activeTemplate = computed<GameTemplate>(() => {
  const brief = adventureDraft.value.brief.trim();
  const title = adventureDraft.value.title.trim() || "Untitled adventure";
  try {
    const parsed = parseCustomTemplate(
      /^---\r?\n/.test(brief) ? brief : `${adventureDraft.value.frontmatter}\n${brief}`,
    );
    return adventureDraft.value.title.trim() ? { ...parsed, title } : parsed;
  } catch {
    const id = selectedTemplateId.value || "custom";
    return {
      id,
      title,
      description: brief.split("\n")[0] || "Your next adventure starts with an idea.",
      rawMarkdown: `${adventureDraft.value.frontmatter}\n# ${title}\n\n## Premise\n${brief}`,
    };
  }
});

const {
  state,
  toggleMute,
  setAudioMode,
  resumeAudio,
  discoverGames,
  bootGame,
  bootAgentGame,
  bootAuthoredGame,
  startWalkthrough,
  stopWalkthrough,
  setWalkthroughSpeed,
  toggleWalkthroughPause,
  toggleWalkthroughPauseOnDialog,
  advanceDialog,
  resumeWalkthrough,
  seekToTick,
  seekToCheckpoint,
  sendInput,
  sendEdit,
  sendDirection,
  sendKey,
  dismissModal,
  submitPrompt,
  ejectGame,
  currentGame,
  clearAgentLog,
  releaseAgentAudioPreviews,
  openPowerUp,
  closePowerUp,
  submitPowerUp,
  stopAgent,
  continueAgent,
  discardAgent,
  exportCurrentGame,
  startTestRecording,
  stopTestRecording,
  cancelTestRecording,
  saveRecordedTest,
  resumeLastGame,
  resumeFromRecord,
  startOver,
  flushAutosave,
  lastAutosaveRecord,
  shutdownEngine,
  pauseEngine,
  resumeEngine,
  updateAiConfig,
} = useEngine(
  (frame) => {
    lastFrame = frame;
    present(frame);
  },
  {
    onPromptType: (text) => {
      promptLine.value = text;
      echoPrompt();
    },
  },
);

const aiSettingsDialog = useTemplateRef("aiSettingsDialog");
const aiSettingsSaving = ref(false);
const aiSettingsError = ref("");
const aiSettingsContext = ref<"header" | "create" | "assistant">("header");
const aiSettingsUnavailable = computed(
  () =>
    state.powerUp.busy ||
    state.agentTask?.status === "running" ||
    state.agentTask?.status === "paused",
);
let aiSettingsReturnFocus: HTMLElement | null = null;
let aiSettingsOwnedPause = false;

function openAiSettings(event: Event | null, context: "header" | "create" | "assistant"): void {
  if (aiSettingsUnavailable.value) return;
  aiSettingsContext.value = context;
  aiSettingsError.value = "";
  aiSettingsReturnFocus =
    event?.currentTarget instanceof HTMLElement ? event.currentTarget : createButton.value;
  releaseMovement();
  if (state.phase === "running" && !state.paused) {
    pauseEngine();
    aiSettingsOwnedPause = true;
  }
  aiSettingsDialog.value?.show();
}

async function applyAiSettings(settings: AiSettings, budgetUsd: number): Promise<void> {
  aiSettingsSaving.value = true;
  aiSettingsError.value = "";
  try {
    saveAiSettings(localStorage, settings);
    aiSettings.value = copyAiSettings(settings);
    taskBudget.value = budgetUsd;
    provider.value = settings.provider;
    model.value = settings.profiles[settings.provider].model;
    apiKey.value = settings.profiles[settings.provider].apiKey;
    effort.value = settings.profiles[settings.provider].effort;
    await updateAiConfig(llmConfig());
    if (state.powerUp.open) await openPowerUp(llmConfig());
    aiSettingsDialog.value?.close();
  } catch (error) {
    aiSettingsError.value = `Could not apply AI settings: ${String(error).replace(/^Error: /, "")}`;
  } finally {
    aiSettingsSaving.value = false;
  }
}

function onAiSettingsClosed(): void {
  if (aiSettingsOwnedPause) {
    aiSettingsOwnedPause = false;
    resumeEngine();
  }
  const returnFocus = aiSettingsReturnFocus;
  aiSettingsReturnFocus = null;
  nextTick(() => {
    if (returnFocus?.isConnected) returnFocus.focus();
    else if (aiSettingsContext.value === "create") createButton.value?.focus();
    else if (aiSettingsContext.value === "assistant") powerUpEl.value?.focus();
    else document.querySelector<HTMLElement>('[data-testid="settings-menu"]')?.focus();
  });
}

watch(
  () => state.powerUp.busy,
  (busy) => {
    if (busy) return;
    const game = currentGame();
    if (game && !game.installed && game.projectId) {
      selectedGameId.value = game.projectId;
      cachedMeta.value = getCachedGameMeta(game.projectId);
      savedGames.value = listCachedGames();
    }
  },
);

const expandedLogIds = ref<Set<string>>(new Set());
const copyFeedback = ref<string>("");
/** Download failures are visible in both the picker and the game. */
const exportRefusal = ref<string>("");
const exportBusy = ref(false);
const exportSavedProgressGameId = ref<string>();

/**
 * Autosave the picker can offer. The app
 * resumes it by itself on load; this is what is left when it could not — the
 * boot failed, or the player ejected back to the picker — plus the way to
 * throw it away and start the game from the beginning.
 */
const pendingAutosave = ref<AutosaveRecord>();
const hasLibraryContent = computed(
  () =>
    savedGames.value.length > 0 ||
    availableCatalogEntries.value.length > 0 ||
    Boolean(state.installedGames?.length) ||
    pendingAutosave.value !== undefined,
);
const createOpen = computed(() =>
  createPreference.value === "open"
    ? true
    : createPreference.value === "closed"
      ? false
      : savedGames.value.length === 0 && pendingAutosave.value === undefined,
);

const localGames = computed(() => {
  const list = state.installedGames ?? [];
  return list.filter(
    (item) =>
      !savedGames.value.some(
        (game) =>
          game.projectId === item.hash ||
          game.projectId === item.alias ||
          (item.folder && game.projectId === item.folder),
      ),
  );
});

const localGameIds = computed(() => localGames.value.map((g) => g.alias));

function localAutosave(game: InstalledGameDescriptor): AutosaveRecord | undefined {
  return (
    libraryAutosaves.value[game.hash] ??
    libraryAutosaves.value[game.alias] ??
    (game.folder ? libraryAutosaves.value[game.folder] : undefined)
  );
}
const TUTORIAL_SECTION_KEY = "monotio_agi.tutorial";
const tutorialPreference = ref<"open" | "closed">();
try {
  const stored = localStorage.getItem(TUTORIAL_SECTION_KEY);
  if (stored === "open" || stored === "closed") tutorialPreference.value = stored;
} catch {
  /* Use the first-visit default when storage is blocked. */
}
const hasOwnGames = computed(
  () =>
    savedGames.value.some((game) => game.library?.catalog?.id !== featuredCatalog.id) ||
    pendingAutosave.value?.game.installed === true,
);
const tutorialOpen = computed(
  () =>
    tutorialPreference.value === "open" ||
    (tutorialPreference.value === undefined && !hasOwnGames.value),
);
function setTutorialOpen(open: boolean): void {
  tutorialPreference.value = open ? "open" : "closed";
  try {
    localStorage.setItem(TUTORIAL_SECTION_KEY, tutorialPreference.value);
  } catch {
    /* Keep the live choice. */
  }
}
watch(
  hasOwnGames,
  (own) => {
    if (own && tutorialPreference.value === undefined) setTutorialOpen(false);
  },
  { immediate: true },
);

async function onPlayLocalGame(aliasOrHash: string): Promise<void> {
  await resumeAudio();
  const checkpoint = readAutosave(aliasOrHash);
  if (checkpoint) await resumeFromRecord(checkpoint, llmConfig());
  else await bootGame(aliasOrHash);
}

async function onStartWalkthrough(targetGame: string): Promise<void> {
  await resumeAudio();
  clearPlayHash();
  await startWalkthrough(targetGame);
}

function refreshPendingAutosave(): void {
  const key = lastGameKey();
  pendingAutosave.value = (key ? readAutosave(key) : null) ?? undefined;
}

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

/** Back at the picker the URL must not name a game any more. */
function clearPlayHash(): void {
  if (location.hash.startsWith(PLAY_HASH_PREFIX))
    history.replaceState(null, "", `${location.pathname}${location.search}`);
}

function llmConfig(): LlmConfig {
  return {
    provider: provider.value,
    apiKey: apiKey.value.trim(),
    model: model.value.trim(),
    effort: effort.value,
    budgetUsd: taskBudget.value,
  };
}

/** Discard the resumed game's progress and boot it from the top. */
async function onStartOver(): Promise<void> {
  const target =
    currentGame()?.projectId ??
    currentGame()?.hash ??
    pendingAutosave.value?.game.projectId ??
    pendingAutosave.value?.game.hash ??
    lastGameKey();
  if (!target) return;
  await resumeAudio();
  await startOver(target, llmConfig());
  refreshPendingAutosave();
}

async function onResumeAutosave(): Promise<void> {
  await resumeAudio();
  await resumeLastGame(llmConfig());
  refreshPendingAutosave();
}

function toggleLogEntry(id: string): void {
  if (expandedLogIds.value.has(id)) {
    expandedLogIds.value.delete(id);
  } else {
    expandedLogIds.value.add(id);
  }
}

async function copyDebugBundle(): Promise<void> {
  const current = currentGame();
  const bundle = {
    exportedAt: new Date().toISOString(),
    game: current
      ? {
          projectId: current.projectId,
          alias: current.alias,
          hash: current.hash,
          title: current.title,
          revision: current.revision,
          source: current.installed ? "installed" : "authored",
        }
      : {
          projectId: activeTemplate.value.id,
          title: activeTemplate.value.title,
          source: "draft",
        },
    mode: state.walkthrough.active ? "walkthrough" : current ? "play" : "authoring",
    provider: provider.value,
    model: model.value,
    budgetUsd: taskBudget.value,
    phase: state.phase,
    error: state.error || null,
    textRows: state.rows,
    agentLog: state.agentLog.map((entry) => {
      const copy = { ...entry };
      delete copy.audio;
      return copy;
    }),
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
    copyFeedback.value = "Copied!";
    setTimeout(() => {
      copyFeedback.value = "";
    }, 2500);
  } catch {
    copyFeedback.value = "Copy failed";
    setTimeout(() => {
      copyFeedback.value = "";
    }, 2500);
  }
}

async function onBootSelectedTemplate(): Promise<void> {
  if (!selectedTemplateId.value || !adventureDraft.value.brief.trim()) return;
  if (provider.value !== "stub" && !apiKey.value.trim()) {
    openAiSettings(null, "create");
    return;
  }
  await resumeAudio();
  await bootAuthoredGame(activeTemplate.value.rawMarkdown, llmConfig(), {
    projectId: activeTemplate.value.id,
    title: activeTemplate.value.title,
    useCached: false,
  });
  const game = currentGame();
  if (game && !game.installed && game.projectId) selectedGameId.value = game.projectId;
  cachedMeta.value = getCachedGameMeta(selectedGameId.value);
}

async function onBootSavedGame(alreadyBusy = false): Promise<void> {
  if (libraryActionBusy.value && !alreadyBusy) return;
  if (!alreadyBusy) libraryActionBusy.value = true;
  libraryActionError.value = "";
  try {
    await resumeAudio();
    await bootAuthoredGame(activeTemplate.value.rawMarkdown, llmConfig(), {
      projectId: selectedGameId.value,
      title: cachedMeta.value?.title ?? selectedGameId.value,
      useCached: true,
    });
  } catch (error) {
    libraryActionError.value = String(error).replace(/^Error: /, "");
  } finally {
    if (!alreadyBusy) libraryActionBusy.value = false;
  }
}

async function onClearSavedGame(): Promise<void> {
  await removeLibraryGame(selectedGameId.value);
  refreshLibrary();
  refreshPendingAutosave();
}

function refreshLibrary(projectId?: ProjectId): void {
  savedGames.value = listCachedGames();
  if (projectId) {
    selectedGameId.value = projectId;
  } else if (!savedGames.value.some((entry) => entry.projectId === selectedGameId.value))
    selectedGameId.value = savedGames.value[0]?.projectId ?? "";
  cachedMeta.value = selectedGameId.value ? getCachedGameMeta(selectedGameId.value) : null;
}

async function onPlayLibraryGame(game: CachedGameMeta): Promise<void> {
  selectLibraryGame(game);
  const autosave = readAutosave(game.projectId);
  if (!autosave) {
    await onBootSavedGame();
    return;
  }
  if (libraryActionBusy.value) return;
  libraryActionBusy.value = true;
  libraryActionError.value = "";
  try {
    await resumeAudio();
    await resumeFromRecord(autosave, llmConfig());
  } catch (error) {
    libraryActionError.value = String(error).replace(/^Error: /, "");
  } finally {
    libraryActionBusy.value = false;
  }
}

async function onStartLibraryGameOver(game: CachedGameMeta): Promise<void> {
  selectLibraryGame(game);
  await resumeAudio();
  await startOver(game.projectId, llmConfig());
}

async function onCheckLibraryGame(game: CachedGameMeta): Promise<void> {
  selectLibraryGame(game);
  await checkSelectedOpening();
}

async function onCopyLibraryGame(game: CachedGameMeta): Promise<void> {
  selectLibraryGame(game);
  await copySelectedGame();
}

async function onExportLibraryGame(game: CachedGameMeta, project = false): Promise<void> {
  selectLibraryGame(game);
  await onExportAgiZip(false, project);
}

async function onRemoveLibraryGame(game: CachedGameMeta): Promise<void> {
  selectLibraryGame(game);
  await onClearSavedGame();
}

async function stageLibraryGame(
  game: OpenedGame,
  title: string,
  source: "zip" | "folder",
): Promise<ImportStorageReport | null> {
  const opening = await previewGame(game);
  let stored: ImportStorageReport | null = null;
  const importedGameId = await addLibraryGame(
    game,
    game.title ?? title,
    source,
    opening,
    undefined,
    (report) => (stored = report),
  );
  refreshLibrary(importedGameId);
  return stored;
}

/** What a project archive brought along besides the game — and what storage refused. */
function progressNote(game: OpenedGame, stored: ImportStorageReport | null): string {
  if (!game.progress) return "";
  const parts = Object.keys(game.progress.saves).map((slot) => {
    const status = stored?.slots.includes(Number(slot))
      ? "stored"
      : stored?.failedSlots.includes(Number(slot))
        ? "could not be stored"
        : "storage unconfirmed";
    return `save slot ${slot} ${status}`;
  });
  if (game.progress.autosave) {
    const status = stored?.autosave
      ? "stored"
      : stored
        ? "could not be stored"
        : "storage unconfirmed";
    parts.push(`autosave ${status}`);
  }
  return parts.length ? ` (${parts.join("; ")})` : "";
}

async function onGameZip(file?: File): Promise<void> {
  if (!file || importBusy.value) return;
  importBusy.value = true;
  importError.value = "";
  importNotice.value = "";
  try {
    if (file.size > MAX_GAME_ZIP_BYTES) throw new Error("Choose a game ZIP smaller than 128 MB.");
    const game = await readGameZip(new Uint8Array(await file.arrayBuffer()));
    const stored = await stageLibraryGame(game, file.name.replace(/\.zip$/i, ""), "zip");
    importNotice.value = `${game.title ?? file.name.replace(/\.zip$/i, "")} added to your library${progressNote(game, stored)}.`;
  } catch (error) {
    importError.value = String(error).replace(/^Error: /, "");
  } finally {
    importBusy.value = false;
    if (zipInput.value) zipInput.value.value = "";
  }
}

async function onGameFolder(files?: FileList | File[] | Map<string, File>): Promise<void> {
  if (!files || (files instanceof Map ? files.size === 0 : files.length === 0) || importBusy.value)
    return;
  importBusy.value = true;
  importError.value = "";
  importNotice.value = "";
  try {
    const selected = files instanceof Map ? [...files.values()] : [...files];
    if (selected.length > 1024) throw new Error("Choose one game folder with at most 1024 files.");
    const total = selected.reduce((bytes, file) => bytes + file.size, 0);
    if (total > 256 * 1024 * 1024) throw new Error("Choose a game folder smaller than 256 MB.");
    if (selected.some((file) => file.size > 64 * 1024 * 1024))
      throw new Error("A game folder file is larger than the 64 MB per-file limit.");
    const entries = new Map<string, Uint8Array>();
    const paths =
      files instanceof Map
        ? files
        : new Map(selected.map((file) => [file.webkitRelativePath || file.name, file]));
    for (const [path, file] of paths) entries.set(path, new Uint8Array(await file.arrayBuffer()));
    const game = readGameFiles(entries);
    const firstPath = paths.keys().next().value as string | undefined;
    const title = firstPath?.split("/")[0] || "Imported game";
    const stored = await stageLibraryGame(game, title, "folder");
    importNotice.value = `${game.title ?? title} added to your library${progressNote(game, stored)}.`;
  } catch (error) {
    importError.value = String(error).replace(/^Error: /, "");
  } finally {
    importBusy.value = false;
    if (folderInput.value) folderInput.value.value = "";
  }
}

async function onGameDrop(dataTransfer?: DataTransfer): Promise<void> {
  if (!dataTransfer || importBusy.value) return;
  importBusy.value = true;
  importError.value = "";
  importNotice.value = "";
  try {
    const dropped = await captureGameDrop(dataTransfer);
    // Each importer takes ownership of the same guard synchronously before its
    // first await, so there is no gap in which another drop can start.
    importBusy.value = false;
    if (dropped.kind === "zip") await onGameZip(dropped.file);
    else await onGameFolder(dropped.files);
  } catch (error) {
    importBusy.value = false;
    importError.value = String(error).replace(/^Error: /, "");
  }
}

async function refreshHostedCatalog(): Promise<void> {
  if (hostedCatalogBusy.value) return;
  hostedCatalogBusy.value = true;
  hostedCatalogError.value = "";
  try {
    const entries = await loadHostedCatalog(
      new URL(`${import.meta.env.BASE_URL}catalog.json`, location.href),
    );
    if (
      entries.some((entry) =>
        GAME_CATALOG.some((builtin) => builtin.id.toLowerCase() === entry.id.toLowerCase()),
      )
    )
      throw new Error(
        "The game list repeats a bundled game identifier. Ask the site owner to give it a unique id.",
      );
    catalogEntries.value = [...GAME_CATALOG, ...entries];
  } catch (error) {
    hostedCatalogError.value = String(error).replace(/^Error: /, "");
  } finally {
    hostedCatalogBusy.value = false;
  }
}

async function loadCatalogOpening(id: string): Promise<void> {
  if (catalogOpenings.value[id] || catalogBusy.value[id]) return;
  const entry = catalogEntries.value.find((item) => item.id === id);
  if (!entry) return;
  catalogBusy.value[id] = true;
  catalogErrors.value[id] = undefined;
  try {
    const game = catalogGames.get(id) ?? (await entry.load());
    catalogGames.set(id, game);
    catalogOpenings.value[id] = await previewGame(game);
  } catch (error) {
    catalogGames.delete(id);
    catalogErrors.value[id] = String(error).replace(/^Error: /, "");
  } finally {
    catalogBusy.value[id] = false;
  }
}

async function playCatalogGame(id: string): Promise<void> {
  if (libraryActionBusy.value) return;
  const entry = catalogEntries.value.find((item) => item.id === id);
  if (!entry) return;
  libraryActionError.value = "";
  libraryActionBusy.value = true;
  try {
    await loadCatalogOpening(id);
    const game = catalogGames.get(id);
    const opening = catalogOpenings.value[id];
    if (!game || !opening)
      throw new Error(catalogErrors.value[id] || "This game could not be opened.");
    const gameId = await addLibraryGame(game, entry.title, "catalog", opening, {
      id: entry.id,
      version: entry.version,
    });
    refreshLibrary(gameId);
    const autosave = readAutosave(gameId);
    if (autosave) {
      await resumeAudio();
      await resumeFromRecord(autosave, llmConfig());
    } else await onBootSavedGame(true);
  } catch (error) {
    libraryActionError.value = String(error).replace(/^Error: /, "");
  } finally {
    libraryActionBusy.value = false;
  }
}

async function checkSelectedOpening(): Promise<void> {
  if (libraryActionBusy.value) return;
  const selected = selectedGameId.value;
  libraryActionError.value = "";
  libraryActionBusy.value = true;
  try {
    const game = await loadAuthoredGame(selected);
    if (!game) throw new Error("This game is no longer in your library. Import it again.");
    const opening = await previewGame(game);
    const revision = game.library?.revision ?? (await gameRevision(game.files));
    if (!(await updateGamePreview(game.projectId, revision, opening.preview, opening)))
      throw new Error("The game changed while its opening was being checked. Try again.");
    refreshLibrary(selectedGameId.value === selected ? game.projectId : undefined);
  } catch (error) {
    libraryActionError.value = String(error).replace(/^Error: /, "");
  } finally {
    libraryActionBusy.value = false;
  }
}

async function copySelectedGame(): Promise<void> {
  if (libraryActionBusy.value) return;
  const selected = selectedGameId.value;
  libraryActionError.value = "";
  libraryActionBusy.value = true;
  try {
    refreshLibrary(await copyLibraryGame(selected));
  } catch (error) {
    libraryActionError.value = String(error).replace(/^Error: /, "");
  } finally {
    libraryActionBusy.value = false;
  }
}

async function onExportAgiZip(live = false, project = false, savedProgress = false): Promise<void> {
  const game = live ? currentGame() : null;
  const gameKey = game ? (game.installed ? (game.hash ?? game.alias) : game.projectId) : undefined;
  const useSavedProgress =
    savedProgress && project && live && gameKey === exportSavedProgressGameId.value;
  exportSavedProgressGameId.value = undefined;
  exportRefusal.value = "";
  exportBusy.value = true;
  try {
    // A project is for continuing elsewhere: the live game checkpoints first,
    // and the archive carries the player's save slots and latest autosave.
    if (live && project && !useSavedProgress && !(await flushAutosave(2000))) {
      const current = currentGame();
      const currentKey = current
        ? current.installed
          ? (current.hash ?? current.alias)
          : current.projectId
        : undefined;
      if (currentKey === gameKey) exportSavedProgressGameId.value = gameKey;
      throw new Error(
        "Current progress could not be saved. Close any open game window and try again, or download with only the progress already saved in this browser.",
      );
    }
    const current = currentGame();
    const currentKey = current
      ? current.installed
        ? (current.hash ?? current.alias)
        : current.projectId
      : undefined;
    if (live && currentKey !== gameKey)
      throw new Error("The game changed during download. Try again.");
    const data = live ? await exportCurrentGame() : await loadAuthoredGame(selectedGameId.value);
    if (!data) throw new Error("No saved game is available.");
    const zipBytes = project
      ? await buildProjectZip(data, readGameProgress(localStorage, data.projectId))
      : buildPublicGameZip(data);
    const url = URL.createObjectURL(new Blob([zipBytes], { type: "application/zip" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `agi-${data.projectId}-${project ? "project" : "game"}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    exportRefusal.value = `Download failed: ${String(error).replace(/^Error: /, "")}`;
  } finally {
    exportBusy.value = false;
  }
}

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

/**
 * Present one engine frame: compose picture band + text cells into the
 * 320x200 frame, draw it on the 2D probe canvas (Playwright pixel probe and
 * no-GPU fallback) and upload it to the GPU stage when one exists.
 */
let cachedImageData: ImageData | null = null;

function present(frame: Frame, textOverride?: Uint8Array): void {
  compositeFrame(
    { visual: frame.visual, text: textOverride ?? frame.text, picRow: frame.picRow },
    composed,
  );
  const ctx = canvas.value?.getContext("2d");
  if (ctx) {
    cachedImageData ??= ctx.createImageData(FRAME_WIDTH, FRAME_HEIGHT);
    cachedImageData.data.set(composed);
    ctx.putImageData(cachedImageData, 0, 0);
  }
  stage?.render(composed);
}

const hasKeyPrompt = computed(() =>
  state.rows.some((r) => r.toLowerCase().includes("press any key")),
);

/** Pointer type of the last screen press; the click event carries none. */
let screenPointerType = "mouse";

function onScreenPointerDown(ev: PointerEvent): void {
  screenPointerType = ev.pointerType;
}

function onScreenClick(): void {
  resumeAudio();
  if (state.phase !== "running") return;
  if (state.walkthrough.active) {
    if (advanceDialog()) return;
    if (state.walkthrough.status === "paused") {
      resumeWalkthrough();
      return;
    }
  }
  if (state.prompt) {
    inputEl.value?.focus({ preventScroll: true });
    return;
  }
  // A tap (touch or pen) still advances title screens and acknowledges
  // message windows — touch devices have no hardware keyboard. A mouse click
  // only focuses the game for typing: it must never act as Enter, or
  // focusing the window could skip a screen, acknowledge a modal, or submit a
  // half-typed command. The pointer type decides, not the touch-controls
  // mode: `any-pointer: coarse` also matches hybrid laptops with a mouse.
  if (touchControls.value && screenPointerType !== "mouse") {
    if (state.modal !== null) {
      if (state.modal !== "save" && state.modal !== "restore") dismissModal();
      return;
    }
    // Empty Enter (0x000d) wakes have.key() e.g. title screens or prompts
    sendKey(0x000d);
    return;
  }
  inputEl.value?.focus({ preventScroll: true });
}
watch(
  () => state.phase,
  (phase) => {
    if (phase === "running" && !touchControls.value) {
      nextTick(() => {
        inputEl.value?.focus({ preventScroll: true });
      });
    }
  },
);

const inputEl = useTemplateRef("inputEl");
const controlsEl = useTemplateRef("controlsEl");

function closeNavMenus(restoreFocus = false): void {
  for (const menu of [controlsEl.value]) {
    if (!menu?.open) continue;
    menu.open = false;
    if (restoreFocus) menu.querySelector("summary")?.focus();
  }
}

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

watch(
  () => state.gameEdit,
  (edit) => {
    if (edit) inputLine.value = edit.text;
  },
);

function onOutsideControls(event: PointerEvent): void {
  for (const menu of [controlsEl.value]) {
    if (event.target instanceof Node && menu && !menu.contains(event.target)) menu.open = false;
  }
}

function triggerKey(code: number): void {
  resumeAudio();
  closeNavMenus();
  sendKey(code);
  if (!touchControls.value) inputEl.value?.focus({ preventScroll: true });
}

/**
 * Blocking get.string / get.num prompt: the engine drew the prompt and is
 * blocked in the worker, so the live edit is echoed here, straight into a
 * copy of the last frame's text cells after the prompt, with the cursor
 * glyph — still on the CRT, never in the DOM.
 */
watch(
  () => state.prompt,
  (prompt) => {
    promptLine.value = "";
    if (prompt && !state.walkthrough.seeking) echoPrompt();
  },
);

function echoPrompt(): void {
  if (state.walkthrough.seeking) return;
  const prompt = state.prompt;
  if (!prompt || !lastFrame) return;
  const text = lastFrame.text.slice();
  const start = prompt.col + prompt.prompt.length;
  const a = text[(prompt.row * TEXT_COLS + prompt.col) * 2 + 1] || 0x0f;
  for (let i = 0; i <= prompt.maxLen && start + i < TEXT_COLS; i++) {
    const at = (prompt.row * TEXT_COLS + start + i) * 2;
    const ch =
      i < promptLine.value.length
        ? promptLine.value.charCodeAt(i)
        : i === promptLine.value.length
          ? GLYPH_CURSOR
          : 0x20;
    text[at] = ch;
    text[at + 1] = a;
  }
  present(lastFrame, text);
}

function onPromptKey(ev: KeyboardEvent): void {
  const prompt = state.prompt!;
  // Native input/composition events own editable text, including Android IMEs.
  if (ev.target === inputEl.value && ev.key !== "Enter" && ev.key !== "Escape") return;
  ev.preventDefault();
  if (ev.key === "Escape") {
    submitPrompt("", true);
  } else if (ev.key === "Enter") {
    submitPrompt(promptLine.value);
  } else if (ev.key === "Backspace") {
    promptLine.value = promptLine.value.slice(0, -1);
    echoPrompt();
  } else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    if (prompt.kind === "getnum" && !/[0-9]/.test(ev.key)) return;
    if (promptLine.value.length >= prompt.maxLen) return;
    promptLine.value += ev.key;
    echoPrompt();
  }
}

/** Keys while an engine modal (print window, inventory, menu…) is open. */
function onModalKey(ev: KeyboardEvent): void {
  const activeModal =
    state.walkthrough.active && window.__AGI_REPLAY__?.latest?.state.modalKind
      ? (window.__AGI_REPLAY__?.latest?.state.modalKind as ModalKind)
      : state.modal;
  if (state.waitingForKey || activeModal === "save" || activeModal === "restore") {
    const code = pcKey(ev);
    if (code !== undefined) {
      ev.preventDefault();
      sendKey(code);
    }
    return;
  }
  const dir = movementDirection(ev);
  if (dir !== undefined) {
    sendDirection(dir);
    ev.preventDefault();
    return;
  }
  const code =
    ev.key === "Enter"
      ? AGI_KEY.ENTER
      : ev.key === "Escape"
        ? AGI_KEY.ESCAPE
        : ev.key === "Home"
          ? AGI_KEY.HOME
          : ev.key === "End"
            ? AGI_KEY.END
            : ev.key === "PageUp"
              ? AGI_KEY.PAGE_UP
              : ev.key === "PageDown"
                ? AGI_KEY.PAGE_DOWN
                : ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey
                  ? ev.key.charCodeAt(0) & 0xff
                  : null;
  if (code === null) return;
  ev.preventDefault();
  sendKey(code);
}

/**
 * Whole-page keyboard trapping: the browser chrome should disappear. Arrows
 * always steer ego (even while the input line is focused — the classic AGI
 * feel); any printable keystroke jumps into the input line; Enter dismisses
 * the print modal first, then submits.
 */
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
const powerUpFeed = computed(() => state.agentLog.slice(state.powerUp.feedStart));
const powerUpAudio = computed(() => powerUpFeed.value.flatMap((entry) => entry.audio ?? []));
const latestAgentAudio = computed(
  () => [...state.agentLog].reverse().find((entry) => entry.audio?.length)?.audio ?? [],
);

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
    else if (!open && wasOpen && creatingRoom.value) inputEl.value?.focus({ preventScroll: true });
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

async function onPowerUp(): Promise<void> {
  if (state.powerUp.busy) return;
  if (state.powerUp.open) {
    closePowerUp();
    inputEl.value?.focus({ preventScroll: true });
    return;
  }
  powerUpLine.value = "";
  await openPowerUp(llmConfig());
  await nextTick();
  powerUpEl.value?.focus({ preventScroll: true });
}

async function onPowerUpSubmit(): Promise<void> {
  const text = powerUpLine.value.trim();
  if (text.length === 0 || state.powerUp.busy) return;
  followProgress.value = true;
  powerUpLine.value = "";
  await submitPowerUp(text);
  if (!state.powerUp.open) inputEl.value?.focus({ preventScroll: true });
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
  inputEl.value?.focus({ preventScroll: true });
}

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
      if (advanceDialog()) return;
      if (state.walkthrough.status === "paused") {
        resumeWalkthrough();
        return;
      }
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
      if (!state.powerUp.open) inputEl.value?.focus({ preventScroll: true });
    }
    return;
  }
  // Page controls keep native keyboard behavior. The invisible input owns
  // game keys; Shift+Tab lets a player leave it even during a game modal.
  const target = ev.target;
  if (
    (target instanceof Element &&
      target !== inputEl.value &&
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
    onPromptKey(ev);
    return;
  }
  const activeModal =
    state.walkthrough.active && window.__AGI_REPLAY__?.latest?.state.modalKind
      ? (window.__AGI_REPLAY__?.latest?.state.modalKind as ModalKind)
      : state.modal;
  if (activeModal !== null) {
    onModalKey(ev);
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
    triggerKey(FUNCTION_KEYS[ev.key]!);
    return;
  }

  const dir = movementDirection(ev);
  if (dir !== undefined) {
    const physicalKey = ev.code && ev.code !== "Unidentified" ? ev.code : ev.key;
    if (!ev.repeat && !heldMovementKeys.has(physicalKey)) {
      heldMovementKeys.add(physicalKey);
      sendDirection(dir);
    }
    ev.preventDefault();
    return;
  }

  const shortcut = registeredKey(ev, state.controls);
  if (shortcut !== undefined) {
    ev.preventDefault();
    triggerKey(shortcut);
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

  const input = inputEl.value;
  // When input field is NOT focused:
  if (!input || ev.target !== input) {
    // If Enter or Space pressed while not typing, forward raw key event to wake have.key() (e.g. title screens)
    if (ev.key === "Enter" || ev.key === " ") {
      sendKey(ev.key === "Enter" ? 0x000d : 0x0020);
      ev.preventDefault();
      return;
    }
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      // Mirror the character into the input line exactly like the focused
      // path does: through the edit message only. The engine also appends
      // printable key events to its edit line, and a sendKey here would be
      // buffered until the next engine tick while the edit applies at once —
      // so the same character landed twice (the "llook" after Start over).
      // No waitKey can be pending here: a blocking key wait sets
      // state.waitingForKey, handled by the raw-key branch above.
      input?.focus({ preventScroll: true });
      inputLine.value += ev.key;
      sendEdit(inputLine.value);
      ev.preventDefault();
    }
    return;
  }

  // When input field IS focused:
  if (ev.key === "Enter") {
    ev.preventDefault();
    submit();
  }
}

function onGlobalKeyup(ev: KeyboardEvent): void {
  const physicalKey = ev.code && ev.code !== "Unidentified" ? ev.code : ev.key;
  if (!heldMovementKeys.delete(physicalKey)) return;
  if (state.phase === "running" && !state.walkthrough.active) {
    sendDirection(0);
    ev.preventDefault();
  }
}

/** The DOM input is the keyboard capture; its text lives on the engine's input row. */
function onInputEdit(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (composing.value || (event instanceof InputEvent && event.isComposing)) return;
  if (state.prompt) {
    const prompt = state.prompt;
    promptLine.value = (
      prompt.kind === "getnum" ? input.value.replace(/[^0-9]/g, "") : input.value
    ).slice(0, Math.min(39, prompt.maxLen));
    input.value = promptLine.value;
    echoPrompt();
  } else {
    // An IME may insert or replace several characters without keydown. Only
    // that inserted range is new input; the rest may be an unfinished command.
    const previous = inputLine.value;
    const next = input.value;
    let start = 0;
    while (start < previous.length && start < next.length && previous[start] === next[start])
      start++;
    let oldEnd = previous.length;
    let newEnd = next.length;
    while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    if (state.textMode || state.waitingForKey || state.modal !== null || !state.inputEnabled) {
      const entered =
        event instanceof InputEvent || event instanceof CompositionEvent
          ? (event.data ?? next.slice(start, newEnd))
          : next.slice(start, newEnd);
      for (const char of entered) sendKey(char.charCodeAt(0));
      // Raw-key answers do not edit the parser command that preceded them.
      input.value = previous;
      return;
    }
    let inserted = "";
    for (const char of next.slice(start, newEnd)) {
      const code = char.charCodeAt(0);
      if (state.controls.some((binding) => binding.key === code)) sendKey(code);
      else inserted += char;
    }
    inputLine.value = next.slice(0, start) + inserted + next.slice(newEnd);
    if (input.value !== inputLine.value) input.value = inputLine.value;
    sendEdit(inputLine.value);
  }
}

function onCompositionEnd(event: CompositionEvent): void {
  composing.value = false;
  onInputEdit(event);
}

function onTouchDirection(dir: number): void {
  resumeAudio();
  if (dir === 0) {
    // Match the release to its press: walking may have opened a dialog, and
    // a navigation gesture may end after that dialog has already closed.
    const wasWalking = touchMovementActive;
    touchMovementActive = false;
    if (wasWalking && state.phase === "running") sendDirection(0);
    return;
  }
  if (state.phase !== "running" || state.powerUp.open || state.prompt) return;
  touchMovementActive = state.modal === null && !state.waitingForKey;
  if (state.waitingForKey || state.modal === "save" || state.modal === "restore")
    sendKey(DIRECTION_KEYS[dir]!);
  else sendDirection(dir);
}

function onVirtualKey(code: number): void {
  resumeAudio();
  if (state.phase !== "running" || state.powerUp.open || composing.value) return;
  if (state.prompt) {
    if (code === AGI_KEY.ENTER || code === AGI_KEY.ESCAPE) {
      submitPrompt(code === AGI_KEY.ESCAPE ? "" : promptLine.value, code === AGI_KEY.ESCAPE);
    } else if (code === AGI_KEY.BACKSPACE) {
      promptLine.value = promptLine.value.slice(0, -1);
      echoPrompt();
    } else if (
      code >= AGI_KEY.SPACE &&
      code <= 126 &&
      promptLine.value.length < Math.min(39, state.prompt.maxLen)
    ) {
      const char = String.fromCharCode(code);
      if (state.prompt.kind !== "getnum" || /[0-9]/.test(char)) promptLine.value += char;
      echoPrompt();
    }
    return;
  }
  const activeModal =
    state.walkthrough.active && window.__AGI_REPLAY__?.latest?.state.modalKind
      ? (window.__AGI_REPLAY__?.latest?.state.modalKind as ModalKind)
      : state.modal;
  if (
    activeModal !== null ||
    state.textMode ||
    state.waitingForKey ||
    !state.inputEnabled ||
    state.controls.some((binding) => binding.key === code)
  ) {
    sendKey(code);
  } else if (code === AGI_KEY.ENTER) submit();
  else if (code === AGI_KEY.BACKSPACE || (code >= AGI_KEY.SPACE && code <= 126)) {
    inputLine.value =
      code === AGI_KEY.BACKSPACE
        ? inputLine.value.slice(0, -1)
        : inputLine.value + String.fromCharCode(code);
    sendEdit(inputLine.value);
  } else sendKey(code);
}

function releaseMovement(): void {
  if (!state.walkthrough.active && heldMovementKeys.size) sendDirection(0);
  heldMovementKeys.clear();
}

function onTakeControl(): void {
  releaseMovement();
  stopWalkthrough(true);
  nextTick(() => {
    inputEl.value?.focus({ preventScroll: true });
  });
}

interface HoverInfo {
  percent: number;
  label: string;
  details?: string;
}

const timelineEl = useTemplateRef("timelineEl");
const hoverInfo = ref<HoverInfo>();
const isScrubbing = ref(false);
const scrubPercent = ref<number>();

function getTimelinePercent(clientX: number): number {
  const el = timelineEl.value;
  if (!el) return 0;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  return (x / rect.width) * 100;
}

function findNearbyCheckpoint(pct: number): WalkthroughCheckpoint | null {
  let closestCp: WalkthroughCheckpoint | null = null;
  let minDiff = Infinity;
  for (const cp of state.walkthrough.checkpoints) {
    const diff = Math.abs(cp.percent - pct);
    if (diff < minDiff && diff < 5) {
      minDiff = diff;
      closestCp = cp;
    }
  }
  return closestCp;
}

function updateHover(clientX: number): void {
  if (state.walkthrough.totalTicks <= 0) return;
  const pct = getTimelinePercent(clientX);
  const cp = findNearbyCheckpoint(pct);

  if (cp) {
    hoverInfo.value = {
      percent: cp.percent,
      label: cp.label,
      details: `Score: ${cp.score} · Room ${cp.room}`,
    };
  } else {
    hoverInfo.value = {
      percent: pct,
      label: `${Math.round(pct)}%`,
    };
  }
}

let hasDraggedDuringScrub = false;
let scrubRafId: number | null = null;
let pendingScrubTick: number | null = null;
let scrubBackwardTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleScrubSeek(tick: number): void {
  pendingScrubTick = tick;
  if (tick < state.walkthrough.tick) {
    if (scrubBackwardTimer !== null) clearTimeout(scrubBackwardTimer);
    scrubBackwardTimer = setTimeout(() => {
      scrubBackwardTimer = null;
      if (pendingScrubTick !== null) {
        const target = pendingScrubTick;
        pendingScrubTick = null;
        void seekToTick(target);
      }
    }, 120);
  } else {
    if (scrubBackwardTimer !== null) {
      clearTimeout(scrubBackwardTimer);
      scrubBackwardTimer = null;
    }
    if (scrubRafId === null) {
      scrubRafId = requestAnimationFrame(() => {
        scrubRafId = null;
        if (pendingScrubTick !== null) {
          const target = pendingScrubTick;
          pendingScrubTick = null;
          void seekToTick(target);
        }
      });
    }
  }
}

function onTimelinePointerDown(ev: PointerEvent): void {
  if (state.walkthrough.totalTicks <= 0) return;
  hasDraggedDuringScrub = false;
  isScrubbing.value = true;
  state.walkthrough.scrubbing = true;
  if (scrubRafId !== null) {
    cancelAnimationFrame(scrubRafId);
    scrubRafId = null;
  }
  if (scrubBackwardTimer !== null) {
    clearTimeout(scrubBackwardTimer);
    scrubBackwardTimer = null;
  }
  pendingScrubTick = null;
  const pct = getTimelinePercent(ev.clientX);
  scrubPercent.value = pct;
  updateHover(ev.clientX);
  const targetTick = Math.round((pct / 100) * state.walkthrough.totalTicks);
  void seekToTick(targetTick);

  window.addEventListener("pointermove", onTimelinePointerMove);
  window.addEventListener("pointerup", onTimelinePointerUp);
  window.addEventListener("pointercancel", onTimelinePointerUp);
}

function onTimelinePointerMove(ev: PointerEvent): void {
  if (isScrubbing.value) {
    hasDraggedDuringScrub = true;
    const pct = getTimelinePercent(ev.clientX);
    scrubPercent.value = pct;
    updateHover(ev.clientX);
    const targetTick = Math.round((pct / 100) * state.walkthrough.totalTicks);
    scheduleScrubSeek(targetTick);
  }
}

function onTimelineHover(ev: PointerEvent): void {
  if (!isScrubbing.value) {
    updateHover(ev.clientX);
  }
}

function onTimelinePointerUp(ev: PointerEvent): void {
  window.removeEventListener("pointermove", onTimelinePointerMove);
  window.removeEventListener("pointerup", onTimelinePointerUp);
  window.removeEventListener("pointercancel", onTimelinePointerUp);

  if (scrubRafId !== null) {
    cancelAnimationFrame(scrubRafId);
    scrubRafId = null;
  }
  if (scrubBackwardTimer !== null) {
    clearTimeout(scrubBackwardTimer);
    scrubBackwardTimer = null;
  }
  pendingScrubTick = null;

  if (isScrubbing.value) {
    const finalPct = scrubPercent.value ?? getTimelinePercent(ev.clientX);
    isScrubbing.value = false;
    state.walkthrough.scrubbing = false;
    scrubPercent.value = undefined;
    if (hasDraggedDuringScrub) {
      const targetTick = Math.round((finalPct / 100) * state.walkthrough.totalTicks);
      void seekToTick(targetTick);
    }
  }
}

function onTimelinePointerLeave(): void {
  if (!isScrubbing.value) {
    hoverInfo.value = undefined;
  }
}

function onTimelineKeydown(ev: KeyboardEvent): void {
  if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
    ev.preventDefault();
    const delta = ev.key === "ArrowRight" ? 0.05 : -0.05;
    const currentPct = scrubPercent.value ?? state.walkthrough.percent;
    const newPct = Math.max(0, Math.min(100, currentPct + delta * 100));
    const targetTick = Math.round((newPct / 100) * state.walkthrough.totalTicks);
    void seekToTick(targetTick);
  }
}

async function onMarkerClick(cp: WalkthroughCheckpoint): Promise<void> {
  if (hasDraggedDuringScrub) return;
  hoverInfo.value = undefined;
  await seekToCheckpoint(cp);
}

function resizeViewport(): void {
  viewportHeight.value = window.visualViewport?.height ?? window.innerHeight;
}

function submit(): void {
  if (composing.value) return;
  if (state.prompt) {
    submitPrompt(promptLine.value);
    return;
  }
  const text = inputLine.value.trim();
  if (text.length === 0) {
    // Empty Enter sends raw Enter key (0x000d) to wake have.key() loops (e.g. title screens)
    sendKey(0x000d);
    return;
  }
  sendInput(text);
  inputLine.value = "";
  if (inputEl.value) inputEl.value.value = "";
  sendEdit("");
}

/**
 * The page is going away: ask for one last snapshot before it does. A reload
 * is the case this whole path exists for, and `visibilitychange` is the last
 * event that still reliably gets a turn of the event loop.
 */
function onPageHidden(): void {
  if (document.visibilityState === "hidden") {
    releaseMovement();
    void flushAutosave();
  }
}

function onPageHide(): void {
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
  document.addEventListener("pointerdown", onOutsideControls);
  window.addEventListener("keyup", onGlobalKeyup);
  window.addEventListener("hashchange", onMenuHashChange);
  document.addEventListener("visibilitychange", onPageHidden);
  window.addEventListener("pagehide", onPageHide);
  try {
    await reconcileGameIndex();
    refreshLibrary();
  } catch (error) {
    libraryActionError.value = `Your saved game library could not be refreshed: ${String(error).replace(/^Error: /, "")}`;
  }
  catalogObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = catalogCardIds.get(entry.target);
        catalogObserver?.unobserve(entry.target);
        if (id) void loadCatalogOpening(id);
      }
    },
    { rootMargin: "200px" },
  );
  void loadCatalogOpening(featuredCatalog.id);
  void refreshHostedCatalog();
  onMenuHashChange();
  await discoverGames();
  // Nobody loses progress to a reload: while a game runs the URL names it
  // (`#play/<gameId>`), and only a reload carrying that hash boots straight back
  // into the autosave. A reload from the picker lands on the picker, which
  // keeps offering the Resume card from the pending autosave.
  // A hot module update hands the running game over in memory: no reload
  // happened, so there is nothing to read back and the resume is instant.
  const handover = import.meta.hot?.data?.["monotio_agi_resume"] as AutosaveRecord | undefined;
  if (import.meta.hot?.data) delete import.meta.hot.data["monotio_agi_resume"];
  refreshPendingAutosave();
  const playKey = playHashGameKey();
  if (handover) await resumeFromRecord(handover, llmConfig());
  else if (
    playKey &&
    (playKey === pendingAutosave.value?.game.projectId ||
      playKey === pendingAutosave.value?.game.hash ||
      playKey === pendingAutosave.value?.game.alias)
  )
    await resumeLastGame(llmConfig());
  if (state.phase === "idle") clearPlayHash();
  if (gpuCanvas.value) {
    stage = await AgiStage.create(gpuCanvas.value);
    gpuBackend.value = stage?.backend ?? undefined;
    if (stage) {
      stage.crt = crtEnabled.value;
      if (lastFrame) present(lastFrame);
    }
  }
});

onUnmounted(() => {
  catalogObserver?.disconnect();
  releaseMovement();
  window.removeEventListener("blur", releaseMovement);
  window.visualViewport?.removeEventListener("resize", resizeViewport);
  window.removeEventListener("resize", resizeViewport);
  stage?.dispose();
  stage = null;
  window.removeEventListener("keydown", onGlobalKeydown);
  document.removeEventListener("pointerdown", onOutsideControls);
  window.removeEventListener("keyup", onGlobalKeyup);
  window.removeEventListener("hashchange", onMenuHashChange);
  document.removeEventListener("visibilitychange", onPageHidden);
  window.removeEventListener("pagehide", onPageHide);
  window.removeEventListener("pointermove", onTimelinePointerMove);
  window.removeEventListener("pointerup", onTimelinePointerUp);
  window.removeEventListener("pointercancel", onTimelinePointerUp);
  if (scrubRafId !== null) {
    cancelAnimationFrame(scrubRafId);
    scrubRafId = null;
  }
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
  () => [state.phase, state.paused] as const,
  ([phase, paused]) => {
    if (phase === "running") {
      if (!paused) {
        const playIdentifier =
          currentGame()?.alias ?? currentGame()?.projectId ?? currentGame()?.hash;
        if (playIdentifier) markPlayHash(playIdentifier);
      }
      return;
    }
    if (phase === "idle" || phase === "error") {
      clearPlayHash();
      refreshPendingAutosave();
      savedGames.value = listCachedGames();
      cachedMeta.value = getCachedGameMeta(selectedGameId.value);
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
            @click="touchControls = !touchControls"
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
            @click="crtEnabled = !crtEnabled"
          >
            <span>CRT display<small>Scanlines, glow and curved glass</small></span>
            <span class="setting-value">{{ crtEnabled ? "On" : "Off" }}</span>
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
            v-if="hasWalkthrough(currentGame()?.alias ?? '') && !state.walkthrough.active"
            type="button"
            role="menuitem"
            data-testid="btn-run-walkthrough"
            @click="onStartWalkthrough(currentGame()!.alias!)"
          >
            <span>Run walkthrough<small>Watch real-time playthrough</small></span>
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
            <span>Project<small>Game and editing history</small></span>
          </button>
        </ActionMenu>
        <button
          v-if="state.phase === 'running'"
          class="ui-button ui-button--secondary audio-btn"
          data-testid="btn-eject"
          :disabled="state.powerUp.busy || state.leaving"
          title="Return to adventure selection menu"
          @click="ejectGame"
        >
          {{ state.leaving ? "Saving…" : "Menu" }}
        </button>
      </nav>
    </header>
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
    <div v-if="exportRefusal" class="export-refusal" data-testid="export-refusal" role="alert">
      <p>{{ exportRefusal }}</p>
      <button
        v-if="
          exportSavedProgressGameId !== undefined &&
          exportSavedProgressGameId === (currentGame()?.projectId ?? currentGame()?.hash)
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
    <div
      v-if="state.walkthrough.active"
      class="walkthrough-bar"
      data-testid="walkthrough-bar"
      role="status"
    >
      <span class="walkthrough-badge">
        <span class="walkthrough-dot" aria-hidden="true"></span>
        Walkthrough
      </span>
      <span
        v-if="state.walkthrough.label"
        class="walkthrough-label"
        data-testid="walkthrough-label"
      >
        {{ state.walkthrough.label }}
      </span>
      <span
        v-if="typeof state.walkthrough.score === 'number'"
        class="walkthrough-score"
        data-testid="walkthrough-score"
      >
        Score: {{ state.walkthrough.score }}
      </span>
      <span
        v-if="typeof state.walkthrough.room === 'number'"
        class="walkthrough-room"
        data-testid="walkthrough-room"
      >
        Room {{ state.walkthrough.room }}
      </span>
      <span v-if="state.walkthrough.status === 'completed'" class="walkthrough-completed-badge">
        Completed!
      </span>
      <div class="walkthrough-actions">
        <button
          type="button"
          class="ui-button ui-button--primary walkthrough-btn"
          data-testid="btn-walkthrough-take-control"
          title="Take control of the game right here"
          @click="onTakeControl"
        >
          Take control
        </button>
      </div>
    </div>
    <p
      v-if="state.walkthrough.error"
      class="export-refusal"
      data-testid="walkthrough-error"
      role="alert"
    >
      {{ state.walkthrough.error }}
    </p>
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
          This recording answered a get.number prompt, which stored tests cannot replay yet; the
          saved test will need editing.
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

    <section
      v-if="state.phase === 'idle' || state.phase === 'error'"
      class="welcome"
      aria-labelledby="welcome-title"
    >
      <p class="welcome-kicker">
        <a
          href="https://en.wikipedia.org/wiki/Adventure_Game_Interpreter"
          target="_blank"
          rel="noopener noreferrer"
          >Adventure Game Interpreter</a
        >
      </p>
      <h1 id="welcome-title">AGI IS HERE<span>.</span></h1>
      <p class="welcome-line">Dream it. Play it. Remix it.</p>
    </section>

    <details
      id="tutorial"
      v-if="state.phase === 'idle' || state.phase === 'error'"
      class="catalog-shelf"
      data-testid="tutorial-disclosure"
      :open="tutorialOpen"
      aria-labelledby="catalog-title"
    >
      <summary
        class="section-summary"
        data-testid="tutorial-toggle"
        @click.prevent="setTutorialOpen(!tutorialOpen)"
      >
        <h2 id="catalog-title">Play the tutorial</h2>
      </summary>
      <article
        v-for="entry in [featuredCatalog]"
        :key="`${entry.id}-${entry.version}`"
        class="catalog-card"
        :data-testid="`catalog-${entry.id}`"
      >
        <div class="catalog-art">
          <img
            v-if="catalogOpenings[entry.id]?.preview"
            :src="catalogOpenings[entry.id]?.preview"
            :alt="`${entry.title} opening scene`"
          />
          <div v-else class="thumbnail-placeholder" aria-hidden="true">
            {{ catalogBusy[entry.id] ? "CHECKING OPENING…" : "16 COLOR ADVENTURE" }}
          </div>
        </div>
        <div class="catalog-copy">
          <h3>{{ entry.title }}</h3>
          <p>{{ entry.description }}</p>
          <p class="catalog-byline">{{ entry.author }} · {{ entry.license }}</p>
          <p v-if="catalogErrors[entry.id]" role="alert" class="library-error">
            {{ catalogErrors[entry.id] }}
          </p>
          <p v-if="libraryActionError && !cachedMeta" role="alert" class="library-error">
            {{ libraryActionError }}
          </p>
          <button
            v-if="catalogErrors[entry.id]"
            type="button"
            class="ui-button ui-button--secondary"
            :disabled="catalogBusy[entry.id]"
            @click="loadCatalogOpening(entry.id)"
          >
            Retry preview
          </button>
          <button
            v-else
            type="button"
            class="ui-button ui-button--primary"
            :data-testid="`catalog-play-${entry.id}`"
            :disabled="catalogBusy[entry.id] || libraryActionBusy"
            @click="playCatalogGame(entry.id)"
          >
            {{
              catalogBusy[entry.id]
                ? "Checking opening…"
                : catalogHasProgress(entry)
                  ? "Resume"
                  : "Play now"
            }}
          </button>
        </div>
      </article>
    </details>

    <!-- Pre-game setup panel -->
    <div v-if="state.phase === 'idle' || state.phase === 'error'" class="setup-panel">
      <details
        id="create-adventure"
        ref="createDetails"
        class="create-pane"
        data-testid="create-adventure-disclosure"
        :open="createOpen"
      >
        <summary
          ref="createSummary"
          class="section-summary"
          data-testid="create-adventure-toggle"
          @click.prevent="onCreateSummaryActivate"
        >
          <h2>Create a new adventure</h2>
        </summary>
        <!-- Adventure Template Selector -->
        <section class="section">
          <div class="template-grid">
            <button
              v-for="tmpl in BUILTIN_TEMPLATES"
              :key="tmpl.id"
              class="template-card"
              :class="{ selected: selectedTemplateId === tmpl.id }"
              :aria-pressed="selectedTemplateId === tmpl.id"
              :data-testid="`template-${tmpl.id}`"
              @click="selectedTemplateId = tmpl.id"
            >
              <span class="template-title">{{ tmpl.title }}</span>
              <span class="template-desc">{{ tmpl.description }}</span>
            </button>
            <button
              class="template-card custom-card"
              :class="{ selected: selectedTemplateId === 'custom' }"
              :aria-pressed="selectedTemplateId === 'custom'"
              data-testid="template-custom"
              @click="selectedTemplateId = 'custom'"
            >
              <span class="template-title">Your own adventure</span>
              <span class="template-desc">Write your own premise.</span>
            </button>
          </div>

          <!-- Adventure brief shared by templates and custom games -->
          <div v-if="selectedTemplateId" class="custom-editor">
            <label for="adventure-name">Adventure name</label>
            <input
              id="adventure-name"
              v-model="adventureDraft.title"
              placeholder="Midnight at the Museum"
              maxlength="100"
            />
            <label for="adventure-brief">Adventure brief</label>
            <p id="adventure-brief-help" class="section-intro">
              Describe your hero, the world and what happens.
            </p>
            <textarea
              id="adventure-brief"
              v-model="adventureDraft.brief"
              aria-label="Adventure brief"
              aria-describedby="adventure-brief-help"
              spellcheck="false"
              placeholder="You are the night guard at a museum where the exhibits come alive. A tiny dinosaur has stolen your keys. Get them back before sunrise.&#10;&#10;Tell us about your hero, the setting, and the trouble they find themselves in."
              rows="8"
              data-testid="custom-adventure-input"
            />
          </div>
        </section>

        <div v-if="!aiConfigured" class="ai-connect" data-testid="create-ai-connect">
          <p>Connect your AI provider to generate a game.</p>
          <button
            type="button"
            class="ui-button ui-button--primary"
            data-testid="connect-create-ai"
            :disabled="aiSettingsUnavailable"
            @click="openAiSettings($event, 'create')"
          >
            Connect AI
          </button>
        </div>

        <!-- Launch Buttons -->
        <div v-if="aiConfigured" class="boot-row">
          <button
            ref="createButton"
            class="ui-button ui-button--primary"
            data-testid="boot-game"
            :disabled="!selectedTemplateId || !adventureDraft.brief.trim()"
            @click="onBootSelectedTemplate"
          >
            Create adventure
          </button>
        </div>
      </details>
      <aside
        id="your-games"
        class="library-pane"
        :class="{ 'empty-library': !hasLibraryContent }"
        :aria-labelledby="hasLibraryContent ? 'library-title' : undefined"
        :aria-label="hasLibraryContent ? undefined : 'Add game'"
      >
        <h2 v-if="hasLibraryContent" id="library-title">Your games</h2>
        <p v-if="libraryActionError" role="alert" class="library-error">
          {{ libraryActionError }}
        </p>
        <div v-if="hostedCatalogError" class="library-error" data-testid="hosted-catalog-error">
          <p role="alert">{{ hostedCatalogError }}</p>
          <button
            type="button"
            class="ui-button ui-button--secondary"
            :disabled="hostedCatalogBusy"
            @click="refreshHostedCatalog"
          >
            Retry game list
          </button>
        </div>

        <div
          v-if="savedGames.length || localGameIds.length || availableCatalogEntries.length"
          class="saved-game-gallery"
          data-testid="saved-game-gallery"
        >
          <article
            v-for="game in savedGames"
            :key="game.projectId"
            class="saved-game-card"
            :class="{ selected: selectedGameId === game.projectId }"
            :data-testid="`saved-game-card-${game.projectId}`"
            :data-project-id="game.projectId"
            :data-game-id="game.projectId"
          >
            <div class="saved-game-media">
              <img
                v-if="libraryAutosaves[game.projectId]?.preview || game.library?.preview"
                class="library-thumbnail"
                data-testid="library-thumbnail"
                :data-preview-kind="
                  libraryAutosaves[game.projectId]?.preview ? 'progress' : 'opening'
                "
                :src="libraryAutosaves[game.projectId]?.preview ?? game.library?.preview"
                :alt="
                  libraryAutosaves[game.projectId]?.preview
                    ? `${game.title}, current progress in room ${libraryAutosaves[game.projectId]?.room}`
                    : `${game.title} opening scene`
                "
              />
              <div v-else class="saved-game-cover" aria-hidden="true">AGI</div>
              <span v-if="libraryAutosaves[game.projectId]" class="saved-world-badge"
                >IN PROGRESS</span
              >
            </div>
            <div class="saved-game-card-body">
              <form
                v-if="renaming && selectedGameId === game.projectId"
                class="game-rename"
                data-testid="rename-game-form"
                @submit.prevent="saveGameTitle"
              >
                <label :for="`game-title-${game.projectId}`">Game name</label>
                <input
                  :id="`game-title-${game.projectId}`"
                  :ref="setTitleInput"
                  v-model="gameTitle"
                  maxlength="100"
                  required
                  @keydown.esc="renaming = false"
                />
                <button
                  type="submit"
                  class="ui-button ui-button--secondary"
                  :disabled="!gameTitle.trim()"
                >
                  Save name
                </button>
                <button
                  type="button"
                  class="ui-button ui-button--secondary"
                  @click="renaming = false"
                >
                  Cancel
                </button>
                <p v-if="renameError" role="alert">{{ renameError }}</p>
              </form>
              <div
                v-show="!(renaming && selectedGameId === game.projectId)"
                class="saved-game-info"
              >
                <div class="saved-game-heading">
                  <h3 class="saved-world-title" data-testid="saved-game-title">
                    {{ game.title }}
                  </h3>
                  <button
                    type="button"
                    class="ui-button ui-button--icon rename-icon"
                    aria-label="Rename game"
                    title="Rename game"
                    data-testid="rename-game"
                    @click="beginRename(game)"
                  >
                    <UiIcon name="pencil" />
                  </button>
                </div>
                <p v-if="libraryAutosaves[game.projectId]" class="saved-world-time">
                  Room {{ libraryAutosaves[game.projectId]?.room }} · Saved
                  {{ new Date(libraryAutosaves[game.projectId]!.savedAt).toLocaleString() }}
                </p>
              </div>
              <div class="saved-game-play-row">
                <button
                  type="button"
                  class="ui-button ui-button--primary"
                  data-testid="btn-resume-cached"
                  :disabled="libraryActionBusy || importBusy"
                  @click="onPlayLibraryGame(game)"
                >
                  {{ libraryAutosaves[game.projectId] ? "Resume" : "Play" }}
                </button>
                <ActionMenu
                  label="Game actions"
                  icon="more"
                  icon-only
                  :test-id="`game-actions-${game.projectId}`"
                >
                  <button
                    v-if="hasWalkthrough(game.library?.alias ?? game.projectId)"
                    type="button"
                    role="menuitem"
                    data-testid="run-walkthrough"
                    @click="onStartWalkthrough(game.library?.alias ?? game.projectId)"
                  >
                    <span>Run walkthrough<small>Watch real-time playthrough</small></span>
                  </button>
                  <button
                    v-if="libraryAutosaves[game.projectId]"
                    type="button"
                    role="menuitem"
                    data-testid="start-library-game-over"
                    @click="onStartLibraryGameOver(game)"
                  >
                    Start over
                  </button>
                  <button
                    v-if="game.library?.validation.status === 'unverified'"
                    type="button"
                    role="menuitem"
                    data-testid="check-library-game"
                    :disabled="libraryActionBusy"
                    @click="onCheckLibraryGame(game)"
                  >
                    Check opening
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="copy-library-game"
                    :disabled="libraryActionBusy"
                    @click="onCopyLibraryGame(game)"
                  >
                    Make a copy
                  </button>
                  <div role="separator"></div>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="btn-export-agi-zip"
                    :disabled="exportBusy"
                    @click="onExportLibraryGame(game)"
                  >
                    <span>Game export<small>Playable game</small></span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="btn-save-project"
                    :disabled="exportBusy"
                    @click="onExportLibraryGame(game, true)"
                  >
                    <span>Project<small>Game and editing history</small></span>
                  </button>
                  <div role="separator"></div>
                  <button
                    type="button"
                    role="menuitem"
                    class="danger"
                    data-testid="remove-library-game"
                    @click="onRemoveLibraryGame(game)"
                  >
                    Remove game
                  </button>
                </ActionMenu>
              </div>
              <details
                class="library-details-disclosure"
                :open="expandedGameId === game.projectId"
                :data-testid="`game-details-${game.projectId}`"
                @toggle="onGameDetailsToggle(game.projectId, $event)"
              >
                <summary>Details</summary>

                <div v-if="game.library" class="library-details">
                  <p v-if="game.library.description">{{ game.library.description }}</p>
                  <dl>
                    <template v-if="game.library.author">
                      <dt>By</dt>
                      <dd>{{ game.library.author }}</dd>
                    </template>
                    <template v-if="game.library.license">
                      <dt>License</dt>
                      <dd>{{ game.library.license }}</dd>
                    </template>
                    <template v-if="game.library.catalog">
                      <dt>Version</dt>
                      <dd>{{ game.library.catalog.version }}</dd>
                    </template>
                  </dl>
                </div>
              </details>
            </div>
          </article>
          <article
            v-for="game in localGames"
            :key="`local-${game.hash}`"
            class="saved-game-card"
            :data-testid="`local-game-card-${game.alias || game.folder || game.hash}`"
          >
            <div class="saved-game-media">
              <img
                v-if="localAutosave(game)?.preview"
                class="library-thumbnail"
                data-testid="library-thumbnail"
                data-preview-kind="progress"
                :src="localAutosave(game)?.preview"
                :alt="`${game.title}, current progress in room ${localAutosave(game)?.room}`"
              />
              <div v-else class="saved-game-cover" aria-hidden="true">
                {{ (game.alias || game.hash).slice(0, 8).toUpperCase() }}
              </div>
              <span v-if="localAutosave(game)" class="saved-world-badge">IN PROGRESS</span>
            </div>
            <div class="saved-game-card-body">
              <div class="saved-game-info">
                <div class="saved-game-heading">
                  <h3 class="saved-world-title">{{ game.title }}</h3>
                </div>
                <p v-if="localAutosave(game)" class="saved-world-time">
                  Room {{ localAutosave(game)?.room }}
                </p>
              </div>
              <div class="saved-game-play-row">
                <button
                  type="button"
                  class="ui-button ui-button--primary"
                  :data-hash="game.hash"
                  :data-alias="game.alias"
                  :data-testid="`boot-${game.alias || game.folder || game.hash}`"
                  :disabled="libraryActionBusy || importBusy"
                  @click="onPlayLocalGame(game.hash)"
                >
                  {{ localAutosave(game) ? "Resume" : "Play" }}
                </button>
                <ActionMenu
                  v-if="localAutosave(game) || hasWalkthrough(game.hash)"
                  label="Game actions"
                  icon="more"
                  icon-only
                  :test-id="`game-actions-${game.alias || game.folder || game.hash}`"
                >
                  <button
                    v-if="hasWalkthrough(game.hash)"
                    type="button"
                    role="menuitem"
                    data-testid="run-walkthrough"
                    @click="onStartWalkthrough(game.hash)"
                  >
                    <span>Run walkthrough<small>Watch real-time playthrough</small></span>
                  </button>
                  <button
                    v-if="localAutosave(game)"
                    type="button"
                    role="menuitem"
                    @click="
                      resumeAudio();
                      startOver(game.hash, llmConfig());
                    "
                  >
                    Start over
                  </button>
                </ActionMenu>
              </div>
            </div>
          </article>
          <article
            v-for="entry in availableCatalogEntries"
            :key="`catalog-${entry.id}-${entry.version}`"
            :ref="(element) => observeCatalogCard(element, entry.id)"
            class="saved-game-card"
            :data-testid="`hosted-game-card-${entry.id}`"
          >
            <div class="saved-game-media">
              <img
                v-if="catalogOpenings[entry.id]?.preview"
                class="library-thumbnail"
                :src="catalogOpenings[entry.id]?.preview"
                :alt="`${entry.title} opening scene`"
              />
              <div v-else class="saved-game-cover" aria-hidden="true">AGI</div>
            </div>
            <div class="saved-game-card-body">
              <div class="saved-game-info">
                <div class="saved-game-heading">
                  <h3 class="saved-world-title">{{ entry.title }}</h3>
                </div>
                <p class="saved-world-time">{{ entry.description }}</p>
              </div>
              <p v-if="catalogErrors[entry.id]" role="alert" class="library-error">
                {{ catalogErrors[entry.id] }}
              </p>
              <div class="saved-game-play-row">
                <button
                  v-if="catalogErrors[entry.id]"
                  type="button"
                  class="ui-button ui-button--secondary"
                  :disabled="catalogBusy[entry.id]"
                  @click="loadCatalogOpening(entry.id)"
                >
                  Retry preview
                </button>
                <button
                  v-else
                  type="button"
                  class="ui-button ui-button--primary"
                  :disabled="catalogBusy[entry.id] || libraryActionBusy || importBusy"
                  @click="playCatalogGame(entry.id)"
                >
                  {{ catalogBusy[entry.id] ? "Checking opening…" : "Play" }}
                </button>
              </div>
              <details class="library-details-disclosure">
                <summary>Details</summary>
                <div class="library-details">
                  <dl>
                    <template v-if="entry.author"
                      ><dt>By</dt>
                      <dd>{{ entry.author }}</dd></template
                    >
                    <dt>License</dt>
                    <dd>{{ entry.license }}</dd>
                    <dt>Version</dt>
                    <dd>{{ entry.version }}</dd>
                  </dl>
                </div>
              </details>
            </div>
          </article>
        </div>
        <!-- Autosave left over from an installed or unavailable game. -->
        <div
          v-if="
            pendingAutosave &&
            !savedGames.some((game) => game.projectId === pendingAutosave?.game.projectId) &&
            !localGames.some(
              (g) =>
                g.hash === pendingAutosave?.game.hash || g.alias === pendingAutosave?.game.alias,
            )
          "
          class="saved-world-card autosave-fallback"
          data-testid="autosave-panel"
        >
          <img
            v-if="pendingAutosave.preview"
            class="library-thumbnail"
            data-testid="library-thumbnail"
            data-preview-kind="progress"
            :src="pendingAutosave.preview"
            :alt="`${pendingAutosave.game.alias ?? pendingAutosave.game.projectId ?? 'Saved game'}, current progress in room ${pendingAutosave.room}`"
          />
          <div class="saved-world-header">
            <div class="saved-world-tag">
              <span class="saved-world-badge">IN PROGRESS</span>
              <span class="saved-world-title">{{
                pendingAutosave.game.alias ?? pendingAutosave.game.projectId
              }}</span>
            </div>
            <span class="saved-world-time">
              Room {{ pendingAutosave.room }} · Saved
              {{ new Date(pendingAutosave.savedAt).toLocaleString() }}
            </span>
          </div>
          <div class="saved-game-play-row">
            <button
              type="button"
              class="ui-button ui-button--primary"
              data-testid="btn-resume-autosave"
              @click="onResumeAutosave"
            >
              Resume
            </button>
            <ActionMenu label="Game actions" icon="more" icon-only>
              <button
                type="button"
                role="menuitem"
                data-testid="btn-start-over-picker"
                title="Discard the autosave and play this game from the beginning"
                @click="onStartOver"
              >
                Start over
              </button>
            </ActionMenu>
          </div>
        </div>

        <section
          id="open-game"
          class="zip-drop-zone"
          aria-label="Add game"
          @dragover.prevent
          @drop.prevent="onGameDrop($event.dataTransfer ?? undefined)"
          data-testid="game-zip-drop"
        >
          <ActionMenu
            :label="importBusy ? 'Adding game…' : 'Add game'"
            test-id="open-game-menu"
            :disabled="importBusy"
          >
            <button
              type="button"
              role="menuitem"
              data-testid="open-game-zip"
              @click="zipInput?.click()"
            >
              ZIP file
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="open-game-folder"
              @click="folderInput?.click()"
            >
              Game folder
            </button>
          </ActionMenu>
          <input
            ref="zipInput"
            type="file"
            accept=".zip,application/zip"
            data-testid="game-zip-input"
            hidden
            @change="onGameZip(($event.target as HTMLInputElement).files?.[0])"
          />
          <p class="drop-hint">Or drop a ZIP or folder</p>
          <input
            ref="folderInput"
            type="file"
            multiple
            webkitdirectory
            data-testid="game-folder-input"
            hidden
            @change="onGameFolder(($event.target as HTMLInputElement).files ?? undefined)"
          />
          <p class="verified-games-hint" data-testid="verified-games-hint">
            Verified to boot: King's Quest I–IV, Space Quest I–II, Police Quest I, Leisure Suit
            Larry I, The Black Cauldron, Mixed-Up Mother Goose, Donald Duck's Playground, Gold
            Rush!, Manhunter 1–2, demopac4.
          </p>
          <p v-if="importError" role="alert" data-testid="game-zip-error">{{ importError }}</p>
          <p
            v-if="importNotice"
            role="status"
            class="import-notice"
            data-testid="game-import-ready"
          >
            {{ importNotice }}
          </p>
        </section>
      </aside>
      <!-- Prominent Error Display inside Setup Panel -->
      <div
        v-if="state.phase === 'error'"
        class="error-banner"
        data-testid="error-panel"
        role="alert"
      >
        <span class="error-badge">ERROR</span>
        <span class="error-msg">{{ state.error }}</span>
      </div>
    </div>

    <!-- Interstitial Splash / Loading Screen during Genesis -->
    <div v-if="state.phase === 'loading'" class="loading-panel" data-testid="splash-screen">
      <div class="splash-card">
        <h2 class="splash-title">{{ activeTemplate.title }}</h2>
        <p class="splash-desc">{{ activeTemplate.description }}</p>
        <div class="splash-progress">
          <div
            class="spinner-box"
            v-if="state.agentTask?.status !== 'paused' && !state.agentTask?.progress"
          >
            <span class="pulsing-dot" />
            <span>Preparing your adventure…</span>
          </div>
          <p class="splash-subtext">Your game will appear here when it is ready.</p>
          <AgentTaskControls
            :task="state.agentTask"
            @stop="stopAgent"
            @resume="continueAgent"
            @discard="discardAgent"
          />
        </div>
      </div>
    </div>

    <!-- Screen Area (Hidden until game is running) -->
    <div class="play-area" :class="{ 'with-touch': touchControls && state.phase === 'running' }">
      <div
        v-show="state.phase === 'running'"
        class="screen"
        :class="{
          active: state.phase === 'running',
          shake: state.shake,
          remixing: state.powerUp.open,
        }"
        @click="onScreenClick"
        @pointerdown="onScreenPointerDown"
      >
        <canvas
          v-show="gpuBackend !== null"
          ref="gpuCanvas"
          class="game-surface"
          width="960"
          height="600"
          data-testid="gpu-canvas"
        />
        <!-- The composed 320x200 frame: Playwright pixel probe and no-GPU fallback. -->
        <canvas
          v-show="gpuBackend === null"
          ref="canvas"
          class="game-surface"
          width="320"
          height="200"
          data-testid="game-canvas"
        />

        <!-- Native keyboard/IME capture; the engine renders the only visible command line. -->
        <form
          v-if="state.phase === 'running'"
          class="input-row"
          @click.stop
          @submit.prevent="onVirtualKey(AGI_KEY.ENTER)"
        >
          <input
            id="game-command"
            :disabled="state.powerUp.open || (!state.inputReady && !state.walkthrough.active)"
            aria-label="Game command"
            aria-describedby="game-input-help"
            ref="inputEl"
            :value="state.prompt ? promptLine : inputLine"
            :inputmode="state.prompt?.kind === 'getnum' ? 'numeric' : 'text'"
            data-testid="input-line"
            autocomplete="off"
            autocapitalize="off"
            enterkeyhint="send"
            spellcheck="false"
            @input="onInputEdit"
            @compositionstart="composing = true"
            @compositionend="onCompositionEnd"
          />
        </form>

        <!-- The remix: freeze the world and ask the agent to change it. -->
        <button
          type="button"
          class="power-up"
          :class="{ armed: state.powerUp.open }"
          data-testid="power-up"
          :disabled="(creatingRoom && state.powerUp.open) || state.recording.active"
          :aria-label="
            creatingRoom && state.powerUp.open
              ? 'Creating the next room'
              : state.powerUp.open
                ? 'Close assistant'
                : 'Ask or remix this game'
          "
          :aria-expanded="state.powerUp.open"
          :title="state.powerUp.open ? 'Back to game (Esc)' : 'Ask or remix with AI'"
          @click.stop="onPowerUp"
        >
          <span class="power-up-glyph">✦</span>
        </button>

        <div v-if="state.powerUp.open" class="agent-bubble" data-testid="agent-bubble" @click.stop>
          <div class="agent-bubble-head">
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
            <span class="agent-bubble-room" data-testid="agent-bubble-room"
              >{{ asking ? "Read-only" : "Paused" }} ·
              {{ state.powerUp.room > 0 ? `room ${state.powerUp.room}` : "…" }}</span
            >
            <button
              v-if="!creatingRoom || !state.powerUp.busy"
              type="button"
              class="ui-button ui-button--secondary remix-close"
              :disabled="state.powerUp.busy"
              @click="onPowerUp"
            >
              Back to game
            </button>
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
              state.powerUp.busy &&
              state.agentTask?.status !== 'paused' &&
              !state.agentTask?.progress
            "
            class="remix-progress"
          >
            <span
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-testid="remix-progress-status"
            >
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
      </div>

      <!-- Walkthrough Transport Bar (Directly below the CRT screen) -->
      <div
        v-if="state.walkthrough.active && state.phase === 'running'"
        class="walkthrough-transport"
        data-testid="walkthrough-transport"
      >
        <button
          type="button"
          class="walkthrough-transport-play-btn"
          data-testid="btn-walkthrough-pause"
          :title="
            state.walkthrough.status === 'paused'
              ? 'Play (Space)'
              : state.walkthrough.status === 'completed'
                ? 'Replay from start'
                : 'Pause (Space)'
          "
          :aria-label="
            state.walkthrough.status === 'paused'
              ? 'Play'
              : state.walkthrough.status === 'completed'
                ? 'Replay'
                : 'Pause'
          "
          @click="toggleWalkthroughPause"
        >
          <svg
            v-if="state.walkthrough.status === 'paused'"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
          <svg
            v-else-if="state.walkthrough.status === 'completed'"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"
            />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
          </svg>
        </button>

        <!-- Scrubbable Timeline Track -->
        <div
          ref="timelineEl"
          class="walkthrough-timeline"
          data-testid="walkthrough-timeline"
          role="slider"
          tabindex="0"
          aria-label="Walkthrough timeline"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="Math.round(scrubPercent ?? state.walkthrough.percent)"
          @pointerdown="onTimelinePointerDown"
          @pointermove="onTimelineHover"
          @pointerleave="onTimelinePointerLeave"
          @keydown="onTimelineKeydown"
        >
          <div class="walkthrough-track">
            <!-- Progress Fill -->
            <div
              class="walkthrough-progress-fill"
              data-testid="walkthrough-progress-fill"
              :style="{ width: `${scrubPercent ?? state.walkthrough.percent}%` }"
            ></div>

            <!-- Chapter Marker Notches -->
            <button
              v-for="cp in state.walkthrough.checkpoints"
              :key="cp.index"
              type="button"
              class="walkthrough-marker"
              :class="{
                'walkthrough-marker--passed':
                  (scrubPercent ?? state.walkthrough.percent) >= cp.percent,
              }"
              :style="{ left: `${cp.percent}%` }"
              :data-testid="`walkthrough-marker-${cp.index}`"
              :title="`${cp.label} (Score: ${cp.score} · Room ${cp.room})`"
              @click.stop="onMarkerClick(cp)"
            ></button>

            <!-- Thumb / Scrubber Handle -->
            <div
              class="walkthrough-thumb"
              data-testid="walkthrough-thumb"
              :style="{ left: `${scrubPercent ?? state.walkthrough.percent}%` }"
            ></div>
          </div>

          <!-- Hover / Scrub Tooltip -->
          <div
            v-if="hoverInfo"
            class="walkthrough-tooltip"
            :style="{ left: `${hoverInfo.percent}%` }"
          >
            <span class="walkthrough-tooltip-label">{{ hoverInfo.label }}</span>
            <span v-if="hoverInfo.details" class="walkthrough-tooltip-details">{{
              hoverInfo.details
            }}</span>
          </div>
        </div>

        <!-- Playback Speed Controls -->
        <div class="walkthrough-speed-group" role="group" aria-label="Playback speed">
          <button
            v-for="s in [1, 2, 4, 8]"
            :key="s"
            type="button"
            class="ui-button ui-button--secondary walkthrough-speed-btn"
            :class="{ 'walkthrough-speed-btn--active': state.walkthrough.speed === s }"
            :data-testid="`walkthrough-speed-${s}`"
            :title="`Set playback speed to ${s}×`"
            @click="setWalkthroughSpeed(s)"
          >
            {{ s }}×
          </button>
        </div>

        <!-- Auto-pause on story dialogue toggle -->
        <button
          type="button"
          class="ui-button ui-button--secondary walkthrough-speed-btn walkthrough-dialog-pause-btn"
          :class="{ 'walkthrough-speed-btn--active': state.walkthrough.pauseOnDialog }"
          data-testid="btn-walkthrough-pause-on-dialog"
          :title="
            state.walkthrough.pauseOnDialog
              ? 'Story pause: enabled (pauses on dialogue)'
              : 'Story pause: disabled (auto-advances with reading dwell)'
          "
          :aria-label="
            state.walkthrough.pauseOnDialog
              ? 'Disable pause on dialogue'
              : 'Enable pause on dialogue'
          "
          @click="toggleWalkthroughPauseOnDialog"
        >
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="currentColor"
            aria-hidden="true"
            class="walkthrough-dialog-pause-icon"
          >
            <path
              d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"
            />
          </svg>
          Story pause
        </button>
      </div>

      <!-- Captions under the screen (never overlays: all game text is on the CRT) -->
      <TouchControls
        v-if="touchControls && state.phase === 'running'"
        :disabled="state.powerUp.open || state.paused"
        :navigating="state.modal !== null"
        :hold="state.holdToMove"
        @direction="onTouchDirection"
        @key="onVirtualKey"
        @keyboard="inputEl?.focus({ preventScroll: true })"
      />
    </div>
    <div v-if="state.phase === 'running'" class="screen-captions">
      <template v-if="!state.walkthrough.seeking">
        <span v-if="state.resumed" class="caption resume-caption" data-testid="resume-caption">
          Resumed where you left off
        </span>
        <span v-if="state.prompt" class="caption" data-testid="prompt-hint">
          [ Type your answer on the screen, Enter to accept, Esc to cancel ]
        </span>
        <span v-else-if="state.textMode" class="caption" data-testid="text-mode-hint">
          [ Use the keys requested by the game ]
        </span>
        <span v-else-if="hasKeyPrompt" class="caption" data-testid="title-prompt-hint">
          [ {{ touchControls ? "Tap screen or press" : "Press" }} Enter / Space to start ]
        </span>
        <span v-else-if="state.modal === 'menu'" class="caption" data-testid="menu-hint">
          [ Arrows to navigate, Enter to select, Esc to close ]
        </span>
        <span v-else-if="state.modal === 'inventory'" class="caption" data-testid="inventory-hint">
          [ Arrows to select, Enter to choose, Esc to return ]
        </span>
        <span v-else-if="state.modal !== null" class="caption" data-testid="modal-hint">
          [ Press Enter to continue ]
        </span>
      </template>
    </div>

    <p v-if="state.phase === 'running'" id="game-input-help" class="input-help">
      {{
        touchControls
          ? "Type to open keyboard · Enter to send · Keys for F1–F10 and more"
          : "Click the game to type · Enter to send · Arrows or numpad to walk · Home / PgUp / End / PgDn for diagonals"
      }}
    </p>

    <SoundPreview
      v-if="!state.powerUp.open && latestAgentAudio.length"
      :audio="latestAgentAudio"
      data-testid="latest-sound-preview"
    />

    <!-- Live Agent Debug Activity Panel -->
    <details v-if="state.agentLog.length || testMode" class="agent-panel" data-testid="agent-panel">
      <summary data-testid="developer-activity-summary">Developer activity</summary>
      <div class="agent-panel-header">
        <span class="backend-tag" data-testid="gpu-backend">{{ gpuBackend || "canvas2d" }}</span>
        <div class="agent-panel-actions">
          <button
            type="button"
            class="telemetry-btn"
            data-testid="btn-copy-trace"
            title="Copy entire debug trace to clipboard"
            @click="copyDebugBundle"
          >
            📋 Copy Debug Bundle
          </button>
          <button
            type="button"
            class="telemetry-btn secondary"
            data-testid="btn-clear-trace"
            title="Clear telemetry logs"
            @click="clearAgentLog"
          >
            Clear
          </button>
          <span v-if="copyFeedback" class="copy-feedback">{{ copyFeedback }}</span>
        </div>
      </div>
      <button
        v-if="testMode && (state.phase === 'idle' || state.phase === 'error')"
        class="ui-button ui-button--secondary"
        data-testid="boot-agent"
        @click="
          resumeAudio();
          bootAgentGame();
        "
      >
        Run test game
      </button>
      <div class="agent-entries">
        <div
          v-for="entry in state.agentLog.slice(-50)"
          :key="entry.id"
          class="agent-entry"
          :class="[entry.kind, { expandable: Boolean(entry.data) }]"
          @click="entry.data ? toggleLogEntry(entry.id) : null"
        >
          <div class="agent-entry-row">
            <span class="agent-kind">{{ entry.kind }}</span>
            <span class="agent-detail">{{ entry.detail }}</span>
            <span v-if="entry.data" class="agent-expand-toggle">
              {{ expandedLogIds.has(entry.id) ? "▲ collapse" : "▼ inspect" }}
            </span>
          </div>
          <pre v-if="entry.data && expandedLogIds.has(entry.id)" class="agent-data-preview">{{
            JSON.stringify(entry.data, null, 2)
          }}</pre>
          <SoundPreview v-if="entry.audio?.length" :audio="entry.audio" />
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
.zip-drop-zone {
  padding: 1.25rem;
  border: 1px dashed #777;
  border-radius: 8px;
  text-align: center;
}
.zip-drop-zone p {
  margin: 0.75rem 0 0;
}
/* ---- The remix: one round button on the game frame (.screen is relative) ---- */
.power-up {
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  border: 2px solid #55ffff;
  background: radial-gradient(circle at 35% 30%, #1b3b4a, #06131a);
  color: #55ffff;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
  box-shadow: 0 0 12px rgba(85, 255, 255, 0.35);
  transition:
    transform 0.12s ease,
    box-shadow 0.12s ease;
  z-index: 3;
}

.power-up:hover {
  transform: scale(1.08);
}

.power-up.armed {
  border-color: #ffff55;
  color: #ffff55;
  box-shadow: 0 0 18px rgba(255, 255, 85, 0.55);
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

.agent-bubble-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  letter-spacing: 0.02em;
  color: #55ffff;
  margin-bottom: 8px;
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
.agent-mode-switch button[aria-pressed="true"] {
  background: #20454e;
  color: #a5ffff;
}
.agent-bubble-head .remix-close {
  margin-left: auto;
  white-space: nowrap;
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
.walkthrough-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin: 6px 0 0;
  padding: 6px 12px;
  border: 1px solid #1a5259;
  border-radius: 8px;
  background: #0f2428;
  color: #c9eff2;
  font-size: 13px;
}
.walkthrough-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: #5ce1e6;
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.05em;
}
.walkthrough-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #5ce1e6;
  animation: walkthrough-pulse 1.5s ease-in-out infinite;
}
@keyframes walkthrough-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.85);
  }
}
.walkthrough-label {
  color: #ffffff;
  font-weight: 500;
}
.walkthrough-score {
  color: #9fe6a0;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
.walkthrough-completed-badge {
  color: #ffd700;
  font-weight: 600;
}
.walkthrough-speed-group {
  display: inline-flex;
  gap: 4px;
}
.walkthrough-speed-btn {
  padding: 2px 8px;
  font-size: 12px;
  min-height: 24px;
  line-height: 1;
}
.walkthrough-speed-btn--active {
  background: #1a5259;
  border-color: #5ce1e6;
  color: #ffffff;
  font-weight: 600;
}
.walkthrough-dialog-pause-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.walkthrough-dialog-pause-icon {
  flex-shrink: 0;
}
.walkthrough-actions {
  display: inline-flex;
  gap: 8px;
  margin-left: auto;
}
.walkthrough-room {
  color: #8da4ac;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}
.walkthrough-transport {
  display: flex;
  align-items: center;
  gap: 12px;
  width: var(--game-width);
  box-sizing: border-box;
  margin-top: -6px;
  padding: 6px 12px;
  background: #0b171b;
  border: 1px solid #1a5259;
  border-radius: 8px;
  user-select: none;
}
.walkthrough-transport-play-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid #2e717b;
  border-radius: 6px;
  background: #163b42;
  color: #5ce1e6;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background-color 0.15s,
    border-color 0.15s,
    color 0.15s,
    transform 0.1s;
}
.walkthrough-transport-play-btn:hover {
  background: #1c4d56;
  border-color: #5ce1e6;
  color: #ffffff;
}
.walkthrough-transport-play-btn:active {
  transform: scale(0.95);
}
.walkthrough-timeline {
  position: relative;
  flex: 1;
  height: 26px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
  outline: none;
}
.walkthrough-timeline:focus-visible .walkthrough-track {
  box-shadow: 0 0 0 2px #5ce1e6;
}
.walkthrough-track {
  position: relative;
  width: 100%;
  height: 6px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  transition: height 0.15s ease;
}
.walkthrough-timeline:hover .walkthrough-track {
  height: 8px;
}
.walkthrough-progress-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: linear-gradient(90deg, #1fa2a6, #5ce1e6);
  border-radius: 3px;
  pointer-events: none;
}
.walkthrough-marker {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 4px;
  height: 10px;
  padding: 0;
  border: 1px solid #0b171b;
  border-radius: 1px;
  background: #ffd700;
  z-index: 2;
  cursor: pointer;
  transition:
    transform 0.15s ease,
    background-color 0.15s ease;
}
.walkthrough-marker:hover {
  transform: translate(-50%, -50%) scale(1.6);
  background: #ffffff;
  z-index: 4;
}
.walkthrough-marker--passed {
  background: #fff080;
}
.walkthrough-thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #5ce1e6;
  box-shadow: 0 0 6px rgba(92, 225, 230, 0.7);
  z-index: 3;
  pointer-events: none;
  transition: transform 0.1s ease;
}
.walkthrough-timeline:hover .walkthrough-thumb {
  transform: translate(-50%, -50%) scale(1.2);
}
.walkthrough-tooltip {
  position: absolute;
  bottom: calc(100% + 6px);
  transform: translateX(-50%);
  background: #0f2428;
  border: 1px solid #2e717b;
  border-radius: 6px;
  padding: 3px 8px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 10;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
}
.walkthrough-tooltip-label {
  font-size: 11px;
  font-weight: 600;
  color: #ffffff;
}
.walkthrough-tooltip-details {
  font-size: 10px;
  color: #9fe6a0;
  font-family: var(--font-mono, monospace);
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

.export-refusal {
  color: #ffff55;
  font-size: 12px;
  width: var(--shell-width);
  margin: 6px 0 16px;
  line-height: 1.5;
}

.app-container {
  --shell-width: min(960px, calc(100vw - 32px));
  --game-width: min(960px, calc(100vw - 32px), max(640px, calc((100dvh - 280px) * 1.6)));
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 0;
  font-size: 14px;
  line-height: 1.5;
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

.setup-panel {
  width: var(--shell-width);
  box-sizing: border-box;
  margin-bottom: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 32px;
  padding: 0;
}

.at-menu {
  --shell-width: min(1120px, calc(100vw - 40px));
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
.welcome {
  width: var(--shell-width);
  padding: 20px 0 36px;
}
.welcome-kicker {
  color: #85b8ba;
  font-size: 12px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  margin: 0 0 16px;
}
.welcome-kicker a {
  color: inherit;
  text-decoration: none;
}
.welcome-kicker a:hover,
.welcome-kicker a:focus-visible {
  text-decoration: underline;
  color: #a2e8ea;
}
.welcome h1 {
  font:
    900 clamp(38px, 6.6vw, 84px)/1.1 ui-monospace,
    "SFMono-Regular",
    Menlo,
    Consolas,
    monospace;
  letter-spacing: -0.065em;
  color: #e9ffff;
  text-shadow: 0 0 32px #55ffff30;
}
.welcome h1 span {
  color: #55ffff;
}
.welcome-line {
  margin: 18px 0 8px;
  color: #e3eded;
  font:
    500 clamp(18px, 2.5vw, 25px)/1.4 system-ui,
    sans-serif;
}
.catalog-shelf {
  width: var(--shell-width);
  margin: 0 auto 28px;
  padding: 22px;
  box-sizing: border-box;
  border: 1px solid #3d6669;
  border-radius: 12px;
  background: linear-gradient(135deg, #152a2c, #0b1113 68%);
  font-family: system-ui, sans-serif;
}
#tutorial,
.create-pane,
.library-pane {
  scroll-margin-top: 20px;
}
.library-pane.empty-library {
  width: 100%;
  align-self: stretch;
  padding: 20px;
  background: #0b1213;
}
.library-pane.empty-library h2 {
  margin-bottom: 10px;
  font-size: 20px;
}
.section-summary {
  display: list-item;
  list-style-position: inside;
  min-height: 44px;
  box-sizing: border-box;
  padding: 8px 0;
  color: #e9f4f4;
  cursor: pointer;
  font:
    700 20px/1.4 system-ui,
    sans-serif;
}
.section-summary::marker {
  color: var(--ui-action);
  font-size: 16px;
}
.section-summary h2 {
  display: inline;
  margin: 0 0 0 8px;
  font: inherit;
  color: inherit;
}
details[open] > .section-summary {
  margin-bottom: 20px;
}
.section-summary:focus-visible {
  border-radius: 6px;
}
.catalog-card {
  display: grid;
  grid-template-columns: minmax(280px, 1.35fr) minmax(240px, 1fr);
  overflow: hidden;
  border: 1px solid #42676a;
  border-radius: 9px;
  background: #0c1517;
}
.catalog-art {
  min-height: 225px;
  background: #050707;
}
.catalog-art img,
.library-thumbnail {
  display: block;
  width: 100%;
  aspect-ratio: 8 / 5;
  object-fit: cover;
  image-rendering: pixelated;
}
.thumbnail-placeholder {
  display: grid;
  height: 100%;
  min-height: 225px;
  place-items: center;
  color: #759294;
  font: 12px/1.4 monospace;
  letter-spacing: 0.12em;
}
.catalog-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  padding: 24px;
}
.catalog-copy h3 {
  margin: 7px 0;
  color: #fff;
  font-size: 24px;
}
.catalog-copy > p:not(.saved-world-badge) {
  margin: 0 0 14px;
  color: #a9bdbf;
  line-height: 1.5;
}
.catalog-copy .catalog-byline {
  color: #7f999b;
  font-size: 12px;
}
.catalog-copy .ui-button {
  width: auto;
  min-width: 150px;
}
.library-thumbnail {
  margin-bottom: 14px;
  border: 1px solid #405457;
  border-radius: 5px;
}
.library-details {
  margin-top: 12px;
  color: #9fb3b5;
  font-size: 13px;
  line-height: 1.45;
}
.library-details dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 10px;
  margin: 12px 0;
}
.library-details dt {
  color: #718d90;
}
.library-details dd {
  margin: 0;
}
.library-details strong {
  color: #b7f3da;
}
.library-error {
  color: #ffc2bd !important;
}
.create-pane {
  font-family: system-ui, sans-serif;
  min-width: 0;
  align-self: start;
  width: 100%;
  box-sizing: border-box;
  padding: 22px;
  background: linear-gradient(135deg, #152a2c, #0b1113 68%);
  border: 1px solid #3d6669;
  border-radius: 12px;
}
.create-pane > .section:first-of-type {
  margin-top: 0;
}
.library-pane {
  min-width: 0;
  padding: 26px;
  box-sizing: border-box;
  border: 1px solid #294346;
  border-radius: 12px;
  background: linear-gradient(145deg, #102021, #0b1012 60%);
  font-family: system-ui, sans-serif;
}
.library-pane h2 {
  margin: 0 0 18px;
  color: #e4eeee;
  font-size: 24px;
}
.library-pane .stub-btn {
  margin-bottom: 20px;
}
.library-pane .zip-drop-zone {
  margin-top: 20px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 16px;
  border-color: #405457;
  border-radius: 8px;
  text-align: left;
}
.library-pane.empty-library .zip-drop-zone {
  margin-top: 0;
  padding: 0;
  border: 0;
}
.library-pane .zip-drop-zone p {
  margin: 0;
  font-size: 13px;
}
.library-pane .zip-drop-zone p.verified-games-hint {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.45;
  color: #7d9c9e;
}
.library-pane .saved-world-header {
  align-items: flex-start;
}
.library-pane .saved-world-tag {
  flex-wrap: wrap;
}
.library-pane .saved-world-title {
  overflow-wrap: anywhere;
}
.saved-game-gallery {
  display: grid;
  /* Top-aligned on purpose: an open Details grows its own card only. */
  align-items: start;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 290px), 1fr));
  gap: 18px;
  margin-top: 20px;
}
.saved-game-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #38575a;
  border-radius: 8px;
  background: #091315;
}
.saved-game-card.selected {
  border-color: #5b9da0;
}
.saved-game-card .library-thumbnail,
.saved-game-cover {
  width: 100%;
  margin: 0;
  aspect-ratio: 8 / 5;
  border: 0;
  border-radius: 0;
  object-fit: cover;
  image-rendering: pixelated;
}
.saved-game-cover {
  display: grid;
  place-items: center;
  color: #6b8588;
  background: linear-gradient(145deg, #162627, #0a0f10);
  font: 700 28px/1 monospace;
  letter-spacing: 0.15em;
  overflow-wrap: anywhere;
  text-align: center;
  box-sizing: border-box;
  padding: 16px;
}
.saved-game-media {
  position: relative;
}
.saved-game-media .saved-world-badge {
  position: absolute;
  right: 10px;
  bottom: 10px;
}
.saved-game-card-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  padding: 18px;
}
/* Two title lines plus one progress line, so Play sits at the same height on
   every card in a row whatever the title length or progress text. */
.saved-game-info {
  width: 100%;
  min-height: calc(2 * 19px * 1.25 + 4px + 13px * 1.4);
}
/* One column has nothing to line up with, so the reservation goes. */
@media (max-width: 640px) {
  .saved-game-info {
    min-height: 0;
  }
}
.saved-game-card .saved-world-title {
  margin: 0;
  color: #f2ffff;
  font-size: 19px;
  line-height: 1.25;
}
.saved-game-card .saved-world-time {
  margin: 0;
  color: #90aaa9;
  font-size: 13px;
  line-height: 1.4;
}
.library-details-disclosure {
  width: 100%;
  margin-top: 12px;
  border-top: 1px solid #2d4144;
  color: #9fb3b5;
}
.library-details-disclosure > summary {
  min-height: 44px;
  box-sizing: border-box;
  padding: 12px 2px;
  color: #b9d0d2;
  cursor: pointer;
  font-size: 13px;
}
.library-details-disclosure[open] > summary {
  color: #efffff;
}
.autosave-fallback {
  margin-top: 20px;
}

.setup-panel > .error-banner {
  grid-column: 1 / -1;
}

.section {
  margin: 24px 0;
}

.section-intro {
  margin: 8px 0 16px;
  color: #aaa;
  font-size: 13px;
}
.section h2 {
  font-size: 16px;
  letter-spacing: 0.02em;
  color: #eee;
  margin: 0 0 0.5rem 0;
}

.template-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.template-card {
  background: #1a1a1a;
  border: 1px solid #333;
  padding: 12px;
  text-align: left;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  border-radius: 6px;
  transition: all 0.15s ease;
}

.template-card:hover {
  border-color: #555;
  background: #222;
}

.template-card.selected {
  border-color: #64dddd;
  background: #173337;
}

.custom-card {
  grid-column: 1 / -1;
}

.template-title {
  font-size: 14px;
  font-weight: bold;
  color: #fff;
  margin-bottom: 0.25rem;
}

.template-desc {
  font-size: 12px;
  color: #bbb;
  line-height: 1.5;
}

.custom-editor {
  margin-top: 24px;
}
.custom-editor label {
  display: block;
  color: #cfdddd;
  font:
    500 14px/1.5 system-ui,
    sans-serif;
  margin: 16px 0 8px;
}
.custom-editor input,
.custom-editor textarea {
  width: 100%;
  background: #070d0f;
  border: 1px solid #405457;
  color: #eee;
  font:
    16px/1.65 system-ui,
    sans-serif;
  padding: 14px;
  border-radius: 6px;
  box-sizing: border-box;
}
.custom-editor textarea {
  min-height: 230px;
  resize: vertical;
}
.custom-editor textarea::placeholder,
.custom-editor input::placeholder {
  color: #819799;
  opacity: 1;
}

.config-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.config-col {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  flex: 1;
  min-width: 140px;
}

.config-col.key-col {
  flex: 2;
  min-width: 200px;
}

.config-col label {
  font-size: 12px;
  color: #bbb;
}

.field-label-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.field-label-row a {
  color: #8debed;
  font:
    600 12px/1.4 system-ui,
    sans-serif;
}
.field-label-row a:hover {
  color: #fff;
}

.config-col select,
.config-col input {
  color-scheme: dark;
  background: #000;
  border: 1px solid #444;
  color: #fff;
  font-family: monospace;
  font-size: 14px;
  min-height: 40px;
  box-sizing: border-box;
  padding: 8px 10px;
  border-radius: 2px;
}

.config-col select {
  height: 44px;
  min-height: 44px;
}

.boot-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.screen {
  position: relative;
  border: 2px solid #33455c;
  background: #000;
  box-shadow:
    0 0 0 4px #090e17,
    0 0 0 5px #223047,
    0 0 56px #55ffff0d;
  transition:
    box-shadow 180ms ease-out,
    border-color 180ms ease-out;
}

.play-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
@media (orientation: landscape) and (max-height: 600px) {
  .play-area.with-touch {
    --game-width: min(calc(100vw - 268px), calc((var(--visible-height, 100dvh) - 100px) * 1.6));
    flex-direction: row;
    align-items: flex-start;
    gap: 16px;
  }
  .app-container:has(.with-touch) {
    padding: 8px 0;
  }
  .app-container:has(.with-touch) .header {
    margin-bottom: 8px;
  }
}
@media (orientation: portrait) {
  .play-area.with-touch {
    --game-width: min(
      calc(100vw - 32px),
      max(160px, calc((var(--visible-height, 100dvh) - 340px) * 1.6))
    );
  }
}

.screen.active {
  border-color: #567087;
}

.screen.remixing {
  border-color: #ffff55;
  box-shadow:
    0 0 0 4px #090e17,
    0 0 0 5px #6e7045,
    0 0 64px #ffff551c;
}

.game-surface {
  display: block;
  width: var(--game-width);
  aspect-ratio: 8 / 5;
  height: auto;
  image-rendering: pixelated;
  outline: none;
  background: #000;
}

.screen-captions {
  width: var(--game-width);
  min-height: 1.4rem;
  margin-top: 0.35rem;
  text-align: center;
}

.caption {
  display: inline-block;
  border: 1px solid #5af;
  color: #5af;
  font-family: monospace;
  font-size: 0.8rem;
  font-weight: bold;
  padding: 0.2rem 0.6rem;
  border-radius: 3px;
  white-space: normal;
}

/* The resume notice states a fact rather than asking for a keystroke, so it
   sits still and fades out on its own instead of pulsing like the hints. */
.resume-caption {
  border-color: #7d7;
  color: #7d7;
  margin-right: 0.4rem;
  animation: resume-fade 10s ease-in forwards;
}

@keyframes resume-fade {
  0%,
  70% {
    opacity: 1;
  }
  100% {
    opacity: 0.25;
  }
}

.splash-screen {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.94);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  padding: 1.5rem;
  box-sizing: border-box;
}

.splash-card {
  text-align: center;
  max-width: 480px;
}

.splash-title {
  font-size: 1.2rem;
  letter-spacing: 0.15em;
  color: #fff;
  margin: 0 0 0.5rem 0;
}

.splash-desc {
  font-size: 0.8rem;
  color: #aaa;
  margin: 0 0 1.2rem 0;
  line-height: 1.4;
}

.splash-progress {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.spinner-box {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: #5af;
}

.pulsing-dot {
  width: 8px;
  height: 8px;
  background: #5af;
  border-radius: 50%;
  animation: pulse 1s infinite alternate;
}

@keyframes pulse {
  0% {
    opacity: 0.2;
    transform: scale(0.8);
  }
  100% {
    opacity: 1;
    transform: scale(1.2);
  }
}

.splash-subtext {
  font-size: 0.7rem;
  color: #666;
  margin: 0;
}

.backend-tag {
  font-size: 0.7rem;
  color: #555;
  letter-spacing: 0.15em;
}

.screen.shake {
  animation: screen-shake 0.1s linear infinite;
}

@keyframes screen-shake {
  0% {
    transform: translate(2px, 1px);
  }
  25% {
    transform: translate(-2px, -1px);
  }
  50% {
    transform: translate(1px, -2px);
  }
  75% {
    transform: translate(-1px, 2px);
  }
  100% {
    transform: translate(2px, 1px);
  }
}

.input-help {
  font-size: 12px;
  color: #aaa;
  text-align: center;
  max-width: var(--game-width);
  margin: 12px 0 0;
}

.input-row {
  position: absolute;
  bottom: 0;
  left: 50%;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.input-row input {
  font-size: 16px;
}

.screen:has(.input-row input:focus-visible) {
  outline: 2px solid #55ffff;
  outline-offset: 4px;
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
.agent-panel {
  width: var(--shell-width);
  margin-top: 1rem;
  border-top: 1px solid #333;
  max-height: 280px;
  overflow-y: auto;
  font-size: 0.75rem;
}

.agent-panel summary {
  cursor: pointer;
  padding: 12px 0;
  color: #aaa;
  font-size: 12px;
}

@media (max-width: 850px) {
  .catalog-card {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 600px) {
  .app-container {
    padding: 16px 0;
  }
  .setup-panel {
    padding: 0;
  }
  .create-pane {
    padding: 18px;
  }
  .library-pane {
    padding: 18px;
  }
  .welcome {
    padding: 12px 0 28px;
  }
  .welcome-kicker {
    font-size: 10px;
    letter-spacing: 0.1em;
  }
  .catalog-shelf {
    padding: 18px;
  }
  .catalog-art,
  .thumbnail-placeholder {
    min-height: 0;
  }
  .catalog-copy {
    padding: 18px;
  }
  .template-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .header {
    gap: 16px;
  }
  .agent-bubble {
    position: fixed;
    top: auto;
    left: auto;
    transform: none;
    bottom: 16px;
    right: 16px;
    width: calc(100% - 32px);
    box-sizing: border-box;
    max-height: min(70dvh, 480px);
    overflow-y: auto;
  }
  .agent-bubble-head {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
  }
  .agent-mode-switch {
    justify-self: start;
  }
  .agent-bubble-room {
    grid-column: 1 / -1;
    grid-row: 2;
    font-size: 10px;
  }
  .agent-bubble-form textarea {
    min-width: 0;
    width: 100%;
  }
  .config-col,
  .config-col.key-col {
    min-width: 0;
    flex-basis: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .app-container *,
  .screen.shake {
    animation: none;
    transition: none;
  }
}

.agent-panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.5rem 0;
}

.agent-panel-actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.telemetry-btn {
  font-size: 0.65rem;
  padding: 0.2rem 0.5rem;
  background: #1c2838;
  border: 1px solid #3a5578;
  color: #7bb5f5;
  border-radius: 3px;
  cursor: pointer;
  font-family: inherit;
}

.telemetry-btn:hover {
  background: #253952;
  border-color: #5b87bf;
  color: #fff;
}

.telemetry-btn.secondary {
  background: #222;
  border-color: #444;
  color: #888;
}

.telemetry-btn.secondary:hover {
  background: #333;
  border-color: #666;
  color: #ccc;
}

.copy-feedback {
  font-size: 0.7rem;
  color: #5f5;
  font-weight: bold;
}

.agent-entries {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.agent-entry {
  padding: 3px 0;
  color: #999;
  font-family: monospace;
}

.agent-entry.expandable {
  cursor: pointer;
}

.agent-entry-row {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
}

.agent-entry .agent-kind {
  color: #5af;
  font-weight: bold;
}

.agent-entry.response .agent-kind {
  color: #7d7;
}

.agent-entry.error .agent-kind {
  color: #f66;
}

.agent-entry.log .agent-kind {
  color: #fa0;
}

.agent-entry.input .agent-kind {
  color: #5ce1e6;
}

.agent-detail {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
}

.agent-expand-toggle {
  font-size: 0.65rem;
  color: #5af;
  opacity: 0.8;
  padding: 0 4px;
}

.agent-data-preview {
  margin: 0.3rem 0 0.5rem 1rem;
  padding: 0.4rem 0.6rem;
  background: #111;
  border: 1px solid #333;
  border-radius: 3px;
  color: #bbb;
  font-size: 0.7rem;
  max-height: 180px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.error-banner {
  margin-top: 0.75rem;
  background: #2a0e0e;
  border: 1px solid #933;
  padding: 0.6rem 0.8rem;
  border-radius: 3px;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.error-badge {
  background: #933;
  color: #fff;
  font-family: monospace;
  font-size: 0.65rem;
  font-weight: bold;
  padding: 0.15rem 0.35rem;
  border-radius: 2px;
  letter-spacing: 0.1em;
}

.error-msg {
  font-family: monospace;
  font-size: 0.75rem;
  color: #fbb;
  line-height: 1.4;
  word-break: break-word;
}

.loading-panel {
  width: min(640px, 92vw);
  aspect-ratio: 8 / 5;
  background: #000;
  border: 2px solid #333;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  box-sizing: border-box;
}

.error {
  margin-top: 1rem;
  color: #f66;
  max-width: 640px;
  white-space: pre-wrap;
}

.saved-world-card {
  margin-top: 1rem;
  background: #102118;
  border: 1px solid #285438;
  padding: 0.75rem 1rem;
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.saved-world-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.saved-world-tag {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.saved-world-badge {
  background: #194d34;
  border: 1px solid #339966;
  color: #66ffaa;
  font-size: 0.65rem;
  font-weight: bold;
  padding: 0.15rem 0.4rem;
  border-radius: 2px;
  letter-spacing: 0.05em;
}

.saved-world-title {
  color: #fff;
  font-weight: bold;
  font-size: 0.85rem;
}

.saved-world-time {
  color: #8bbfa3;
  font-size: 0.75rem;
}

.ai-connect {
  margin-top: 24px;
  color: #b9cdce;
  font:
    14px/1.5 system-ui,
    sans-serif;
}
.ai-connect p {
  margin: 0 0 12px;
}
.assistant-connect {
  margin-top: 12px;
}
.saved-game-heading {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  margin: 0 0 4px;
}
.saved-game-card .saved-game-heading .saved-world-title {
  margin: 0;
  flex: 1;
}
/* Centre the 44px button on the first title line rather than on the whole title. */
.rename-icon {
  margin: calc((19px * 1.25 - 44px) / 2) 0;
  color: #91b9bc;
  background: transparent;
}
.rename-icon:hover {
  color: var(--ui-action);
  background: #14282a;
}
.saved-game-play-row {
  display: flex;
  gap: 8px;
  width: 100%;
  margin-top: 14px;
}
.saved-game-card .saved-game-play-row > .ui-button {
  flex: 1;
  min-width: 0;
}
.game-rename {
  width: 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.game-rename label {
  width: 100%;
  color: #bce3d0;
}

.game-rename input {
  flex: 1 1 14rem;
  min-width: 0;
  padding: 0.6rem;
  color: #fff;
  background: #081910;
  border: 1px solid #579873;
  border-radius: 4px;
  font: inherit;
}
</style>
