import { parseWordsTok } from "../../../src/logic/words.ts";
import type { ProjectChange } from "../../../src/authoring/projectContent.ts";
import type { ProjectCommitMetadata } from "../../../src/authoring/projectHistoryData.ts";
import type { ProjectSession, PendingProjectRestart } from "../project/projectSession.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import type { AgentHandler, LlmRequest } from "../agent/hostRequests.ts";
import { getCurrentScope, onScopeDispose, reactive, shallowReactive, shallowRef } from "vue";
import { createAgentLogger } from "../agent/agentLog.ts";
import type { ReplayObservation } from "../walkthrough/replay.ts";
import { createReplayDriver } from "../walkthrough/useReplayDriver.ts";
import {
  useWalkthroughController,
  createInitialWalkthroughState,
} from "../walkthrough/useWalkthroughController.ts";
import { useInputController } from "../play/useInputController.ts";
import { useTestRecorder } from "../authoring/useTestRecorder.ts";
import { STALE_SAVE_MESSAGE, useAuthoringController } from "../authoring/useAuthoringController.ts";
import type { LlmConfig } from "../agent/llmClient.ts";
import { AgiAudio } from "../audio/AgiAudio.ts";
import { useAudioController } from "../audio/useAudioController.ts";
import {
  autosaveKey,
  clearAutosave,
  lastGameKey,
  readAutosave,
  useAutosaveController,
  writeAutosave,
} from "../saves/useAutosaveController.ts";
import { clearCachedGame } from "../project/gameStorage.ts";
import { resolveProgressTarget } from "../project/progressBinding.ts";
import { PROJECT_REMOVED_MESSAGE, watchProjectWrites } from "../project/projectTransaction.ts";
import { clearGameSaves } from "../saves/gameSaves.ts";
import { writeResumePointer } from "../saves/resumePointer.ts";
import { removeMapSidecar } from "../world/roomMapStore.ts";
import type { BootedGame, Frame, ProjectId } from "../project/gameTypes.ts";
export type { BootedGame, Frame, ProjectId };

