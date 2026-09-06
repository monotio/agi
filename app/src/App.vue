<script setup lang="ts">
import AgentTaskControls from "./AgentTaskControls.vue";
import AiSettingsDialog from "./AiSettings.vue";
import SoundPreview from "./SoundPreview.vue";
import TouchControls from "./TouchControls.vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  useEngine,
  readAutosave,
  lastGameSlug,
  type Frame,
  type AutosaveRecord,
} from "./useEngine.ts";
import { AgiStage } from "./three/AgiStage.ts";
import { FRAME_HEIGHT, FRAME_WIDTH, compositeFrame } from "./composite.ts";
import { GLYPH_CURSOR, TEXT_COLS } from "../../src/runtime/textSurface.ts";
import { BUILTIN_CARTRIDGES, parseCustomCartridge, type CartridgeMetadata } from "./cartridges.ts";
import {
  DEFAULT_MODELS,
  MODEL_OPTIONS,
  type LlmConfig,
  type ProviderType,
} from "./agent/llmClient.ts";
import {
  getCachedCartridgeMeta,
  clearCachedCartridge,
  loadAuthoredCartridge,
  listCachedCartridges,
  renameAuthoredCartridge,
  reconcileCartridgeIndex,
  updateCartridgePreview,
  type CachedCartridgeMeta,
} from "./cartridgeStorage.ts";
import { buildProjectZip, buildPublicGameZip } from "./projectArchive.ts";
import { MAX_GAME_ZIP_BYTES, readGameFiles, readGameZip, type OpenedGame } from "./gameZip.ts";
import { captureGameDrop } from "./gameDrop.ts";
import { GAME_CATALOG, type GameCatalogEntry } from "./gameCatalog.ts";
import { loadHostedCatalog } from "./hostedCatalog.ts";
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
import { copyAiSettings, loadAiSettings, saveAiSettings, type AiSettings } from "./aiSettings.ts";

const canvas = ref<HTMLCanvasElement | null>(null);
const testMode = import.meta.env.MODE === "test";
const gpuCanvas = ref<HTMLCanvasElement | null>(null);
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
const gpuBackend = ref<string | null>(null);
const crtEnabled = ref<boolean>(localStorage.getItem("monotio_agi.crt") !== "off");
let stage: AgiStage | null = null;
let lastFrame: Frame | null = null;
/** Composed 320x200 RGBA frame shared by the probe canvas and the GPU stage. */
const composed = new Uint8ClampedArray(FRAME_WIDTH * FRAME_HEIGHT * 4);

watch(crtEnabled, (on) => {
  localStorage.setItem("monotio_agi.crt", on ? "on" : "off");
  if (stage) stage.crt = on;
});
const heldMovementKeys = new Set<string>();
let touchMovementActive = false;

// Cartridge and LLM state
const savedWorlds = ref(listCachedCartridges());
const selectedCartridgeSlug = ref<string>(
  lastGameSlug() ?? savedWorlds.value[0]?.slug ?? "knights-trial",
);
const zipInput = ref<HTMLInputElement | null>(null);
const folderInput = ref<HTMLInputElement | null>(null);
const openGameMenuEl = ref<HTMLDivElement | null>(null);
const openGameButtonEl = ref<HTMLButtonElement | null>(null);
const openGameMenuOpen = ref(false);
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
      !savedWorlds.value.some(
        (world) =>
          world.library?.catalog?.id === entry.id &&
          world.library.catalog.version === entry.version,
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
const creationSlug = ref("");
const adventureDrafts = ref<Record<string, { title: string; brief: string; frontmatter: string }>>({
  ...Object.fromEntries(
    BUILTIN_CARTRIDGES.map((cart) => {
      const frontmatter = cart.rawMarkdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0] ?? "";
      return [
        cart.slug,
        {
          title: cart.title,
          brief: cart.rawMarkdown.slice(frontmatter.length).trimStart(),
          frontmatter,
        },
      ];
    }),
  ),
  custom: { title: "", brief: "", frontmatter: "---\nname: custom\n---\n" },
});
const adventureDraft = computed(
  () => adventureDrafts.value[creationSlug.value] ?? adventureDrafts.value["custom"]!,
);
const cachedMeta = ref<CachedCartridgeMeta | null>(
  getCachedCartridgeMeta(selectedCartridgeSlug.value),
);
const renaming = ref(false);
const expandedGameSlug = ref<string | null>(null);
const cartridgeTitle = ref("");
const renameError = ref("");
const titleInput = ref<HTMLInputElement | null>(null);
const createDetails = ref<HTMLDetailsElement | null>(null);
const createSummary = ref<HTMLElement | null>(null);
const createButton = ref<HTMLButtonElement | null>(null);
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
    [...savedWorlds.value.map((world) => world.slug), ...(state.installedGames ?? [])].flatMap(
      (slug) => {
        const autosave = readAutosave(slug);
        return autosave ? [[slug, autosave]] : [];
      },
    ),
  ),
);

function selectLibraryWorld(world: CachedCartridgeMeta): void {
  selectedCartridgeSlug.value = world.slug;
  cachedMeta.value = world;
}

async function beginRename(world?: CachedCartridgeMeta): Promise<void> {
  if (world) selectLibraryWorld(world);
  cartridgeTitle.value = cachedMeta.value?.title ?? "";
  renameError.value = "";
  renaming.value = true;
  await nextTick();
  titleInput.value?.focus();
  titleInput.value?.select();
}

function setTitleInput(element: unknown): void {
  titleInput.value = element instanceof HTMLInputElement ? element : null;
}

