import { requireProjectId } from "../../../src/gameIdentity.ts";
import type { createExecutionDebugLink } from "./executionDebugLink.ts";
import type * as PlayerSentenceTools from "../project/playerSentences.ts";
import type { PlayerSentence } from "../project/playerSentences.ts";
import { computeResourceRevision } from "../../../src/authoring/resourceRevision.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import type { ProjectChange } from "../../../src/authoring/projectContent.ts";
import type { ProjectCommitMetadata } from "../../../src/authoring/projectHistoryData.ts";
import type { ProjectSession, PendingProjectRestart } from "../project/projectSession.ts";
import type { HistoryBoot } from "../../../src/agent/history.ts";
import { base64ToBytes } from "../project/bytes.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import type { AgentHandler, LlmRequest } from "../agent/hostRequests.ts";
import {
  effectScope,
  getCurrentScope,
  onScopeDispose,
  reactive,
  watch,
  shallowReactive,
  shallowRef,
} from "vue";
import type { createAgentLogger } from "../agent/agentLog.ts";
import type { ReplayObservation } from "../walkthrough/replay.ts";
import { createReplayDriver } from "../walkthrough/useReplayDriver.ts";
import {
  useWalkthroughController,
  createInitialWalkthroughState,
} from "../walkthrough/useWalkthroughController.ts";
import { useInputController } from "../play/useInputController.ts";
import { useTestRecorder } from "../authoring/useTestRecorder.ts";
import type { useAuthoringController } from "../authoring/useAuthoringController.ts";
import type { LlmConfig } from "../agent/llmClient.ts";
import { useAmigaRegion } from "../settings/amigaRegion.ts";
import type { AgiAudio, AudioMode } from "../audio/AgiAudio.ts";
import {
  autosaveKey,
  clearAutosave,
  lastGameKey,
  readAutosave,
  useAutosaveController,
  writeAutosave,
} from "../saves/useAutosaveController.ts";
import { clearCachedGame } from "../project/gameStorage.ts";
import { bindProgressTarget, resolveProgressTarget } from "../project/progressBinding.ts";
import {
  advanceAuthoring,
  requireSaved,
  STALE_SAVE_MESSAGE,
  PROJECT_REMOVED_MESSAGE,
  watchProjectWrites,
} from "../project/projectTransaction.ts";
import { createProgressOwnership } from "../saves/progressOwnership.ts";
import { withCheckpointLock } from "../saves/gameProgress.ts";
import { clearGameSaves } from "../saves/gameSaves.ts";
import { writeResumePointer } from "../saves/resumePointer.ts";
import { removeMapSidecar } from "../world/roomMapStore.ts";
import type { BootedGame, Frame, ProjectId } from "../project/gameTypes.ts";
export type { BootedGame, Frame, ProjectId };

import { usePromptController } from "../play/usePromptController.ts";
import { useSaveSlotController } from "../saves/useSaveSlotController.ts";
import { discoverInstalledGames } from "../library/gameDiscovery.ts";
import { useWorkerLink } from "./useWorkerLink.ts";
import type { useHistoryController } from "../history/useHistoryController.ts";
import type { useHistoryView } from "../history/useHistoryView.ts";
import { freshHistoryView } from "./useEngineTypes.ts";
import { useStartOverNote } from "../history/useStartOverNote.ts";
import type { TransportModel } from "../history/useTransport.ts";
import { useGameLifecycle } from "./useGameLifecycle.ts";
import { createPauseHolds } from "./pauseHolds.ts";
import { createRuntimePauseLeaseAcquire } from "./runtimePauseLease.ts";
import { createStartOver } from "./startOver.ts";
import type { useEngineDebug } from "./useEngineDebug.ts";
import type { useRoomMap } from "../world/useRoomMap.ts";
import type { WorkerInbound, WorkerQueryPayload, WorkerControl } from "../worker/workerProtocol.ts";
import type { PlayHereTarget } from "../../../src/runtime/playHere.ts";
import type { HistoryBatch } from "../../../src/agent/history.ts";
export type { ModalKind, TextHook, EngineState } from "./useEngineTypes.ts";
import type { EngineState, TextHook } from "./useEngineTypes.ts";

export { autosaveKey, lastGameKey, readAutosave, writeAutosave };
export type { AutosaveRecord } from "../saves/useAutosaveController.ts";

/**
 * Forget a library game completely: its project body and conversation, its
 * checkpoint, its numbered saves and the resume pointer. Game IDs are
 * deterministic, so anything left behind would resurface on the next import.
 */
export async function removeLibraryGame(projectId: ProjectId): Promise<void> {
  await clearCachedGame(projectId);
  await clearAutosave(projectId);
  clearGameSaves(localStorage, projectId);
  removeMapSidecar(localStorage, projectId);
}

/**
 * The composition root: constructs the controllers, wires the function
 * tables, and returns the engine API. The bodies live in
 * useWorkerLink.ts (worker lifetime and message dispatch),
 * useGameLifecycle.ts (boot/eject/shutdown/export) and
 * useEngineDebug.ts (inspector queries).
 */
