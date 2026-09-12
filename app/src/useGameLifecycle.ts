/**
 * Game lifecycle: boot (fixture / authored / stub-agent), eject, shutdown,
 * export, and the screen reset both boot and eject share. `booted` — the
 * game in the slot — lives here; every other composable reads it through
 * getBootedGame.
 */
import { continuationTranscript } from "./projectArchive.ts";
import { detectKnownGame, gameRevision, updateBootedResources } from "./gameMetadata.ts";
import { parseWordsTok } from "../../src/logic/words.ts";
import { AgentSession } from "./agent/agentSession.ts";
import type { LlmConfig } from "./agent/llmClient.ts";
import type { AgiAudio } from "./audio/AgiAudio.ts";
import {
  getCachedGameMeta,
  loadAuthoredGame,
  saveAuthoredGame,
  updateAuthoredGameFiles,
} from "./gameStorage.ts";
import type { BootedGame, CurrentGame, ProjectId } from "./gameTypes.ts";
import { fetchFixtureFiles, resolveFixtureTarget } from "./gameDiscovery.ts";
import type { useAuthoringController } from "./useAuthoringController.ts";
import type { useAutosaveController } from "./useAutosaveController.ts";
import type { EngineState, TextHook } from "./useEngineTypes.ts";
import type { LogAgentFn } from "./useInputController.ts";
import type { useTestRecorder } from "./useTestRecorder.ts";
import type { WorkerLink } from "./useWorkerLink.ts";
import type { CachedGameData } from "./gameStorage.ts";
import type { WorkerInbound } from "./workerProtocol.ts";

export interface GameLifecycleOptions {
  readonly state: EngineState;
  readonly hook: TextHook;
  readonly audio: AgiAudio;
  readonly logAgent: LogAgentFn;
  readonly link: WorkerLink;
  readonly autosave: ReturnType<typeof useAutosaveController>;
  readonly authoring: ReturnType<typeof useAuthoringController>;
  readonly testRecorder: ReturnType<typeof useTestRecorder>;
  readonly promptCancel: () => void;
  readonly releaseAgentAudioPreviews: () => void;
  readonly pauseEngine: () => void;
  readonly resumeEngine: () => void;
  readonly getSessionId: () => number;
  readonly nextSessionId: () => number;
  readonly getActiveReplaySeed: () => number | null;
  readonly setActiveReplaySeed: (seed: number | null) => void;
  readonly setActiveLlmConfig: (config: LlmConfig) => void;
  readonly abortWalkthrough: () => void;
}

