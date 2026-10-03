/**
 * The menu screen's shared state: the saved-game library, the hosted catalog,
 * create-adventure drafts, pending autosaves and the import/export paths.
 * App.vue provides one controller; LibraryPanel, CatalogPanel and CreatePanel
 * inject it instead of receiving this surface as props.
 */
import { computed, inject, nextTick, provide, ref, shallowRef, watch } from "vue";
import type { InjectionKey } from "vue";
import {
  lastGameKey,
  readAutosave,
  removeLibraryGame,
  type AutosaveRecord,
} from "../engine/useEngine.ts";
import { clearAutosave } from "../saves/useAutosaveController.ts";
import {
  LEGACY_LAST_GAME_KEY,
  clearResumePointer,
  readResumePointer,
} from "../saves/resumePointer.ts";
import { resolveGameHash } from "../../../src/games/knownGames.ts";
import { clearGameSaves } from "../saves/gameSaves.ts";
import { emptyMapSidecar, readMapSidecar, removeMapSidecar } from "../world/roomMapStore.ts";
import { clearPlayerSentences } from "../project/playerSentenceKey.ts";
import { findInstalledFolder, gameStorageKey } from "../project/gameTypes.ts";
import type { EngineApi } from "../engine/engineContext.ts";
import type { AiSettingsApi } from "../settings/useAiSettings.ts";
import type { ShellBridge } from "../shell/shellBridge.ts";
import { BUILTIN_TEMPLATES, parseCustomTemplate, type GameTemplate } from "./gameTemplates.ts";
import {
  getCachedGameMeta,
  loadAuthoredGame,
  loadAuthoredGameWithHistoryLifetime,
  listCachedGames,
  listUnsupportedStoredProjects,
  type UnsupportedStoredProject,
  removeProjectWithProgress,
  renameAuthoredGame,
  updateGamePreview,
  type CachedGameMeta,
} from "../project/gameStorage.ts";
import { bindSavedProgressTarget } from "../project/progressBinding.ts";
import {
  installedProgressTarget,
  parseProgressLocator,
  projectProgressTarget,
  resolveInstalledFolder,
  type ProgressTarget,
  type ProjectProgressTarget,
} from "../project/progressTarget.ts";
import type { RawLocalEntry } from "../project/legacyProgressRecovery.ts";
import { MAX_GAME_ZIP_BYTES } from "../archive/gameZipLimits.ts";
import type { OpenedGame } from "../archive/gameZip.ts";
import {
  readGameProgress,
  autosaveKey,
  type GameProgress,
  type ImportStorageReport,
} from "../saves/gameProgress.ts";
import { autosaveRecordRestores, checkpointBasisMatches } from "./exportCheckpoint.ts";
import { computeResourceRevision } from "../../../src/authoring/resourceRevision.ts";
import { PROFILES, type ProfileId } from "../../../src/runtime/profile.ts";
import { captureDropHandles } from "./gameDropCapture.ts";
import type { GameDrop } from "./gameDrop.ts";
import { GAME_CATALOG, type GameCatalogEntry } from "./gameCatalog.ts";
import { loadHostedCatalog } from "./hostedCatalog.ts";
import { resolveWalkthrough } from "../walkthrough/walkthrough.ts";
import type { CheckedOpening } from "./gameLibrary.ts";
import { gameRevision, normalizeLibraryMetadata } from "../project/gameMetadata.ts";
import type { InstalledGameDescriptor, ProjectId } from "../project/gameTypes.ts";
import { projectId, requireProjectId, type GameIdentity } from "../../../src/gameIdentity.ts";
import { createProfileChoiceController } from "./profileChoice.ts";
import { coalescesInstalled, parentDisplayTitle } from "../home/shelfIdentity.ts";

/**
 * What a card can offer for one game's stored progress. `pending` means a
 * saved body's physical target is still binding (the card keeps its opening
 * preview); `unbound` means no live evidence owns a target — a removed or
 * unreadable body, an installed descriptor without its exact folder and
 * full served revision. `ready` carries the bound target and the autosave
 * record read under its own locator with full ownership checks — never a
 * record read under another game's spelling.
 */
export type LibraryProgress =
  | { readonly status: "pending" }
  | { readonly status: "unbound" }
  | {
      readonly status: "ready";
      readonly target: ProgressTarget;
      readonly autosave: AutosaveRecord | null;
    };

/**
 * The exact physical equality a caller's captured binding demands of a
 * freshly bound target: locator, project identity and full revision
 * identity all equal. A body rebound to another epoch or a descriptor now
 * serving another revision is a different instance and answers false.
 */
function bindsTarget(target: ProgressTarget | null, expected: ProgressTarget): boolean {
  return (
    target !== null &&
    target.locator === expected.locator &&
    target.identity.project === expected.identity.project &&
    target.identity.revision === expected.identity.revision
  );
}

function storedMap(locator: string) {
  try {
    return readMapSidecar(localStorage, locator);
  } catch {
    return emptyMapSidecar();
  }
}

/** The engine-reported profile, when it names a known interpreter. */
function liveProfileToProfileId(profile: string | null): ProfileId | undefined {
  return profile !== null && Object.hasOwn(PROFILES, profile) ? (profile as ProfileId) : undefined;
}