import { usePromptController } from "../play/usePromptController.ts";
import { useSaveSlotController } from "../saves/useSaveSlotController.ts";
import { discoverInstalledGames } from "../library/gameDiscovery.ts";
import { useWorkerLink } from "./useWorkerLink.ts";
import { useHistoryController } from "../history/useHistoryController.ts";
import { useHistoryView, freshHistoryView } from "../history/useHistoryView.ts";
import { useStartOverNote } from "../history/useStartOverNote.ts";
import { loadTapeOutline } from "../history/historyStorage.ts";
import type { TransportModel } from "../history/useTransport.ts";
import { useGameLifecycle } from "./useGameLifecycle.ts";
import { createPauseHolds } from "./pauseHolds.ts";
import { createRuntimePauseLeaseAcquire } from "./runtimePauseLease.ts";
import { createStartOver } from "./startOver.ts";
import { useEngineDebug } from "./useEngineDebug.ts";
import { useRoomMap } from "../world/useRoomMap.ts";
import type { WorkerInbound, WorkerQueryPayload } from "../worker/workerProtocol.ts";
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
  clearAutosave(projectId);
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
  engineOptions?: { onPromptType?: (text: string) => void },
) {
  let projectMode: "create" | "play" = "play";
  let projectSession: ProjectSession | null = null;
  const pendingProjectRestart = shallowRef<PendingProjectRestart | null>(null);
  let projectOpenEpoch = 0;
  const audio = new AgiAudio();

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
    soundMuted: audio.isMuted,
    soundMode: audio.currentMode,
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
  const observationListeners = new Set<(obs: ReplayObservation) => void>();

  const { logAgent, clearAgentLog, releaseAgentAudioPreviews } = createAgentLogger(state);
  const promptController = usePromptController({ state, logAgent });
  const saveSlotController = useSaveSlotController({
    getBootedGame: () => lifecycle.getBootedGame(),
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
    audio,
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
    audio,
    state,
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

  const debug = useEngineDebug({ state, link });

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
    (window as unknown as { __AGI_AUDIO__: AgiAudio }).__AGI_AUDIO__ = audio;
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
    projectSession?.stopWrites();
    autosaveController.handleRecoveryError(PROJECT_REMOVED_MESSAGE);
    logAgent("error", PROJECT_REMOVED_MESSAGE);
    state.powerUp.error = PROJECT_REMOVED_MESSAGE;
    state.powerUp.offerReload = false;
    state.staleTab = false;
    state.projectRemoved = true;
    historyController.forgetRemovedGame();
  }

  const autosaveController = useAutosaveController({
    state,
    getBootedGame: () => lifecycle.getBootedGame(),
    getWorker: link.getWorker,
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
    projectOpenEpoch++;
    projectSession?.dispose();
    projectSession = null;
    pendingProjectRestart.value = null;
  };
  link.deps.projectBooted = (msg) => {
    const grant = msg.projectAdmission;
    const game = lifecycle.getBootedGame();
    const worker = link.getWorker();
    const epoch = ++projectOpenEpoch;
    if (
      grant === undefined ||
      game?.authoredGame === undefined ||
      game.projectId === undefined ||
      game.historyLifetime == null
    )
      return;
    const current = () =>
      projectOpenEpoch === epoch &&
      lifecycle.getBootedGame() === game &&
      link.getWorker() === worker &&
      !game.removed &&
      !game.behindStorage;
    void Promise.all([import("../project/projectSession.ts"), import("./mainProjectAdmission.ts")])
      .then(([{ openProjectSession }, { createMainProjectAdmission }]) => {
        if (!current()) return;
        const admission = createMainProjectAdmission({ ...grant, query: link.query, current });
        projectSession = openProjectSession({
          data: game.authoredGame!,
          lifetime: game.historyLifetime!,
          admission,
          current,
          publish(snapshot, data, outcome) {
            if (!current()) return;
            const running = outcome?.status === "committed" || outcome?.status === "unchanged";
            if (running) {
              game.files = structuredClone(data.files);
              game.revision = snapshot.lastAdmissibleBuild!.identity.revision;
              if (outcome.replacementRunToken !== undefined)
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
            if (running) audio.useGameFiles(game.files);
            state.patchTick++;
            state.worldTick++;
            if (outcome?.status === "committed") {
              roomMap.projectImageAdmitted(outcome.patchGeneration);
              const frame = link.getLatestFrame();
              if (frame !== null) roomMap.observeFrame(frame);
            }
          },
          changed() {
            if (current()) {
              state.status = projectSession?.saveStatus().message ?? "";
              pendingProjectRestart.value = projectSession?.pendingRestart ?? null;
            }
          },
        });
      })
      .catch((error: unknown) => {
        if (current()) state.status = String(error instanceof Error ? error.message : error);
      });
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

  const historyController = useHistoryController({
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

  const authoringController = useAuthoringController({
    state,
    getWorker: link.getWorker,
    query: link.query,
    awaitPatched: link.awaitPatched,
    logAgent,
    readFrames: debug.readFrames,
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
    getRoomNotes: (room) => roomMap.noteIntentFor(room),
    onBehindStorage: tellBehindStorage,
  });

  const testRecorder = useTestRecorder({
    state,
    getWorker: link.getWorker,
    query: link.query,
    logAgent,
    getBootedGame: () => lifecycle.getBootedGame(),
    getOrCreateSession: authoringController.getOrCreateSession,
    commitTestsFile: authoringController.commitTestsFile,
    flushAutosave: () => autosaveController.flushAutosave(),
  });

  const lifecycle = useGameLifecycle({
    state,
    hook,
    audio,
    logAgent,
    link,
    autosave: autosaveController,
    authoring: authoringController,
    testRecorder,
    promptCancel: cancelPendingPrompts,
    releaseAgentAudioPreviews,
    pauseEngine,
    resumeEngine,
    resetPauseOwners,
    resetHistoryView: () => {
      historyView.resetHistoryView();
      startOverNote.hide();
    },
    stopHistoryWriter: historyController.stopWriterRenewal,
    flushProject: async () => {
      const session = projectSession;
      if (session === null) return;
      await session.flush();
      if (session.saveStatus().state !== "saved") throw new Error(session.saveStatus().message);
    },
    getProjectMode: () => projectMode,
    getSessionId: () => activeWalkthroughSession,
    nextSessionId: () => ++activeWalkthroughSession,
    getActiveReplaySeed: () => activeReplaySeed,
    setActiveReplaySeed: (seed) => {
      activeReplaySeed = seed;
    },
    setActiveLlmConfig: (config) => {
      activeLlmConfig = config;
    },
    getActiveLlmConfig: () => activeLlmConfig,
    abortWalkthrough: () => walkthroughAbort(),
    drainHistoryCommits: historyController.drainHistoryCommits,
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
      historyView.observeBatch(msg.batch);
      return historyController.handleHistoryBatch(msg);
    },
    handleFlushed: autosaveController.handleFlushed,
    handleRestored: autosaveController.handleRestored,
    handleRecoveryError: autosaveController.handleRecoveryError,
    handleSaveSlotRequest: saveSlotController.handleSaveSlotRequest,
    handlePromptRequest: promptController.handlePromptRequest,
    handleRoomAuthoring: (req: LlmRequest, agent: AgentHandler) =>
      authoringController.handleRoomAuthoring(req, agent, (dir) => sendDirection(dir)),
    // The room answer's authoring checkpoint posts after the hostAnswer —
    // the tape records the state after the cause that produced it — and
    // the saved room's install confirmation reads the game back after it.
    hostAnswered: (req: LlmRequest) => {
      if (req.op === "room") authoringController.roomAnswered();
    },
    getAgentSession: () => authoringController.getSession(),
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

  const { openPowerUp, closePowerUp, submitPowerUp } = authoringController;

  const startOver = createStartOver({
    state,
    getBootedGame: lifecycle.getBootedGame,
    getWorker: link.getWorker,
    // Every spawned worker session moves this counter, so a boot that
    // replaced the slot mid-operation supersedes the parked call even when
    // the game and target spell out the same.
    getSessionId: () => activeWalkthroughSession,
    sealHistory: lifecycle.sealHistory,
    drainHistoryCommits: historyController.drainHistoryCommits,
    pauseEngine,
    resumeEngine,
    selectTarget: (targetKey, booted) => autosaveController.selectProgressTarget(targetKey, booted),
    hasEarlierSession: (targetLocator) =>
      loadTapeOutline(targetLocator)
        .then((outline) => outline?.segments.some((segment) => segment.extent > 0) ?? false)
        .catch(() => false),
    // historyView is built below; the closure reads it once it exists.
    expectStartOver: (expected) => historyView.expectStartOver(expected),
    bootFresh: (targetKey, config, admission) =>
      autosaveController.startOver(targetKey, config, admission),
    showNote: startOverNote.show,
  });

  /** Undo start over: back to where the earlier session ended. */
  async function undoStartOver(): Promise<boolean> {
    startOverNote.hide();
    return historyView.undoStartOver();
  }

  async function updateAiConfig(config: LlmConfig): Promise<void> {
    activeLlmConfig = config;
    await authoringController.updateAiConfig(config);
  }

  const { startTestRecording, stopTestRecording, cancelTestRecording, saveRecordedTest } =
    testRecorder;

  const { toggleMute, setAudioMode, resumeAudio } = useAudioController(audio, state, (msg) =>
    link.getWorker()?.postMessage(msg),
  );

  const walkthrough = useWalkthroughController({
    state,
    audio,
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

  const roomMap = useRoomMap({
    state,
    hook,
    getBootedGame: () => lifecycle.getBootedGame(),
    getSession: () => authoringController.getSession(),
    pauseEngine,
    resumeEngine,
    pauseWalkthrough: walkthrough.pauseWalkthrough,
    resumeWalkthrough: walkthrough.resumeWalkthrough,
    onWorldEdited: () => authoringController.persistSessionState(),
    buildRoomFromMap: (room, from, notes, exitName) =>
      authoringController.buildRoomFromMap(room, from, notes, exitName),
  });

  const historyView = useHistoryView({
    state,
    getWorker: link.getWorker,
    query: link.query,
    getBootedGame: () => lifecycle.getBootedGame(),
    pauseEngine,
    resumeEngine,
    drainHistoryCommits: historyController.drainHistoryCommits,
    highlightRoom: (room) => roomMap.select(room),
    getSession: () => authoringController.getSession(),
    adoptSession: (game, boot, snapshot) =>
      authoringController.adoptSessionState(game, boot, snapshot),
    logAgent,
  });
  link.deps.handleHistoryView = historyView.applyReport;

  return {
    setProjectMode(mode: "create" | "play") {
      projectMode = mode;
    },
    getProjectSession: () => projectSession,
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
      const proposal = session.model.propose(session.model.capture(), edit.label, edit.changes);
      return session.submit({
        proposal,
        origin: edit.origin,
        label: edit.label,
        author: edit.author,
      });
    },
    runStudioAssist: authoringController.runStudioAssist,
    stopAgent: () => authoringController.getSession()?.task.stop(),
    continueAgent: (requestLimit?: number) =>
      authoringController.getSession()?.task.resume(requestLimit),
    discardAgent: () => authoringController.getSession()?.task.cancel(),
    state,
    audio,
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
    roomMap,
    historyView,
    /**
     * The transport bar's model — the walkthrough artifact's while one plays,
     * else the live recording's: always on from boot, LIVE-pinned, recording
     * and saving on its own.
     */
    get transport(): TransportModel | null {
      if (state.phase !== "running") return null;
      if (state.walkthrough.active) return walkthrough.transport;
      return historyView.transport;
    },
    /** The "history not saved" banner's Try now: resend, then Saved or the reason. */
    retryHistorySave: historyController.retrySave,
    /** Beside a stored tape this version cannot extend, start a new one (player-confirmed). */
    startNewTimeline: historyController.startNewTimeline,
    /** That old tape's stored records, verbatim as JSON, for its own reader. */
    readOldTimeline: historyController.readOldTimeline,
    /** Export waits out in-flight history commits before reading the tape. */
    drainHistoryCommits: historyController.drainHistoryCommits,
    observeMapFrame: roomMap.observeFrame,
    readFrames: debug.readFrames,
    updateAiConfig,
    openPowerUp,
    closePowerUp,
    submitPowerUp,
    listReferences: authoringController.listReferences,
    attachRoomReference: authoringController.attachRoomReference,
    attachCharacterReference: authoringController.attachCharacterReference,
    attachStudioReference: authoringController.attachStudioReference,
    detachReference: authoringController.detachReference,
    keepStagedView: authoringController.keepStagedView,
    commitPictureEdit: authoringController.commitPictureEdit,
    commitRoomEdit: authoringController.commitRoomEdit,
    commitViewEdit: authoringController.commitViewEdit,
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
      await projectSession?.flush();
      return autosaveController.flushAutosave(timeoutMs);
    },
    flushAutosaveDetailed: autosaveController.flushAutosaveDetailed,
    lastAutosaveRecord: autosaveController.lastAutosaveRecord,
    setDebugConsumer: debug.setDebugConsumer,
    debugWrite: debug.debugWrite,
    playHere,
    /** The live screen objects (ego first when animated): Room Studio's walkable estimate. */
    readObjects: () => link.query("objects"),
    debugEventsSince: debug.debugEventsSince,
    debugTraceSince: debug.debugTraceSince,
    readEngineState: debug.readEngineState,
    shutdownEngine: lifecycle.shutdownEngine,
  };
}