export function useGameLifecycle(options: GameLifecycleOptions) {
  const { state, hook, audio, logAgent, link, autosave, authoring, testRecorder } = options;

  /** The game currently in the slot, or null when nothing is booted. */
  let booted: BootedGame | null = null;
  const getBootedGame = () => booted;
  const setBootedGame = (game: BootedGame | null) => {
    booted = game;
  };

  function resetScreenState(): void {
    autosave.resetScreen();
    state.powerUp.open = false;
    state.powerUp.busy = false;
    testRecorder.reset();
    state.walkthrough.error = "";
    audio.setPaused(false);
    state.paused = false;
    state.profile = null;
    hook.profile = null;
    state.textMode = false;
    state.modal = null;
    state.controls = [];
    state.inputEnabled = false;
    state.inputReady = false;
    state.holdToMove = false;
    state.waitingForKey = false;
    state.gameEdit = null;
    state.rows = [];
    options.promptCancel();
    state.soundPlaying = false;
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
    link.terminateWorker();
    audio.stop();
    options.releaseAgentAudioPreviews();
    authoring.resetSession();
    link.drainPendingQueries();
    autosave.drainFlushWaiters();
    state.debugObjects = [];
    state.debugTrace = [];
    state.debugTraceDropped = 0;
    state.debugChannels = { ownership: false, objects: false, trace: false, picture: false };
  }

  /** Keep the selected provider and its key together; archives carry no credentials. */
  function configForGame(projectId: ProjectId, config: LlmConfig): LlmConfig {
    const cached = getCachedGameMeta(projectId);
    return cached?.provider === "stub" && !cached.imported
      ? { provider: "stub", model: "offline-stub", apiKey: "" }
      : config;
  }

  async function bootGame(hashOrAlias: string): Promise<void> {
    if (!import.meta.env?.DEV) throw new Error("Installed fixtures are development-only");
    state.phase = "loading";
    state.error = "";
    try {
      const { target, match } = resolveFixtureTarget(state.installedGames, hashOrAlias);
      const files = await fetchFixtureFiles(target);
      // Parse the dictionary on the main thread; ship entries to the worker.
      const words = parseWordsTok(files["WORDS.TOK"]!).map(
        (e) => [e.word, e.id] as [string, number],
      );
      const known = await detectKnownGame(files);
      const revision = await gameRevision(files);
      const folder = match?.folder ?? hashOrAlias;
      const alias = known?.alias ?? match?.alias ?? hashOrAlias;
      const title = known?.title ?? match?.title ?? folder.toUpperCase();
      const hash = match?.hash ?? target;

      const w = link.spawnWorker();
      authoring.resetSession();
      booted = {
        installed: true,
        hash,
        alias,
        folder,
        title,
        revision,
        files,
        words,
      };
      // A successful remix is saved as its own local game before playback resumes.
      const activeReplaySeed = options.getActiveReplaySeed();
      w.postMessage({
        type: "boot",
        sessionId: options.getSessionId(),
        ...(activeReplaySeed !== null ? { replaySeed: activeReplaySeed } : {}),
        soundDevice: state.soundMode === "pc-speaker" ? 0 : 1,
        files,
        words,
        autosaveFiles: true,
        ...(await autosave.takeResumeState(files)),
      } satisfies WorkerInbound);
    } catch (e) {
      state.phase = "error";
      state.error = String(e);
    }
  }

  async function ejectGame(ejectOptions?: { abandonUnsaved?: boolean }): Promise<void> {
    if (state.leaving || state.powerUp.busy) return;
    state.leaving = true;
    options.pauseEngine();
    try {
      const game = booted;
      const session = authoring.getSession();
      if (game && session && (!game.installed || authoring.isRemixNeedsSave())) {
        const files = await link.query<Record<string, Uint8Array> | null>("exportFiles");
        if (!files)
          throw new Error(
            "The current game could not be saved. Try Game actions → Project before leaving.",
          );
        await authoring.persistRemix(game, session, files);
      }
      if (!ejectOptions?.abandonUnsaved) {
        const flushResult = await autosave.flushAutosaveDetailed(2000);
        if (flushResult.status === "storage_failure") {
          throw new Error(
            "Browser storage could not save latest progress. Download a Project backup, or leave with previously saved progress.",
          );
        } else if (flushResult.status === "timeout") {
          throw new Error(
            "Autosave timed out. Try again, download a Project backup, or leave with previously saved progress.",
          );
        } else if (flushResult.status === "not_checkpointable") {
          if (autosave.lastAutosaveRecord() !== null) {
            throw new Error(
              `Current progress cannot be saved: ${flushResult.reason} Close any open game window and try again, download a Project backup, or leave with previously saved progress.`,
            );
          }
        }
      }
    } catch (error) {
      state.leaving = false;
      options.resumeEngine();
      throw error;
    }
    state.leaving = false;
    options.nextSessionId();
    options.abortWalkthrough();
    options.promptCancel();
    link.drainPendingQueries();
    state.walkthrough.active = false;
    state.walkthrough.status = "stopped";
    options.setActiveReplaySeed(null);
    // Keep the player's saved position available from the menu.
    autosave.reset();
    link.terminateWorker();
    audio.stop();
    authoring.resetSession();
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
    resetScreenState();
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
    },
  ): Promise<void> {
    state.phase = "loading";
    state.error = "";
    try {
      const w = link.spawnWorker();

      let projectId = bootOptions?.projectId || "custom";
      const title = bootOptions?.title || projectId;
      const templateId = bootOptions?.templateId;

      if (bootOptions?.useCached) {
        const cached = await loadAuthoredGame(projectId);
        if (cached) {
          logAgent(
            "log",
            `⚡ Booting saved world for "${cached.title}" (authored ${new Date(cached.authoredAt).toLocaleTimeString()}${cached.transcript ? `, ${cached.transcript.length} saved messages` : ""})`,
          );
          const cachedConfig = configForGame(projectId, config);
          options.setActiveLlmConfig(cachedConfig);
          const isConfigured =
            cachedConfig.provider === "stub" || Boolean(cachedConfig.apiKey.trim());
          const canAuthor = Boolean(cached.roomGeneration);
          const cachedSession =
            canAuthor && isConfigured
              ? AgentSession.fromAuthoredData(
                  cachedConfig,
                  logAgent,
                  cached.files,
                  cached.words,
                  continuationTranscript(cached, cachedConfig.provider, cachedConfig.model),
                  cached.provider === cachedConfig.provider && cached.model === cachedConfig.model
                    ? cached.sessionId
                    : undefined,
                  cached.authoringState,
                )
              : null;
          authoring.setSession(cachedSession);
          const known = await detectKnownGame(cached.files);
          const revision = cached.library?.revision || (await gameRevision(cached.files));
          booted = {
            installed: false,
            projectId,
            alias: cached.library?.alias ?? known?.alias,
            title: cached.title ?? known?.title ?? title,
            revision,
            files: cached.files,
            words: cached.words,
            authoredGame: cached,
          };
          if (cachedSession) {
            authoring.attachSessionRuntime(cachedSession, booted);
          }
          const activeReplaySeed = options.getActiveReplaySeed();
          w.postMessage({
            type: "boot",
            sessionId: options.getSessionId(),
            ...(activeReplaySeed !== null ? { replaySeed: activeReplaySeed } : {}),
            soundDevice: state.soundMode === "pc-speaker" ? 0 : 1,
            files: cached.files,
            words: cached.words,
            autosaveFiles: true,
            authorRooms: Boolean(cached.roomGeneration),
            ...(await autosave.takeResumeState(cached.files)),
          } satisfies WorkerInbound);
          return;
        }
        throw new Error(
          "This saved game is no longer available. Import it again or choose a catalog game.",
        );
      }

      if (!bootOptions?.overwrite && (await loadAuthoredGame(projectId))) {
        let safeId = projectId;
        do safeId = `${projectId}-${crypto.randomUUID().slice(0, 8)}`;
        while (await loadAuthoredGame(safeId));
        projectId = safeId;
      }

      options.setActiveLlmConfig(config);
      const genesisSession = new AgentSession(config, logAgent);
      authoring.setSession(genesisSession);

      const { files, words, transcript, sessionId } =
        await genesisSession.startGenesis(templateMarkdown);
      const authoredGame: CachedGameData = {
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
        authoringState: genesisSession.getAuthoringState(),
        roomGeneration: true,
      };
      const known = await detectKnownGame(files);
      const revision = await gameRevision(files);
      booted = {
        installed: false,
        projectId,
        alias: known?.alias,
        title,
        revision,
        files,
        words,
        authoredGame,
      };
      authoring.attachSessionRuntime(genesisSession, booted);

      const saved = await saveAuthoredGame(projectId, {
        templateId,
        title,
        provider: config.provider,
        model: config.model,
        files,
        words,
        transcript,
        sessionId,
        authoringState: genesisSession.getAuthoringState(),
        roomGeneration: true,
      });
      if (!saved)
        logAgent(
          "error",
          "Browser storage could not save this world. Use Game actions → Project to keep it.",
        );
      if (saved)
        logAgent(
          "log",
          `Saved the world and its authoring conversation in this browser (${projectId}).`,
        );

      const activeReplaySeed = options.getActiveReplaySeed();
      w.postMessage({
        type: "boot",
        sessionId: options.getSessionId(),
        soundDevice: state.soundMode === "pc-speaker" ? 0 : 1,
        files,
        words,
        autosaveFiles: true,
        authorRooms: true,
        ...(activeReplaySeed !== null ? { replaySeed: activeReplaySeed } : {}),
      } satisfies WorkerInbound);
    } catch (e) {
      state.phase = "error";
      state.error = String(e);
    }
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
  function isInstalledGame(aliasOrHash: string): boolean {
    const norm = aliasOrHash.toLowerCase();
    return (state.installedGames ?? []).some(
      (entry) =>
        entry.hash.toLowerCase() === norm ||
        entry.alias.toLowerCase() === norm ||
        entry.wordsSha256?.toLowerCase() === norm ||
        entry.folder?.toLowerCase() === norm,
    );
  }

  /** The game currently in the slot, or null when nothing is booted. */
  function currentGame(): CurrentGame | null {
    return booted
      ? {
          installed: booted.installed,
          title: booted.title,
          revision: booted.revision,
          hash: booted.hash,
          alias: booted.alias,
          projectId: booted.projectId,
          folder: booted.folder,
        }
      : null;
  }

  async function exportCurrentGame(): Promise<{ data: CachedGameData; progressKey: string }> {
    if (state.powerUp.busy || state.phase !== "running")
      throw new Error("Wait for the current authoring turn to finish before saving.");
    const game = booted;
    if (!game) throw new Error("No game is running.");
    const session = authoring.getSession();
    const data: CachedGameData | null = game.installed
      ? {
          projectId: game.alias ?? game.hash ?? "installed",
          title: game.title,
          provider: "stub",
          model: state.profile ?? "unknown",
          authoredAt: "",
          files: game.files,
          words: game.words,
        }
      : ((await loadAuthoredGame(game.projectId!).catch(() => null)) ?? game.authoredGame ?? null);
    if (!data) throw new Error("The current game metadata is unavailable.");
    const files = await link.query<Record<string, Uint8Array> | null>("exportFiles");
    if (!files || booted !== game) throw new Error("The game changed during export. Try again.");
    await updateBootedResources(game, files);
    if (!game.installed && !(await updateAuthoredGameFiles(game.projectId!, files))) {
      logAgent("error", "Browser storage could not save this world. Keep the downloaded ZIP.");
    }
    const assembled = authoring.assembleExportData(data, game, session, files);
    const progressKey = game.installed ? (game.hash ?? game.alias ?? "installed") : game.projectId!;
    return { data: assembled, progressKey };
  }

  return {
    getBootedGame,
    setBootedGame,
    resetScreenState,
    shutdownEngine,
    configForGame,
    bootGame,
    bootAuthoredGame,
    bootAgentGame,
    ejectGame,
    isInstalledGame,
    currentGame,
    exportCurrentGame,
  };
}

export type GameLifecycle = ReturnType<typeof useGameLifecycle>;