export function createGameLibrary(
  engine: EngineApi,
  ai: AiSettingsApi,
  bridge: ShellBridge,
  seams?: {
    /** Async seam for focused tests: the production binding never changes. */
    bindSavedProgressTarget?: (project: string) => Promise<ProjectProgressTarget | null>;
  },
) {
  const {
    state,
    resumeAudio,
    bootGame,
    bootAuthoredGame,
    resumeFromRecord,
    startOver,
    currentGame,
    getBootedGame,
    flushAutosave,
    exportCurrentGame,
  } = engine;
  const { llmConfig, openAiSettings, aiConfigured } = ai;
  const bindSaved = seams?.bindSavedProgressTarget ?? bindSavedProgressTarget;

  // Game and LLM state
  const initialGames = listCachedGames();
  // lastGameKey is the resume pointer at the storage edge — an installed
  // game's hash or an authored project's id — so it is validated here, not
  // trusted.
  const initialProjectId =
    projectId(lastGameKey()) ?? initialGames[0]?.projectId ?? requireProjectId("knights-trial");
  const savedGames = ref<CachedGameMeta[]>(initialGames);
  const unsupportedProjects = ref<UnsupportedStoredProject[]>([]);
  const selectedProjectId = ref<ProjectId | "">(initialProjectId);
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

  /**
   * The saved domain's bound progress targets, keyed by project id. Each
   * entry was bound from an atomic body+lifetime read. Every refresh issues
   * a new generation; a bind lands only while its generation is current and
   * its id is still listed, so a resolution that returns after a
   * remove-and-recreate under the same id can never re-enable the prior
   * incarnation's records. A listed id whose entry is missing or
   * retired reads `pending` — the card shows its opening, never another
   * game's checkpoint.
   */
  const savedTargets = ref<
    Record<string, { generation: number; target: ProjectProgressTarget | null }>
  >(Object.create(null));
  let savedTargetGeneration = 0;
  // localStorage sits outside Vue's tracking; the explicit refresh paths
  // bump this so card reads re-run when progress or the pointer moved.
  const progressReads = ref(0);

  /**
   * Rebind every listed body's progress target from live storage. Called by
   * the explicit refresh and change paths only — never from a computed or a
   * per-card read — so a shelf render does no IndexedDB work.
   */
  function resolveSavedTargets(): void {
    const generation = ++savedTargetGeneration;
    // The bump retires every saved entry's proof, so a pending offer
    // published under a saved target is withdrawn in the same tick rather
    // than outliving the binding that vouched for it — a shelf that comes
    // back empty or a bind that refuses leaves no stale Resume standing.
    // An installed offer is proven without this cache and stays while it
    // still is.
    if (pendingProgressTarget.value?.kind === "project") {
      pendingAutosave.value = undefined;
      pendingProgressTarget.value = undefined;
    }
    const listed = new Set<string>(savedGames.value.map((game) => game.projectId));
    const kept: Record<string, { generation: number; target: ProjectProgressTarget | null }> =
      Object.create(null);
    for (const [id, entry] of Object.entries(savedTargets.value))
      if (listed.has(id)) kept[id] = entry;
    savedTargets.value = kept;
    for (const id of listed) {
      void bindSaved(id)
        .then((target) => {
          if (generation !== savedTargetGeneration) return;
          if (!savedGames.value.some((game) => game.projectId === id)) return;
          savedTargets.value = { ...savedTargets.value, [id]: { generation, target } };
          // A held pending offer settles now that the live epoch is known.
          refreshPendingAutosave();
        })
        .catch(() => {
          // A refused or unreadable read stays pending: the card keeps its
          // opening, and playGuarded marks it when the player asks.
        });
    }
  }

  /**
   * One saved card's progress readiness — the bound-target cache plus a
   * localStorage read only, synchronous and IndexedDB-free.
   */
  function projectCheckpoint(target: ProjectProgressTarget): AutosaveRecord | null {
    const current = readGameProgress(localStorage, target).autosave;
    if (current !== null) return current;
    try {
      const previous =
        localStorage.getItem(autosaveKey(target.locator)) !== null
          ? readAutosave(target.locator)
          : target.bodyEpoch === "initial"
            ? readAutosave(target.project)
            : null;
      return previous &&
        !previous.game.installed &&
        previous.game.identity.project === target.project
        ? previous
        : null;
    } catch {
      return null;
    }
  }

  function savedProgress(id: ProjectId): LibraryProgress {
    void progressReads.value;
    const entry = savedTargets.value[id];
    if (entry === undefined || entry.generation !== savedTargetGeneration)
      return { status: "pending" };
    if (entry.target === null) return { status: "unbound" };
    return {
      status: "ready",
      target: entry.target,
      autosave: projectCheckpoint(entry.target),
    };
  }

  /**
   * One installed card's progress readiness. The target binds synchronously
   * from the descriptor's exact folder and full served revision; a
   * descriptor that lacks either names no current instance — its released
   * spellings stay read context, never an address.
   */
  function installedProgress(game: InstalledGameDescriptor): LibraryProgress {
    void progressReads.value;
    const target =
      game.revision === undefined
        ? null
        : installedProgressTarget(
            { folder: game.folder, hash: game.hash, alias: game.alias },
            game.revision,
          );
    if (target === null) return { status: "unbound" };
    return {
      status: "ready",
      target,
      autosave: readGameProgress(localStorage, target).autosave,
    };
  }

  /**
   * Saved cards' checkpoints, keyed by project id for the released
   * consumers. Records are read under each body's bound physical target
   * only; installed instances never land in this map, so the two domains
   * can share a spelling without sharing progress.
   */
  const libraryAutosaves = computed<Record<string, AutosaveRecord>>(() =>
    Object.fromEntries(
      savedGames.value.flatMap((game) => {
        const progress = savedProgress(game.projectId);
        return progress.status === "ready" && progress.autosave !== null
          ? [[game.projectId, progress.autosave]]
          : [];
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
    const id = selectedProjectId.value;
    if (!id || !(await renameAuthoredGame(id, gameTitle.value))) {
      renameError.value = "Could not save the name. Use 1–100 characters and try again.";
      return;
    }
    cachedMeta.value = getCachedGameMeta(id);
    savedGames.value = listCachedGames();
    renaming.value = false;
    resolveSavedTargets();
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

  watch(selectedProjectId, (selected) => {
    cachedMeta.value = selected ? getCachedGameMeta(selected) : null;
    renaming.value = false;
  });

  /**
   * The public selection's context token, bumped synchronously on every
   * `selectedProjectId` change — selectLibraryGame, the refresh paths and
   * direct ref writes alike. An action captures it before awaited work and
   * re-checks it at each admission step, so a selection that left and
   * returned (A→B→A) can never revive a parked intent the way a plain
   * id comparison would. The flush is synchronous precisely so a batched
   * same-tick return still reads as a change.
   */
  let selectionContext = 0;
  watch(
    selectedProjectId,
    () => {
      selectionContext += 1;
    },
    { flush: "sync" },
  );

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
        resolveSavedTargets();
      }
    },
  );

  /** Download failures are visible in both the picker and the game. */
  const exportRefusal = ref<string>("");
  const exportBusy = ref(false);

  /**
   * Autosave the picker can offer, published only with the physical target
   * that proved it. The app resumes it by itself on load; this is what is
   * left when it could not — the boot failed, or the player ejected back to
   * the picker — plus the way to throw it away and start the game from the
   * beginning. Record and target move together: a record never offers
   * itself under a target that did not vouch for it.
   */
  const pendingAutosave = shallowRef<AutosaveRecord>();
  const pendingProgressTarget = ref<ProgressTarget>();

  // One card per game: a stored entry hides its installed instance only by
  // the intentional same-instance/verified-content rule in shelfIdentity —
  // an alias or string-id collision alone never hides a distinct local
  // game, and declared ancestry always keeps its own card.
  const localGames = computed(() => {
    const list = state.installedGames ?? [];
    return list.filter((item) => !savedGames.value.some((game) => coalescesInstalled(game, item)));
  });

  function localAutosave(game: InstalledGameDescriptor): AutosaveRecord | undefined {
    const progress = installedProgress(game);
    return progress.status === "ready" ? (progress.autosave ?? undefined) : undefined;
  }

  async function onPlayLocalGame(
    query: string,
    expected?: ProgressTarget,
    isCurrent?: () => boolean,
  ): Promise<void> {
    await resumeAudio();
    // An action parked on the audio wait must still belong to the intent
    // that dispatched it — an ended note that departed in the wait owns
    // nothing, even while the body underneath never moved.
    if (isCurrent !== undefined && !isCurrent()) return;
    // The query's resolved folder binds the instance's physical target —
    // its exact folder spelling plus the descriptor's full served revision.
    // A spelling that names no single folder, or a descriptor missing that
    // evidence, binds nothing; no hash or alias ever fabricates a physical
    // address.
    const folder = findInstalledFolder(state.installedGames, query);
    const descriptor = (state.installedGames ?? []).find((item) => item.folder === folder);
    const target =
      descriptor === undefined || descriptor.revision === undefined
        ? null
        : installedProgressTarget(descriptor, descriptor.revision);
    // A caller carrying the binding it proved — an ended note's own target —
    // accepts only the live descriptor bound to that exact instance: a folder
    // that comes back serving another revision never answers for it, no
    // matter that the folder spelling still resolves.
    if (expected !== undefined && !bindsTarget(target, expected)) return;
    // A descriptor claiming the resolved folder is an identified installed
    // card: without its full served revision it binds no physical target,
    // so it boots its opening and never adopts a bare-spelling record from
    // another domain. Only a query naming no installed card — a genuinely
    // manual spelling — keeps the released read under the resolved folder's
    // own spelling, never under a hash or alias another instance could share.
    const checkpoint =
      target !== null
        ? readGameProgress(localStorage, target).autosave
        : descriptor === undefined
          ? readAutosave(folder)
          : null;
    if (checkpoint)
      await resumeFromRecord(checkpoint, llmConfig(), target?.locator, () => isCurrent?.() ?? true);
    else
      await bootGame(query, undefined, {
        ...(expected !== undefined ? { target: expected } : target !== null ? { target } : {}),
        isCurrent: () => isCurrent?.() ?? true,
      });
  }

  /** Short provenance line for a saved card: remixes name their parent, imports say so. */
  function libraryProvenance(game: CachedGameMeta): string | null {
    const lib = game.library;
    if (!lib) return null;
    const origin = libraryOrigin(game);
    if (!lib.workInProgress) return origin;
    return origin ? `${origin} · Work in progress` : "Work in progress";
  }

  function libraryOrigin(game: CachedGameMeta): string | null {
    const lib = game.library!;
    if (lib.source === "remix") {
      const parent = lib.parent;
      return parent
        ? `Remix of ${parentDisplayTitle(parent, savedGames.value, state.installedGames ?? [])}`
        : "Remix";
    }
    return lib.source === "zip" || lib.source === "folder" ? "Imported copy" : null;
  }

  /**
   * An installed card's provenance: the immediate parent its GAME.JSON
   * declares, resolved like a saved remix's — never inferred from shared
   * vocabulary or object bytes.
   */
  function installedProvenance(game: InstalledGameDescriptor): string | null {
    return game.parent
      ? `Remix of ${parentDisplayTitle(game.parent, savedGames.value, state.installedGames ?? [])}`
      : null;
  }

  /** The identity's display title, shared by saved and installed ancestry. */
  function identityTitle(identity: GameIdentity): string {
    return parentDisplayTitle(identity, savedGames.value, state.installedGames ?? []);
  }

  /**
   * The physical target a strict resume pointer names, or null. A project
   * locator must equal the saved cache's bound target for that id — the
   * exact live body epoch; while the bind is still in flight the offer is
   * held and the landing resolution re-reads. An installed locator must
   * resolve by folder digest to one served folder whose descriptor carries
   * the pointer's own full revision. Anything else names nothing current.
   */
  function pendingTarget(locator: string): ProgressTarget | null {
    const parsed = parseProgressLocator(locator);
    if (parsed === null) {
      const entry = savedTargets.value[locator];
      if (entry?.generation === savedTargetGeneration && entry.target !== null) return entry.target;
      const descriptor = (state.installedGames ?? []).find((item) => item.folder === locator);
      return descriptor?.revision === undefined
        ? null
        : installedProgressTarget(descriptor, descriptor.revision);
    }
    if (parsed?.kind === "project") {
      const entry = savedTargets.value[parsed.project];
      if (entry === undefined || entry.generation !== savedTargetGeneration) return null;
      return entry.target !== null && entry.target.locator === locator ? entry.target : null;
    }
    if (parsed?.kind !== "installed") return null;
    const resolved = resolveInstalledFolder(locator, state.installedGames);
    if (resolved.status !== "resolved") return null;
    const descriptor = (state.installedGames ?? []).find((item) => item.folder === resolved.folder);
    if (descriptor?.revision === undefined) return null;
    const target = installedProgressTarget(descriptor, descriptor.revision);
    return target !== null && target.locator === locator ? target : null;
  }

  /**
   * Home's Continue: only the strict physical pointer's own offer. The
   * dedicated resumeTarget value must parse to a locator that still binds a
   * current target — a saved body's live epoch through the cache, an
   * installed instance's exact folder plus its served revision — and the
   * typed read under it must return a record owning that target. A legacy
   * lastGame value is history context, never an offer. A missing,
   * unsupported, stale or unbound target publishes nothing and touches
   * nothing: the raw checkpoint and both pointer keys stay exactly as
   * stored.
   */
  function refreshPendingAutosave(): void {
    progressReads.value += 1;
    pendingAutosave.value = undefined;
    pendingProgressTarget.value = undefined;
    const pointer = readResumePointer(localStorage);
    if (pointer === null) return;
    const target = pendingTarget(pointer.value);
    if (target === null) return;
    const record = readGameProgress(localStorage, target).autosave;
    if (record === null) return;
    pendingProgressTarget.value = target;
    pendingAutosave.value = record;
  }

  /**
   * Discard the resumed game's progress and boot it from the top. A running
   * game's unsaved timeline refuses it (HistoryUnsavedError) unless
   * `abandonHistory` starts over without that tail.
   */
  async function onStartOver(options?: { abandonHistory?: boolean }): Promise<void> {
    const current = currentGame();
    const pending = pendingAutosave.value?.game;
    const target =
      (current ? (current.progressTarget?.locator ?? gameStorageKey(current)) : "") ||
      lastGameKey() ||
      (pending ? pending.identity.project : "");
    if (!target) return;
    await resumeAudio();
    await startOver(target, llmConfig(), options);
    refreshPendingAutosave();
  }

  /**
   * Resume the pending offer under the exact target that proved it. The pair
   * is captured before the audio wait and re-checked after, so a pointer or
   * binding that moved during the wait ends this resume rather than handing
   * another game's record to the runtime. The handoff is the proven record
   * plus its physical locator; resumeFromRecord re-proves the live binding.
   */
  async function onResumeAutosave(): Promise<void> {
    const record = pendingAutosave.value;
    const target = pendingProgressTarget.value;
    if (record === undefined || target === undefined) return;
    await resumeAudio();
    // Re-prove, not just compare refs: the strict pointer must still name
    // this target, the target must still bind current — a retired saved
    // generation or a moved descriptor ends it — and the target must still
    // vouch for this very record. A pair that left and returned in the
    // wait reads as a different pair.
    const pointer = readResumePointer(localStorage);
    if (
      pendingAutosave.value !== record ||
      pendingProgressTarget.value !== target ||
      pointer === null ||
      (pointer.legacy
        ? !target.legacyKeys.includes(pointer.value)
        : pointer.value !== target.locator)
    )
      return;
    const resolved = pendingTarget(pointer.value);
    if (
      resolved === null ||
      resolved.locator !== target.locator ||
      resolved.identity.project !== target.identity.project ||
      resolved.identity.revision !== target.identity.revision
    )
      return;
    const proof = readGameProgress(localStorage, target).autosave;
    if (proof === null || JSON.stringify(proof) !== JSON.stringify(record)) return;
    if (target.kind === "project" && record.game.identity.revision !== target.identity.revision) {
      offerLatestVersion(target);
      return;
    }
    if (!(await resumeFromRecord(record, llmConfig(), target.locator)) && state.phase === "error")
      offerLatestVersion(target, state.error);
    refreshPendingAutosave();
  }

  /**
   * The pending resume offer a routed `#play/<key>` may claim, or null. The
   * strict resume pointer must still prove current evidence for the routed
   * instance: a project locator binds the live body itself — awaited here
   * rather than read off the shelf cache, so a still-pending first bind
   * never drops a real checkpoint — and must equal the pointer's locator;
   * an installed locator must come from the served folder the key names
   * under the descriptor's exact revision. Both domains then require the
   * record stored under that target's own locator. A stale epoch, a
   * missing or foreign record and every non-strict spelling answer null
   * with bytes and pointer left exactly as stored.
   */
  async function routedResumeOffer(
    key: string,
  ): Promise<{ record: AutosaveRecord; target: ProgressTarget } | null> {
    const pointer = readResumePointer(localStorage);
    if (pointer === null) return null;
    if (pointer.legacy) {
      if (key !== pointer.value) return null;
      const target = await bindSaved(key).catch(() => null);
      const live = readResumePointer(localStorage);
      if (live === null || !live.legacy || live.value !== pointer.value || target === null)
        return null;
      const record = readGameProgress(localStorage, target).autosave;
      return record === null ? null : { record, target };
    }
    const parsed = parseProgressLocator(pointer.value);
    if (parsed?.kind === "project") {
      if (key !== parsed.project) return null;
      const target = await bindSaved(parsed.project).catch(() => null);
      // The bind is awaited: re-read the pointer before offering. One that
      // cleared, turned legacy or moved to another locator in the wait no
      // longer names this offer — the proof it once made dies here, with
      // bytes and pointer left exactly as the writer left them.
      const live = readResumePointer(localStorage);
      if (live === null || live.legacy || live.value !== pointer.value) return null;
      if (target === null || target.locator !== live.value) return null;
      const record = readGameProgress(localStorage, target).autosave;
      return record === null ? null : { record, target };
    }
    if (parsed?.kind !== "installed") return null;
    const folder = findInstalledFolder(state.installedGames, key);
    const descriptor = (state.installedGames ?? []).find((item) => item.folder === folder);
    if (descriptor?.revision === undefined) return null;
    const target = installedProgressTarget(descriptor, descriptor.revision);
    if (target === null || target.locator !== pointer.value) return null;
    const record = readGameProgress(localStorage, target).autosave;
    return record === null ? null : { record, target };
  }

  /**
   * The routed `#play/<key>` startup resume attempt, typed so its caller
   * can tell evidence from outcome: "absent" means no proven offer stood —
   * the ordinary routed open applies; "resumed" means the strict seam
   * restored the proven record; "refused" means the attempt itself was
   * made and the runtime answered no — its result stays the runtime's to
   * show, and is never a signal to retry or boot over refused evidence.
   */
  async function routedResume(key: string): Promise<"resumed" | "absent" | "refused"> {
    const offer = await routedResumeOffer(key);
    if (offer === null) return "absent";
    if (
      offer.target.kind === "project" &&
      offer.record.game.identity.revision !== offer.target.identity.revision
    ) {
      offerLatestVersion(offer.target);
      return "refused";
    }
    const resumed = await resumeFromRecord(offer.record, llmConfig(), offer.target.locator);
    if (!resumed && state.phase === "error") offerLatestVersion(offer.target, state.error);
    return resumed ? "resumed" : "refused";
  }

  const currentCreationProjectId = ref<ProjectId>();

  function getOrCreateCreationProjectId(templateId: string): ProjectId {
    if (
      !currentCreationProjectId.value ||
      !currentCreationProjectId.value.startsWith(`${templateId}-`)
    ) {
      currentCreationProjectId.value = requireProjectId(
        `${templateId}-${crypto.randomUUID().slice(0, 8)}`,
      );
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
    cachedMeta.value = selectedProjectId.value ? getCachedGameMeta(selectedProjectId.value) : null;
  }

  async function onBootSavedGame(
    alreadyBusy = false,
    context?: number,
    expected?: ProgressTarget,
    isCurrent?: () => boolean,
  ): Promise<void> {
    if (libraryActionBusy.value && !alreadyBusy) return;
    const id = selectedProjectId.value;
    if (!id) return;
    const openingContext = selectionContext;
    if (!alreadyBusy) libraryActionBusy.value = true;
    libraryActionError.value = "";
    try {
      await resumeAudio();
      // A caller passing its captured context is booting for the intent it
      // parked: the audio wait is an await, and a selection that moved in
      // it — even back to the same id — ends that intent.
      if (context !== undefined && selectionContext !== context) return;
      if (isCurrent !== undefined && !isCurrent()) return;
      // A qualified opening re-binds the body after the audio wait: the id
      // resolving a body recreated under another epoch means the caller's
      // proven target is dead, and this call must not boot the replacement.
      if (expected !== undefined) {
        const live = await bindSaved(id).catch(() => null);
        if (context !== undefined && selectionContext !== context) return;
        if (isCurrent !== undefined && !isCurrent()) return;
        if (!bindsTarget(live, expected)) return;
      }
      await bootAuthoredGame(activeTemplate.value.rawMarkdown, llmConfig(), {
        projectId: id,
        title: cachedMeta.value?.title ?? id,
        useCached: true,
        opening: {
          ...(expected !== undefined ? { target: expected } : {}),
          isCurrent: () => selectionContext === openingContext && (isCurrent?.() ?? true),
        },
      });
    } catch (error) {
      libraryActionError.value = String(error).replace(/^Error: /, "");
    } finally {
      if (!alreadyBusy) libraryActionBusy.value = false;
    }
  }

  /**
   * The released unscoped localStorage strings a bound target lists as its
   * legacy spellings, observed through the earlier-progress read surface so
   * removal captures them verbatim. Never claimed atomic with the body's
   * records — removeProjectWithProgress re-proves the body inside its own
   * transaction.
   */
  async function observeLegacyLocal(target: ProjectProgressTarget): Promise<RawLocalEntry[]> {
    const byKey = new Map<string, RawLocalEntry>();
    for (const legacyKey of target.legacyKeys) {
      const read = await (
        await import("../project/earlierProgress.ts")
      ).readEarlierProgress({ kind: "live", legacyKey });
      if (read.kind === "live") for (const entry of read.local) byKey.set(entry.key, entry);
    }
    return [...byKey.values()];
  }

  /**
   * Remove the selected project with the progress its live body epoch owns.
   * The physical target is re-bound at admission; a stale one refuses
   * inside removeProjectWithProgress rather than deleting a body recreated
   * under the same id. The observed legacy strings travel into that
   * transaction's recovery capture and leave storage only while still
   * unchanged; the retired locator's own keys clear after. The result's
   * `recoveryId` — a real capture's id, or null when nothing needed capture —
   * goes to the caller; a refused or unselected call returns undefined.
   */
  async function onClearSavedGame(): Promise<string | null | undefined> {
    const id = selectedProjectId.value;
    if (!id) return undefined;
    const context = selectionContext;
    const target = await bindSaved(id).catch(() => null);
    if (selectionContext !== context) return undefined;
    let recoveryId: string | null = null;
    try {
      if (target === null) {
        // No live body binds: the released removal still serves an entry
        // whose body this build could not read (Start fresh on an
        // unreadable copy).
        await removeLibraryGame(id);
      } else {
        const observed = await observeLegacyLocal(target);
        if (selectionContext !== context) return undefined;
        const removed = await removeProjectWithProgress(target, observed);
        recoveryId = removed.recoveryId;
        for (const entry of observed)
          if (localStorage.getItem(entry.key) === entry.value) localStorage.removeItem(entry.key);
        await clearAutosave(removed.retiredLocator);
        clearGameSaves(localStorage, removed.retiredLocator);
        removeMapSidecar(localStorage, removed.retiredLocator);
        clearPlayerSentences(localStorage, id);
        // The released pointer spelling follows only when it names this id
        // — the pointer key alone, never the checkpoint's bytes: a record
        // changed since the capture stays.
        const pointer = readResumePointer(localStorage);
        const resolved = resolveGameHash(id);
        if (
          pointer !== null &&
          (pointer.value === id || (resolved !== null && pointer.value === resolved))
        ) {
          if (pointer.legacy) localStorage.removeItem(LEGACY_LAST_GAME_KEY);
          else clearResumePointer(localStorage, pointer.value);
        }
      }
    } catch (error) {
      libraryActionError.value = String(error).replace(/^Error: /, "");
      return undefined;
    }
    refreshLibrary();
    refreshPendingAutosave();
    return recoveryId;
  }

  function refreshLibrary(projectId?: ProjectId): void {
    savedGames.value = listCachedGames();
    void refreshUnsupportedProjects();
    if (projectId) {
      selectedProjectId.value = projectId;
    } else if (!savedGames.value.some((entry) => entry.projectId === selectedProjectId.value))
      selectedProjectId.value = savedGames.value[0]?.projectId ?? "";
    cachedMeta.value = selectedProjectId.value ? getCachedGameMeta(selectedProjectId.value) : null;
    resolveSavedTargets();
  }

  /** The idle/error phase re-reads the shelf and the resume pointer. */
  function syncMenuPhase(): void {
    refreshPendingAutosave();
    savedGames.value = listCachedGames();
    void refreshUnsupportedProjects();
    cachedMeta.value = selectedProjectId.value ? getCachedGameMeta(selectedProjectId.value) : null;
    resolveSavedTargets();
  }

  async function refreshUnsupportedProjects(): Promise<void> {
    try {
      unsupportedProjects.value = await listUnsupportedStoredProjects();
      const unsupportedIds = new Set(unsupportedProjects.value.map((entry) => entry.projectId));
      savedGames.value = savedGames.value.filter((entry) => !unsupportedIds.has(entry.projectId));
    } catch (error) {
      libraryActionError.value = `Your saved game library could not be refreshed: ${String(error).replace(/^Error: /, "")}`;
    }
  }

  const latestVersion = shallowRef<ProgressTarget>();
  function offerLatestVersion(target: ProgressTarget, cause?: string): void {
    if (target.kind !== "project") return;
    latestVersion.value = target;
    state.phase = "error";
    state.error = cause?.includes("Start the latest version?")
      ? cause
      : `${cause ?? "This play position belongs to an earlier version of the game. Your project is safe."} Start the latest version? The old position is replaced when the new run saves.`;
  }
  watch(
    () => state.phase,
    (phase) => {
      if (phase === "running" || phase === "idle") latestVersion.value = undefined;
    },
  );
  async function startLatestVersion(): Promise<void> {
    const offer = latestVersion.value;
    if (offer?.kind !== "project" || libraryActionBusy.value) return;
    const context = selectionContext;
    let target: ProjectProgressTarget | null;
    try {
      target = await bindSaved(offer.project);
    } catch (error) {
      if (selectionContext === context && latestVersion.value === offer)
        libraryActionError.value = String(error).replace(/^Error: /, "");
      return;
    }
    if (selectionContext !== context || latestVersion.value !== offer) return;
    const game = getCachedGameMeta(offer.project);
    if (target === null || game === null) {
      refreshLibrary();
      state.error = "";
      state.phase = "idle";
      return;
    }
    selectLibraryGame(game);
    await onBootSavedGame(false, selectionContext, target);
  }

  async function onPlayLibraryGame(
    game: CachedGameMeta,
    expected?: ProgressTarget,
    isCurrent?: () => boolean,
  ): Promise<void> {
    selectLibraryGame(game);
    const selected = game.projectId;
    const context = selectionContext;
    // The checkpoint answers to the live body incarnation: its target is
    // re-bound atomically with the body at admission, so a click between a
    // delete and a recreate can never resume the removed epoch's record.
    const target = await bindSaved(selected).catch(() => null);
    if (selectionContext !== context) return;
    // A caller carrying the binding it proved — an ended note's own target —
    // accepts only the live body bound to that exact instance: the id may
    // resolve a body recreated under another epoch, and that replacement
    // never answers for the note's intent.
    if (expected !== undefined && !bindsTarget(target, expected)) return;
    if (isCurrent !== undefined && !isCurrent()) return;
    const autosave = target === null ? null : projectCheckpoint(target);
    if (
      autosave !== null &&
      target !== null &&
      autosave.game.identity.revision !== target.identity.revision
    ) {
      offerLatestVersion(target);
      return;
    }
    if (target === null || autosave === null) {
      await onBootSavedGame(false, context, expected ?? target ?? undefined, isCurrent);
      return;
    }
    if (libraryActionBusy.value) return;
    libraryActionBusy.value = true;
    libraryActionError.value = "";
    try {
      await resumeAudio();
      if (selectionContext !== context) return;
      if (isCurrent !== undefined && !isCurrent()) return;
      // The audio wait is another boundary: a qualified call re-binds the
      // live body so a same-id recreation in the wait can never resume the
      // dead incarnation's intent onto the replacement.
      if (expected !== undefined) {
        const live = await bindSaved(selected).catch(() => null);
        if (selectionContext !== context) return;
        if (isCurrent !== undefined && !isCurrent()) return;
        if (!bindsTarget(live, expected)) return;
      }
      if (
        !(await resumeFromRecord(
          autosave,
          llmConfig(),
          target.locator,
          () => selectionContext === context && (isCurrent?.() ?? true),
        ))
      ) {
        if (state.phase === "error" && selectionContext === context && (isCurrent?.() ?? true))
          offerLatestVersion(target, state.error);
        refreshLibrary();
      }
    } catch (error) {
      libraryActionError.value = String(error).replace(/^Error: /, "");
    } finally {
      libraryActionBusy.value = false;
    }
  }

  const {
    profileChoiceState,
    offerImportProfileChoice,
    openLibraryProfileChoice,
    closeProfileChoice,
    applyProfileChoice,
  } = createProfileChoiceController({
    // A copy shares its original's revision, so only the project id names the running game.
    runningProjectId: () =>
      state.phase === "idle" || state.phase === "loading" || state.phase === "error"
        ? undefined
        : currentGame()?.projectId,
    flushAutosave,
    refreshLibrary,
    onPlayLibraryGame,
    reportError: (message) => (libraryActionError.value = message),
  });

  async function onStartLibraryGameOver(
    game: CachedGameMeta,
    isCurrent?: () => boolean,
  ): Promise<void> {
    selectLibraryGame(game);
    const selected = game.projectId;
    const context = selectionContext;
    await resumeAudio();
    if (selectionContext !== context) return;
    if (isCurrent !== undefined && !isCurrent()) return;
    // Re-bind at admission: only the live incarnation's own address may be
    // started over — a removed body's stale selection can never act on the
    // body recreated under its id.
    const target = await bindSaved(selected).catch(() => null);
    if (selectionContext !== context || target === null) return;
    if (isCurrent !== undefined && !isCurrent()) return;
    await startOver(target.locator, llmConfig());
  }

  async function onCheckLibraryGame(game: CachedGameMeta): Promise<void> {
    selectLibraryGame(game);
    await checkSelectedOpening();
  }

  /**
   * Make a copy of the card's game; the new project's id is the call's result —
   * the card's "Edit a copy" opens Studio on it. A busy or failed copy returns
   * undefined, so the caller can never land on the original by mistake.
   */
  async function onCopyLibraryGame(game: CachedGameMeta): Promise<ProjectId | undefined> {
    selectLibraryGame(game);
    return copySelectedGame();
  }

  async function onExportLibraryGame(game: CachedGameMeta, project = false): Promise<void> {
    // The card's id is the download's owner, captured at entry — a selection
    // that moves while the export awaits can never redirect it to another body.
    const cardId = game.projectId;
    selectLibraryGame(game);
    await onExportAgiZip(false, project, cardId);
  }

  async function onRemoveLibraryGame(game: CachedGameMeta): Promise<string | null | undefined> {
    selectLibraryGame(game);
    return onClearSavedGame();
  }

  /**
   * Stage an import. `copy` says the library already held this game under
   * another card: a project import always gets its own card, so a repeat is
   * another copy, not the first. `title` is the one its card shows — a known
   * game's own title rather than the ZIP or folder name.
   */
  async function stageLibraryGame(
    game: OpenedGame,
    title: string,
    source: "zip" | "folder",
  ): Promise<{ stored: ImportStorageReport | null; copy: boolean; title: string }> {
    const opening = await (await import("./gamePreview.ts")).previewGame(game, game.profile);
    const before = new Map(
      savedGames.value.map((entry) => [entry.projectId, entry.library?.revision]),
    );
    let stored: ImportStorageReport | null = null;
    const importedProjectId = await (
      await import("./gameLibrary.ts")
    ).addLibraryGame(
      game,
      game.title ?? title,
      source,
      opening,
      undefined,
      (report) => (stored = report),
    );
    refreshLibrary(importedProjectId);
    const entry = getCachedGameMeta(importedProjectId);
    if (entry)
      offerImportProfileChoice(entry, game.project !== undefined || game.roomGeneration === true);
    const revision = entry?.library?.revision;
    const copy =
      !before.has(importedProjectId) &&
      revision !== undefined &&
      [...before.values()].includes(revision);
    return { stored, copy, title: entry?.title ?? game.title ?? title };
  }

  /**
   * The import notice, in plain words: what was added, what came along with
   * it ("with its saved progress, map and history"), what storage refused,
   * and what it is.
   */
  function importedNotice(
    game: OpenedGame,
    { stored, copy, title }: { stored: ImportStorageReport | null; copy: boolean; title: string },
  ): string {
    const added = copy
      ? `Added another copy of ${title} to your library`
      : `${title} added to your library`;
    const { kept, refused, unconfirmed, warnings } = importedParts(game, stored);
    return [
      `${added}${kept.length ? `, with its ${listed(kept)}` : ""}.`,
      ...(refused.length ? [`Its ${listed(refused)} could not be stored.`] : []),
      ...(unconfirmed.length ? [`Its ${listed(unconfirmed)} may not have been stored.`] : []),
      ...warnings,
      ...(workInProgressNote(game) ? [workInProgressNote(game)] : []),
    ].join(" ");
  }

  /** An unfinished world this copy cannot grow stops at unbuilt rooms. */
  function workInProgressNote(game: OpenedGame): string {
    const unfinished = game.workInProgress === true || game.roomGeneration === true;
    const grows = game.project !== undefined && game.roomGeneration === true;
    return unfinished && !grows
      ? "It is a work in progress: exits to rooms not built yet stop the game."
      : "";
  }

  /** "a", "a and b", "a, b and c". */
  function listed(items: readonly string[]): string {
    return items.length < 2
      ? (items[0] ?? "")
      : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  }

  /** What a project archive brought along besides the game — and what storage refused. */
  function importedParts(
    game: OpenedGame,
    stored: ImportStorageReport | null,
  ): { kept: string[]; refused: string[]; unconfirmed: string[]; warnings: string[] } {
    const kept: string[] = [];
    const refused: string[] = [];
    const unconfirmed: string[] = [];
    const slots = Object.keys(game.progress?.saves ?? {}).map(Number);
    const slotsIn = (list: readonly number[]) => slots.filter((slot) => list.includes(slot));
    const saves = (numbers: readonly number[]) =>
      numbers.length === 1
        ? `save slot ${numbers[0]}`
        : `save slots ${listed(numbers.map(String))}`;
    const keptSlots = slotsIn(stored?.slots ?? []);
    const refusedSlots = slotsIn(stored?.failedSlots ?? []);
    const unknownSlots = slots.filter(
      (slot) => !keptSlots.includes(slot) && !refusedSlots.includes(slot),
    );
    if (game.progress?.autosave)
      (stored?.autosave ? kept : stored ? refused : unconfirmed).push("saved progress");
    if (keptSlots.length) kept.push(saves(keptSlots));
    if (refusedSlots.length) refused.push(saves(refusedSlots));
    if (unknownSlots.length) unconfirmed.push(saves(unknownSlots));
    if (game.map) (stored?.map ? kept : refused).push("map");
    if (game.history) (stored?.history ? kept : refused).push("history");
    const warnings = [game.mapWarning, game.backupWarning].filter(
      (warning): warning is string => warning !== undefined,
    );
    return { kept, refused, unconfirmed, warnings };
  }

  /** A drop that arrived while another game was being added. */
  const BUSY_DROP = "A game is still being added. Drop this one again when it is ready.";
  let droppedWhileBusy = false;

  async function onGameZip(file?: File): Promise<void> {
    if (!file || importBusy.value) return;
    importBusy.value = true;
    importError.value = droppedWhileBusy ? BUSY_DROP : "";
    importNotice.value = "";
    try {
      if (file.size > MAX_GAME_ZIP_BYTES) throw new Error("Choose a game ZIP smaller than 128 MB.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      // The archive reader loads with the import action, not with the shelf.
      const { readGameZip } = await import("../archive/gameZip.ts");
      const game = await readGameZip(bytes);
      const name = file.name.replace(/\.zip$/i, "");
      const staged = await stageLibraryGame(game, name, "zip");
      importNotice.value = importedNotice(game, staged);
    } catch (error) {
      importError.value = String(error).replace(/^Error: /, "");
    } finally {
      importBusy.value = false;
      droppedWhileBusy = false;
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
    importError.value = droppedWhileBusy ? BUSY_DROP : "";
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
      const { readGameFiles } = await import("../archive/gameZip.ts");
      const game = readGameFiles(entries);
      const firstPath = paths.keys().next().value as string | undefined;
      const title = firstPath?.split("/")[0] || "Imported game";
      const staged = await stageLibraryGame(game, title, "folder");
      importNotice.value = importedNotice(game, staged);
    } catch (error) {
      importError.value = String(error).replace(/^Error: /, "");
    } finally {
      importBusy.value = false;
      droppedWhileBusy = false;
      if (folderInput.value) folderInput.value.value = "";
    }
  }

  async function onGameDrop(dataTransfer?: DataTransfer): Promise<void> {
    if (!dataTransfer) return;
    if (importBusy.value) {
      // The Add game button waits while a game is added; a drop says so too,
      // and the note outlasts the running import's own start.
      droppedWhileBusy = true;
      importError.value = BUSY_DROP;
      return;
    }
    importBusy.value = true;
    importError.value = "";
    importNotice.value = "";
    try {
      // The drop event's file/entry handles die with its dispatch: read
      // them synchronously here, then let the lazy resolver traverse.
      const captured = captureDropHandles(dataTransfer);
      const { resolveGameDrop } = await import("./gameDrop.ts");
      const dropped: GameDrop = await resolveGameDrop(captured);
      // Each importer takes ownership of the same guard synchronously before its
      // first await, so there is no gap in which another drop can start.
      importBusy.value = false;
      if (dropped.kind === "zip") await onGameZip(dropped.file);
      else await onGameFolder(dropped.files);
    } catch (error) {
      importBusy.value = false;
      droppedWhileBusy = false;
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
      catalogOpenings.value[id] = await (
        await import("./gamePreview.ts")
      ).previewGame(game, game.profile);
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
      const projectId = await (
        await import("./gameLibrary.ts")
      ).addLibraryGame(game, entry.title, "catalog", opening, {
        id: entry.id,
        version: entry.version,
      });
      refreshLibrary(projectId);
      const context = selectionContext;
      // The stored body's own address: an imported checkpoint lands under
      // the live epoch's locator, and nothing else may name it.
      const target = await bindSaved(projectId).catch(() => null);
      if (selectionContext !== context) return;
      const autosave = target === null ? null : readGameProgress(localStorage, target).autosave;
      if (target !== null && autosave !== null) {
        await resumeAudio();
        if (selectionContext !== context) return;
        await resumeFromRecord(autosave, llmConfig(), target.locator);
      } else await onBootSavedGame(true, context);
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
    if (!selected) return;
    libraryActionError.value = "";
    libraryActionBusy.value = true;
    try {
      const game = await loadAuthoredGame(selected);
      if (!game) throw new Error("This game is missing from your library. Import it again.");
      const opening = await (
        await import("./gamePreview.ts")
      ).previewGame(game, game.library?.profile);
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

  /** Copy the selected project; returns the copy's own id, never the original's. */
  async function copySelectedGame(): Promise<ProjectId | undefined> {
    if (libraryActionBusy.value) return undefined;
    const selected = selectedProjectId.value;
    if (!selected) return undefined;
    libraryActionError.value = "";
    libraryActionBusy.value = true;
    try {
      const copied = await (await import("./gameLibrary.ts")).copyLibraryGame(selected);
      refreshLibrary(copied);
      return copied;
    } catch (error) {
      libraryActionError.value = String(error).replace(/^Error: /, "");
      return undefined;
    } finally {
      libraryActionBusy.value = false;
    }
  }

  async function onExportAgiZip(
    live = false,
    project = false,
    requestedProjectId?: ProjectId,
  ): Promise<void> {
    // The live capture is the runtime's own boot object — its immutable
    // progress binding and the interpreter it runs under — never a fresh
    // CurrentGame DTO, whose object identity says nothing.
    exportRefusal.value = "";
    if (exportBusy.value) {
      exportRefusal.value = "A download is already in progress.";
      return;
    }
    exportBusy.value = true;
    if (live && project) engine.pauseEngine("backup");
    try {
      const exportResult = live ? await exportCurrentGame() : null;
      const game = live ? getBootedGame() : null;
      const liveTarget = game?.progressTarget;
      const liveRevision = game?.revision;
      const liveProfile = live ? state.profile : null;
      const liveRemoved = game?.removed;
      const liveBehindStorage = game?.behindStorage;
      const liveStale = state.staleTab;
      const notes: string[] = [...(exportResult?.notes ?? [])];
      if (
        live &&
        project &&
        !liveRemoved &&
        !liveBehindStorage &&
        !liveStale &&
        !(await flushAutosave(2000).catch(() => false))
      )
        notes.push(
          "The latest play position was not saved. The ZIP includes it if this tab could copy it.",
        );
      if (live && getBootedGame() !== game)
        throw new Error("The game changed during download. Try again.");
      if (live && exportResult) {
        // The assembled offer must be the captured runtime's own: the same
        // binding object it resolved at entry and the same full native
        // revision it ran — a rebind or a committed change in between is a
        // different owner, not fresher bytes.
        if (
          (liveRemoved !== true && exportResult.progressTarget !== liveTarget) ||
          computeResourceRevision(exportResult.data.files) !== liveRevision
        )
          throw new Error("The game changed during download. Try again.");
      }
      // A stored body's data and its live lifetime epoch are captured in one
      // atomic read — the epoch binds every sidecar to this exact
      // incarnation, so a same-id recreate after it can never inherit this
      // download's records.
      const storedId = requestedProjectId ?? (selectedProjectId.value || undefined);
      const stored =
        exportResult || storedId === undefined
          ? null
          : await loadAuthoredGameWithHistoryLifetime(storedId);
      let data = exportResult ? exportResult.data : (stored?.data ?? null);
      if (!data) throw new Error("No saved game is available.");
      if (live && game !== null) {
        const exportProfile = liveProfileToProfileId(liveProfile);
        const library =
          data.library ??
          normalizeLibraryMetadata(undefined, {
            revision: computeResourceRevision(data.files),
            source: game.parent ? "remix" : game.installed ? "folder" : "authored",
          });
        data = {
          ...data,
          library: {
            ...library,
            ...(game.parent ? { parent: structuredClone(game.parent) } : {}),
            ...(exportProfile !== undefined ? { profile: exportProfile } : {}),
          },
        };
      }
      let storedTarget: ProjectProgressTarget | null = null;
      if (!live) {
        if (!stored || stored.lifetime === null) throw new Error("The saved project was removed.");
        // The physical owner is the loaded body's own full native revision;
        // stored metadata claiming a different one is stale, not trusted.
        const revision = await gameRevision(data.files);
        if (data.library?.revision !== undefined && data.library.revision !== revision)
          throw new Error(
            "The saved project changed since it was stored. Save it again, then try the download.",
          );
        storedTarget = projectProgressTarget(data.projectId, revision, stored.lifetime);
        if (!storedTarget)
          throw new Error("The saved project's stored identity could not be verified.");
      }
      // The one physical owner every stored sidecar reads under: the live
      // binding captured at entry, or the stored body's epoch target. No
      // bare legacy spelling or derived key ever reaches storage here.
      const ownerTarget: ProgressTarget | undefined = live
        ? liveRemoved === true || liveBehindStorage === true || liveStale
          ? undefined
          : liveTarget
        : (storedTarget ?? undefined);
      if (live && project) await engine.drainHistoryCommits();
      let recovery: Awaited<ReturnType<EngineApi["recoverHistory"]>> | null = null;
      const backupReader = project ? await import("../archive/historyBackup.ts") : null;
      let storedMetadataUnavailable = false;
      const backup = project
        ? await backupReader!.collectHistoryBackup(
            () =>
              ownerTarget === undefined
                ? Promise.resolve(null)
                : import("../history/historyStorage.ts")
                    .then(({ loadProjectHistory }) => loadProjectHistory(ownerTarget.locator))
                    .catch((cause: unknown) => {
                      storedMetadataUnavailable = true;
                      throw cause;
                    }),
            live
              ? async () => {
                  recovery = await engine.recoverHistory();
                  return recovery.batches;
                }
              : null,
          )
        : null;
      let progressReadFailed = false;
      const progress: GameProgress | undefined = project
        ? ownerTarget === undefined
          ? { saves: {}, autosave: null }
          : readGameProgress(
              {
                getItem: (key) => {
                  try {
                    return localStorage.getItem(key);
                  } catch (error) {
                    progressReadFailed = true;
                    throw error;
                  }
                },
                setItem: (key, value) => localStorage.setItem(key, value),
              },
              ownerTarget,
            )
        : undefined;
      if (progressReadFailed)
        notes.push(
          "Some saved play positions could not be read. Try downloading again to keep them.",
        );
      if (live && project && ownerTarget === undefined)
        notes.push(
          liveRemoved
            ? "Saved play positions, the map and saved play history were removed with the project."
            : "This ZIP leaves out saved play positions, the map and play history. Download them from the tab with the latest game.",
        );
      // The reply owns a current checkpoint independently of browser storage.
      const snapshot = recovery as Awaited<ReturnType<EngineApi["recoverHistory"]>> | null;
      // The runtime's actual interpreter choice is the override the archive
      // declares for reimport — independent of whether a checkpoint shipped.
      const bootProfile = live && project ? snapshot?.boot?.profile : undefined;
      if (data.library && bootProfile !== undefined && data.library.profile !== bootProfile)
        data = { ...data, library: { ...data.library, profile: bootProfile } };
      if (live && project && progress && snapshot?.boot?.image) {
        const boot = snapshot.boot;
        // The checkpoint embeds the physical target's own identity — the
        // logical project and the full native revision — never a locator
        // re-derived through projectId(), which cannot spell one.
        const identity = ownerTarget?.identity ?? {
          project: data.projectId,
          revision: computeResourceRevision(data.files),
        };
        const record: AutosaveRecord = {
          format: "monotio.agi.autosave",
          version: 1,
          image: snapshot.boot.image,
          ...(boot.menus ? { menus: boot.menus } : {}),
          cycle: snapshot.cycle,
          room: snapshot.room,
          savedAt: Date.now(),
          game: { installed: game?.installed ?? false, identity },
        };
        // The checkpoint must restore under the interpreter the archive
        // ships with, against the offered bytes — vocabulary included.
        const effectiveProfile: ProfileId | undefined =
          data.library?.profile ?? bootProfile ?? liveProfileToProfileId(liveProfile);
        if (
          checkpointBasisMatches(boot, data.files) &&
          (await autosaveRecordRestores(record, data.files, effectiveProfile))
        ) {
          progress.autosave = record;
        } else {
          notes.push(
            "This play position could not be matched to the game. Keep this tab open and try downloading again.",
          );
        }
      } else if (live && project) {
        notes.push(
          "The ZIP holds saved play positions. Keep this tab open and try downloading again for your current position.",
        );
      }
      // The map sidecar is read and detached before the remaining awaited
      // work — the archive ships the record the captured owner held, not a
      // live map that moved underneath the download. An unbound live game
      // has no stored authority and its running map answers under no proven
      // spelling, so the archive omits it and the backup report says so.
      const mapSidecar = project
        ? ownerTarget === undefined
          ? undefined
          : structuredClone(
              engine.roomMap?.storedSidecar(ownerTarget.locator) ?? storedMap(ownerTarget.locator),
            )
        : undefined;
      if (backup) {
        backup.report.notes.push(...notes);
        backup.report.complete = backup.report.notes.length === 0;
      }
      // The archive readers/writers load with the download action, not the
      // menu — a Home shelf and a Play boot never fetch them.
      const { buildProjectZip, buildPublicGameZip } = await import("../archive/projectArchive.ts");
      const zipBytes = project
        ? await buildProjectZip(
            data,
            progress,
            mapSidecar,
            backup?.history ?? undefined,
            backup?.report,
          )
        : buildPublicGameZip(data);
      // Final admission, after every awaited ZIP step and before the anchor
      // exists: the owner the archive describes must still be the same
      // physical one. The atomic re-read is admission proof only — archive
      // content came from the first capture — and everything after it is a
      // synchronous comparison, so no unguarded await can open a window.
      if (live) {
        const now = getBootedGame();
        if (now !== game || game?.progressTarget !== liveTarget)
          throw new Error("The game changed during download. Try again.");
        if (ownerTarget?.kind === "project") {
          const proof = await loadAuthoredGameWithHistoryLifetime(ownerTarget.project).catch(
            (error: unknown) => {
              if (!storedMetadataUnavailable) throw error;
              return undefined;
            },
          );
          if (
            proof !== undefined &&
            (!proof ||
              proof.lifetime !== ownerTarget.bodyEpoch ||
              proof.data.generation !== data.generation)
          )
            throw new Error("The saved project changed during download. Try again.");
        }
        // The body proof above is itself awaited. Recheck the live owner and
        // its actual bytes/profile after it, immediately before publication.
        if (
          getBootedGame() !== game ||
          game?.progressTarget !== liveTarget ||
          game?.revision !== liveRevision ||
          (game !== null && computeResourceRevision(game.files) !== liveRevision) ||
          state.profile !== liveProfile ||
          game?.removed !== liveRemoved ||
          game?.behindStorage !== liveBehindStorage ||
          state.staleTab !== liveStale
        )
          throw new Error("The game changed during download. Try again.");
      } else {
        const proof = await loadAuthoredGameWithHistoryLifetime(storedId!);
        if (
          !proof ||
          proof.lifetime !== stored!.lifetime ||
          proof.data.projectId !== data.projectId ||
          proof.data.generation !== data.generation ||
          proof.data.library?.profile !== data.library?.profile ||
          proof.data.library?.source !== data.library?.source ||
          computeResourceRevision(proof.data.files) !== storedTarget!.identity.revision
        )
          throw new Error("The saved project changed during download. Try again.");
      }
      const url = URL.createObjectURL(new Blob([zipBytes], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `agi-${data.projectId}-${project ? "project" : "game"}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      if (backup && !backup.report.complete)
        exportRefusal.value = `Downloaded the game. ${backup.report.notes.join(" ")}`;
      else if (!project && notes.length > 0)
        exportRefusal.value = `Downloaded the game. ${notes.join(" ")}`;
    } catch (error) {
      exportRefusal.value = `Download failed: ${String(error).replace(/^Error: /, "")}`;
    } finally {
      if (live && project) engine.resumeEngine("backup");
      exportBusy.value = false;
    }
  }

  /** Catalog warmup; App.vue calls it at the same onMounted point. */
  function mountCatalog(): void {
    void refreshHostedCatalog();
  }

  function unmountCatalog(): void {
    catalogGames.clear();
  }

  // The shelf's initial bind; later resolutions come only from the explicit
  // refresh and change paths above.
  resolveSavedTargets();

  return {
    savedGames,
    unsupportedProjects,
    refreshUnsupportedProjects,
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
    pendingProgressTarget,
    libraryAutosaves,
    localGames,
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
    catalogHasProgress,
    selectLibraryGame,
    beginRename,
    setTitleInput,
    saveGameTitle,
    onGameDetailsToggle,
    savedProgress,
    installedProgress,
    localAutosave,
    onPlayLocalGame,
    libraryProvenance,
    installedProvenance,
    identityTitle,
    refreshPendingAutosave,
    refreshLibrary,
    syncMenuPhase,
    onStartOver,
    onResumeAutosave,
    routedResumeOffer,
    routedResume,
    onBootSelectedTemplate,
    onBootSavedGame,
    onClearSavedGame,
    onPlayLibraryGame,
    latestVersion,
    startLatestVersion,
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
    profileChoiceState,
    openLibraryProfileChoice,
    closeProfileChoice,
    applyProfileChoice,
    onExportAgiZip,
    mountCatalog,
    unmountCatalog,
  };
}

export type GameLibrary = ReturnType<typeof createGameLibrary>;

const gameLibraryKey: InjectionKey<GameLibrary> = Symbol("agi-game-library");

export function provideGameLibrary(lib: GameLibrary): void {
  provide(gameLibraryKey, lib);
}

export function useGameLibrary(): GameLibrary {
  const lib = inject(gameLibraryKey);
  if (!lib) throw new Error("useGameLibrary: App.vue did not provide the game library");
  return lib;
}
