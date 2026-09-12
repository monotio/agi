/**
 * The menu screen's shared state: the saved-game library, the hosted catalog,
 * create-adventure drafts, pending autosaves and the import/export paths.
 * App.vue provides one controller; LibraryPanel, CatalogPanel and CreatePanel
 * inject it instead of receiving this surface as props.
 */
import { computed, inject, nextTick, provide, ref, watch } from "vue";
import type { InjectionKey } from "vue";
import { lastGameKey, readAutosave, removeLibraryGame, type AutosaveRecord } from "./useEngine.ts";
import { gameStorageKey } from "./gameTypes.ts";
import type { EngineApi } from "./engineContext.ts";
import type { AiSettingsApi } from "./useAiSettings.ts";
import type { ShellBridge } from "./shellBridge.ts";
import { BUILTIN_TEMPLATES, parseCustomTemplate, type GameTemplate } from "./gameTemplates.ts";
import {
  getCachedGameMeta,
  loadAuthoredGame,
  listCachedGames,
  renameAuthoredGame,
  updateGamePreview,
  type CachedGameMeta,
} from "./gameStorage.ts";
import { buildProjectZip, buildPublicGameZip } from "./projectArchive.ts";
import { MAX_GAME_ZIP_BYTES, readGameFiles, readGameZip, type OpenedGame } from "./gameZip.ts";
import { readGameProgress, type ImportStorageReport } from "./gameProgress.ts";
import { captureGameDrop } from "./gameDrop.ts";
import { GAME_CATALOG, type GameCatalogEntry } from "./gameCatalog.ts";
import { loadHostedCatalog } from "./hostedCatalog.ts";
import { resolveWalkthrough } from "./walkthrough.ts";
import { previewGame } from "./gamePreview.ts";
import { addLibraryGame, copyLibraryGame, type CheckedOpening } from "./gameLibrary.ts";
import { gameRevision } from "./gameMetadata.ts";
import { getKnownGameByAlias } from "../../src/games/knownGames.ts";
import type { InstalledGameDescriptor, ProjectId } from "./gameTypes.ts";