export function useEngine(
  onFrame: (frame: Frame) => void,
  engineOptions?: {
    onPromptType?: (text: string) => void;
    flushWorkspace?: () => Promise<void>;
    pendingEditorChanges?: () => boolean;
  },
) {
  let projectMode: "create" | "play" = "play";
  let projectSession: ProjectSession | null = null;
  let projectSessionOpening: string | undefined;
  const pendingProjectRestart = shallowRef<PendingProjectRestart | null>(null);
  let projectOpenEpoch = 0;
  let audio: AgiAudio | null = null;
  const amigaSettings = useAmigaRegion();

  let audioLoading: Promise<AgiAudio> | undefined;

  const state = reactive<EngineState>({
    agentTask: null,
    loading: null,
    leaving: false,
    controls: [],
    inputEnabled: false,
    inputReady: false,
    holdToMove: false,
    waitingForKey: false,
    gameEdit: null,
    phase: "idle",
    error: "",
    genesisStarter: null,
    status: "",
    textMode: false,
    modal: null,
    rows: [],
    installedGames: null,
    profile: null,
    profileKind: null,
    agentLog: [],
    omittedLogEntries: 0,
    shake: false,
    prompt: null,
    soundPlaying: false,
    soundMuted: false,
    soundMode: "tandy",
    paused: false,
    powerUp: {
      mode: "remix",
      messages: [],
      open: false,
      needsConfig: false,
      busy: false,
      feedStart: 0,
      feedStartSeq: 1,
      reply: "",
      room: 0,
      error: "",
    },
    resumed: false,
    startOverNote: false,
    gameEnded: null,
    otherTab: false,
    returnProblem: "",
    entryProblem: "",
    staleTab: false,
    projectRemoved: false,
    recording: { active: false, starting: false, error: "" },
    historyPending: 0,
    historyUnsaved: null,
    historyBlocked: null,
    historyRetry: null,
    historyView: freshHistoryView(),
    walkthrough: createInitialWalkthroughState(),
    debugObjects: [],
    debugTrace: [],
    debugTraceDropped: 0,
    roomJournal: [],
    patchTick: 0,
    worldTick: 0,
    planDurableRev: "",
    showObjView: null,
    debugChannels: { ownership: false, objects: false, trace: false, picture: false },
    debugConsumers: {
      dock: false,
      overlay: false,
      inspect: false,
      exploded: false,
      trace: false,
    },
  });

  let activeWalkthroughSession = 0;
  let walkthroughAbort: () => void = () => {};
  let activeLlmConfig: LlmConfig = { provider: "stub", apiKey: "", model: "offline-stub" };
  const urlReplaySeedText =
    import.meta.env.MODE === "test" ? new URLSearchParams(location.search).get("replaySeed") : null;
  const urlReplaySeed = urlReplaySeedText === null ? null : Number(urlReplaySeedText);
  let activeReplaySeed: number | null =
    urlReplaySeed !== null && Number.isInteger(urlReplaySeed) ? urlReplaySeed : null;
  let activeReplayRngVersion: 1 | 2 = 1;
  const observationListeners = new Set<(obs: ReplayObservation) => void>();

  let logger: ReturnType<typeof createAgentLogger> | undefined;
  let loggerLoading: Promise<void> | undefined;
  const pendingLog: Parameters<ReturnType<typeof createAgentLogger>["logAgent"]>[] = [];
  const logAgent: ReturnType<typeof createAgentLogger>["logAgent"] = (...entry) => {
    if (logger) return logger.logAgent(...entry);
    pendingLog.push(entry);
    loggerLoading ??= import("../agent/agentLog.ts").then(({ createAgentLogger }) => {
      logger = createAgentLogger(state);
      for (const entry of pendingLog.splice(0)) logger.logAgent(...entry);
    });
  };
  function clearAgentLog(): void {
    pendingLog.length = 0;
    logger?.clearAgentLog();
  }
  function releaseAgentAudioPreviews(): void {
    logger?.releaseAgentAudioPreviews();
  }
  const promptController = usePromptController({ state, logAgent });
  watch(
    () => state.prompt,
    (prompt, prior) => {
      if (prior && !prompt) state.entryProblem = "";
    },
  );
  const saveSlotController = useSaveSlotController({
    getBootedGame: () => lifecycle.getBootedGame(),
    getWriterGeneration: () => progressOwnership.generation(),
    logAgent,
  });

  function cancelPendingPrompts(): void {
    promptController.cancelPrompt();
  }

  // The map subscribes to the live room across cycles, restores and replay.
  // Keep the heartbeat fields reactive without proxying their payloads.
  const hook = shallowReactive<TextHook>({
    rows: [],
    modal: null,
    textMode: false,
    profile: null,
    profileKind: null,
    paused: false,
    cycle: 0,
    frame: 0,
    autosave: -1,
    room: 0,
    egoX: 0,
    egoY: 0,
  });

  const link = useWorkerLink({
    state,
    hook,
    get audio() {
      return audio;
    },
    onFrame,
    logAgent,
    getBootedGame: () => lifecycle.getBootedGame(),
    getActiveWalkthroughSession: () => activeWalkthroughSession,
    observationListeners,
    onBehindStorage: tellBehindStorage,
  });
  const { pauseEngine, resumeEngine, resetPauseOwners } = createPauseHolds({
    post: (paused) =>
      link.getWorker()?.postMessage({ type: "pause", paused } satisfies WorkerInbound),
    audio: { setPaused: (paused) => audio?.setPaused(paused) },
    state,
  });
  const progressOwnership = createProgressOwnership({
    storage: localStorage,
    owner: crypto.randomUUID(),
    lock: withCheckpointLock,
    changed(lost) {
      state.otherTab = lost;
      link.getWorker()?.postMessage({
        type: "playOwner",
        active: !lost,
        generation: progressOwnership.lastGeneration(),
      } satisfies WorkerInbound);
      if (lost) pauseEngine("otherTab");
      else resumeEngine("otherTab");
    },
  });
  const observeOwner = (event: StorageEvent) => progressOwnership.observe(event.key);
  window.addEventListener("storage", observeOwner);
  if (getCurrentScope())
    onScopeDispose(() => {
      window.removeEventListener("storage", observeOwner);
      progressOwnership.close();
    });
  const acquireRuntimePauseLease = createRuntimePauseLeaseAcquire({
    getWorker: () => link.getWorker(),
    pause: pauseEngine,
    resume: resumeEngine,
    readState: () => link.query("state"),
  });

  const input = useInputController({
    getWorker: link.getWorker,
    isSeeking: () => state.walkthrough.seeking,
    isHoldToMove: () => state.holdToMove,
    logAgent,
    getActiveWalkthroughSession: () => activeWalkthroughSession,
  });
  const { sendInput, sendEdit, sendDirection, sendKey, sendClick } = input;
  const startOverNote = useStartOverNote(state);

  let executionDebug: ReturnType<typeof createExecutionDebugLink> | undefined;
  let executionDebugLoading: Promise<ReturnType<typeof createExecutionDebugLink>> | undefined;
  function loadExecutionDebug(): Promise<ReturnType<typeof createExecutionDebugLink>> {
    executionDebugLoading ??= import("./executionDebugLink.ts").then(
      ({ createExecutionDebugLink }) => {
        executionDebug = createExecutionDebugLink(link.query);
        link.deps.handleDebugEvent = executionDebug.handle;
        return executionDebug;
      },
    );
    return executionDebugLoading;
  }
  let debug: ReturnType<typeof useEngineDebug> | undefined;
  async function loadEngineDebug(): Promise<ReturnType<typeof useEngineDebug>> {
    if (!debug) {
      const { useEngineDebug } = await import("./useEngineDebug.ts");
      debug ??= useEngineDebug({ state, link });
    }
    return debug;
  }

  const replayDriver = createReplayDriver({
    query: link.query,
    post: (msg) => link.getWorker()?.postMessage(msg),
    sendKey: (code, sessionId) => sendKey(code, sessionId),
    sendDirection: (dir, sessionId) => sendDirection(dir, sessionId),
    submitPrompt: (text) => promptController.submitPrompt(text),
    setPromptEcho: (text) => engineOptions?.onPromptType?.(text),
    isPromptPending: () => promptController.isPromptPending(),
    getActiveWalkthroughSession: () => activeWalkthroughSession,
    getLatestFrame: link.getLatestFrame,
    observationListeners,
  });
  // Test/debug automation surface; dev and e2e only, never in production builds.
  if (import.meta.env?.DEV) {
    window.__AGI_REPLAY__ = replayDriver;
    (window as unknown as { __AGI_STATE__: EngineState }).__AGI_STATE__ = state;
    window.__AGI_FRAME__ = link.getLatestFrame;
    (window as unknown as { __AGI_PROJECT__: unknown }).__AGI_PROJECT__ = {
      getSession: () => projectSession,
      getWorker: link.getWorker,
      query: link.query,
    };
  }

  /**
   * Storage moved past the running game, found by a refused autosave or
   * another tab's notice: the Assistant says so and offers Reload game, as a
   * refused turn does, and the stage's note says it while it is closed.
   */
  function tellBehindStorage(): void {
    projectSession?.stopWrites();
    autosaveController.handleRecoveryError(STALE_SAVE_MESSAGE);
    logAgent("error", STALE_SAVE_MESSAGE);
    state.powerUp.error = STALE_SAVE_MESSAGE;
    state.powerUp.offerReload = true;
    state.staleTab = true;
  }

  /**
   * The running game's project was removed in another tab: nothing more is
   * stored for it (BootedGame.removed) and no reload brings it back. The
   * stage's one note says so with Download game and Back to games, and the
   * Assistant says the same without a reload offer. The timeline it can
   * no longer store is not owed: its retry banner goes.
   */
  function tellRemoved(): void {
    projectSession?.stopWrites("removed");
    autosaveController.handleRecoveryError(PROJECT_REMOVED_MESSAGE);
    logAgent("error", PROJECT_REMOVED_MESSAGE);
    state.powerUp.error = PROJECT_REMOVED_MESSAGE;
    state.powerUp.offerReload = false;
    state.staleTab = false;
    state.projectRemoved = true;
    historyController?.forgetRemovedGame();
  }

  const autosaveController = useAutosaveController({
    state,
    // The worker grants the run before the editor modules finish loading.
    // Checkpoints keep that owner while its project session opens.
    getRunScope: () => projectSessionOpening ?? projectSession?.runToken,
    getWriterGeneration: () => progressOwnership.generation(),
    getBootedGame: () => lifecycle.getBootedGame(),
    getWorker: link.getWorker,
    async prepareCheckpoint(game, files, checkpointRevision) {
      const session = projectSession;
      if (session === null) return "legacy";
      if ((await session.prepareCheckpoint(checkpointRevision)) === "not_ready") return "not_ready";
      const revision = session.model.capture().lastAdmissibleBuild!.identity.revision;
      if (checkpointRevision !== undefined && checkpointRevision !== revision) return "refused";
      if (files !== undefined && computeResourceRevision(files) !== revision) return "refused";
      return session === projectSession &&
        lifecycle.getBootedGame() === game &&
        session.saveStatus().state === "saved" &&
        session.model.capture().lastAdmissibleBuild!.identity.revision === revision
        ? "owned"
        : "refused";
    },
    onAutosaveStored: (cycle) => {
      hook.autosave = cycle;
      link.publishHook();
    },
    onAutosaveRestored: (room, egoX, egoY) => {
      hook.room = room;
      hook.egoX = egoX;
      hook.egoY = egoY;
      link.publishHook();
    },
    onBehindStorage: tellBehindStorage,
    onRemoved: tellRemoved,
    logAgent,
    isInstalledGame: (target) => lifecycle.isInstalledGame(target),
    bootGame: (target, carrier) => lifecycle.bootGame(target, carrier),
    bootInstalledFresh: (selected, admission) => lifecycle.bootInstalledFresh(selected, admission),
    bootAuthoredGame: (template, config, bootOptions) =>
      lifecycle.bootAuthoredGame(template, config, bootOptions),
    configForGame: (projectId, config) => lifecycle.configForGame(projectId, config),
    // A refused or unanswered restore retires the armed worker through the
    // lifecycle's own seam: terminate, drain, error surface — the slot's
    // checkpoint and pointer stay exactly as they were.
    retireFailedRecovery: (game, message) => lifecycle.retireFailedRecovery(game, message),
  });

  link.deps.projectClosed = () => {
    progressOwnership.close();
    executionDebug?.reset();
    projectOpenEpoch++;
    projectSession?.dispose();
    projectSession = null;
    pendingProjectRestart.value = null;
  };
  async function openSession(
    grant: Extract<WorkerControl, { type: "booted" }>["projectAdmission"],
  ): Promise<void> {
    const openedGame = lifecycle.getBootedGame();
    const worker = link.getWorker();
    if (
      grant === undefined ||
      projectSession?.runToken === grant.runToken ||
      projectSessionOpening === grant.runToken
    )
      return;
    const epoch = ++projectOpenEpoch;
    if (
      grant === undefined ||
      openedGame?.authoredGame === undefined ||
      openedGame.projectId === undefined ||
      openedGame.historyLifetime == null
    )
      return;
    let game: BootedGame = openedGame;
    const current = () =>
      projectOpenEpoch === epoch &&
      lifecycle.getBootedGame() === game &&
      link.getWorker() === worker &&
      !game.removed &&
      !game.behindStorage;
    projectSessionOpening = grant.runToken;
    await Promise.all([import("../project/projectSession.ts"), import("./mainProjectAdmission.ts")])
      .then(async ([{ openProjectSession }, { createMainProjectAdmission }]) => {
        if (!current()) return;
        // A room can finish while these modules load. Open the confirmed
        // stored body, including its files, source claims and generation.
        if (!game.installed) {
          const saved = await requireSaved(game, { authoring: true, message: STALE_SAVE_MESSAGE });
          if (!current()) return;
          game.authoredGame = saved.data;
        }
        const admission = createMainProjectAdmission({
          ...grant,
          query: link.query,
          current,
          waitForContinue: () => executionDebug?.waitForContinue(),
          acceptedImage: () => projectSession?.model.capture().lastAdmissibleBuild,
        });
        projectSession = openProjectSession({
          data: game.authoredGame!,
          lifetime: game.historyLifetime!,
          ...(game.installed && game.progressTarget
            ? { forkParent: game.progressTarget.identity }
            : {}),
          admission,
          current,
          forked(data, lifetime) {
            if (!current()) return;
            state.copyCreated = { projectId: data.projectId, originalTitle: game.title };
            game = {
              ...game!,
              installed: false,
              revision: computeResourceRevision(data.files),
              files: data.files,
              projectId: data.projectId,
              title: data.title,
              authoredGame: data,
              historyLifetime: lifetime,
            };
            lifecycle.setBootedGame(game);
            const target = bindProgressTarget(game);
            if (target) writeResumePointer(localStorage, target.locator);
            autosaveController.reset();
            hook.autosave = -1;
            state.patchTick++;
            state.worldTick++;
            void autosaveController.flushAutosave();
          },
          publish(snapshot, data, outcome, nativeInstalled) {
            if (!current()) return;
            if (
              computeResourceRevision(game.authoredGame!.files) !==
              snapshot.lastAdmissibleBuild!.identity.revision
            ) {
              hook.autosave = -1;
              link.publishHook();
            }
            const running =
              nativeInstalled === true ||
              outcome?.status === "committed" ||
              outcome?.status === "unchanged";
            if (running) {
              game.files = structuredClone(data.files);
              if (!game.installed) {
                game.revision = snapshot.lastAdmissibleBuild!.identity.revision;
                bindProgressTarget(game);
              }
              if (outcome?.replacementRunToken !== undefined)
                state.profile = snapshot.lastAdmissibleBuild!.identity.profileId;
            }
            if (running)
              game.words =
                data.files["WORDS.TOK"] === undefined
                  ? data.words
                  : parseWordsTok(data.files["WORDS.TOK"]).map(({ word, id }) => [word, id]);
            game.authoredGame = {
              ...data,
              projectId: game.projectId!,
              authoredAt: game.authoredGame!.authoredAt,
            };
            if (running) audio?.useGameFiles(game.files);
            state.patchTick++;
            state.worldTick++;
            if (outcome?.status === "committed") {
              roomMap.value?.projectImageAdmitted(outcome.patchGeneration);
              const frame = link.getLatestFrame();
              if (frame !== null) roomMap.value?.observeFrame(frame);
            }
          },
          saved(data, _lifetime, generation) {
            if (current()) {
              advanceAuthoring(game, data.authoringState, data.workspace);
              if (game.authoredGame) game.authoredGame.generation = generation;
              void autosaveController.flushAutosave();
            }
          },
          checkpointReady() {
            if (current() && !game.installed) void autosaveController.flushAutosave();
          },
          changed() {
            if (current()) {
              state.status = projectSession?.saveStatus().message ?? "";
              pendingProjectRestart.value = projectSession?.pendingRestart ?? null;
            }
          },
        });
        state.patchTick++;
        if ((await projectSession.ready) && current()) void autosaveController.flushAutosave();
      })
      .catch((error: unknown) => {
        if (current()) state.status = String(error instanceof Error ? error.message : error);
      })
      .finally(() => {
        if (projectSessionOpening === grant.runToken) projectSessionOpening = undefined;
      });
  }
  async function adoptHistorySession(game: BootedGame, boot: HistoryBoot, snapshot: unknown) {
    const worker = link.getWorker();
    const editable = projectSession !== null || projectMode === "create";
    const { loadAuthoredGame } = await import("../project/gameStorage.ts");
    if (lifecycle.getBootedGame() !== game || link.getWorker() !== worker) return;
    if (!editable || game.installed || !game.projectId) {
      const controller = await loadAuthoringController();
      await controller.adoptSessionState(game, boot, snapshot);
      // The legacy adoption writes the body; a later Create must open that generation.
      if (game.projectId && !game.installed && lifecycle.getBootedGame() === game)
        game.authoredGame = (await loadAuthoredGame(game.projectId)) ?? game.authoredGame;
      return;
    }
    projectOpenEpoch++;
    projectSession?.dispose();
    projectSession = null;
    pendingProjectRestart.value = null;
    const data = await loadAuthoredGame(game.projectId);
    if (lifecycle.getBootedGame() !== game || link.getWorker() !== worker) return;
    if (data === null) throw new Error("The saved project is missing. Reopen the game.");
    const [
      { readProjectWorkspace },
      { historyProjectDocuments },
      { readProjectDocuments },
      { diffProjectDocuments },
      { detectProfile },
    ] = await Promise.all([
      import("../../../src/authoring/projectWorkspace.ts"),
      import("../history/historyProject.ts"),
      import("../../../src/authoring/projectDocuments.ts"),
      import("../../../src/authoring/projectContent.ts"),
      import("../../../src/runtime/profile.ts"),
    ]);
    const files = Object.fromEntries(
      Object.entries(boot.files).map(([name, bytes]) => [name, base64ToBytes(bytes)]),
    );
    const recordedDocuments = boot.project
      ? readProjectWorkspace(boot.project.documents)
      : readProjectDocuments({
          files,
          profileId: detectProfile(new Map(Object.entries(files)), boot.profile).id,
        }).documents;
    const documents = historyProjectDocuments(
      recordedDocuments,
      data.workspace ? readProjectWorkspace(data.workspace) : {},
    );
    if (lifecycle.getBootedGame() !== game || link.getWorker() !== worker) return;
    const reply = await link.query("projectCreate", { progressMode: projectMode });
    if (lifecycle.getBootedGame() !== game || link.getWorker() !== worker) return;
    if (!reply.grant) throw new Error(reply.reason ?? "Open this game in Create to edit it.");
    game.authoredGame = data;
    await openSession(reply.grant);
    if (lifecycle.getBootedGame() !== game || link.getWorker() !== worker) return;
    const session = projectSession as ProjectSession | null;
    if (session === null)
      throw new Error("The adopted project could not be opened. Reopen the game.");
    const changes = diffProjectDocuments(session.model.capture().documents(), documents);
    if (changes.length > 0) {
      const result = await session.submit({
        proposal: session.model.propose(session.model.capture(), "Resume from here", changes),
        label: "Resume from here",
        origin: "history",
        author: "creator",
      });
      if (result.status !== "committed")
        throw new Error("The adopted project could not be saved. Reopen the game.");
      await session.flush();
    }
  }
  const playerSentences = shallowRef<readonly PlayerSentence[]>([]);
  let sentenceTools: typeof PlayerSentenceTools | undefined;
  let triedProject = "";
  const pendingSentences: Omit<PlayerSentence, "count">[] = [];
  function loadTried(): void {
    if (!sentenceTools) return;
    const project = lifecycle.getBootedGame()?.projectId ?? "";
    if (project === triedProject) return;
    triedProject = project;
    playerSentences.value = project ? sentenceTools.readPlayerSentences(project) : [];
  }
  async function loadPlayerSentences(): Promise<void> {
    sentenceTools ??= await import("../project/playerSentences.ts");
    loadTried();
    for (const entry of pendingSentences.splice(0))
      playerSentences.value = sentenceTools.recordPlayerSentence(playerSentences.value, entry);
    if (triedProject) sentenceTools.savePlayerSentences(triedProject, playerSentences.value);
  }
  link.deps.missedSentence = (msg) => {
    if (projectMode !== "create") return;
    if (!sentenceTools) {
      pendingSentences.push({ text: msg.text, room: msg.room, unknown: msg.unknown });
      void loadPlayerSentences();
      return;
    }
    loadTried();
    playerSentences.value = sentenceTools.recordPlayerSentence(playerSentences.value, msg);
    if (triedProject) sentenceTools.savePlayerSentences(triedProject, playerSentences.value);
  };
  link.deps.projectBooted = (msg) => {
    openSession(msg.projectAdmission);
    playerSentences.value = [];
    pendingSentences.length = 0;
    triedProject = "";
    loadTried();
    link.getWorker()?.postMessage({
      type: "observeSentences",
      enabled: projectMode === "create",
    } satisfies WorkerInbound);
  };

  // Another tab committing a newer revision of the running project marks it
  // behind at once, not at its next refused write; removing it stops every
  // write for it.
  const stopWatchingWrites = watchProjectWrites({
    getBootedGame: () => lifecycle.getBootedGame(),
    onBehindStorage: tellBehindStorage,
    onRemoved: tellRemoved,
  });
  if (getCurrentScope()) onScopeDispose(stopWatchingWrites);

  let historyController: ReturnType<typeof useHistoryController> | undefined;

  let authoringController: ReturnType<typeof useAuthoringController> | null = null;
  let authoringLoading: Promise<ReturnType<typeof useAuthoringController>> | undefined;
  function loadAuthoringController(): Promise<ReturnType<typeof useAuthoringController>> {
    authoringLoading ??= import("../authoring/useAuthoringController.ts").then(
      ({ useAuthoringController }) => {
        authoringController = useAuthoringController({
          state,
          getProjectSession: () => projectSession,
          getWorker: link.getWorker,
          query: link.query,
          awaitPatched: link.awaitPatched,
          logAgent,
          readFrames: async (req) => (await loadEngineDebug()).readFrames(req),
          pauseEngine,
          resumeEngine,
          getBootedGame: () => lifecycle.getBootedGame(),
          setBootedGame: (game) => lifecycle.setBootedGame(game),
          flushAutosave: () => autosaveController.flushAutosave(),
          getAutosaveWrite: () => autosaveController.getAutosaveWrite(),
          clearAutosave,
          onRemixCreated: (remixProjectId) => {
            // The remix boot already installed and bound the saved body's physical
            // target; the resume pointer names that exact locator — but only while
            // the slot still holds the project this callback reports. A completion
            // for a world that was replaced since writes nothing and resets nothing.
            const booted = lifecycle.getBootedGame();
            const target =
              booted !== null && !booted.installed && booted.projectId === remixProjectId
                ? resolveProgressTarget(booted)
                : null;
            if (target?.kind !== "project" || target.project !== remixProjectId) return;
            writeResumePointer(localStorage, target.locator);
            autosaveController.reset();
            hook.autosave = -1;
          },
          configForGame: (projectId, config) => lifecycle.configForGame(projectId, config),
          getLlmConfig: () => activeLlmConfig,
          getRoomNotes: (room) => roomMap.value?.noteIntentFor(room) ?? [],
          onBehindStorage: tellBehindStorage,
        });
        return authoringController;
      },
    );
    return authoringLoading;
  }

  const testRecorder = useTestRecorder({
    state,
    getWorker: link.getWorker,
    query: link.query,
    logAgent,
    getBootedGame: () => lifecycle.getBootedGame(),
    getOrCreateSession: async (...args) =>
      (await loadAuthoringController()).getOrCreateSession(...args),
    commitTestsFile: async (...args) => (await loadAuthoringController()).commitTestsFile(...args),
    flushAutosave: () => autosaveController.flushAutosave(),
  });

  link.deps.recordingReset = () => {
    testRecorder.reset();
    state.recording.error = "Game run changed. Start Playtest to record the current run.";
  };

  const lifecycle = useGameLifecycle({
    getAmigaRegion: () => amigaSettings.region.value,
    state,
    hook,
    get audio() {
      return audio;
    },
    logAgent,
    link,
    autosave: autosaveController,
    get authoring() {
      return authoringController;
    },
    ensureAuthoring: loadAuthoringController,
    prepareRun,
    testRecorder,
    promptCancel: cancelPendingPrompts,
    releaseAgentAudioPreviews,
    pauseEngine,
    resumeEngine,
    resetPauseOwners,
    resetHistoryView: () => {
      historyView?.resetHistoryView();
      startOverNote.hide();
    },
    stopHistoryWriter: () => historyController?.stopWriterRenewal(),
    pendingEditorChanges: () =>
      (engineOptions?.pendingEditorChanges?.() ?? false) ||
      (projectSession?.pendingChanges ?? false),
    flushProject: async () => {
      if (projectSession?.saveStatus().state === "conflict") return;
      await engineOptions?.flushWorkspace?.();
      const session = projectSession;
      if (session === null) return;
      await session.flush();
      if (session.saveStatus().state !== "saved") throw new Error(session.saveStatus().message);
    },
    getProjectMode: () => projectMode,
    getSessionId: () => activeWalkthroughSession,
    nextSessionId: () => ++activeWalkthroughSession,
    acquirePlayOwnership: async (game) => {
      const target = resolveProgressTarget(game);
      if (target) await progressOwnership.acquire(target);
    },
    getActiveReplayRngVersion: () => activeReplayRngVersion,
    getActiveReplaySeed: () => activeReplaySeed,
    setActiveReplaySeed: (seed) => {
      activeReplaySeed = seed;
    },
    setActiveLlmConfig: (config) => {
      activeLlmConfig = config;
    },
    getActiveLlmConfig: () => activeLlmConfig,
    abortWalkthrough: () => walkthroughAbort(),
    drainHistoryCommits: async () => {
      await historyController?.drainHistoryCommits();
    },
  });

  // The wire dispatches to controllers that did not exist when the link was
  // constructed; filling the table now keeps construction acyclic.
  Object.assign(link.deps, {
    resetScreenState: lifecycle.resetScreenState,
    cancelPrompt: cancelPendingPrompts,
    handleAutosave: autosaveController.handleAutosave,
    // The transport's live axis tracks every posted batch — the timeline's
    // LIVE endpoint moves with play whether or not the commit has landed.
    handleHistoryBatch: (msg: { epoch: number; batch: HistoryBatch; profile?: ProfileId }) => {
      historyView!.observeBatch(msg.batch);
      return historyController!.handleHistoryBatch(msg);
    },
    handleFlushed: autosaveController.handleFlushed,
    handleRestored: autosaveController.handleRestored,
    handleRecoveryError: autosaveController.handleRecoveryError,
    handleSaveSlotRequest: saveSlotController.handleSaveSlotRequest,
    handlePromptRequest: promptController.handlePromptRequest,
    handleRoomAuthoring: (req: LlmRequest, agent: AgentHandler) =>
      loadAuthoringController().then((controller) =>
        controller.handleRoomAuthoring(req, agent, (dir) => sendDirection(dir)),
      ),
    // The room answer's authoring checkpoint posts after the hostAnswer —
    // the tape records the state after the cause that produced it — and
    // the saved room's install confirmation reads the game back after it.
    hostAnswered: (req: LlmRequest) => {
      if (req.op === "room") authoringController?.roomAnswered();
    },
    getAgentSession: () => authoringController?.getSession() ?? null,
    getReplayDriver: () => replayDriver,
    gameQuit: () => void lifecycle.gameQuit(),
    observeCycle: startOverNote.observeCycle,
    observeRoom: startOverNote.observeRoom,
  });

  async function discoverGames(): Promise<void> {
    state.installedGames = await discoverInstalledGames();
  }

  /** Acknowledge the engine's open modal (click path); the worker resumes ticking. */
  function dismissModal(): void {
    if (state.modal === null) return;
    link.getWorker()?.postMessage({ type: "dismissPrint" } satisfies WorkerInbound);
  }

  /** Player submitted (or cancelled) the blocking prompt modal. */
  function submitPrompt(value: string, cancelled = false): void {
    promptController.submitPrompt(value, cancelled);
  }

  /**
   * Play here: the live game jumps to a room with ego's baseline at (x, y),
   * keeping its flags (app/src/worker/playHere.ts). The jump runs under its
   * own pause hold; any other owner's hold keeps the game frozen after it.
   */
  async function playHere(target: PlayHereTarget): Promise<WorkerQueryPayload["playHere"]> {
    pauseEngine("playHere");
    try {
      return await link.query("playHere", { room: target.room, x: target.x, y: target.y });
    } finally {
      resumeEngine("playHere");
    }
  }

  async function visitRoom(room: number | "back"): Promise<WorkerQueryPayload["playHere"]> {
    pauseEngine("stageVisit");
    try {
      return await link.query("playHere", {
        room: room === "back" ? 1 : room,
        x: 0,
        y: 0,
        visit: room === "back" ? "back" : "start",
      });
    } finally {
      resumeEngine("stageVisit");
    }
  }

  async function launchRoom(
    room: number,
    launch: NonNullable<Extract<WorkerInbound, { type: "playHere" }>["launch"]> = {},
  ): Promise<WorkerQueryPayload["playHere"]> {
    pauseEngine("roomLaunch");
    try {
      return await link.query("playHere", { room, x: 0, y: 0, launch });
    } finally {
      resumeEngine("roomLaunch");
    }
  }

  const openPowerUp: ReturnType<typeof useAuthoringController>["openPowerUp"] = async (...args) =>
    (await loadAuthoringController()).openPowerUp(...args);
  function closePowerUp(): void {
    state.powerUp.open = false;
    authoringController?.closePowerUp();
  }
  const submitPowerUp: ReturnType<typeof useAuthoringController>["submitPowerUp"] = async (
    ...args
  ) => (await loadAuthoringController()).submitPowerUp(...args);

  const startOver = createStartOver({
    state,
    getBootedGame: lifecycle.getBootedGame,
    getWorker: link.getWorker,
    // Every spawned worker session moves this counter, so a boot that
    // replaced the slot mid-operation supersedes the parked call even when
    // the game and target spell out the same.
    getSessionId: () => activeWalkthroughSession,
    sealHistory: lifecycle.sealHistory,
    drainHistoryCommits: async () => {
      await historyController?.drainHistoryCommits();
    },
    pauseEngine,
    resumeEngine,
    selectTarget: (targetKey, booted) => autosaveController.selectProgressTarget(targetKey, booted),
    hasEarlierSession: (targetLocator) =>
      import("../history/historyStorage.ts")
        .then(({ loadTapeOutline }) => loadTapeOutline(targetLocator))
        .then((outline) => outline?.segments.some((segment) => segment.extent > 0) ?? false)
        .catch(() => false),
    // historyView is built by prepareRun, which Start over awaits first.
    prepareTimeline: prepareRun,
    expectStartOver: (expected) => historyView!.expectStartOver(expected),
    bootFresh: (targetKey, config, admission) =>
      autosaveController.startOver(targetKey, config, admission),
    showNote: startOverNote.show,
  });

  /** Undo start over: back to where the earlier session ended. */
  async function undoStartOver(): Promise<boolean> {
    startOverNote.hide();
    return historyView!.undoStartOver();
  }

  async function updateAiConfig(config: LlmConfig): Promise<void> {
    activeLlmConfig = config;
    if (authoringController) await authoringController.updateAiConfig(config);
  }

  const { startTestRecording, stopTestRecording, cancelTestRecording, saveRecordedTest } =
    testRecorder;

  function loadAudio(): Promise<AgiAudio> {
    audioLoading ??= import("../audio/AgiAudio.ts")
      .then(({ AgiAudio }) => {
        audio = new AgiAudio({
          mode: state.soundMode,
          muted: state.soundMuted,
          amigaRegion: amigaSettings.region.value,
        });
        audio.setPaused(state.paused);
        if (import.meta.env?.DEV)
          (window as unknown as { __AGI_AUDIO__: AgiAudio }).__AGI_AUDIO__ = audio;
        return audio;
      })
      .catch((error: unknown) => {
        audioLoading = undefined;
        throw error;
      });
    return audioLoading;
  }
  function toggleMute(): boolean {
    state.soundMuted = !state.soundMuted;
    audio?.setMuted(state.soundMuted);
    link
      .getWorker()
      ?.postMessage({ type: "soundEnabled", enabled: !state.soundMuted } satisfies WorkerInbound);
    return state.soundMuted;
  }
  function setAudioMode(mode: AudioMode): void {
    state.soundMode = mode;
    audio?.setMode(mode);
    link.getWorker()?.postMessage({
      type: "soundDevice",
      device: mode === "pc-speaker" ? 0 : 1,
    } satisfies WorkerInbound);
  }
  async function resumeAudio(): Promise<void> {
    await (await loadAudio()).resume();
  }

  const walkthrough = useWalkthroughController({
    state,
    get audio() {
      return audio;
    },
    replayDriver,
    getWorker: link.getWorker,
    getWorkerProfile: () => state.profile,
    getBootedGame: lifecycle.getBootedGame,
    isCurrentGame: (target) =>
      Boolean(
        link.getWorker() &&
        (lifecycle.getBootedGame()?.alias === target ||
          lifecycle.getBootedGame()?.projectId === target ||
          lifecycle.getBootedGame()?.hash === target ||
          lifecycle.getBootedGame()?.folder === target),
      ),
    nextSessionId: () => ++activeWalkthroughSession,
    getActiveSessionId: () => activeWalkthroughSession,
    setActiveReplaySeed: (seed) => {
      activeReplaySeed = seed;
    },
    setActiveReplayRngVersion: (version) => {
      activeReplayRngVersion = version;
    },
    observationListeners,
    cancelPendingPrompts,
    drainPendingQueries: link.drainPendingQueries,
    bootGame: lifecycle.bootGame,
    bootAuthoredGame: lifecycle.bootAuthoredGame,
    configForGame: lifecycle.configForGame,
    ejectGame: lifecycle.ejectGame,
    sendDirection,
    logAgent,
    isInstalledGame: lifecycle.isInstalledGame,
    onWalkthroughReset: () => {
      autosaveController.reset();
    },
  });
  walkthroughAbort = walkthrough.abort;

  const roomMap = shallowRef<ReturnType<typeof useRoomMap> | null>(null);
  const mapScope = effectScope();
  let historyView: ReturnType<typeof useHistoryView> | undefined;
  let mapLoading: Promise<void> | undefined;
  function prepareRun(): Promise<void> {
    mapLoading ??= Promise.all([
      import("../world/useRoomMap.ts"),
      import("../history/useHistoryController.ts"),
      import("../history/useHistoryView.ts"),
      loadAudio(),
    ]).then(([{ useRoomMap }, { useHistoryController }, { useHistoryView }]) => {
      historyController = useHistoryController({
        state,
        getBootedGame: () => lifecycle.getBootedGame(),
        getProfile: () => state.profile,
        scheduleRenewal: (callback, delay) => {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
        logAgent,
        retryWorker: () =>
          link.getWorker()?.postMessage({ type: "historyRetry" } satisfies WorkerInbound),
      });
      historyView = useHistoryView({
        state,
        getWorker: link.getWorker,
        query: link.query,
        getBootedGame: () => lifecycle.getBootedGame(),
        pauseEngine,
        resumeEngine,
        drainHistoryCommits: async () => {
          await projectSession?.flush();
          await historyController?.drainHistoryCommits();
        },
        highlightRoom: (room) => roomMap.value?.select(room),
        getSession: () => authoringController?.getSession() ?? null,
        adoptSession: adoptHistorySession,
        logAgent,
      });
      link.deps.handleHistoryView = historyView.applyReport;
      roomMap.value =
        mapScope.run(() =>
          useRoomMap({
            state,
            hook,
            getBootedGame: () => lifecycle.getBootedGame(),
            getSession: () => authoringController?.getSession() ?? null,
            pauseEngine,
            resumeEngine,
            pauseWalkthrough: walkthrough.pauseWalkthrough,
            resumeWalkthrough: walkthrough.resumeWalkthrough,
            onWorldEdited: () =>
              loadAuthoringController().then((controller) => controller.persistSessionState()),
            buildRoomFromMap: (room, from, notes, exitName) =>
              loadAuthoringController().then((controller) =>
                controller.buildRoomFromMap(room, from, notes, exitName),
              ),
          }),
        ) ?? null;
    });
    return mapLoading;
  }

  return {
    playerSentences,
    loadPlayerSentences,
    resolvePlayerSentence(entry: PlayerSentence) {
      if (!sentenceTools) return;
      playerSentences.value = sentenceTools.resolvePlayerSentence(playerSentences.value, entry);
      if (triedProject) sentenceTools.savePlayerSentences(triedProject, playerSentences.value);
    },
    async setProjectMode(mode: "create" | "play", restart = false): Promise<boolean> {
      const prior = projectMode;
      if (mode === "create") state.entryProblem = "";
      if (mode === "play" && state.phase === "running") {
        const reply = await link.query("projectPlay", restart ? { restart: true } : {});
        if (!reply.ok) {
          state.returnProblem = reply.reason ?? "Your game needs a restart.";
          return false;
        }
      }
      if (mode === "play") state.returnProblem = "";
      projectMode = mode;
      loadTried();
      link.getWorker()?.postMessage({
        type: "observeSentences",
        enabled: mode === "create",
      } satisfies WorkerInbound);
      let game = lifecycle.getBootedGame();
      const worker = link.getWorker();
      if (mode === "create" && game?.installed && !game.authoredGame && game.historyLifetime) {
        const id = requireProjectId(`edition-${crypto.randomUUID()}`);
        game = {
          ...game,
          projectId: id,
          authoredGame: {
            projectId: id,
            title: game.title,
            authoredAt: new Date().toISOString(),
            files: game.files,
            words: game.words,
            imported: true,
            roomGeneration: false,
            library: {
              version: 1,
              revision: game.revision,
              source: "folder",
              profile: roomMap.value?.resources.value.profile?.id ?? "2.936",
              validation: { status: "ready", message: "Ready to edit" },
            },
          },
        };
        lifecycle.setBootedGame(game);
      }
      if (
        mode !== "create" ||
        projectSessionOpening ||
        !game?.authoredGame ||
        state.phase !== "running"
      )
        return true;
      const data = game.authoredGame;
      return link
        .query("projectCreate", {
          progressMode: projectMode,
          ...(data.workspace ? { documents: data.workspace } : {}),
          ...(data.projectHistory ? { history: data.projectHistory } : {}),
        })
        .then(async (reply) => {
          if (
            projectMode !== "create" ||
            lifecycle.getBootedGame() !== game ||
            link.getWorker() !== worker
          )
            return false;
          if (!reply.grant) {
            projectMode = prior;
            state.entryProblem = reply.reason ?? "Open this game in Create to edit it.";
            state.status = state.entryProblem;
            return false;
          }
          if (projectSession && projectSession.runToken !== reply.grant.runToken) {
            await projectSession.flush();
            const { loadAuthoredGame } = await import("../project/gameStorage.ts");
            const saved = await loadAuthoredGame(data.projectId);
            if (
              projectMode !== "create" ||
              lifecycle.getBootedGame() !== game ||
              link.getWorker() !== worker
            )
              return false;
            if (saved === null) throw new Error("The saved project is missing. Reopen the game.");
            game.authoredGame = saved;
          }
          await openSession(reply.grant);
          return true;
        })
        .catch((cause) => {
          if (lifecycle.getBootedGame() === game) state.status = String(cause);
          projectMode = prior;
          return false;
        });
    },
    takePlayBack: () => progressOwnership.takeBack(),
    getProjectSession: () => projectSession,
    previewImageCels(bytes: Uint8Array | null, loops?: readonly number[]): void {
      if (projectSession)
        link.getWorker()?.postMessage({
          type: "imageHeroPreview",
          runToken: projectSession.runToken,
          bytes,
          ...(loops ? { loops } : {}),
        } satisfies WorkerInbound);
    },
    pendingProjectRestart,
    restartWithChanges() {
      return projectSession?.restartWithChanges();
    },
    reenterRoom() {
      return projectSession?.reenterRoom();
    },
    submitProjectEdit(
      edit: { changes: readonly ProjectChange[] } & Omit<ProjectCommitMetadata, "time">,
    ) {
      const session = projectSession;
      if (session === null) throw new Error("Open this game in Create to edit it.");
      if (edit.author === "creator") return session.stage(edit.changes);
      const proposal = session.model.propose(session.model.capture(), edit.label, edit.changes);
      return session.submit({
        proposal,
        origin: edit.origin,
        label: edit.label,
        author: edit.author,
      });
    },
    stopAgent: () => authoringController?.getSession()?.task.stop(),
    continueAgent: (requestLimit?: number) =>
      authoringController?.getSession()?.task.resume(requestLimit),
    discardAgent: () => authoringController?.getSession()?.task.cancel(),
    state,
    get audio() {
      return audio!;
    },
    toggleMute,
    setAudioMode,
    resumeAudio,
    discoverGames,
    bootGame: lifecycle.bootGame,
    bootAgentGame: lifecycle.bootAgentGame,
    bootAuthoredGame: lifecycle.bootAuthoredGame,
    openStarterRecovery: lifecycle.openStarterRecovery,
    startWalkthrough: walkthrough.startWalkthrough,
    stopWalkthrough: walkthrough.stopWalkthrough,
    setWalkthroughSpeed: walkthrough.setWalkthroughSpeed,
    toggleWalkthroughPause: walkthrough.toggleWalkthroughPause,
    toggleWalkthroughPauseOnDialog: walkthrough.toggleWalkthroughPauseOnDialog,
    advanceDialog: walkthrough.advanceDialog,
    pauseWalkthrough: walkthrough.pauseWalkthrough,
    resumeWalkthrough: walkthrough.resumeWalkthrough,
    seekToTick: walkthrough.seekToTick,
    seekToCheckpoint: walkthrough.seekToCheckpoint,
    // The player's own input: the first key, click or command after a
    // Start over starts the note's countdown.
    sendInput: (text: string) => {
      startOverNote.noteInput();
      sendInput(text);
    },
    sendEdit: (text: string) => {
      startOverNote.noteInput();
      sendEdit(text);
    },
    sendDirection: (dir: number, sessionId?: number) => {
      startOverNote.noteInput();
      sendDirection(dir, sessionId);
    },
    sendKey: (code: number, sessionId?: number) => {
      startOverNote.noteInput();
      sendKey(code, sessionId);
    },
    sendClick: (x: number, y: number, sessionId?: number) => {
      startOverNote.noteInput();
      sendClick(x, y, sessionId);
    },
    dismissModal,
    submitPrompt,
    ejectGame: lifecycle.ejectGame,
    clearAgentLog,
    releaseAgentAudioPreviews,
    pauseEngine,
    resumeEngine,
    /**
     * Preview surfaces' owned freeze: pauses under a unique token, awaits the
     * same worker's FIFO state reply, and releases only that hold while the
     * captured worker is still current. Resolves a no-op lease with no run.
     */
    acquireRuntimePauseLease,
    get roomMap() {
      return roomMap.value!;
    },
    get historyView() {
      return historyView!;
    },
    /**
     * The transport bar's model — the walkthrough artifact's while one plays,
     * else the live recording's: always on from boot, LIVE-pinned, recording
     * and saving on its own.
     */
    get transport(): TransportModel | null {
      if (state.phase !== "running") return null;
      if (state.walkthrough.active) return walkthrough.transport;
      return historyView!.transport;
    },
    /** The "history not saved" banner's Try now: resend, then Saved or the reason. */
    retryHistorySave: async () => historyController?.retrySave(),
    /** Beside a stored tape this version cannot extend, start a new one (player-confirmed). */
    startNewTimeline: async () => historyController?.startNewTimeline(),
    /** That old tape's stored records, verbatim as JSON, for its own reader. */
    readOldTimeline: async () => (await historyController?.readOldTimeline()) ?? null,
    /** Export waits out in-flight history commits before reading the tape. */
    drainHistoryCommits: async () => {
      await historyController?.drainHistoryCommits();
    },
    observeMapFrame: (frame: Frame) => roomMap.value?.observeFrame(frame),
    readFrames: async (req: Parameters<ReturnType<typeof useEngineDebug>["readFrames"]>[0]) =>
      (await loadEngineDebug()).readFrames(req),
    getAuthoringSession: () => authoringController?.getSession() ?? null,
    getAgentRuntime: async (
      ...args: Parameters<ReturnType<typeof useAuthoringController>["getAgentRuntime"]>
    ) => (await loadAuthoringController()).getAgentRuntime(...args),
    updateAiConfig,
    openPowerUp(config: LlmConfig) {
      if (projectMode !== "create") return openPowerUp(config);
      state.powerUp.open = true;
      state.powerUp.mode = "remix";
      state.powerUp.busy = false;
      return Promise.resolve();
    },
    closePowerUp,
    submitPowerUp,
    listReferences: async (
      ...args: Parameters<ReturnType<typeof useAuthoringController>["listReferences"]>
    ) => (await loadAuthoringController()).listReferences(...args),
    attachRoomReference: async (
      ...args: Parameters<ReturnType<typeof useAuthoringController>["attachRoomReference"]>
    ) => (await loadAuthoringController()).attachRoomReference(...args),
    attachCharacterReference: async (
      ...args: Parameters<ReturnType<typeof useAuthoringController>["attachCharacterReference"]>
    ) => (await loadAuthoringController()).attachCharacterReference(...args),
    attachStudioReference: async (
      ...args: Parameters<ReturnType<typeof useAuthoringController>["attachStudioReference"]>
    ) => (await loadAuthoringController()).attachStudioReference(...args),
    detachReference: async (
      ...args: Parameters<ReturnType<typeof useAuthoringController>["detachReference"]>
    ) => (await loadAuthoringController()).detachReference(...args),
    keepStagedView: async (
      ...args: Parameters<ReturnType<typeof useAuthoringController>["keepStagedView"]>
    ) => (await loadAuthoringController()).keepStagedView(...args),
    commitPictureEdit: async (
      ...args: Parameters<ReturnType<typeof useAuthoringController>["commitPictureEdit"]>
    ) => (await loadAuthoringController()).commitPictureEdit(...args),
    commitRoomEdit: async (
      ...args: Parameters<ReturnType<typeof useAuthoringController>["commitRoomEdit"]>
    ) => (await loadAuthoringController()).commitRoomEdit(...args),
    commitViewEdit: async (
      ...args: Parameters<ReturnType<typeof useAuthoringController>["commitViewEdit"]>
    ) => (await loadAuthoringController()).commitViewEdit(...args),
    isInstalledGame: lifecycle.isInstalledGame,
    currentGame: lifecycle.currentGame,
    getBootedGame: lifecycle.getBootedGame,
    exportCurrentGame: lifecycle.exportCurrentGame,
    recoverHistory: () => link.query("historyRecover"),
    startTestRecording,
    stopTestRecording,
    cancelTestRecording,
    saveRecordedTest,
    resumeLastGame: autosaveController.resumeLastGame,
    resumeFromRecord: autosaveController.resumeFromRecord,
    /**
     * Earlier progress "Open checkpoint": a proven, rebound checkpoint into
     * its explicitly selected destination — revalidated against the live
     * body and settled only by the worker's real restore acknowledgement.
     */
    resumeEarlierCheckpoint: autosaveController.resumeEarlierCheckpoint,
    /** The pending resume's proven destination while it awaits the ack. */
    pendingProgressTarget: autosaveController.pendingProgressTarget,
    startOver,
    undoStartOver,
    dismissStartOverNote: startOverNote.hide,
    /** Boot the running project again from storage under its own AI settings. */
    reloadFromStorage: () => autosaveController.reloadFromStorage(activeLlmConfig),
    flushAutosave: async (timeoutMs?: number) => {
      const documents = projectSession?.flush().catch((cause: unknown) => {
        logAgent("error", `Could not save project documents: ${String(cause)}`);
      });
      const [progress] = await Promise.all([
        autosaveController.flushAutosave(timeoutMs),
        documents,
      ]);
      return progress;
    },
    flushAutosaveDetailed: autosaveController.flushAutosaveDetailed,
    lastAutosaveRecord: autosaveController.lastAutosaveRecord,
    loadExecutionDebug,
    get executionDebug() {
      return executionDebug!;
    },
    setDebugConsumer: async (
      ...args: Parameters<ReturnType<typeof useEngineDebug>["setDebugConsumer"]>
    ) => (await loadEngineDebug()).setDebugConsumer(...args),
    debugWrite: async (...args: Parameters<ReturnType<typeof useEngineDebug>["debugWrite"]>) =>
      (await loadEngineDebug()).debugWrite(...args),
    playHere,
    visitRoom,
    launchRoom,
    /** The live screen objects (ego first when animated): Room Studio's walkable estimate. */
    readObjects: () => link.query("objects"),
    debugEventsSince: async (
      ...args: Parameters<ReturnType<typeof useEngineDebug>["debugEventsSince"]>
    ) => (await loadEngineDebug()).debugEventsSince(...args),
    debugTraceSince: async (
      ...args: Parameters<ReturnType<typeof useEngineDebug>["debugTraceSince"]>
    ) => (await loadEngineDebug()).debugTraceSince(...args),
    readEngineState: async (
      ...args: Parameters<ReturnType<typeof useEngineDebug>["readEngineState"]>
    ) => (await loadEngineDebug()).readEngineState(...args),
    shutdownEngine: lifecycle.shutdownEngine,
  };
}
