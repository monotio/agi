import { migrateAgentChats } from "../../../src/agent/chats.ts";
/**
 * Game lifecycle: boot (fixture / authored / stub-agent), eject, shutdown,
 * export, and the screen reset both boot and eject share. `booted` — the
 * game in the slot — lives here; every other composable reads it through
 * getBootedGame.
 */
import { continuationTranscript } from "../archive/projectConversation.ts";
import { detectKnownGame, gameRevision } from "../project/gameMetadata.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import type { AgentSession, BootResources } from "../agent/agentSession.ts";
import type { AuthoringLoader } from "../agent/authoringLoader.ts";
import type { LlmConfig } from "../agent/llmClient.ts";
import type { AgiAudio } from "../audio/AgiAudio.ts";
import {
  getCachedGameMeta,
  loadAuthoredGame,
  loadAuthoredGameWithHistoryLifetime,
  readHistoryLifetime,
  saveAuthoredGameCapture,
} from "../project/gameStorage.ts";
import {
  gameStorageKey,
  type BootedGame,
  type CurrentGame,
  type ProjectId,
} from "../project/gameTypes.ts";
import { projectId, requireProjectId } from "../../../src/gameIdentity.ts";
import { fetchFixtureFiles, resolveFixtureTarget } from "../library/gameDiscovery.ts";
import type { useAuthoringController } from "../authoring/useAuthoringController.ts";
import type { GenesisStarterRecovery } from "../authoring/genesisStarterRecovery.ts";
import {
  storageMovedPast,
  type ResumeBootCarrier,
  type FreshInstalledAdmission,
  type SelectedInstalledTarget,
  type StartOverOutcome,
  type useAutosaveController,
} from "../saves/useAutosaveController.ts";
import { bindProgressTarget } from "../project/progressBinding.ts";
import type { ProgressTarget } from "../project/progressTarget.ts";
import {
  advanceAuthoring,
  hydrateAuthoring,
  needsReload,
  ResourceCommitError,
} from "../project/projectTransaction.ts";
import type { EngineState, TextHook } from "./useEngineTypes.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import type { LogAgentFn } from "../play/useInputController.ts";
import type { useTestRecorder } from "../authoring/useTestRecorder.ts";
import type { WorkerLink } from "./useWorkerLink.ts";
import type { CachedGameData } from "../project/gameStorage.ts";
import type { WorkerInbound } from "../worker/workerProtocol.ts";
import { admitQualifiedOpening, type QualifiedGameOpening } from "./openingAdmission.ts";

/**
 * Exit's refusal while this session's timeline is still owed to storage:
 * the game is saved and still open. The shell offers leaving without the
 * timeline (`ejectGame({ abandonHistory: true })`) or staying.
 */
export class HistoryUnsavedError extends Error {
  constructor() {
    super("This session's rewind timeline is not saved yet.");
    this.name = "HistoryUnsavedError";
  }
}

export interface GameLifecycleOptions {
  readonly getAmigaRegion?: () => "ntsc" | "pal";
  readonly state: EngineState;
  readonly hook: TextHook;
  readonly audio: AgiAudio | null;
  readonly logAgent: LogAgentFn;
  readonly link: WorkerLink;
  readonly autosave: ReturnType<typeof useAutosaveController>;
  readonly authoring: ReturnType<typeof useAuthoringController> | null;
  readonly ensureAuthoring?: () => Promise<ReturnType<typeof useAuthoringController>>;
  readonly prepareRun?: () => Promise<void>;
  readonly testRecorder: ReturnType<typeof useTestRecorder>;
  readonly promptCancel: () => void;
  readonly releaseAgentAudioPreviews: () => void;
  readonly pauseEngine: (owner: string) => void;
  readonly resumeEngine: (owner: string) => void;
  /** A replaced worker takes every pause hold with it. */
  readonly resetPauseOwners: () => void;
  /** The history transport's scratch session dies with the worker. */
  readonly resetHistoryView: () => void;
  readonly flushProject?: () => Promise<void>;
  readonly pendingEditorChanges?: () => boolean;
  readonly getProjectMode?: () => "create" | "play";
  readonly getSessionId: () => number;
  readonly nextSessionId: () => number;
  readonly acquirePlayOwnership?: (game: BootedGame) => Promise<void>;
  readonly getActiveReplayRngVersion?: () => 1 | 2;
  readonly getActiveReplaySeed: () => number | null;
  readonly setActiveReplaySeed: (seed: number | null) => void;
  readonly setActiveLlmConfig: (config: LlmConfig) => void;
  /** The config the running or failed boot settled on; Open starter boots under it. */
  readonly getActiveLlmConfig: () => LlmConfig;
  /** Test seams; production composes the real loader and controller. */
  readonly loadAuthoring?: AuthoringLoader;
  readonly genesisStarterRecovery?: GenesisStarterRecovery;
  /** Test seam; production keeps installed fixtures behind the Vite dev gate. */
  readonly devFixtures?: boolean;
  readonly abortWalkthrough: () => void;
  /** Eject waits out in-flight history commits before the worker dies. */
  readonly drainHistoryCommits: () => Promise<void>;
  readonly stopHistoryWriter: () => void;
}

/**
 * An installed build fetched and prepared without touching the slot: the
 * served folder's files, dictionary, revision and identity fields, plus the
 * physical progress binding and its captured history lifetime. What installs
 * it — an ordinary boot or a start-over fresh boot — decides separately.
 */
interface PreparedInstalledGame {
  readonly game: BootedGame;
  readonly profile: ProfileId | undefined;
}