export function createGameLibrary(engine: EngineApi, ai: AiSettingsApi, bridge: ShellBridge) {
  const {
    state,
    resumeAudio,
    bootGame,
    bootAuthoredGame,
    resumeLastGame,
    resumeFromRecord,
    startOver,
    currentGame,
    flushAutosave,
    exportCurrentGame,
  } = engine;
  const { llmConfig, openAiSettings, aiConfigured } = ai;

  // Game and LLM state
  const initialGames = listCachedGames();
  const initialProjectId = lastGameKey() ?? initialGames[0]?.projectId ?? "knights-trial";
  const savedGames = ref<CachedGameMeta[]>(initialGames);
  const selectedProjectId = ref<string>(initialProjectId);
  const zipInput = ref<HTMLInputElement>();
  const folderInput = ref<HTMLInputElement>();
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
            game.library?.catalog?.id === entry.id &&
            game.library.catalog.version === entry.version,
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
  const adventureDrafts = ref<
    Record<string, { title: string; brief: string; frontmatter: string }>
  >({
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
  const cachedMeta = ref<CachedGameMeta | null>(getCachedGameMeta(initialProjectId));
  const renaming = ref(false);
  const expandedProjectId = ref<string>();
  const gameTitle = ref("");
  const renameError = ref("");
  const titleInput = ref<HTMLInputElement>();

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
    selectedProjectId.value = game.projectId;
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
    if (!(await renameAuthoredGame(selectedProjectId.value, gameTitle.value))) {
      renameError.value = "Could not save the name. Use 1–100 characters and try again.";
      return;
    }
    cachedMeta.value = getCachedGameMeta(selectedProjectId.value);
    savedGames.value = listCachedGames();
    renaming.value = false;
  }

  function onGameDetailsToggle(projectId: ProjectId, event: Event): void {
    const details = event.currentTarget as HTMLDetailsElement;
    if (details.open) {
      expandedProjectId.value = projectId;
      const game = savedGames.value.find((entry) => entry.projectId === projectId);
      if (game) selectLibraryGame(game);
    } else if (expandedProjectId.value === projectId) {
      expandedProjectId.value = undefined;
      renaming.value = false;
    }
  }

  watch(selectedProjectId, (projectId) => {
    cachedMeta.value = getCachedGameMeta(projectId);
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

  watch(
    () => state.powerUp.busy,
    (busy) => {
      if (busy) return;
      const game = currentGame();
      if (game && !game.installed && game.projectId) {
        selectedProjectId.value = game.projectId;
        cachedMeta.value = getCachedGameMeta(game.projectId);
        savedGames.value = listCachedGames();
      }
    },
  );

  /** Download failures are visible in both the picker and the game. */
  const exportRefusal = ref<string>("");
  const exportBusy = ref(false);
  const exportSavedProgressKey = ref<string>();

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

  const localGameAliases = computed(() => localGames.value.map((g) => g.alias));

  function localAutosave(game: InstalledGameDescriptor): AutosaveRecord | undefined {
    // Folder-keyed progress keeps same-hash editions separate; descriptors
    // without a folder (hosted installs) still match by hash or alias.
    return game.folder
      ? libraryAutosaves.value[game.folder]
      : (libraryAutosaves.value[game.hash] ?? libraryAutosaves.value[game.alias]);
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

  /** Short provenance line for a saved card: remixes name their parent, imports say so. */
  function libraryProvenance(game: CachedGameMeta): string | null {
    const lib = game.library;
    if (!lib) return null;
    if (lib.source === "remix") {
      const parent = lib.parent;
      const parentTitle =
        (parent?.projectId
          ? savedGames.value.find((g) => g.projectId === parent.projectId)?.title
          : undefined) ??
        (parent?.alias ? getKnownGameByAlias(parent.alias)?.title : undefined) ??
        parent?.alias;
      return parentTitle ? `Remix of ${parentTitle}` : "Remix";
    }
    if (lib.source === "zip" || lib.source === "folder") return "Imported copy";
    return null;
  }

  function refreshPendingAutosave(): void {
    const key = lastGameKey();
    pendingAutosave.value = (key ? readAutosave(key) : null) ?? undefined;
  }

  /** Discard the resumed game's progress and boot it from the top. */
  async function onStartOver(): Promise<void> {
    const current = currentGame();
    const pending = pendingAutosave.value?.game;
    const target =
      (current ? gameStorageKey(current) : "") ||
      (pending ? gameStorageKey(pending) : "") ||
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

  const currentCreationProjectId = ref<string>();

  function getOrCreateCreationProjectId(templateId: string): string {
    if (
      !currentCreationProjectId.value ||
      !currentCreationProjectId.value.startsWith(`${templateId}-`)
    ) {
      currentCreationProjectId.value = `${templateId}-${crypto.randomUUID().slice(0, 8)}`;
    }
    return currentCreationProjectId.value;
  }

  async function onBootSelectedTemplate(): Promise<void> {
    if (!selectedTemplateId.value || !adventureDraft.value.brief.trim()) return;
    if (!aiConfigured.value) {
      openAiSettings(null, "create");
      return;
    }
    await resumeAudio();
    const allocatedId = getOrCreateCreationProjectId(activeTemplate.value.id);
    await bootAuthoredGame(activeTemplate.value.rawMarkdown, llmConfig(), {
      projectId: allocatedId,
      templateId: activeTemplate.value.id,
      title: activeTemplate.value.title,
      useCached: false,
    });
    currentCreationProjectId.value = undefined;
    const game = currentGame();
    if (game && !game.installed && game.projectId) selectedProjectId.value = game.projectId;
    cachedMeta.value = getCachedGameMeta(selectedProjectId.value);
  }

  async function onBootSavedGame(alreadyBusy = false): Promise<void> {
    if (libraryActionBusy.value && !alreadyBusy) return;
    if (!alreadyBusy) libraryActionBusy.value = true;
    libraryActionError.value = "";
    try {
      await resumeAudio();
      await bootAuthoredGame(activeTemplate.value.rawMarkdown, llmConfig(), {
        projectId: selectedProjectId.value,
        title: cachedMeta.value?.title ?? selectedProjectId.value,
        useCached: true,
      });
    } catch (error) {
      libraryActionError.value = String(error).replace(/^Error: /, "");
    } finally {
      if (!alreadyBusy) libraryActionBusy.value = false;
    }
  }

  async function onClearSavedGame(): Promise<void> {
    await removeLibraryGame(selectedProjectId.value);
    refreshLibrary();
    refreshPendingAutosave();
  }

  function refreshLibrary(projectId?: ProjectId): void {
    savedGames.value = listCachedGames();
    if (projectId) {
      selectedProjectId.value = projectId;
    } else if (!savedGames.value.some((entry) => entry.projectId === selectedProjectId.value))
      selectedProjectId.value = savedGames.value[0]?.projectId ?? "";
    cachedMeta.value = selectedProjectId.value ? getCachedGameMeta(selectedProjectId.value) : null;
  }

  /** The idle/error phase re-reads the shelf and the resume pointer. */
  function syncMenuPhase(): void {
    refreshPendingAutosave();
    savedGames.value = listCachedGames();
    cachedMeta.value = getCachedGameMeta(selectedProjectId.value);
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
    const importedProjectId = await addLibraryGame(
      game,
      game.title ?? title,
      source,
      opening,
      undefined,
      (report) => (stored = report),
    );
    refreshLibrary(importedProjectId);
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
    if (
      !files ||
      (files instanceof Map ? files.size === 0 : files.length === 0) ||
      importBusy.value
    )
      return;
    importBusy.value = true;
    importError.value = "";
    importNotice.value = "";
    try {
      const selected = files instanceof Map ? [...files.values()] : [...files];
      if (selected.length > 1024)
        throw new Error("Choose one game folder with at most 1024 files.");
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
      const projectId = await addLibraryGame(game, entry.title, "catalog", opening, {
        id: entry.id,
        version: entry.version,
      });
      refreshLibrary(projectId);
      const autosave = readAutosave(projectId);
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

  /** Boot a catalog game, then hand it to its recorded walkthrough. */
  async function playCatalogWalkthrough(id: string): Promise<void> {
    await playCatalogGame(id);
    const alias = resolveWalkthrough(id);
    if (!alias) return;
    // The boot resolves with the post; the running phase lands one message later.
    for (let n = 0; n < 200 && state.phase !== "running" && state.phase !== "error"; n++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (state.phase === "running") bridge.startWalkthrough(alias);
  }

  async function checkSelectedOpening(): Promise<void> {
    if (libraryActionBusy.value) return;
    const selected = selectedProjectId.value;
    libraryActionError.value = "";
    libraryActionBusy.value = true;
    try {
      const game = await loadAuthoredGame(selected);
      if (!game) throw new Error("This game is no longer in your library. Import it again.");
      const opening = await previewGame(game);
      const revision = game.library?.revision ?? (await gameRevision(game.files));
      if (!(await updateGamePreview(game.projectId, revision, opening.preview, opening)))
        throw new Error("The game changed while its opening was being checked. Try again.");
      refreshLibrary(selectedProjectId.value === selected ? game.projectId : undefined);
    } catch (error) {
      libraryActionError.value = String(error).replace(/^Error: /, "");
    } finally {
      libraryActionBusy.value = false;
    }
  }

  async function copySelectedGame(): Promise<void> {
    if (libraryActionBusy.value) return;
    const selected = selectedProjectId.value;
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

  async function onExportAgiZip(
    live = false,
    project = false,
    savedProgress = false,
  ): Promise<void> {
    const game = live ? currentGame() : null;
    const gameKey = game
      ? game.installed
        ? (game.hash ?? game.alias)
        : game.projectId
      : undefined;
    const useSavedProgress =
      savedProgress && project && live && gameKey === exportSavedProgressKey.value;
    exportSavedProgressKey.value = undefined;
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
        if (currentKey === gameKey) exportSavedProgressKey.value = gameKey;
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
      const exportResult = live ? await exportCurrentGame() : null;
      const data = exportResult
        ? exportResult.data
        : await loadAuthoredGame(selectedProjectId.value);
      if (!data) throw new Error("No saved game is available.");
      const progressKey = exportResult ? exportResult.progressKey : data.projectId;
      const zipBytes = project
        ? await buildProjectZip(data, readGameProgress(localStorage, progressKey))
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

  /** Observer + catalog warmup; App.vue calls it at the same onMounted point. */
  function mountCatalog(): void {
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
  }

  function unmountCatalog(): void {
    catalogObserver?.disconnect();
  }

  return {
    savedGames,
    selectedProjectId,
    cachedMeta,
    renaming,
    expandedProjectId,
    gameTitle,
    renameError,
    zipInput,
    folderInput,
    importBusy,
    importNotice,
    importError,
    libraryActionBusy,
    libraryActionError,
    pendingAutosave,
    hasLibraryContent,
    libraryAutosaves,
    localGames,
    localGameAliases,
    hasOwnGames,
    tutorialOpen,
    featuredCatalog,
    catalogEntries,
    catalogOpenings,
    catalogErrors,
    catalogBusy,
    hostedCatalogError,
    hostedCatalogBusy,
    availableCatalogEntries,
    selectedTemplateId,
    adventureDrafts,
    adventureDraft,
    activeTemplate,
    exportBusy,
    exportRefusal,
    exportSavedProgressKey,
    catalogHasProgress,
    selectLibraryGame,
    beginRename,
    setTitleInput,
    saveGameTitle,
    onGameDetailsToggle,
    localAutosave,
    setTutorialOpen,
    onPlayLocalGame,
    libraryProvenance,
    refreshPendingAutosave,
    refreshLibrary,
    syncMenuPhase,
    onStartOver,
    onResumeAutosave,
    onBootSelectedTemplate,
    onBootSavedGame,
    onClearSavedGame,
    onPlayLibraryGame,
    onStartLibraryGameOver,
    onCheckLibraryGame,
    onCopyLibraryGame,
    onExportLibraryGame,
    onRemoveLibraryGame,
    onGameZip,
    onGameFolder,
    onGameDrop,
    refreshHostedCatalog,
    loadCatalogOpening,
    playCatalogGame,
    playCatalogWalkthrough,
    observeCatalogCard,
    onExportAgiZip,
    mountCatalog,
    unmountCatalog,
  };
}

export type GameLibrary = ReturnType<typeof createGameLibrary>;

export const gameLibraryKey: InjectionKey<GameLibrary> = Symbol("agi-game-library");

export function provideGameLibrary(lib: GameLibrary): void {
  provide(gameLibraryKey, lib);
}

export function useGameLibrary(): GameLibrary {
  const lib = inject(gameLibraryKey);
  if (!lib) throw new Error("useGameLibrary: App.vue did not provide the game library");
  return lib;
}