async function saveCartridgeTitle(): Promise<void> {
  if (!(await renameAuthoredCartridge(selectedCartridgeSlug.value, cartridgeTitle.value))) {
    renameError.value = "Could not save the name. Use 1–100 characters and try again.";
    return;
  }
  cachedMeta.value = getCachedCartridgeMeta(selectedCartridgeSlug.value);
  savedWorlds.value = listCachedCartridges();
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

function onGameDetailsToggle(slug: string, event: Event): void {
  const details = event.currentTarget as HTMLDetailsElement;
  if (details.open) {
    expandedGameSlug.value = slug;
    const world = savedWorlds.value.find((entry) => entry.slug === slug);
    if (world) selectLibraryWorld(world);
  } else if (expandedGameSlug.value === slug) {
    expandedGameSlug.value = null;
    renaming.value = false;
  }
}

const savedBudget = Number(localStorage.getItem("monotio_agi.taskBudget") ?? 5);
const taskBudget = ref(Number.isFinite(savedBudget) && savedBudget > 0 ? savedBudget : 5);
watch(taskBudget, (value) => {
  if (Number.isFinite(value) && value > 0)
    localStorage.setItem("monotio_agi.taskBudget", String(value));
});
const aiSettings = ref(loadAiSettings(localStorage, DEFAULT_MODELS, testMode));
const provider = ref<ProviderType>(aiSettings.value.provider);
const apiKey = ref(aiSettings.value.profiles[provider.value].apiKey);
const model = ref(aiSettings.value.profiles[provider.value].model);
const effort = ref(aiSettings.value.profiles[provider.value].effort);
const aiConfigured = computed(() => provider.value === "stub" || apiKey.value.trim().length > 0);
const aiSettingsStatus = computed(() =>
  aiConfigured.value
    ? provider.value === "stub"
      ? "Offline test provider"
      : `${provider.value === "openai" ? "OpenAI" : "Anthropic"} · Key saved`
    : `${provider.value === "openai" ? "OpenAI" : "Anthropic"} · Not configured`,
);

watch(selectedCartridgeSlug, (slug) => {
  cachedMeta.value = getCachedCartridgeMeta(slug);
  renaming.value = false;
});

const activeCartridge = computed<CartridgeMetadata>(() => {
  const brief = adventureDraft.value.brief.trim();
  const title = adventureDraft.value.title.trim() || "Untitled adventure";
  try {
    const parsed = parseCustomCartridge(
      /^---\r?\n/.test(brief) ? brief : `${adventureDraft.value.frontmatter}\n${brief}`,
    );
    return adventureDraft.value.title.trim() ? { ...parsed, title } : parsed;
  } catch {
    return {
      slug: creationSlug.value || "custom",
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
  bootCartridgeGame,
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
  resumeLastGame,
  resumeFromRecord,
  startOver,
  flushAutosave,
  lastAutosaveRecord,
  shutdownEngine,
  pauseEngine,
  resumeEngine,
  updateAiConfig,
} = useEngine((frame) => {
  lastFrame = frame;
  present(frame);
});

const aiSettingsDialog = ref<InstanceType<typeof AiSettingsDialog> | null>(null);
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

async function applyAiSettings(settings: AiSettings): Promise<void> {
  aiSettingsSaving.value = true;
  aiSettingsError.value = "";
  try {
    saveAiSettings(localStorage, settings);
    aiSettings.value = copyAiSettings(settings);
    provider.value = settings.provider;
    model.value = settings.profiles[settings.provider].model;
    apiKey.value = settings.profiles[settings.provider].apiKey;
    effort.value = settings.profiles[settings.provider].effort;
    await updateAiConfig(llmConfig());
    if (aiSettingsContext.value === "assistant" && state.powerUp.open)
      await openPowerUp(llmConfig());
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
  nextTick(() => returnFocus?.focus());
}

watch(
  () => state.powerUp.busy,
  (busy) => {
    if (busy) return;
    const game = currentGame();
    if (game && !game.installed) {
      selectedCartridgeSlug.value = game.slug;
      cachedMeta.value = getCachedCartridgeMeta(game.slug);
      savedWorlds.value = listCachedCartridges();
    }
  },
);

const expandedLogIds = ref<Set<string>>(new Set());
const copyFeedback = ref<string>("");
/** Download failures are visible in both the picker and the game. */
const exportRefusal = ref<string>("");
const exportBusy = ref(false);

/**
 * Autosave the picker can offer. The app
 * resumes it by itself on load; this is what is left when it could not — the
 * boot failed, or the player ejected back to the picker — plus the way to
 * throw it away and start the game from the beginning.
 */
const pendingAutosave = ref<AutosaveRecord | null>(null);
const hasLibraryContent = computed(
  () =>
    savedWorlds.value.length > 0 ||
    availableCatalogEntries.value.length > 0 ||
    Boolean(state.installedGames?.length) ||
    pendingAutosave.value !== null,
);
const createOpen = computed(() =>
  createPreference.value === "open"
    ? true
    : createPreference.value === "closed"
      ? false
      : savedWorlds.value.length === 0 && pendingAutosave.value === null,
);

const localGameSlugs = computed(() =>
  (state.installedGames ?? []).filter(
    (slug) => !savedWorlds.value.some((world) => world.slug === slug),
  ),
);
const TUTORIAL_SECTION_KEY = "monotio_agi.tutorial";
const tutorialPreference = ref<"open" | "closed" | null>(null);
try {
  const stored = localStorage.getItem(TUTORIAL_SECTION_KEY);
  if (stored === "open" || stored === "closed") tutorialPreference.value = stored;
} catch {
  /* Use the first-visit default when storage is blocked. */
}
const hasOwnGames = computed(
  () =>
    savedWorlds.value.some((world) => world.library?.catalog?.id !== featuredCatalog.id) ||
    pendingAutosave.value?.game.installed === true,
);
const tutorialOpen = computed(
  () =>
    tutorialPreference.value === "open" ||
    (tutorialPreference.value === null && !hasOwnGames.value),
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
    if (own && tutorialPreference.value === null) setTutorialOpen(false);
  },
  { immediate: true },
);

async function onPlayLocalGame(slug: string): Promise<void> {
  await resumeAudio();
  const checkpoint = readAutosave(slug);
  if (checkpoint) await resumeFromRecord(checkpoint, llmConfig());
  else await bootGame(slug);
}

function refreshPendingAutosave(): void {
  const slug = lastGameSlug();
  pendingAutosave.value = slug ? readAutosave(slug) : null;
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
  const slug = currentGame()?.slug ?? pendingAutosave.value?.game.slug ?? lastGameSlug();
  if (!slug) return;
  await resumeAudio();
  await startOver(slug, llmConfig());
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
  const bundle = {
    exportedAt: new Date().toISOString(),
    cartridge: {
      slug: activeCartridge.value.slug,
      title: activeCartridge.value.title,
    },
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

async function onBootSelectedCartridge(): Promise<void> {
  if (!creationSlug.value || !adventureDraft.value.brief.trim()) return;
  if (provider.value !== "stub" && !apiKey.value.trim()) {
    openAiSettings(null, "create");
    return;
  }
  await resumeAudio();
  await bootCartridgeGame(activeCartridge.value.rawMarkdown, llmConfig(), {
    slug: activeCartridge.value.slug,
    title: activeCartridge.value.title,
    useCached: false,
  });
  const game = currentGame();
  if (game && !game.installed) selectedCartridgeSlug.value = game.slug;
  cachedMeta.value = getCachedCartridgeMeta(selectedCartridgeSlug.value);
}

async function onBootSavedCartridge(alreadyBusy = false): Promise<void> {
  if (libraryActionBusy.value && !alreadyBusy) return;
  if (!alreadyBusy) libraryActionBusy.value = true;
  libraryActionError.value = "";
  try {
    await resumeAudio();
    await bootCartridgeGame(activeCartridge.value.rawMarkdown, llmConfig(), {
      slug: selectedCartridgeSlug.value,
      title: cachedMeta.value?.title ?? selectedCartridgeSlug.value,
      useCached: true,
    });
  } catch (error) {
    libraryActionError.value = String(error).replace(/^Error: /, "");
  } finally {
    if (!alreadyBusy) libraryActionBusy.value = false;
  }
}

async function onClearSavedCartridge(): Promise<void> {
  await clearCachedCartridge(selectedCartridgeSlug.value);
  refreshLibrary();
}

function refreshLibrary(slug?: string): void {
  savedWorlds.value = listCachedCartridges();
  if (slug) {
    selectedCartridgeSlug.value = slug;
    expandedGameSlug.value = slug;
  } else if (!savedWorlds.value.some((entry) => entry.slug === selectedCartridgeSlug.value))
    selectedCartridgeSlug.value = savedWorlds.value[0]?.slug ?? "";
  cachedMeta.value = selectedCartridgeSlug.value
    ? getCachedCartridgeMeta(selectedCartridgeSlug.value)
    : null;
}

async function onPlayLibraryWorld(world: CachedCartridgeMeta): Promise<void> {
  selectLibraryWorld(world);
  const autosave = readAutosave(world.slug);
  if (!autosave) {
    await onBootSavedCartridge();
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

async function onStartLibraryWorldOver(world: CachedCartridgeMeta): Promise<void> {
  selectLibraryWorld(world);
  await resumeAudio();
  await startOver(world.slug, llmConfig());
}

async function onCheckLibraryWorld(world: CachedCartridgeMeta): Promise<void> {
  selectLibraryWorld(world);
  await checkSelectedOpening();
}

async function onCopyLibraryWorld(world: CachedCartridgeMeta): Promise<void> {
  selectLibraryWorld(world);
  await copySelectedGame();
}

async function onExportLibraryWorld(world: CachedCartridgeMeta, project = false): Promise<void> {
  selectLibraryWorld(world);
  await onExportAgiZip(false, project);
}

async function onRemoveLibraryWorld(world: CachedCartridgeMeta): Promise<void> {
  selectLibraryWorld(world);
  await onClearSavedCartridge();
}

function closeOpenGameMenu(restoreFocus = false): void {
  openGameMenuOpen.value = false;
  if (restoreFocus) nextTick(() => openGameButtonEl.value?.focus());
}

function onOpenGameMenuFocusout(): void {
  nextTick(() => {
    if (
      openGameMenuOpen.value &&
      document.activeElement instanceof Node &&
      !openGameMenuEl.value?.contains(document.activeElement)
    )
      closeOpenGameMenu();
  });
}

async function openGameMenu(focus: "first" | "last" | false = false): Promise<void> {
  openGameMenuOpen.value = true;
  if (!focus) return;
  await nextTick();
  const items = openGameMenuEl.value?.querySelectorAll<HTMLButtonElement>("[role='menuitem']");
  if (!items?.length) return;
  (focus === "first" ? items[0] : items[items.length - 1])?.focus();
}

function onOpenGameMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeOpenGameMenu(true);
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [
    ...(openGameMenuEl.value?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? []),
  ];
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowUp"
          ? (current - 1 + items.length) % items.length
          : (current + 1) % items.length;
  items[next]?.focus();
}

async function stageLibraryGame(
  game: OpenedGame,
  title: string,
  source: "zip" | "folder",
): Promise<void> {
  const opening = await previewGame(game);
  const slug = await addLibraryGame(game, game.title ?? title, source, opening);
  refreshLibrary(slug);
}

async function onGameZip(file?: File): Promise<void> {
  if (!file || importBusy.value) return;
  importBusy.value = true;
  importError.value = "";
  importNotice.value = "";
  try {
    if (file.size > MAX_GAME_ZIP_BYTES) throw new Error("Choose a game ZIP smaller than 128 MB.");
    const game = await readGameZip(new Uint8Array(await file.arrayBuffer()));
    await stageLibraryGame(game, file.name.replace(/\.zip$/i, ""), "zip");
    importNotice.value = `${game.title ?? file.name.replace(/\.zip$/i, "")} is checked and ready to play.`;
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
    await stageLibraryGame(game, title, "folder");
    importNotice.value = `${game.title ?? title} is checked and ready to play.`;
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
    const slug = await addLibraryGame(game, entry.title, "catalog", opening, {
      id: entry.id,
      version: entry.version,
    });
    refreshLibrary(slug);
    await onBootSavedCartridge(true);
  } catch (error) {
    libraryActionError.value = String(error).replace(/^Error: /, "");
  } finally {
    libraryActionBusy.value = false;
  }
}

async function checkSelectedOpening(): Promise<void> {
  if (libraryActionBusy.value) return;
  const selectedSlug = selectedCartridgeSlug.value;
  libraryActionError.value = "";
  libraryActionBusy.value = true;
  try {
    const game = await loadAuthoredCartridge(selectedSlug);
    if (!game) throw new Error("This game is no longer in your library. Import it again.");
    const opening = await previewGame(game);
    const revision = game.library?.revision ?? (await gameRevision(game.files));
    if (!(await updateCartridgePreview(game.slug, revision, opening.preview, opening)))
      throw new Error("The game changed while its opening was being checked. Try again.");
    refreshLibrary(selectedCartridgeSlug.value === selectedSlug ? game.slug : undefined);
  } catch (error) {
    libraryActionError.value = String(error).replace(/^Error: /, "");
  } finally {
    libraryActionBusy.value = false;
  }
}

async function copySelectedGame(): Promise<void> {
  if (libraryActionBusy.value) return;
  const selectedSlug = selectedCartridgeSlug.value;
  libraryActionError.value = "";
  libraryActionBusy.value = true;
  try {
    refreshLibrary(await copyLibraryGame(selectedSlug));
  } catch (error) {
    libraryActionError.value = String(error).replace(/^Error: /, "");
  } finally {
    libraryActionBusy.value = false;
  }
}

async function onExportAgiZip(live = false, project = false): Promise<void> {
  exportRefusal.value = "";
  exportBusy.value = true;
  try {
    const data = live
      ? await exportCurrentGame()
      : await loadAuthoredCartridge(selectedCartridgeSlug.value);
    if (!data) throw new Error("No saved world is available.");
    const zipBytes = project ? await buildProjectZip(data) : buildPublicGameZip(data);
    const url = URL.createObjectURL(new Blob([zipBytes], { type: "application/zip" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `agi-${data.slug}-${project ? "project" : "game"}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    exportRefusal.value = `Download failed: ${String(error).replace(/^Error: /, "")}`;
  } finally {
    exportBusy.value = false;
  }
}

/**
 * Present one engine frame: compose picture band + text cells into the
 * 320x200 frame, draw it on the 2D probe canvas (Playwright pixel probe and
 * no-GPU fallback) and upload it to the GPU stage when one exists.
 */
function present(frame: Frame, textOverride?: Uint8Array): void {
  compositeFrame(
    { visual: frame.visual, text: textOverride ?? frame.text, picRow: frame.picRow },
    composed,
  );
  const ctx = canvas.value?.getContext("2d");
  if (ctx) {
    const img = ctx.createImageData(FRAME_WIDTH, FRAME_HEIGHT);
    img.data.set(composed);
    ctx.putImageData(img, 0, 0);
  }
  stage?.render(composed);
}

const hasKeyPrompt = computed(() =>
  state.rows.some((r) => r.toLowerCase().includes("press any key")),
);

function onScreenClick(): void {
  resumeAudio();
  if (state.phase !== "running") return;
  if (state.prompt) {
    inputEl.value?.focus();
    return;
  }
  if (state.modal !== null) {
    if (state.modal === "save" || state.modal === "restore") return;
    dismissModal();
    if (!touchControls.value) inputEl.value?.focus();
    return;
  }
  // Empty Enter (0x000d) wakes have.key() e.g. title screens or prompts
  sendKey(0x000d);
  if (!state.textMode && !touchControls.value) inputEl.value?.focus();
}

watch(
  () => state.phase,
  (phase) => {
    if (phase === "running" && !touchControls.value) {
      nextTick(() => {
        inputEl.value?.focus();
      });
    }
  },
);

const inputEl = ref<HTMLInputElement | null>(null);
const controlsEl = ref<HTMLDetailsElement | null>(null);
const settingsEl = ref<HTMLDetailsElement | null>(null);
const savingEl = ref<HTMLDetailsElement | null>(null);

function closeNavMenus(restoreFocus = false): void {
  for (const menu of [controlsEl.value, settingsEl.value, savingEl.value]) {
    if (!menu?.open) continue;
    menu.open = false;
    if (restoreFocus) menu.querySelector("summary")?.focus();
  }
}

function onNavToggle(event: Event): void {
  const current = event.target as HTMLDetailsElement;
  if (!current.open) return;
  for (const menu of [controlsEl.value, settingsEl.value, savingEl.value]) {
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
  for (const menu of [controlsEl.value, settingsEl.value, savingEl.value]) {
    if (event.target instanceof Node && menu && !menu.contains(event.target)) menu.open = false;
  }
  if (
    openGameMenuOpen.value &&
    event.target instanceof Node &&
    !openGameMenuEl.value?.contains(event.target)
  )
    closeOpenGameMenu();
}

function triggerKey(code: number): void {
  resumeAudio();
  closeNavMenus();
  sendKey(code);
  if (!touchControls.value) inputEl.value?.focus();
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
    if (prompt) echoPrompt();
  },
);

function echoPrompt(): void {
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
  if (state.waitingForKey || state.modal === "save" || state.modal === "restore") {
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
      ? 0x000d
      : ev.key === "Escape"
        ? 0x001b
        : ev.key === "Home"
          ? 0x4700
          : ev.key === "End"
            ? 0x4f00
            : ev.key === "PageUp"
              ? 0x4900
              : ev.key === "PageDown"
                ? 0x5100
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
const powerUpEl = ref<HTMLTextAreaElement | null>(null);

/** The live tool-call feed for this remix turn: the transcript tail. */
const asking = computed(() => state.powerUp.mode === "ask");
const creatingRoom = computed(() => state.powerUp.mode === "room");
const powerUpFeed = computed(() => state.agentLog.slice(state.powerUp.feedStart));
const powerUpAudio = computed(() => powerUpFeed.value.flatMap((entry) => entry.audio ?? []));
const latestAgentAudio = computed(
  () => [...state.agentLog].reverse().find((entry) => entry.audio?.length)?.audio ?? [],
);

const conversationEl = ref<HTMLDivElement | null>(null);
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
const progressFeedEl = ref<HTMLDivElement | null>(null);
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
    else if (!open && wasOpen && creatingRoom.value) inputEl.value?.focus();
  },
);
watch(progressFeedEl, (el, _previous, cleanup) => {
  if (!el) return;
  const observer = new ResizeObserver(() => {
    if (followProgress.value) el.scrollTop = el.scrollHeight;
  });
  observer.observe(el);
  cleanup(() => observer.disconnect());
});

async function onPowerUp(): Promise<void> {
  if (state.powerUp.busy) return;
  if (state.powerUp.open) {
    closePowerUp();
    inputEl.value?.focus();
    return;
  }
  powerUpLine.value = "";
  await openPowerUp(llmConfig());
  await nextTick();
  powerUpEl.value?.focus();
}

async function onPowerUpSubmit(): Promise<void> {
  const text = powerUpLine.value.trim();
  if (text.length === 0 || state.powerUp.busy) return;
  followProgress.value = true;
  powerUpLine.value = "";
  await submitPowerUp(text);
  if (!state.powerUp.open) inputEl.value?.focus();
  else {
    await nextTick();
    powerUpEl.value?.focus();
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
  inputEl.value?.focus();
}

function onGlobalKeydown(ev: KeyboardEvent): void {
  resumeAudio();
  if (state.phase !== "running") return;
  if (ev.isComposing || ev.keyCode === 229) return;
  if (ev.target instanceof Element && ev.target.closest("dialog[open]")) return;
  // The bubble owns the keyboard while it is open: the world is frozen and
  // nothing typed here may reach the interpreter's input line.
  if (state.powerUp.open) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closePowerUp();
      if (!state.powerUp.open) inputEl.value?.focus();
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
  if (state.modal !== null) {
    onModalKey(ev);
    return;
  }

  // Text screens can ask a specific question: preserve the actual key.
  if (state.textMode || state.waitingForKey) {
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
      // The key goes to the engine as a key event AND into the input line.
      // have.key() blocks the worker on the host's waitKey in graphics mode as
      // well as in text mode (a "press any key" title screen), so a letter has
      // to wake it; sendKey resolves that wait when one is pending and
      // otherwise delivers a normal key event. The edit message follows and
      // overwrites the engine's edit line with the host's, so the character is
      // never doubled.
      sendKey(ev.key.charCodeAt(0));
      input?.focus();
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
  if (state.phase === "running") {
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
    sendKey([0, 0x4800, 0x4900, 0x4d00, 0x5100, 0x5000, 0x4f00, 0x4b00, 0x4700][dir]!);
  else sendDirection(dir);
}

function onVirtualKey(code: number): void {
  resumeAudio();
  if (state.phase !== "running" || state.powerUp.open || composing.value) return;
  if (state.prompt) {
    if (code === 13 || code === 27) {
      submitPrompt(code === 27 ? "" : promptLine.value, code === 27);
    } else if (code === 8) {
      promptLine.value = promptLine.value.slice(0, -1);
      echoPrompt();
    } else if (
      code >= 32 &&
      code <= 126 &&
      promptLine.value.length < Math.min(39, state.prompt.maxLen)
    ) {
      const char = String.fromCharCode(code);
      if (state.prompt.kind !== "getnum" || /[0-9]/.test(char)) promptLine.value += char;
      echoPrompt();
    }
    return;
  }
  if (
    state.modal !== null ||
    state.textMode ||
    state.waitingForKey ||
    !state.inputEnabled ||
    state.controls.some((binding) => binding.key === code)
  ) {
    sendKey(code);
  } else if (code === 13) submit();
  else if (code === 8 || (code >= 32 && code <= 126)) {
    inputLine.value =
      code === 8 ? inputLine.value.slice(0, -1) : inputLine.value + String.fromCharCode(code);
    sendEdit(inputLine.value);
  } else sendKey(code);
}

function releaseMovement(): void {
  if (heldMovementKeys.size) sendDirection(0);
  heldMovementKeys.clear();
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
    await reconcileCartridgeIndex();
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
  // Nobody loses progress to a reload: whatever was being played comes back
  // by itself, restored from the last autosave. The picker only appears when
  // there is nothing to resume.
  // A hot module update hands the running game over in memory: no reload
  // happened, so there is nothing to read back and the resume is instant.
  const handover = import.meta.hot?.data?.["monotio_agi_resume"] as AutosaveRecord | undefined;
  if (import.meta.hot?.data) delete import.meta.hot.data["monotio_agi_resume"];
  refreshPendingAutosave();
  if (handover) await resumeFromRecord(handover, llmConfig());
  else if (pendingAutosave.value) await resumeLastGame(llmConfig());
  if (gpuCanvas.value) {
    stage = await AgiStage.create(gpuCanvas.value);
    gpuBackend.value = stage?.backend ?? null;
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
  releaseAgentAudioPreviews();
  // Development only: this instance is being replaced by a hot update, and its
  // worker would otherwise keep ticking (and autosaving) behind the new one.
  if (import.meta.hot) shutdownEngine();
});

// Back at the picker (the player ejected, or a boot failed): re-read what is
// left in the autosave slot so the offer below matches storage.
watch(
  () => state.phase,
  (phase) => {
    if (phase === "idle" || phase === "error") {
      refreshPendingAutosave();
      savedWorlds.value = listCachedCartridges();
      cachedMeta.value = getCachedCartridgeMeta(selectedCartridgeSlug.value);
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
      <button
        v-if="state.phase === 'idle' || state.phase === 'error' || state.phase === 'running'"
        type="button"
        class="audio-btn ai-settings-trigger"
        data-testid="open-ai-settings"
        :disabled="aiSettingsUnavailable"
        @click="openAiSettings($event, 'header')"
      >
        AI settings
      </button>
      <a
        v-if="state.phase === 'idle' || state.phase === 'error'"
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
      <nav v-if="state.phase === 'running'" class="game-nav" aria-label="Game options">
        <details
          ref="controlsEl"
          class="game-controls nav-menu"
          data-testid="game-controls"
          @keydown.esc.prevent.stop="closeNavMenus(true)"
          @toggle="onNavToggle"
        >
          <summary class="audio-btn">Controls</summary>
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
        <details
          ref="settingsEl"
          class="nav-menu"
          data-testid="sound-display-menu"
          @toggle="onNavToggle"
          @keydown.esc.prevent.stop="closeNavMenus(true)"
        >
          <summary class="audio-btn">Settings</summary>
          <div class="game-controls-panel settings-panel">
            <button
              type="button"
              class="game-shortcut"
              :aria-pressed="touchControls"
              data-testid="toggle-touch-controls"
              @click="touchControls = !touchControls"
            >
              <span>Touch controls<small>Directions, keyboard and game keys</small></span>
              <span class="setting-value">{{ touchControls ? "On" : "Off" }}</span>
            </button>
            <button
              class="game-shortcut"
              data-testid="toggle-mute"
              :aria-pressed="!state.soundMuted"
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
              class="game-shortcut"
              data-testid="toggle-sound-mode"
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
              class="game-shortcut"
              :aria-pressed="crtEnabled"
              data-testid="toggle-crt"
              @click="crtEnabled = !crtEnabled"
            >
              <span>CRT display<small>Scanlines, glow and curved glass</small></span>
              <span class="setting-value">{{ crtEnabled ? "On" : "Off" }}</span>
            </button>
          </div>
        </details>
        <details
          ref="savingEl"
          class="nav-menu"
          data-testid="save-share-menu"
          @toggle="onNavToggle"
          @keydown.esc.prevent.stop="closeNavMenus(true)"
        >
          <summary class="audio-btn">Save &amp; share</summary>
          <div class="game-controls-panel settings-panel">
            <p class="controls-hint">
              Your progress saves in this browser. Downloads let you keep or share the game.
            </p>
            <button
              v-if="state.phase === 'running'"
              class="game-shortcut"
              data-testid="btn-export-live-zip"
              :disabled="exportBusy || state.powerUp.busy"
              title="Share a playable game. Your authoring conversation stays private."
              @click="onExportAgiZip(true)"
            >
              <span
                >{{ exportBusy ? "Exporting…" : "Export game"
                }}<small>A playable ZIP to share</small></span
              >
            </button>
            <button
              v-if="state.phase === 'running'"
              class="game-shortcut"
              data-testid="btn-save-live-project"
              :disabled="exportBusy || state.powerUp.busy"
              title="Continue creating with your conversation history and authoring sources."
              @click="onExportAgiZip(true, true)"
            >
              <span>Save project<small>Your game, sources and conversation</small></span>
            </button>
            <button
              type="button"
              class="game-shortcut"
              data-testid="btn-start-over"
              title="Discard the autosave and play this game from the beginning"
              @click="onStartOver"
            >
              <span>Start over<small>Begin this adventure again</small></span>
            </button>
          </div>
        </details>
        <button
          v-if="state.phase === 'running'"
          class="audio-btn eject-btn"
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
      :models="MODEL_OPTIONS"
      :allow-stub="testMode"
      :saving="aiSettingsSaving"
      :error="aiSettingsError"
      @save="applyAiSettings"
      @closed="onAiSettingsClosed"
    />
    <p v-if="exportRefusal" class="export-refusal" data-testid="export-refusal" role="alert">
      {{ exportRefusal }}
    </p>

    <section
      v-if="state.phase === 'idle' || state.phase === 'error'"
      class="welcome"
      aria-labelledby="welcome-title"
    >
      <p class="welcome-kicker">Adventure Game Interpreter</p>
      <h1 id="welcome-title">AGI IS HERE<span>.</span></h1>
      <p class="welcome-line">Dream it. Play it. Remix it.</p>
      <nav class="menu-jumps" aria-label="Start an adventure">
        <button
          type="button"
          class="hero-play"
          data-testid="hero-play-now"
          :disabled="catalogBusy[featuredCatalog.id] || libraryActionBusy"
          @click="
            catalogErrors[featuredCatalog.id]
              ? loadCatalogOpening(featuredCatalog.id)
              : playCatalogGame(featuredCatalog.id)
          "
        >
          {{
            catalogErrors[featuredCatalog.id]
              ? "Retry tutorial preview"
              : catalogBusy[featuredCatalog.id]
                ? "Checking opening…"
                : "Play now"
          }}
        </button>
        <a class="hero-create" href="#create-adventure" @click.prevent="openCreateSection()">
          Create an adventure
        </a>
        <a class="hero-create" :href="hasLibraryContent ? '#your-games' : '#open-game'">
          Play existing game
        </a>
      </nav>
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
        class="catalog-heading"
        data-testid="tutorial-toggle"
        @click.prevent="setTutorialOpen(!tutorialOpen)"
      >
        <div>
          <p class="welcome-kicker">Ready to play · no API key</p>
          <h2 id="catalog-title">Play the tutorial</h2>
        </div>
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
          <p class="saved-world-badge">FEATURED GAME</p>
          <h3>{{ entry.title }}</h3>
          <p class="catalog-version">Version {{ entry.version }}</p>
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
            class="saved-action-btn"
            :disabled="catalogBusy[entry.id]"
            @click="loadCatalogOpening(entry.id)"
          >
            Retry preview
          </button>
          <button
            v-else
            type="button"
            class="boot-btn primary-btn"
            :data-testid="`catalog-play-${entry.id}`"
            :disabled="catalogBusy[entry.id] || libraryActionBusy"
            @click="playCatalogGame(entry.id)"
          >
            {{ catalogBusy[entry.id] ? "Checking opening…" : "Play now" }}
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
          data-testid="create-adventure-toggle"
          @click.prevent="onCreateSummaryActivate"
        >
          <span>Create a new adventure</span>
          <small>Choose a template and describe your adventure</small>
        </summary>
        <!-- Cartridge Selector -->
        <section class="section">
          <div class="cartridge-grid">
            <button
              v-for="cart in BUILTIN_CARTRIDGES"
              :key="cart.slug"
              class="cartridge-card"
              :class="{ selected: creationSlug === cart.slug }"
              :aria-pressed="creationSlug === cart.slug"
              :data-testid="`cartridge-${cart.slug}`"
              @click="creationSlug = cart.slug"
            >
              <span class="cartridge-title">{{ cart.title }}</span>
              <span class="cartridge-desc">{{ cart.description }}</span>
            </button>
            <button
              class="cartridge-card custom-card"
              :class="{ selected: creationSlug === 'custom' }"
              :aria-pressed="creationSlug === 'custom'"
              data-testid="cartridge-custom"
              @click="creationSlug = 'custom'"
            >
              <span class="cartridge-title">Your own adventure</span>
              <span class="cartridge-desc">Write your own premise.</span>
            </button>
          </div>

          <!-- Adventure brief shared by templates and custom games -->
          <div v-if="creationSlug" class="custom-editor">
            <label for="adventure-name">Adventure name</label>
            <input
              id="adventure-name"
              v-model="adventureDraft.title"
              placeholder="Midnight at the Museum"
              maxlength="100"
            />
            <label for="adventure-brief">Adventure brief</label>
            <p id="adventure-brief-help" class="section-intro">
              This Markdown is the starting point for a new game. Edit it, or use it as is. The AI
              creates the rooms, artwork and game logic when you click Create adventure.
            </p>
            <textarea
              id="adventure-brief"
              v-model="adventureDraft.brief"
              aria-label="Adventure brief"
              aria-describedby="adventure-brief-help"
              spellcheck="false"
              placeholder="You are the night guard at a museum where the exhibits come alive. A tiny dinosaur has stolen your keys. Get them back before sunrise.&#10;&#10;Tell us about your hero, the setting, and the trouble they find themselves in."
              rows="8"
              data-testid="custom-cartridge-input"
            />
          </div>
        </section>

        <section class="section create-ai-context" aria-labelledby="create-ai-title">
          <div>
            <h2 id="create-ai-title">AI for this adventure</h2>
            <p>{{ aiSettingsStatus }} · {{ model }}</p>
          </div>
          <button
            type="button"
            class="saved-action-btn"
            data-testid="connect-create-ai"
            :disabled="aiSettingsUnavailable"
            @click="openAiSettings($event, 'create')"
          >
            {{ aiConfigured ? "Change AI settings" : "Connect AI" }}
          </button>
        </section>
        <label class="task-budget"
          >Task budget · USD (estimated)
          <input
            v-model.number="taskBudget"
            type="number"
            min="0.01"
            step="any"
            required
            data-testid="task-budget"
          />
        </label>

        <!-- Launch Buttons -->
        <div class="boot-row">
          <button
            ref="createButton"
            class="boot-btn primary-btn"
            data-testid="boot-cartridge"
            :disabled="!creationSlug || !adventureDraft.brief.trim()"
            @click="onBootSelectedCartridge"
          >
            Create adventure
          </button>
        </div>
      </details>
      <aside
        id="your-games"
        class="library-pane"
        :class="{ 'empty-library': !hasLibraryContent }"
        :aria-labelledby="hasLibraryContent ? 'library-title' : 'open-game-title'"
      >
        <h2 v-if="hasLibraryContent" id="library-title">Your games</h2>
        <h2 v-else id="open-game-title">Open a game</h2>
        <p v-if="libraryActionError" role="alert" class="library-error">
          {{ libraryActionError }}
        </p>
        <div v-if="hostedCatalogError" class="library-error" data-testid="hosted-catalog-error">
          <p role="alert">{{ hostedCatalogError }}</p>
          <button
            type="button"
            class="saved-action-btn"
            :disabled="hostedCatalogBusy"
            @click="refreshHostedCatalog"
          >
            Retry game list
          </button>
        </div>

        <div
          v-if="savedWorlds.length || localGameSlugs.length || availableCatalogEntries.length"
          class="saved-game-gallery"
          data-testid="saved-game-gallery"
        >
          <article
            v-for="world in savedWorlds"
            :key="world.slug"
            class="saved-game-card"
            :class="{ selected: selectedCartridgeSlug === world.slug }"
            :data-testid="`saved-game-card-${world.slug}`"
            :data-slug="world.slug"
          >
            <img
              v-if="libraryAutosaves[world.slug]?.preview || world.library?.preview"
              class="library-thumbnail"
              data-testid="library-thumbnail"
              :data-preview-kind="libraryAutosaves[world.slug]?.preview ? 'progress' : 'opening'"
              :src="libraryAutosaves[world.slug]?.preview ?? world.library?.preview"
              :alt="
                libraryAutosaves[world.slug]?.preview
                  ? `${world.title}, current progress in room ${libraryAutosaves[world.slug]?.room}`
                  : `${world.title} opening scene`
              "
            />
            <div v-else class="saved-game-cover" aria-hidden="true">AGI</div>
            <div class="saved-game-card-body">
              <span class="saved-world-badge">
                {{ libraryAutosaves[world.slug] ? "IN PROGRESS" : "SAVED GAME" }}
              </span>
              <h3 class="saved-world-title" data-testid="saved-game-title">{{ world.title }}</h3>
              <p v-if="world.library?.catalog" class="saved-game-version">
                Version {{ world.library.catalog.version }}
              </p>
              <p v-if="libraryAutosaves[world.slug]" class="saved-world-time">
                Room {{ libraryAutosaves[world.slug]?.room }} · Saved
                {{ new Date(libraryAutosaves[world.slug]!.savedAt).toLocaleString() }}
              </p>
              <p v-else class="saved-world-time">
                {{
                  world.library?.validation.status === "ready"
                    ? "Ready to play"
                    : world.library?.validation.status === "needs-input"
                      ? "Opening needs input"
                      : "Opening not checked"
                }}
              </p>
              <button
                type="button"
                class="boot-btn resume-btn saved-game-primary"
                data-testid="btn-resume-cached"
                :disabled="libraryActionBusy || importBusy"
                @click="onPlayLibraryWorld(world)"
              >
                {{ libraryAutosaves[world.slug] ? "Resume" : "Play" }}
              </button>
              <details
                class="library-details-disclosure"
                :open="expandedGameSlug === world.slug"
                :data-testid="`game-details-${world.slug}`"
                @toggle="onGameDetailsToggle(world.slug, $event)"
              >
                <summary>Details</summary>
                <form
                  v-if="renaming && selectedCartridgeSlug === world.slug"
                  class="cartridge-rename"
                  data-testid="rename-game-form"
                  @submit.prevent="saveCartridgeTitle"
                >
                  <label :for="`cartridge-title-${world.slug}`">Game name</label>
                  <input
                    :id="`cartridge-title-${world.slug}`"
                    :ref="setTitleInput"
                    v-model="cartridgeTitle"
                    maxlength="100"
                    required
                    @keydown.esc="renaming = false"
                  />
                  <button type="submit" class="saved-action-btn" :disabled="!cartridgeTitle.trim()">
                    Save name
                  </button>
                  <button type="button" class="saved-action-btn" @click="renaming = false">
                    Cancel
                  </button>
                  <p v-if="renameError" role="alert">{{ renameError }}</p>
                </form>
                <div v-if="world.library" class="library-details">
                  <p v-if="world.library.description">{{ world.library.description }}</p>
                  <dl>
                    <template v-if="world.library.author">
                      <dt>By</dt>
                      <dd>{{ world.library.author }}</dd>
                    </template>
                    <template v-if="world.library.license">
                      <dt>License</dt>
                      <dd>{{ world.library.license }}</dd>
                    </template>
                    <dt>Opening</dt>
                    <dd>
                      <strong>{{
                        world.library.validation.status === "ready"
                          ? "Ready"
                          : world.library.validation.status === "needs-input"
                            ? "Needs input"
                            : "Not checked"
                      }}</strong>
                      · {{ world.library.validation.message }}
                    </dd>
                    <template v-if="world.library.validation.profile">
                      <dt>Interpreter</dt>
                      <dd>{{ world.library.validation.profile }}</dd>
                    </template>
                  </dl>
                </div>
                <p class="download-help">
                  Save project keeps your conversation and editing history. Export game creates a
                  cartridge to share.
                </p>
                <div class="saved-world-actions">
                  <button
                    v-if="!(renaming && selectedCartridgeSlug === world.slug)"
                    type="button"
                    class="saved-action-btn"
                    data-testid="rename-game"
                    @click="beginRename(world)"
                  >
                    Rename
                  </button>
                  <button
                    v-if="libraryAutosaves[world.slug]"
                    type="button"
                    class="saved-action-btn"
                    data-testid="start-library-game-over"
                    @click="onStartLibraryWorldOver(world)"
                  >
                    Start over
                  </button>
                  <button
                    v-if="world.library?.validation.status === 'unverified'"
                    type="button"
                    class="saved-action-btn"
                    data-testid="check-library-game"
                    :disabled="libraryActionBusy"
                    @click="onCheckLibraryWorld(world)"
                  >
                    Check opening
                  </button>
                  <button
                    type="button"
                    class="saved-action-btn"
                    data-testid="copy-library-game"
                    :disabled="libraryActionBusy"
                    @click="onCopyLibraryWorld(world)"
                  >
                    Make a copy
                  </button>
                  <button
                    type="button"
                    class="saved-action-btn"
                    data-testid="btn-export-agi-zip"
                    title="Share a playable game. Your authoring conversation stays private."
                    :disabled="exportBusy"
                    @click="onExportLibraryWorld(world)"
                  >
                    Export game
                  </button>
                  <button
                    type="button"
                    class="saved-action-btn"
                    title="Continue creating with your conversation history and authoring sources."
                    data-testid="btn-save-project"
                    :disabled="exportBusy"
                    @click="onExportLibraryWorld(world, true)"
                  >
                    Save project
                  </button>
                  <button
                    type="button"
                    class="saved-action-btn danger"
                    data-testid="remove-library-game"
                    @click="onRemoveLibraryWorld(world)"
                  >
                    Remove game
                  </button>
                </div>
              </details>
            </div>
          </article>
          <article
            v-for="slug in localGameSlugs"
            :key="`local-${slug}`"
            class="saved-game-card"
            :data-testid="`local-game-card-${slug}`"
          >
            <img
              v-if="libraryAutosaves[slug]?.preview"
              class="library-thumbnail"
              data-testid="library-thumbnail"
              data-preview-kind="progress"
              :src="libraryAutosaves[slug]?.preview"
              :alt="`${slug.toUpperCase()}, current progress in room ${libraryAutosaves[slug]?.room}`"
            />
            <div v-else class="saved-game-cover" aria-hidden="true">{{ slug.toUpperCase() }}</div>
            <div class="saved-game-card-body">
              <span class="saved-world-badge">{{
                libraryAutosaves[slug] ? "IN PROGRESS" : "AVAILABLE"
              }}</span>
              <h3 class="saved-world-title">{{ slug.toUpperCase() }}</h3>
              <p class="saved-world-time">
                {{
                  libraryAutosaves[slug] ? `Room ${libraryAutosaves[slug]?.room}` : "Ready to play"
                }}
              </p>
              <button
                type="button"
                class="boot-btn resume-btn saved-game-primary"
                :data-testid="`boot-${slug}`"
                :disabled="libraryActionBusy || importBusy"
                @click="onPlayLocalGame(slug)"
              >
                {{ libraryAutosaves[slug] ? "Resume" : "Play" }}
              </button>
              <details v-if="libraryAutosaves[slug]" class="library-details-disclosure">
                <summary>Details</summary>
                <button
                  type="button"
                  class="saved-action-btn"
                  @click="
                    resumeAudio();
                    startOver(slug, llmConfig());
                  "
                >
                  Start over
                </button>
              </details>
            </div>
          </article>
          <article
            v-for="entry in availableCatalogEntries"
            :key="`catalog-${entry.id}-${entry.version}`"
            :ref="(element) => observeCatalogCard(element, entry.id)"
            class="saved-game-card"
            :data-testid="`hosted-game-card-${entry.id}`"
          >
            <img
              v-if="catalogOpenings[entry.id]?.preview"
              class="library-thumbnail"
              :src="catalogOpenings[entry.id]?.preview"
              :alt="`${entry.title} opening scene`"
            />
            <div v-else class="saved-game-cover" aria-hidden="true">AGI</div>
            <div class="saved-game-card-body">
              <span class="saved-world-badge">AVAILABLE</span>
              <h3 class="saved-world-title">{{ entry.title }}</h3>
              <p class="saved-world-time">{{ entry.description }}</p>
              <p v-if="catalogErrors[entry.id]" role="alert" class="library-error">
                {{ catalogErrors[entry.id] }}
              </p>
              <button
                v-if="catalogErrors[entry.id]"
                type="button"
                class="saved-action-btn"
                :disabled="catalogBusy[entry.id]"
                @click="loadCatalogOpening(entry.id)"
              >
                Retry preview
              </button>
              <button
                v-else
                type="button"
                class="boot-btn resume-btn saved-game-primary"
                :disabled="catalogBusy[entry.id] || libraryActionBusy || importBusy"
                @click="playCatalogGame(entry.id)"
              >
                {{ catalogBusy[entry.id] ? "Checking opening…" : "Play" }}
              </button>
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
                    <template v-if="catalogOpenings[entry.id]"
                      ><dt>Opening</dt>
                      <dd>{{ catalogOpenings[entry.id]?.message }}</dd></template
                    >
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
            !savedWorlds.some((world) => world.slug === pendingAutosave?.game.slug) &&
            !localGameSlugs.includes(pendingAutosave.game.slug)
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
            :alt="`${pendingAutosave.game.slug}, current progress in room ${pendingAutosave.room}`"
          />
          <div class="saved-world-header">
            <div class="saved-world-tag">
              <span class="saved-world-badge">IN PROGRESS</span>
              <span class="saved-world-title">{{ pendingAutosave.game.slug }}</span>
            </div>
            <span class="saved-world-time">
              Room {{ pendingAutosave.room }} · Saved
              {{ new Date(pendingAutosave.savedAt).toLocaleString() }}
            </span>
          </div>
          <div class="saved-world-actions">
            <button
              type="button"
              class="boot-btn resume-btn"
              data-testid="btn-resume-autosave"
              @click="onResumeAutosave"
            >
              Resume
            </button>
            <button
              type="button"
              class="saved-action-btn danger"
              data-testid="btn-start-over-picker"
              title="Discard the autosave and play this game from the beginning"
              @click="onStartOver"
            >
              Start over
            </button>
          </div>
        </div>

        <section
          id="open-game"
          class="zip-drop-zone"
          aria-label="Open a game"
          @dragover.prevent
          @drop.prevent="onGameDrop($event.dataTransfer ?? undefined)"
          data-testid="game-zip-drop"
        >
          <div ref="openGameMenuEl" class="open-game-menu" @focusout="onOpenGameMenuFocusout">
            <button
              ref="openGameButtonEl"
              type="button"
              class="boot-btn primary-btn open-game-trigger"
              aria-haspopup="menu"
              :aria-expanded="openGameMenuOpen"
              aria-controls="open-game-options"
              :disabled="importBusy"
              @click="openGameMenuOpen ? closeOpenGameMenu() : openGameMenu()"
              @keydown.down.prevent="openGameMenu('first')"
              @keydown.up.prevent="openGameMenu('last')"
              @keydown.esc.prevent.stop="closeOpenGameMenu(true)"
            >
              {{ importBusy ? "Opening game…" : "Open game" }}
              <span aria-hidden="true">▾</span>
            </button>
            <div
              v-if="openGameMenuOpen"
              id="open-game-options"
              class="open-game-options"
              role="menu"
              aria-label="Open game"
              @keydown="onOpenGameMenuKeydown"
            >
              <button
                type="button"
                role="menuitem"
                data-testid="open-game-zip"
                :disabled="importBusy"
                @click="
                  closeOpenGameMenu();
                  zipInput?.click();
                "
              >
                ZIP file
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="open-game-folder"
                :disabled="importBusy"
                @click="
                  closeOpenGameMenu();
                  folderInput?.click();
                "
              >
                Game folder
              </button>
            </div>
          </div>
          <input
            ref="zipInput"
            type="file"
            accept=".zip,application/zip"
            data-testid="game-zip-input"
            hidden
            @change="onGameZip(($event.target as HTMLInputElement).files?.[0])"
          />
          <p>Drop a game ZIP or folder here.</p>
          <p class="zip-format-note">AGI v2 & v3 · Play without an API key</p>
          <input
            ref="folderInput"
            type="file"
            multiple
            webkitdirectory
            data-testid="game-folder-input"
            hidden
            @change="onGameFolder(($event.target as HTMLInputElement).files ?? undefined)"
          />
          <p v-if="importError" role="alert" data-testid="game-zip-error">{{ importError }}</p>
          <p v-if="importNotice" class="import-notice" data-testid="game-import-ready">
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
        <h2 class="splash-title">{{ activeCartridge.title }}</h2>
        <p class="splash-desc">{{ activeCartridge.description }}</p>
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
          @submit.prevent="onVirtualKey(13)"
        >
          <input
            id="game-command"
            :disabled="state.powerUp.open"
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
          :disabled="creatingRoom && state.powerUp.open"
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
              class="remix-close"
              :disabled="state.powerUp.busy"
              @click="onPowerUp"
            >
              Back to game
            </button>
          </div>
          <section v-if="!creatingRoom" class="assistant-ai-context">
            <div>
              <strong>{{ aiSettingsStatus }}</strong>
              <span>{{ model }}</span>
            </div>
            <label>
              Task budget · USD
              <input
                v-model.number="taskBudget"
                type="number"
                min="0.01"
                step="any"
                :disabled="state.powerUp.busy"
                data-testid="assistant-task-budget"
              />
            </label>
            <button
              type="button"
              class="saved-action-btn"
              data-testid="connect-assistant-ai"
              :disabled="aiSettingsUnavailable"
              @click="openAiSettings($event, 'assistant')"
            >
              {{ aiConfigured ? "Change AI settings" : "Connect AI" }}
            </button>
            <p v-if="state.powerUp.needsConfig">Add an API key before asking or remixing.</p>
          </section>
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
              :class="['agent-message', message.role]"
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
              <button type="button" data-testid="remix-jump-latest" @click="jumpToLatest">
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

      <!-- Captions under the screen (never overlays: all game text is on the CRT) -->
      <TouchControls
        v-if="touchControls && state.phase === 'running'"
        :disabled="state.powerUp.open || state.paused"
        :navigating="state.modal !== null"
        :hold="state.holdToMove"
        @direction="onTouchDirection"
        @key="onVirtualKey"
        @keyboard="inputEl?.focus()"
      />
    </div>
    <div v-if="state.phase === 'running'" class="screen-captions">
      <span v-if="state.resumed" class="caption resume-caption" data-testid="resume-caption">
        Resumed where you left off
      </span>
      <span v-if="state.textMode" class="caption" data-testid="text-mode-hint">
        [ Use the keys requested by the game ]
      </span>
      <span v-else-if="hasKeyPrompt" class="caption" data-testid="title-prompt-hint">
        [ Click screen or press Enter / Space to start ]
      </span>
      <span v-else-if="state.prompt" class="caption" data-testid="prompt-hint">
        [ Type your answer on the screen, Enter to accept, Esc to cancel ]
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
        <h2>Agent activity</h2>
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
        class="boot-btn stub-btn"
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
.zip-drop-zone .zip-format-note {
  font-size: 12px;
  color: #aaa;
}
.open-game-menu {
  position: relative;
  display: inline-block;
}
.open-game-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
}
.open-game-trigger span {
  font-size: 11px;
}
.open-game-options {
  position: absolute;
  z-index: 20;
  top: calc(100% + 6px);
  left: 50%;
  display: grid;
  width: max-content;
  min-width: 180px;
  padding: 5px;
  border: 1px solid #507477;
  border-radius: 5px;
  background: #10191b;
  box-shadow: 0 10px 24px #000b;
  transform: translateX(-50%);
}
.open-game-options button {
  min-height: 44px;
  padding: 8px 12px;
  border: 0;
  border-radius: 3px;
  color: #dcecec;
  background: transparent;
  font:
    700 14px/1.4 system-ui,
    sans-serif;
  text-align: left;
  cursor: pointer;
}
.open-game-options button:hover:not(:disabled),
.open-game-options button:focus-visible {
  color: #fff;
  background: #203537;
}
.power-up-config {
  display: grid;
  gap: 0.6rem;
  padding: 0.8rem;
}
.power-up-config label {
  display: grid;
  gap: 0.25rem;
}
.power-up-field {
  display: grid;
  gap: 0.25rem;
}
.power-up-config input,
.power-up-config select,
.power-up-config button {
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem;
}
.assistant-ai-context {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: end;
  gap: 8px 12px;
  padding: 10px;
  border: 1px solid #29474f;
  border-radius: 6px;
  background: #081116;
  font:
    12px/1.4 system-ui,
    sans-serif;
}
.assistant-ai-context strong,
.assistant-ai-context span {
  display: block;
}
.assistant-ai-context span,
.assistant-ai-context p {
  margin: 2px 0 0;
  color: #93a9ae;
}
.assistant-ai-context label {
  color: #aebfc2;
}
.assistant-ai-context input {
  display: block;
  width: 76px;
  min-height: 34px;
  margin-top: 3px;
  box-sizing: border-box;
  color: #fff;
  border: 1px solid #496068;
  background: #03080a;
}
.assistant-ai-context > p {
  grid-column: 1 / -1;
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

.task-budget {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  color: #afc6ce;
  font:
    12px/1.5 system-ui,
    sans-serif;
}
.task-budget input {
  width: 80px;
  margin: 0;
  padding: 6px 8px;
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
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #a9bac0;
  padding: 7px 12px;
  font: inherit;
  cursor: pointer;
}
.agent-mode-switch button[aria-pressed="true"] {
  background: #20454e;
  color: #a5ffff;
}
.agent-bubble-head .remix-close {
  margin-left: auto;
  border: 0;
  padding: 8px 0 8px 8px;
  background: transparent;
  color: #d8e9ed;
  font: inherit;
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
.agent-activity summary {
  cursor: pointer;
}
.agent-bubble button:disabled {
  opacity: 0.5;
  cursor: default;
}
.agent-bubble :focus-visible {
  outline: 2px solid #85f2ff;
  outline-offset: 2px;
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
  background: #123039;
  border: 1px solid #55ffff;
  color: #55ffff;
  border-radius: 4px;
  padding: 0 12px;
  cursor: pointer;
  font-size: 13px;
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

.agent-bubble-feed:focus-visible {
  outline: 1px solid #55ffff;
  outline-offset: 2px;
}

.remix-follow-controls {
  display: flex;
  justify-content: flex-end;
  padding-top: 6px;
}

.remix-follow-controls button {
  border: 1px solid #48666e;
  border-radius: 4px;
  background: #123039;
  color: #b4ffff;
  padding: 6px 10px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
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
  margin: 6px 0 0;
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
.ai-settings-trigger {
  margin-left: auto;
}

.game-nav {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.game-nav > .audio-btn {
  min-height: 40px;
  box-sizing: border-box;
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
  color: #88e5eb;
  font-size: 12px;
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
  .game-nav .audio-btn {
    font-size: 11px;
    letter-spacing: 0;
    padding-inline: 7px;
  }
  .game-nav .game-controls-panel {
    left: 0;
    right: auto;
    width: 100%;
    max-height: min(60vh, 28rem);
  }
}

.audio-btn {
  background: #1a1a1a;
  border: 1px solid #444;
  color: #ccc;
  font-size: 12px;
  min-height: 36px;
  padding: 6px 10px;
  border-radius: 3px;
  cursor: pointer;
  letter-spacing: 0.05em;
  transition: all 0.15s ease;
}

.audio-btn:hover {
  background: #282828;
  border-color: #666;
  color: #fff;
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
.repo-link {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: #739193;
  text-decoration: none;
  font: 600 12px/1 monospace;
  letter-spacing: 0.08em;
  transition: color 0.15s;
}
.repo-link:hover,
.repo-link:focus-visible {
  color: #deeeee;
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
.menu-jumps {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 20px;
}
.menu-jumps a,
.menu-jumps button {
  color: #9deded;
  text-decoration: none;
  background: transparent;
  font:
    500 14px/1.5 system-ui,
    sans-serif;
  padding: 10px 14px;
  border: 1px solid #365759;
  border-radius: 5px;
  cursor: pointer;
  min-height: 44px;
  box-sizing: border-box;
}
.menu-jumps a:hover,
.menu-jumps button:hover:not(:disabled) {
  color: #fff;
  background: #13282a;
}
.menu-jumps .hero-play {
  color: #071112;
  background: #79e5e6;
  border-color: #79e5e6;
  font-weight: 750;
}
.menu-jumps .hero-create {
  color: #c9ffff;
  border-color: #68cfd1;
  font-weight: 700;
  box-shadow: inset 0 0 0 1px #68cfd126;
}
.menu-jumps button:disabled {
  cursor: wait;
  opacity: 0.65;
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
  width: min(100%, 640px);
  align-self: center;
  padding: 20px;
  background: #0b1213;
}
.library-pane.empty-library h2 {
  margin-bottom: 10px;
  font-size: 20px;
}
.catalog-heading {
  display: flex;
  justify-content: space-between;
  align-items: end;
  gap: 24px;
  margin-bottom: 18px;
}
.catalog-heading {
  list-style: none;
  cursor: pointer;
}
.catalog-heading::-webkit-details-marker {
  display: none;
}
.catalog-heading::after {
  content: "−";
  color: #79e5e6;
  font-size: 26px;
}
.catalog-shelf:not([open]) .catalog-heading {
  margin: 0;
  align-items: center;
}
.catalog-shelf:not([open]) .catalog-heading::after {
  content: "+";
}
.catalog-shelf:not([open]) .welcome-kicker {
  display: none;
}
.catalog-shelf:not([open]) .catalog-heading h2 {
  margin: 0;
  font-size: 20px;
}
.catalog-heading:focus-visible {
  outline: 2px solid #79e5e6;
  outline-offset: 6px;
}
.catalog-heading h2 {
  margin: 4px 0 0;
  color: #f1ffff;
  font-size: clamp(22px, 3vw, 34px);
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
.catalog-copy .catalog-version {
  margin: -2px 0 10px;
  color: #79c3c5;
  font: 700 11px/1.4 monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
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
.catalog-copy .boot-btn {
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
  min-width: 0;
  align-self: start;
  width: 100%;
  box-sizing: border-box;
  padding: 26px;
  background: linear-gradient(145deg, #102021, #0b1012 60%);
  border: 1px solid #294346;
  border-radius: 12px;
}
.create-pane > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  color: #e4eeee;
  cursor: pointer;
  list-style: none;
  font:
    700 20px/1.4 system-ui,
    sans-serif;
}
.create-pane > summary::-webkit-details-marker {
  display: none;
}
.create-pane > summary::before {
  content: "+";
  color: #78e3e5;
  font: 700 22px/1 monospace;
}
.create-pane[open] > summary::before {
  content: "−";
}
.create-pane > summary small {
  margin-left: auto;
  color: #829b9d;
  font:
    400 13px/1.4 system-ui,
    sans-serif;
}
.create-pane[open] > summary {
  padding-bottom: 18px;
  border-bottom: 1px solid #294346;
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
  padding: 12px;
}
.library-pane .zip-drop-zone p {
  margin: 0;
  font-size: 13px;
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
.library-pane .saved-world-actions {
  gap: 8px;
}
.saved-game-gallery {
  display: grid;
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
.saved-game-card-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  padding: 18px;
}
.saved-game-card .saved-world-title {
  margin: 10px 0 4px;
  color: #f2ffff;
  font-size: 19px;
  line-height: 1.25;
}
.saved-game-version {
  margin: 0 0 8px;
  color: #72bfc2;
  font: 700 11px/1.4 monospace;
  letter-spacing: 0.05em;
}
.saved-game-card .saved-world-time {
  min-height: 2.8em;
  margin: 0 0 16px;
  color: #90aaa9;
  font-size: 13px;
  line-height: 1.4;
}
.boot-btn.saved-game-primary {
  width: 100%;
  min-height: 44px;
  margin-top: auto;
  font:
    700 14px/1.4 system-ui,
    sans-serif;
}
.library-details-disclosure {
  width: 100%;
  margin-top: 12px;
  border-top: 1px solid #2d4144;
  color: #9fb3b5;
}
.library-details-disclosure > summary {
  padding: 12px 2px 0;
  color: #b9d0d2;
  cursor: pointer;
  font-size: 13px;
}
.library-details-disclosure[open] > summary {
  color: #efffff;
}
.saved-game-empty {
  margin: 20px 0 0;
  padding: 24px;
  border: 1px dashed #38575a;
  border-radius: 8px;
  color: #829b9d;
  text-align: center;
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
.create-ai-context {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px;
  border: 1px solid #31494c;
  border-radius: 6px;
  background: #0a1416;
}
.create-ai-context h2,
.create-ai-context p {
  margin: 0;
}
.create-ai-context p {
  color: #91a7aa;
  font:
    12px/1.5 system-ui,
    sans-serif;
}

.saved-game-picker {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}

.saved-game-picker select {
  min-height: 40px;
  max-width: 100%;
  padding: 8px 12px;
  border: 1px solid #555;
  background: #171717;
  color: #fff;
  font: inherit;
}

.section h2 {
  font-size: 16px;
  letter-spacing: 0.02em;
  color: #eee;
  margin: 0 0 0.5rem 0;
}

.cartridge-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.cartridge-card {
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

.cartridge-card:hover {
  border-color: #555;
  background: #222;
}

.cartridge-card.selected {
  border-color: #64dddd;
  background: #173337;
}

.custom-card {
  grid-column: 1 / -1;
}

.cartridge-title {
  font-size: 14px;
  font-weight: bold;
  color: #fff;
  margin-bottom: 0.25rem;
}

.cartridge-desc {
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
.config-col input,
.task-budget input,
.power-up-config input,
.power-up-config select {
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

.config-col select,
.power-up-config select {
  height: 44px;
  min-height: 44px;
}

.boot-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.boot-btn {
  min-height: 44px;
  padding: 0.5rem 0.8rem;
  font-family: monospace;
  font-size: 0.8rem;
  font-weight: bold;
  cursor: pointer;
  border: 1px solid #444;
  background: #222;
  color: #fff;
  border-radius: 2px;
  transition: all 0.15s ease;
}

.boot-btn:hover:not(:disabled) {
  border-color: #777;
  background: #333;
}

.boot-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.menu-jumps .hero-play,
.primary-btn {
  background: #79e5e6;
  border-color: #79e5e6;
  color: #072226;
  font-family: system-ui, sans-serif;
  font-size: 14px;
  font-weight: 700;
}

.menu-jumps .hero-play:hover:not(:disabled),
.primary-btn:hover:not(:disabled) {
  background: #b2ffff;
  border-color: #b2ffff;
}

.menu-jumps .hero-play:disabled,
.primary-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.stub-btn {
  background: #232323;
  color: #bbb;
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
  min-height: 40px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  list-style: none;
}
.nav-menu summary::-webkit-details-marker {
  display: none;
}
.nav-menu summary::after {
  content: "+";
  color: #7fe8ee;
}
.nav-menu[open] summary::after {
  content: "−";
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
.game-shortcut:focus-visible,
.nav-menu summary:focus-visible {
  outline: 2px solid #7ff7ff;
  outline-offset: 2px;
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

.remix-close {
  background: transparent;
  color: #cceeee;
  border: 1px solid #52757c;
  padding: 6px 8px;
  min-height: 32px;
  cursor: pointer;
}

a:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
summary:focus-visible {
  outline: 2px solid #55ffff;
  outline-offset: 3px;
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
  .create-pane > summary {
    justify-content: flex-start;
    flex-wrap: wrap;
    gap: 3px 10px;
  }
  .create-pane > summary small {
    flex-basis: 100%;
    margin-left: 32px;
  }
  .library-pane {
    padding: 18px;
  }
  .create-ai-context {
    align-items: flex-start;
    flex-direction: column;
  }
  .assistant-ai-context {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .assistant-ai-context > div,
  .assistant-ai-context > p {
    grid-column: 1 / -1;
  }
  .welcome {
    padding: 12px 0 28px;
  }
  .welcome-kicker {
    font-size: 10px;
    letter-spacing: 0.1em;
  }
  .catalog-shelf {
    padding: 14px;
  }
  .catalog-heading {
    display: flex;
  }
  .catalog-art,
  .thumbnail-placeholder {
    min-height: 0;
  }
  .catalog-copy {
    padding: 18px;
  }
  .cartridge-grid {
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
  .agent-bubble-form button {
    min-height: 40px;
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

.agent-panel h2 {
  font-size: 0.7rem;
  letter-spacing: 0.2em;
  color: #666;
  margin: 0;
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

.agent-detail {
  flex: 1;
  word-break: break-all;
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

.eject-btn {
  background: #2a1515;
  border-color: #5c2222;
  color: #f99;
}

.eject-btn:hover {
  background: #3d1c1c;
  border-color: #8c3333;
  color: #fff;
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

.saved-world-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.cartridge-rename {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.cartridge-rename label {
  width: 100%;
  color: #bce3d0;
}

.cartridge-rename input {
  flex: 1 1 14rem;
  min-width: 0;
  padding: 0.6rem;
  color: #fff;
  background: #081910;
  border: 1px solid #579873;
  border-radius: 4px;
  font: inherit;
}

.boot-btn.resume-btn {
  background: #1e5c3a;
  border-color: #38a169;
  color: #ffffff;
  font-weight: bold;
}

.boot-btn.resume-btn:hover {
  background: #27794d;
  border-color: #48bb78;
  color: #fff;
}

.saved-action-btn {
  min-height: 36px;
  font-size: 0.75rem;
  padding: 0.4rem 0.6rem;
  background: #18221c;
  border: 1px solid #2d4a37;
  color: #a0c4ab;
  border-radius: 3px;
  cursor: pointer;
  font-family: inherit;
}

.saved-action-btn:hover {
  background: #233329;
  color: #fff;
}

.saved-action-btn.danger {
  color: #e57373;
  border-color: #5c2828;
  background: #2a1515;
}

.saved-action-btn.danger:hover {
  background: #421d1d;
  color: #ff9999;
}
</style>