export function useGameLifecycle(options: GameLifecycleOptions) {
  const { state, hook, logAgent, link, autosave, testRecorder } = options;

  /** The game currently in the slot, or null when nothing is booted. */
  let booted: BootedGame | null = null;
  const getBootedGame = () => booted;
  const setBootedGame = (game: BootedGame | null) => {
    booted = game;
  };

  /**
   * A resume's armed worker answered restored:false, or its acknowledgement
   * timed out: retire it synchronously — terminate the worker so nothing it
   * still queues can publish, drain what asked it, clear the slot and move
   * the surface to the error. The destination's checkpoint, the resume
   * pointer and earlier sources are untouched by design: they were never
   * this worker's to change. A slot that already moved to another game —
   * or already retired — answers nothing.
   */
  function retireFailedRecovery(game: BootedGame, message: string): void {
    if (booted !== game) return;
    retireGenesisStarter();
    link.terminateWorker();
    link.drainPendingQueries(new Error("engine worker stopped"));
    options.audio?.stop();
    booted = null;
    state.phase = "error";
    state.error = message;
  }

  const loadAuthoring: AuthoringLoader =
    options.loadAuthoring ??
    (async () => (await import("../agent/authoringLoader.ts")).loadAuthoringStack());
  // The recovery controller and the seed compiler behind it stay off the
  // cold Home-Play path: the module loads with the first provider-dependent
  // Create that arms one. `lifecycleEpoch` is the synchronous supersession
  // clock, so a retire that lands while the module was still loading still
  // invalidates the run that was arming.
  let genesisStarterRecovery = options.genesisStarterRecovery ?? null;
  let lifecycleEpoch = 0;
  async function armedGenesisStarterRecovery(): Promise<GenesisStarterRecovery> {
    genesisStarterRecovery ??= (
      await import("../authoring/genesisStarterRecovery.ts")
    ).createGenesisStarterRecovery();
    return genesisStarterRecovery;
  }

  /**
   * A boot, eject or shutdown outside the armed run owns the slot: the
   * failed run's starter offer goes with its epoch.
   */
  function retireGenesisStarter(): void {
    lifecycleEpoch++;
    genesisStarterRecovery?.retire();
    state.genesisStarter = null;
  }

  function resetScreenState(): void {
    autosave.resetScreen();
    state.otherTab = false;
    state.returnProblem = "";
    state.entryProblem = "";
    state.staleTab = false;
    state.projectRemoved = false;
    // The timeline notices belong to the session that raised them.
    state.historyBlocked = null;
    state.historyRetry = null;
    state.powerUp.open = false;
    state.powerUp.busy = false;
    testRecorder.reset();
    state.walkthrough.error = "";
    options.audio?.setPaused(false);
    state.paused = false;
    state.profile = null;
    hook.profile = null;
    state.textMode = false;
    state.modal = null;
    state.showObjView = null;
    state.controls = [];
    state.inputEnabled = false;
    state.inputReady = false;
    state.holdToMove = false;
    state.waitingForKey = false;
    state.gameEdit = null;
    state.rows = [];
    options.promptCancel();
    state.soundPlaying = false;
    options.resetPauseOwners();
    options.resetHistoryView();
    state.shake = false;
    link.clearShake();
    hook.modal = null;
    hook.textMode = false;
    hook.rows = [];
    hook.paused = false;
    hook.cycle = 0;
    hook.frame = 0;
    hook.autosave = -1;
    hook.room = 0;
    hook.egoX = 0;
    hook.egoY = 0;
  }

  /**
   * Tear the engine down WITHOUT touching the autosave: the game is not being
   * left, its host module is being replaced (HMR). `ejectGame` is the
   * deliberate-departure path and waits for storage before leaving.
   */
  function shutdownEngine(): void {
    retireGenesisStarter();
    options.stopHistoryWriter();
    link.terminateWorker();
    options.audio?.stop();
    options.releaseAgentAudioPreviews();
    options.authoring?.resetSession();
    link.drainPendingQueries();
    autosave.drainFlushWaiters();
    state.debugObjects = [];
    state.debugTrace = [];
    state.debugTraceDropped = 0;
    state.debugChannels = { ownership: false, objects: false, trace: false, picture: false };
    state.debugConsumers = {
      dock: false,
      overlay: false,
      inspect: false,
      exploded: false,
      trace: false,
    };
  }

  /** Keep the selected provider and its key together; archives carry no credentials. */
  function configForGame(projectId: ProjectId, config: LlmConfig): LlmConfig {
    const cached = getCachedGameMeta(projectId);
    return cached?.provider === "stub" && !cached.imported
      ? { provider: "stub", model: "offline-stub", apiKey: "" }
      : config;
  }

  /**
   * Fetch and prepare an installed build without touching the slot: the
   * served folder's files, its parsed dictionary, the full revision of the
   * bytes that actually arrived and the physical progress binding with its
   * captured history lifetime. Nothing here retires, loads, spawns or
   * reassigns — the caller proves the slot is still its own before the
   * candidate may be installed.
   */
  async function prepareInstalledGame(query: string): Promise<PreparedInstalledGame> {
    const { target, match } = resolveFixtureTarget(state.installedGames, query);
    const files = await fetchFixtureFiles(target);
    // Parse the dictionary on the main thread; ship entries to the worker.
    const words = parseWordsTok(files["WORDS.TOK"]!).map((e) => [e.word, e.id] as [string, number]);
    const known = await detectKnownGame(files);
    const revision = await gameRevision(files);
    const folder = match?.folder ?? query;
    // The served descriptor is the instance's own identity: an export's
    // declared title and alias take precedence over the recognized-family
    // defaults its vocabulary fingerprint alone would claim.
    const alias = match?.alias ?? known?.alias ?? query;
    const title = match?.title ?? known?.title ?? folder.toUpperCase();
    const hash = match?.hash ?? target;
    const game: BootedGame = {
      installed: true,
      hash,
      alias,
      folder,
      title,
      revision,
      files,
      words,
      ...(match?.parent ? { parent: match.parent } : {}),
    };
    // The physical progress binding lands before the worker can send its
    // first history or save request: the exact served folder and the full
    // revision of the bytes actually booted — never a family alias or hash.
    const progressTarget = bindProgressTarget(game);
    // The captured lifetime is that physical locator's own receipt — the
    // record installed history writes are checked against. The saved or
    // legacy spelling under the same slug answers for another record (a
    // live body's epoch, a removal's ended receipt), so it is never this
    // instance's authority. An instance that cannot bind keeps no
    // lifetime: its writes refuse rather than mint a fabricated epoch.
    game.historyLifetime =
      progressTarget === null ? null : await readHistoryLifetime(progressTarget.locator);
    return { game, profile: match?.profile };
  }

  async function bootGame(
    query: string,
    resumeCarrier?: ResumeBootCarrier,
    requestedOpening?: QualifiedGameOpening,
  ): Promise<void> {
    const opening =
      requestedOpening === undefined
        ? undefined
        : {
            isCurrent: requestedOpening.isCurrent,
            ...(requestedOpening.target !== undefined
              ? { target: structuredClone(requestedOpening.target) }
              : {}),
          };
    if (opening !== undefined && !opening.isCurrent()) return;
    const previousGame = booted;
    const previousWorker = link.getWorker?.();
    const beforeFlush = ++lifecycleEpoch;
    await options.flushProject?.();
    if (
      beforeFlush !== lifecycleEpoch ||
      booted !== previousGame ||
      link.getWorker?.() !== previousWorker ||
      (opening !== undefined && !opening.isCurrent())
    )
      return;
    const previousSurface = { phase: state.phase, loading: state.loading, error: state.error };
    if (!autosave.beginResumeBoot(resumeCarrier)) return;
    if (!(options.devFixtures ?? import.meta.env?.DEV))
      throw new Error("Installed fixtures are development-only");
    state.loading = { title: "", generating: false };
    state.phase = "loading";
    state.error = "";
    retireGenesisStarter();
    // This boot's ownership of the slot, captured before the first await:
    // any later boot, eject or shutdown moved the epoch, and a stale
    // completion must not touch the slot, the session, audio or the worker
    // that now owns them.
    const bootEpoch = lifecycleEpoch;
    let slotGame = booted;
    let slotWorker = link.getWorker?.();
    const ownsSlot = () =>
      bootEpoch === lifecycleEpoch &&
      booted === slotGame &&
      link.getWorker?.() === slotWorker &&
      (opening === undefined || opening.isCurrent());
    const isCurrent = () =>
      ownsSlot() && (resumeCarrier === undefined || resumeCarrier.isCurrent());
    try {
      const { game, profile } = await prepareInstalledGame(query);
      // Superseded while the fixture served and hashed: the newer flow owns
      // the slot and the loading surface.
      if (!isCurrent()) return;
      state.loading = { title: game.title, generating: false };
      state.installedGames =
        state.installedGames?.map((entry) =>
          entry.folder === game.folder || (entry.folder === undefined && entry.hash === query)
            ? { ...entry, folder: game.folder, revision: game.revision }
            : entry,
        ) ?? null;

      // The resume admission runs on the prepared candidate — before the
      // worker is replaced, the session installed, or anything is
      // published: it hashes the exact bytes this boot will post and
      // re-proves its intent after the hash's await. A boot the intent
      // rejected never spawns; the previous world keeps running.
      const resumeAdmission = await autosave.takeResumeState(
        {
          game,
          files: game.files,
          isCurrent,
          ...(profile !== undefined ? { profile } : {}),
        },
        resumeCarrier,
      );
      if (resumeAdmission.status === "aborted") {
        // Validation settles its carrier before returning the refusal. Its
        // message still belongs to this slot unless another opening took it.
        if (ownsSlot() && resumeAdmission.message !== undefined) {
          state.phase = "error";
          state.error = resumeAdmission.message;
        }
        return;
      }
      if (!isCurrent()) return;

      await options.prepareRun?.();
      if (!isCurrent()) return;
      const openingAdmission = await admitQualifiedOpening(
        opening,
        game,
        game.files,
        profile,
        isCurrent,
        () => state.installedGames,
      );
      if (openingAdmission === null || !openingAdmission()) {
        if (opening !== undefined && bootEpoch === lifecycleEpoch && booted === previousGame)
          Object.assign(state, previousSurface);
        return;
      }
      if (resumeCarrier !== undefined && !resumeCarrier.isCurrent()) return;
      // A successful remix is saved as its own local game before playback resumes.
      const activeReplaySeed = options.getActiveReplaySeed();
      if (!isCurrent()) return;
      await options.acquirePlayOwnership?.(game);
      if (!isCurrent()) return;
      const w = link.spawnWorker(true);
      slotWorker = link.getWorker?.();
      options.authoring?.resetSession();
      booted = game;
      slotGame = game;
      options.audio?.useGameFiles(game.files);
      w.postMessage({
        type: "boot",
        amigaRegion: options.getAmigaRegion?.() ?? "ntsc",
        progressMode: options.getProjectMode?.() ?? "play",
        ...(options.getProjectMode?.() === "create"
          ? {
              projectMode: "create" as const,
              ...(game.authoredGame?.workspace !== undefined
                ? {
                    projectDocuments: game.authoredGame.workspace,
                    ...(game.authoredGame.projectHistory !== undefined
                      ? { projectHistory: game.authoredGame.projectHistory }
                      : {}),
                  }
                : {}),
            }
          : {}),
        sessionId: options.getSessionId(),
        ...(activeReplaySeed !== null
          ? {
              replaySeed: activeReplaySeed,
              replayRngVersion: options.getActiveReplayRngVersion?.() ?? 1,
            }
          : {}),
        soundDevice: state.soundMode === "pc-speaker" ? 0 : 1,
        files: game.files,
        words: game.words,
        autosaveFiles: true,
        ...(profile !== undefined ? { profile } : {}),
        ...(resumeAdmission.status === "restore"
          ? {
              restoreImage: resumeAdmission.restoreImage,
              ...(resumeAdmission.restoreRng !== undefined
                ? { restoreRng: resumeAdmission.restoreRng }
                : {}),
              ...(resumeAdmission.restoreMenus !== undefined
                ? { restoreMenus: resumeAdmission.restoreMenus }
                : {}),
            }
          : {}),
      } satisfies WorkerInbound);
    } catch (e) {
      if (!isCurrent()) return;
      state.phase = "error";
      state.error = String(e);
      if (resumeCarrier?.isCurrent()) throw e;
    }
  }

  /**
   * Start over's fresh installed boot. The folder's served files are fetched
   * and prepared once into a private candidate while the current world keeps
   * running — no loading surface, no starter retire, no worker swap, no
   * `booted` reassignment. After the final preparation await, the slot's
   * incarnation is re-proven and the candidate's actual physical locator
   * must be the one the selection named: the cached descriptor routed the
   * fetch but never proves the bytes. Only then — synchronously, with no
   * further await or refetch — the operation's admission re-runs, the
   * selected physical checkpoint clears, and this same candidate installs
   * and posts with an explicitly empty resume payload. A build the locator
   * did not name refuses; a slot that moved supersedes; a commit rejection
   * propagates before installation begins — all three leave the running
   * world, its checkpoint and the resume pointer untouched, and completed
   * is reported only after the candidate actually installed.
   */
  async function bootInstalledFresh(
    selected: SelectedInstalledTarget,
    admission: FreshInstalledAdmission,
  ): Promise<StartOverOutcome> {
    if (!(options.devFixtures ?? import.meta.env?.DEV))
      throw new Error("Installed fixtures are development-only");
    const bootEpoch = lifecycleEpoch;
    const previousGame = booted;
    const previousWorker = link.getWorker?.();
    const isCurrent = () =>
      bootEpoch === lifecycleEpoch &&
      booted === previousGame &&
      link.getWorker?.() === previousWorker;
    let prepared: PreparedInstalledGame;
    try {
      prepared = await prepareInstalledGame(selected.folder);
    } catch (error) {
      // A preparation failure on a slot this call no longer owns stays with
      // the dead world; while still owned, the failure reaches the caller.
      if (!isCurrent()) return { status: "superseded" };
      throw error;
    }
    if (!isCurrent()) return { status: "superseded" };
    const landed = prepared.game.progressTarget;
    if (landed?.kind !== "installed" || landed.locator !== selected.locator)
      return { status: "refused" };
    if (!admission.admitted({ kind: "installed", locator: landed.locator, folder: landed.folder }))
      return { status: "superseded" };
    // Finish fallible preparation while the selected checkpoint and prior
    // worker remain intact. Re-prove admission after ownership settles;
    // commit and installation then run synchronously.
    await options.flushProject?.();
    if (
      !isCurrent() ||
      !admission.admitted({ kind: "installed", locator: landed.locator, folder: landed.folder })
    )
      return { status: "superseded" };
    await options.prepareRun?.();
    if (!isCurrent()) return { status: "superseded" };
    if (!admission.admitted({ kind: "installed", locator: landed.locator, folder: landed.folder }))
      return { status: "superseded" };
    try {
      await options.acquirePlayOwnership?.(prepared.game);
    } catch (error) {
      if (
        !isCurrent() ||
        !admission.admitted({ kind: "installed", locator: landed.locator, folder: landed.folder })
      )
        return { status: "superseded" };
      throw error;
    }
    if (!isCurrent()) return { status: "superseded" };
    if (!admission.admitted({ kind: "installed", locator: landed.locator, folder: landed.folder }))
      return { status: "superseded" };
    admission.commit();
    try {
      retireGenesisStarter();
      const activeReplaySeed = options.getActiveReplaySeed();
      const w = link.spawnWorker(true);
      options.authoring?.resetSession();
      booted = prepared.game;
      options.audio?.useGameFiles(prepared.game.files);
      w.postMessage({
        type: "boot",
        amigaRegion: options.getAmigaRegion?.() ?? "ntsc",
        progressMode: options.getProjectMode?.() ?? "play",
        ...(options.getProjectMode?.() === "create"
          ? {
              projectMode: "create" as const,
              ...(prepared.game.authoredGame?.workspace !== undefined
                ? {
                    projectDocuments: prepared.game.authoredGame.workspace,
                    ...(prepared.game.authoredGame.projectHistory !== undefined
                      ? { projectHistory: prepared.game.authoredGame.projectHistory }
                      : {}),
                  }
                : {}),
            }
          : {}),
        sessionId: options.getSessionId(),
        ...(activeReplaySeed !== null
          ? {
              replaySeed: activeReplaySeed,
              replayRngVersion: options.getActiveReplayRngVersion?.() ?? 1,
            }
          : {}),
        soundDevice: state.soundMode === "pc-speaker" ? 0 : 1,
        files: prepared.game.files,
        words: prepared.game.words,
        autosaveFiles: true,
        ...(prepared.profile !== undefined ? { profile: prepared.profile } : {}),
        restoreImage: "",
      } satisfies WorkerInbound);
    } catch (e) {
      state.phase = "error";
      state.error = String(e);
      throw e;
    }
    return { status: "completed" };
  }

  /**
   * Seal this session's timeline before its worker dies: end the open
   * segment and wait until every batch it still owes storage is durable.
   * The open batch lives only in the worker, so anything that replaces or
   * stops the worker (Exit, Start over) seals first or loses it. Throws
   * HistoryUnsavedError when the tail cannot be made durable.
   */
  async function sealHistory(): Promise<void> {
    // A reply certifies that every queued history batch is durable. A
    // timeout says nothing about worker health: preserve its recovery bytes.
    // Commits already in flight settle first: one may be the refusal that
    // says the tape can never be stored.
    await options.drainHistoryCommits();
    // A removed or stale project's timeline has no current write authority.
    if (
      state.historyBlocked ||
      (booted !== null && (storageMovedPast(booted) || needsReload(booted)))
    )
      return;
    try {
      await link.query("historyEnd", {}, 10_000);
      await options.drainHistoryCommits();
    } catch {
      if (!state.historyBlocked) throw new HistoryUnsavedError();
    }
  }

  /**
   * Leave the game: save it, then wait until this session's timeline is
   * durable. `abandonUnsaved` leaves without the latest progress checkpoint,
   * `abandonHistory` without the timeline. A timeline storage can never
   * take (`state.historyBlocked`) never holds Exit — the game itself saved.
   */
  async function ejectGame(ejectOptions?: {
    abandonUnsaved?: boolean;
    abandonProject?: boolean;
    abandonHistory?: boolean;
  }): Promise<void> {
    if (state.leaving || state.powerUp.busy) return;
    state.leaving = true;
    // Departure owns both clocks before persistence/history can suspend.
    retireGenesisStarter();
    const ejectEpoch = lifecycleEpoch;
    autosave.beginResumeBoot();
    try {
      if (!ejectOptions?.abandonProject) await options.flushProject?.();
      if (ejectEpoch !== lifecycleEpoch) {
        state.leaving = false;
        return;
      }
      options.pauseEngine("eject");
      const game = booted;
      const session = options.authoring?.getSession() ?? null;
      // Behind storage (another tab committed a newer revision) this game's
      // files, conversation and checkpoint describe bytes storage no longer
      // holds; after another tab's authoring edit, its session describes
      // authoring storage no longer holds. Nothing is saved over the newer
      // project — found now or by the save itself — and leaving is fine.
      if (
        !ejectOptions?.abandonProject &&
        game &&
        session &&
        !storageMovedPast(game) &&
        !needsReload(game) &&
        (!game.installed || options.authoring?.isRemixNeedsSave())
      ) {
        const files = await link.query("exportFiles");
        if (!files)
          throw new Error(
            "The current game could not be saved. Try Settings → This game → Download… before leaving.",
          );
        await options.authoring!.persistRemix(game, session, files).catch((error: unknown) => {
          if (!(error instanceof ResourceCommitError && error.code === "stale")) throw error;
        });
      }
      // Only a storage failure or a timeout puts progress at risk. A moment
      // the interpreter cannot checkpoint (a live prompt, text mode, a text
      // window the game keeps up while it runs on) leaves with the last save
      // point, and the timeline sealed below holds the rest.
      if (
        !ejectOptions?.abandonUnsaved &&
        !(game !== null && (storageMovedPast(game) || needsReload(game)))
      ) {
        const flushResult = await autosave.flushAutosaveDetailed(2000);
        if (flushResult.status === "storage_failure") {
          throw new Error(
            "Browser storage could not save latest progress. Use Settings → This game → Download… for a development backup, or leave with previously saved progress.",
          );
        } else if (flushResult.status === "timeout") {
          throw new Error(
            "Autosave timed out. Try again, use Settings → This game → Download… for a development backup, or leave with previously saved progress.",
          );
        }
      }
    } catch (error) {
      state.leaving = false;
      options.resumeEngine("eject");
      throw error;
    }
    try {
      if (ejectOptions?.abandonHistory) await options.drainHistoryCommits();
      else await sealHistory();
    } catch (error) {
      state.leaving = false;
      options.resumeEngine("eject");
      throw error;
    }
    state.leaving = false;
    options.abortWalkthrough();
    options.promptCancel();
    options.nextSessionId();
    link.drainPendingQueries();
    state.walkthrough.active = false;
    state.walkthrough.status = "stopped";
    options.setActiveReplaySeed(null);
    // Keep the player's saved position available from the menu.
    autosave.reset();
    options.stopHistoryWriter();
    link.terminateWorker();
    options.audio?.stop();
    options.authoring?.resetSession();
    booted = null;
    state.paused = false;
    state.powerUp = {
      mode: "remix",
      messages: [],
      open: false,
      needsConfig: false,
      busy: false,
      feedStart: 0,
      reply: "",
      room: 0,
      error: "",
    };
    state.phase = "idle";
    state.error = "";
    state.status = "";
    retireGenesisStarter();
    resetScreenState();
  }

  /**
   * The game ran `quit`. Its interpreter has stopped, so no new autosave is
   * taken: the one saved before the quit stays the one to continue. Play
   * returns Home, which says the game ended.
   */
  async function gameQuit(): Promise<void> {
    const game = booted;
    if (!game) return;
    // The ended note carries the game's logical identity — a saved body's
    // id or an installed edition's bound minted/folder id — never a colon
    // locator, and the physical target beside it for the surfaces that
    // resolve its exact instance. An unbound game keeps the released
    // spelling for its library match.
    const ended = {
      projectId: game.progressTarget?.identity.project ?? gameStorageKey(game),
      title: game.title,
      ...(game.progressTarget === undefined ? {} : { progressTarget: game.progressTarget }),
    };
    try {
      await ejectGame({ abandonUnsaved: true });
    } catch (error) {
      logAgent("log", `Leaving the ended game failed: ${String(error)}`);
      return;
    }
    state.gameEnded = ended;
  }

  /**
   * The tail both create flows share once resources exist: record the
   * project, put the game in the slot, then boot a fresh worker with it. The
   * direct flow reaches it after startGenesis; the map's plan review reaches
   * it through the build turn after the player approves the draft.
   */
  async function finishAuthoredBoot(
    session: AgentSession,
    resources: BootResources,
    boot: {
      projectId: ProjectId;
      templateId?: string | undefined;
      title: string;
      config: LlmConfig;
    },
    epoch?: number,
    intent?: () => boolean,
  ): Promise<void> {
    const bootEpoch = epoch ?? lifecycleEpoch;
    let slotGame = booted;
    let slotWorker = link.getWorker?.();
    const isCurrent = () =>
      bootEpoch === lifecycleEpoch &&
      booted === slotGame &&
      link.getWorker?.() === slotWorker &&
      (intent?.() ?? true);
    const { files, words, transcript, sessionId } = resources;
    const { projectId, templateId, title, config } = boot;
    const authoringState = session.getAuthoringState();
    let authoredGame: CachedGameData = {
      projectId,
      templateId,
      title,
      authoredAt: new Date().toISOString(),
      provider: config.provider,
      model: config.model,
      files,
      words,
      transcript,
      sessionId,
      authoringState,
      roomGeneration: true,
    };
    const known = await detectKnownGame(files);
    if (!isCurrent()) return;
    const revision = await gameRevision(files);
    // Superseded while detection and hashing ran: the newer flow owns the
    // slot, and this world's first save goes with the run that was retired.
    if (!isCurrent()) return;
    authoredGame.chats = migrateAgentChats({
      ...authoredGame,
      transcript: transcript?.length
        ? transcript
        : session.getMessages().map((message) => ({ ...message })),
    });
    if (!authoredGame.chats.chats.length) {
      authoredGame.chats.chats.push({
        id: "genesis",
        title: `Created ${title}`,
        provider: config.provider,
        model: config.model,
        transcript: [],
        messages: [{ id: "genesis-result", role: "assistant", text: `Created ${title}` }],
      });
      authoredGame.chats.active = "genesis";
    }
    if (authoredGame.chats.chats[0]) authoredGame.chats.chats[0].title = `Created ${title}`;
    const saved = await saveAuthoredGameCapture(projectId, {
      templateId,
      title,
      provider: config.provider,
      model: config.model,
      files,
      words,
      transcript,
      sessionId,
      authoringState,
      chats: authoredGame.chats,
      roomGeneration: true,
    });
    const historyLifetime = saved?.lifetime ?? null;
    if (saved !== null) authoredGame = saved.data;
    if (!isCurrent()) return;
    if (historyLifetime === null)
      logAgent(
        "error",
        "Browser storage could not save this world. Use Settings → This game → Download… to keep it.",
      );
    if (historyLifetime !== null)
      logAgent(
        "log",
        `Saved the world and its authoring conversation in this browser (${projectId}).`,
      );

    await options.flushProject?.();
    if (!isCurrent()) return;
    await options.prepareRun?.();
    if (!isCurrent()) return;
    const w = link.spawnWorker();
    slotWorker = link.getWorker?.();
    const game: BootedGame = {
      installed: false,
      projectId,
      alias: known?.alias,
      title,
      revision,
      files,
      words,
      authoredGame,
      historyLifetime,
    };
    // The epoch the body's own save returned binds the physical progress
    // target before the worker can send its first history or save request.
    bindProgressTarget(game);
    booted = game;
    slotGame = game;
    try {
      await options.acquirePlayOwnership?.(game);
    } catch (error) {
      if (!isCurrent()) return;
      throw error;
    }
    if (!isCurrent()) return;
    // The world's first record is this tab's own authoring content.
    advanceAuthoring(game, authoringState);
    let authoring = options.authoring;
    if (!authoring) {
      try {
        authoring = await options.ensureAuthoring!();
      } catch (error) {
        if (!isCurrent()) return;
        throw error;
      }
      if (!isCurrent()) return;
    }
    authoring.attachSessionRuntime(session, game);

    const activeReplaySeed = options.getActiveReplaySeed();
    options.audio?.useGameFiles(files);
    w.postMessage({
      type: "boot",
      amigaRegion: options.getAmigaRegion?.() ?? "ntsc",
      progressMode: options.getProjectMode?.() ?? "play",
      projectMode: "create",
      sessionId: options.getSessionId(),
      soundDevice: state.soundMode === "pc-speaker" ? 0 : 1,
      files,
      words,
      autosaveFiles: true,
      authorRooms: true,
      ...(activeReplaySeed !== null
        ? {
            replaySeed: activeReplaySeed,
            replayRngVersion: options.getActiveReplayRngVersion?.() ?? 1,
          }
        : {}),
    } satisfies WorkerInbound);
    // The baseline lands on the tape only now — attachSessionRuntime's post
    // ran before the segment existed. A rewind to before the first commit
    // restores exactly this state.
    authoring.postSessionSnapshot(session);
  }

  /**
   * Boot an agent-authored adventure using the unified AgentSession.
   * Can run either with live LLM (Anthropic / OpenAI) or offline deterministic stub.
   */
  async function bootAuthoredGame(
    templateMarkdown: string,
    config: LlmConfig,
    bootOptions?: {
      projectId?: ProjectId;
      templateId?: string;
      title?: string;
      useCached?: boolean;
      overwrite?: boolean;
      resumeCarrier?: ResumeBootCarrier;
      opening?: QualifiedGameOpening;
    },
  ): Promise<void> {
    const requestedOpening = bootOptions?.opening;
    const opening =
      requestedOpening === undefined
        ? undefined
        : {
            isCurrent: requestedOpening.isCurrent,
            ...(requestedOpening.target !== undefined
              ? { target: structuredClone(requestedOpening.target) }
              : {}),
          };
    if (opening !== undefined && !opening.isCurrent()) return;
    const previousGame = booted;
    const previousWorker = link.getWorker?.();
    const beforeFlush = ++lifecycleEpoch;
    await options.flushProject?.();
    if (
      beforeFlush !== lifecycleEpoch ||
      booted !== previousGame ||
      link.getWorker?.() !== previousWorker ||
      (opening !== undefined && !opening.isCurrent())
    )
      return;
    const previousSurface = { phase: state.phase, loading: state.loading, error: state.error };
    const resumeCarrier = bootOptions?.resumeCarrier;
    if (!autosave.beginResumeBoot(resumeCarrier)) return;
    const resumed = bootOptions?.useCached && bootOptions.projectId;
    state.loading = {
      title: bootOptions?.title || (resumed ? (getCachedGameMeta(resumed)?.title ?? "") : ""),
      generating: !bootOptions?.useCached,
    };
    state.phase = "loading";
    state.error = "";
    retireGenesisStarter();
    // This boot's identity, captured synchronously before the first awaited
    // admission — any later boot, eject or shutdown that moved the epoch owns
    // the slot, and this flow must stop before it mutates the session, arms
    // recovery or issues its provider request.
    const bootEpoch = lifecycleEpoch;
    let slotGame = booted;
    let slotWorker = link.getWorker?.();
    const ownsSlot = () =>
      bootEpoch === lifecycleEpoch &&
      booted === slotGame &&
      link.getWorker?.() === slotWorker &&
      (opening === undefined || opening.isCurrent());
    const isCurrent = () =>
      ownsSlot() && (resumeCarrier === undefined || resumeCarrier.isCurrent());
    let genesisRun: {
      recovery: GenesisStarterRecovery;
      run: number;
    } | null = null;
    try {
      let projectId = bootOptions?.projectId || requireProjectId("custom");
      const title = bootOptions?.title || projectId;
      const templateId = bootOptions?.templateId;

      if (bootOptions?.useCached) {
        // Start the authoring stack's download while storage reads the world.
        if (getCachedGameMeta(projectId)?.roomGeneration) void loadAuthoring().catch(() => {});
        const loaded = await loadAuthoredGameWithHistoryLifetime(projectId);
        // Superseded while storage answered: the newer flow owns the slot,
        // the session and the worker this boot would still spawn.
        if (!isCurrent()) return;
        const cached = loaded?.data;
        const historyLifetime = loaded?.lifetime ?? null;
        if (cached) {
          logAgent(
            "log",
            `⚡ Booting saved world for "${cached.title}" (authored ${new Date(cached.authoredAt).toLocaleTimeString()}${cached.transcript ? `, ${cached.transcript.length} saved messages` : ""})`,
          );
          const cachedConfig = configForGame(projectId, config);
          const isConfigured =
            cachedConfig.provider === "stub" || Boolean(cachedConfig.apiKey.trim());
          const canAuthor = Boolean(cached.roomGeneration);
          // A world that writes its rooms boots with its session, so the
          // authoring stack loads with it; if the stack cannot load, the game
          // still plays and its first new room retries.
          const stack =
            canAuthor && isConfigured
              ? await loadAuthoring().catch((error: unknown) => {
                  logAgent("error", String(error));
                  return null;
                })
              : null;
          // A boot superseded while the stack loaded owns nothing: bail
          // before its session can replace the newer flow's.
          if (!isCurrent()) return;
          const known = await detectKnownGame(cached.files);
          if (!isCurrent()) return;
          const revision = await gameRevision(cached.files);
          if (!isCurrent()) return;
          const cachedSession = stack
            ? stack.AgentSession.fromAuthoredData(
                cachedConfig,
                logAgent,
                cached.files,
                cached.words,
                continuationTranscript(cached, cachedConfig.provider, cachedConfig.model),
                cached.provider === cachedConfig.provider && cached.model === cachedConfig.model
                  ? cached.sessionId
                  : undefined,
                cached.authoringState,
                cached.library?.profile,
              )
            : null;
          const game: BootedGame = {
            installed: false,
            projectId,
            alias: known?.alias,
            title: cached.title ?? known?.title ?? title,
            revision,
            files: cached.files,
            words: cached.words,
            authoredGame: cached,
            historyLifetime,
          };
          // The physical progress binding lands before the worker can send
          // its first history or save request: the id plus the live body
          // epoch storage answered in the same atomic snapshot.
          bindProgressTarget(game);
          // The same admission-before-replacement as the installed boot:
          // the resume intent is proven against the cached body's bytes and
          // epoch binding before the worker, session or slot can move. A
          // boot the intent rejected never spawns.
          const resumeAdmission = await autosave.takeResumeState(
            {
              game,
              files: cached.files,
              isCurrent,
              ...(cached.library?.profile !== undefined ? { profile: cached.library.profile } : {}),
            },
            resumeCarrier,
          );
          if (resumeAdmission.status === "aborted") {
            if (ownsSlot() && resumeAdmission.message !== undefined) {
              state.phase = "error";
              state.error = resumeAdmission.message;
            }
            return;
          }
          if (!isCurrent()) return;
          await options.prepareRun?.();
          if (!isCurrent()) return;
          const openingAdmission = await admitQualifiedOpening(
            opening,
            game,
            cached.files,
            cached.library?.profile,
            isCurrent,
          );
          if (openingAdmission === null || !openingAdmission()) {
            if (opening !== undefined && bootEpoch === lifecycleEpoch && booted === previousGame)
              Object.assign(state, previousSurface);
            return;
          }
          if (resumeCarrier !== undefined && !resumeCarrier.isCurrent()) return;
          options.setActiveLlmConfig(cachedConfig);
          if (cachedSession && !options.authoring) {
            await options.ensureAuthoring!();
            if (!isCurrent()) return;
          }
          options.authoring?.setSession(cachedSession);
          if (!isCurrent()) return;
          await options.acquirePlayOwnership?.(game);
          if (!isCurrent()) return;
          const w = link.spawnWorker(true);
          slotWorker = link.getWorker?.();
          // The authoring content this boot read is the tab's base for it.
          hydrateAuthoring(game, cached.authoringState);
          booted = game;
          slotGame = game;
          if (cachedSession) {
            options.authoring!.attachSessionRuntime(cachedSession, game);
          }
          const activeReplaySeed = options.getActiveReplaySeed();
          options.audio?.useGameFiles(cached.files);
          w.postMessage({
            type: "boot",
            amigaRegion: options.getAmigaRegion?.() ?? "ntsc",
            progressMode: options.getProjectMode?.() ?? "play",
            ...(options.getProjectMode?.() === "create"
              ? {
                  projectMode: "create" as const,
                  ...(cached.workspace !== undefined
                    ? {
                        projectDocuments: cached.workspace,
                        ...(cached.projectHistory !== undefined
                          ? { projectHistory: cached.projectHistory }
                          : {}),
                      }
                    : {}),
                }
              : {}),
            sessionId: options.getSessionId(),
            ...(activeReplaySeed !== null
              ? {
                  replaySeed: activeReplaySeed,
                  replayRngVersion: options.getActiveReplayRngVersion?.() ?? 1,
                }
              : {}),
            soundDevice: state.soundMode === "pc-speaker" ? 0 : 1,
            files: cached.files,
            words: cached.words,
            autosaveFiles: true,
            authorRooms: Boolean(cached.roomGeneration),
            ...(cached.library?.profile ? { profile: cached.library.profile } : {}),
            ...(resumeAdmission.status === "restore"
              ? {
                  restoreImage: resumeAdmission.restoreImage,
                  ...(resumeAdmission.restoreRng !== undefined
                    ? { restoreRng: resumeAdmission.restoreRng }
                    : {}),
                  ...(resumeAdmission.restoreMenus !== undefined
                    ? { restoreMenus: resumeAdmission.restoreMenus }
                    : {}),
                }
              : {}),
          } satisfies WorkerInbound);
          // Same baseline as a fresh boot — posted after the segment opens.
          if (cachedSession) options.authoring!.postSessionSnapshot(cachedSession);
          return;
        }
        throw new Error(
          "This saved game is missing from this browser. Import it again or choose a catalog game.",
        );
      }

      if (!bootOptions?.overwrite && (await loadAuthoredGame(projectId))) {
        let safeId = projectId;
        do safeId = requireProjectId(`${projectId}-${crypto.randomUUID().slice(0, 8)}`);
        while (await loadAuthoredGame(safeId));
        projectId = safeId;
      }

      // Superseded while storage answered: the newer flow owns the settled
      // provider/model selection too.
      if (!isCurrent()) return;
      options.setActiveLlmConfig(config);
      const stack = await loadAuthoring();
      // A boot superseded while the stack loaded owns nothing: bail before
      // its session can replace the newer flow's.
      if (!isCurrent()) return;
      const genesisSession = new stack.AgentSession(config, logAgent);
      const authoring = options.authoring ?? (await options.ensureAuthoring!());
      if (!isCurrent()) return;
      authoring.setSession(genesisSession);
      // A provider-dependent run keeps the canonical Starter prepared beside
      // it — armed before the first request — so a refusal or cancel can
      // offer "Open starter" on the error surface. The deterministic offline
      // stub needs none; it cannot fail its way here.
      if (config.provider !== "stub") {
        const recovery = await armedGenesisStarterRecovery();
        if (!isCurrent()) return;
        const run = await recovery.begin(title);
        // The seed prepared while a newer action took the slot: the retired
        // run's provider request must never be issued.
        if (!isCurrent() || recovery.superseded(run)) return;
        genesisRun = { recovery, run };
      }
      const resources = await genesisSession.startGenesis(templateMarkdown);
      if (!isCurrent()) return;
      if (genesisRun !== null) {
        // A run superseded while its request was in flight owns nothing: its
        // late result must not boot or save over what took the slot.
        if (!isCurrent() || genesisRun.recovery.superseded(genesisRun.run)) return;
        genesisRun.recovery.handedOver(genesisRun.run);
        genesisRun = null;
      }
      await finishAuthoredBoot(
        genesisSession,
        resources,
        {
          projectId,
          templateId,
          title,
          config,
        },
        bootEpoch,
        () =>
          (opening === undefined || opening.isCurrent()) &&
          (resumeCarrier === undefined || resumeCarrier.isCurrent()),
      );
    } catch (e) {
      // A delayed failure from a run another action superseded belongs to no
      // screen: the newer flow owns the phase, whether or not the retired
      // flow had reached its arming.
      if (
        (bootOptions?.useCached
          ? !isCurrent()
          : bootEpoch !== lifecycleEpoch ||
            (opening !== undefined && !opening.isCurrent()) ||
            (resumeCarrier !== undefined && !resumeCarrier.isCurrent())) ||
        (genesisRun !== null && genesisRun.recovery.superseded(genesisRun.run))
      )
        return;
      state.phase = "error";
      state.error = String(e);
      if (resumeCarrier?.isCurrent()) throw e;
      if (genesisRun !== null) {
        const offer = genesisRun.recovery.fail(genesisRun.run);
        if (offer !== null) state.genesisStarter = offer;
      }
    }
  }

  /**
   * Home's "Open starter" after a failed or cancelled Create: commits the
   * retained canonical Starter once — no provider, no key — and opens it as
   * an ordinary manual project through the usual saved-game boot. The epoch
   * and the opening flag keep stale, late and double clicks settling once.
   */
  async function openStarterRecovery(): Promise<void> {
    const recovery = genesisStarterRecovery;
    const offer = recovery?.pending() ?? null;
    const shown = state.genesisStarter;
    if (
      recovery === null ||
      offer === null ||
      shown === null ||
      shown.opening ||
      state.phase !== "error"
    )
      return;
    shown.opening = true;
    let projectId: ProjectId | null;
    try {
      projectId = await recovery.open(offer);
    } catch (e) {
      shown.opening = false;
      // A save refused after a newer action retired the offer belongs to no
      // screen: the new owner keeps its error, phase and offer untouched.
      // Only a still-owned refusal earns the retryable save message.
      if (recovery.pending() !== offer || state.phase !== "error") return;
      const detail = String(e)
        .replace(/^Error: /, "")
        .replace(/\.+$/, "");
      state.error = detail
        ? `Could not save the starter: ${detail}. Try again.`
        : "Could not save the starter. Try again.";
      return;
    }
    // Superseded while the commit was in flight: the starter stays saved in
    // the library, unopened; the newer flow keeps the slot.
    if (projectId === null || recovery.pending() !== offer || state.phase !== "error") {
      shown.opening = false;
      return;
    }
    // The failed run's session never built this project; the explicit
    // selection discards it now.
    options.authoring?.resetSession();
    await bootAuthoredGame("", options.getActiveLlmConfig(), {
      projectId,
      title: offer.title,
      useCached: true,
    });
  }

  /**
   * Boot the deterministic stub agent game (eval harness / Playwright baseline).
   */
  async function bootAgentGame(): Promise<void> {
    const stubConfig: LlmConfig = {
      provider: "stub",
      apiKey: "",
      model: "offline-stub",
    };
    return bootAuthoredGame("", stubConfig);
  }

  /** Whether this development environment offers the original game files. */
  function isInstalledGame(query: string): boolean {
    const norm = query.toLowerCase();
    return (state.installedGames ?? []).some(
      (entry) =>
        entry.hash.toLowerCase() === norm ||
        entry.alias.toLowerCase() === norm ||
        entry.wordsSha256?.toLowerCase() === norm ||
        entry.revision?.toLowerCase() === norm ||
        entry.folder?.toLowerCase() === norm,
    );
  }

  /** The game currently in the slot, or null when nothing is booted. */
  function currentGame(): CurrentGame | null {
    return booted
      ? {
          installed: booted.installed,
          title: booted.title,
          workInProgress:
            booted.authoredGame?.roomGeneration === true ||
            booted.authoredGame?.library?.workInProgress === true,
          revision: booted.revision,
          hash: booted.hash,
          alias: booted.alias,
          projectId: booted.projectId,
          folder: booted.folder,
          parent: booted.parent,
          progressTarget: booted.progressTarget,
        }
      : null;
  }

  /**
   * The running game as a downloadable record, plus the physical progress
   * binding it holds. `progressKey` keeps the released shape — the bound
   * target's locator — and `progressTarget` carries the typed identity so
   * consumers never re-derive an address from a spelling. A game whose
   * saved body is gone (a removed project) still exports its in-memory
   * bytes, but carries no binding: `progressKey` is then only the
   * historical storage spelling, and grants no progress write or adoption.
   */
  async function exportCurrentGame(): Promise<{
    data: CachedGameData;
    progressKey: string;
    progressTarget: ProgressTarget | undefined;
    notes: string[];
  }> {
    if (state.powerUp.busy || state.phase !== "running")
      throw new Error("Wait for the current authoring turn to finish before saving.");
    const game = booted;
    if (!game) throw new Error("No game is running.");
    const notes: string[] = [];
    try {
      await options.flushProject?.();
    } catch {
      notes.push(
        "The ZIP holds the game and edits already added to it. Use Download unsaved edits to keep the rest.",
      );
    }
    if (options.pendingEditorChanges?.())
      notes.push("Your unsaved edits are not in it: use Download unsaved edits.");
    if (game.removed) notes.push("The game is from this tab before the project was removed.");
    else if (needsReload(game)) notes.push("The game is from before the changes in the other tab.");
    if (game !== booted) throw new Error("The game changed during download. Try again.");
    const progressTarget = game.progressTarget;
    const session = options.authoring?.getSession() ?? null;
    const data: CachedGameData | null = game.installed
      ? {
          // The bound target's logical id — the folder spelling when it is
          // one, the minted `installed-<digest>` otherwise — never the
          // locator, an alias or a shared vocabulary hash.
          projectId:
            progressTarget?.identity.project ??
            projectId(game.alias) ??
            projectId(game.hash) ??
            requireProjectId("installed"),
          title: game.title,
          provider: "stub",
          model: state.profile ?? "unknown",
          authoredAt: "",
          files: game.files,
          words: game.words,
        }
      : ((notes.length > 0
          ? game.authoredGame
          : ((await loadAuthoredGame(game.projectId!).catch(() => null)) ?? game.authoredGame)) ??
        null);
    if (!data) throw new Error("The current game metadata is unavailable.");
    const files = await link.query("exportFiles");
    // The binding captured before the storage and worker reads must still
    // be the running game's in full — a superseded boot owns the slot now,
    // and a rebound target is not this export's: a Keep advancing the bound
    // revision keeps the same owner object and saved-body locator, so the
    // logical project and full revision are compared beside the locator.
    // An unbound game (a removed saved body) compares equal on both sides
    // and still exports its in-memory bytes.
    const bound = game.progressTarget;
    if (
      !files ||
      booted !== game ||
      bound?.locator !== progressTarget?.locator ||
      bound?.identity.project !== progressTarget?.identity.project ||
      bound?.identity.revision !== progressTarget?.identity.revision
    )
      throw new Error("The game changed during export. Try again.");
    // The download is the running game as it stands; storage is not written.
    // Every resource write already saved its files before installing them,
    // so a running game that differs from the record is behind it (a Keep
    // it never loaded, a save from another tab), and writing its files back
    // would roll that newer save back.
    const words = files["WORDS.TOK"]
      ? parseWordsTok(files["WORDS.TOK"]).map(({ word, id }) => [word, id] as [string, number])
      : game.words;
    const authoring = options.authoring ?? (await options.ensureAuthoring!());
    const assembled = authoring.assembleExportData(data, { ...game, words }, session, files);
    const progressKey = progressTarget?.locator ?? gameStorageKey(game);
    return { data: assembled, progressKey, progressTarget, notes };
  }

  return {
    getBootedGame,
    setBootedGame,
    resetScreenState,
    shutdownEngine,
    configForGame,
    bootGame,
    bootInstalledFresh,
    bootAuthoredGame,
    finishAuthoredBoot,
    openStarterRecovery,
    bootAgentGame,
    ejectGame,
    sealHistory,
    gameQuit,
    isInstalledGame,
    currentGame,
    exportCurrentGame,
    retireFailedRecovery,
  };
}
