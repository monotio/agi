import type { ProfileId } from "../../../src/runtime/profile.ts";
import type { AgentHandler, LlmRequest } from "../agent/hostRequests.ts";
import { getCurrentScope, onScopeDispose, reactive, shallowReactive } from "vue";
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
  resumableAutosave,
  useAutosaveController,
  writeAutosave,
} from "../saves/useAutosaveController.ts";
import { clearCachedGame } from "../project/gameStorage.ts";
import { PROJECT_REMOVED_MESSAGE, watchProjectWrites } from "../project/projectTransaction.ts";
import { clearGameSaves } from "../saves/gameSaves.ts";
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
import { useEngineDebug } from "./useEngineDebug.ts";
import { useRoomMap } from "../world/useRoomMap.ts";
import type { WorkerInbound, WorkerQueryPayload } from "../worker/workerProtocol.ts";
import type { PlayHereTarget } from "../../../src/runtime/playHere.ts";
import type { HistoryBatch } from "../../../src/agent/history.ts";
export type { ModalKind, TextHook, EngineState } from "./useEngineTypes.ts";
import type { EngineState, TextHook } from "./useEngineTypes.ts";

export { autosaveKey, lastGameKey, readAutosave, resumableAutosave, writeAutosave };
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
  }

  /**
   * Storage moved past the running game, found by a refused autosave or
   * another tab's notice: the Assistant says so and offers Reload game, as a
   * refused turn does, and the stage's note says it while it is closed.
   */
  function tellBehindStorage(): void {
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
    bootGame: (target) => lifecycle.bootGame(target),
    bootAuthoredGame: (template, config, bootOptions) =>
      lifecycle.bootAuthoredGame(template, config, bootOptions),
    configForGame: (projectId, config) => lifecycle.configForGame(projectId, config),
  });

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
      localStorage.setItem("monotio_agi.lastGame", remixProjectId);
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
    markRemixNeedsSave: () => authoringController.setRemixNeedsSave(true),
    persistRemix: authoringController.persistRemix,
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
    getSessionId: () => activeWalkthroughSession,
    nextSessionId: () => ++activeWalkthroughSession,
    getActiveReplaySeed: () => activeReplaySeed,
    setActiveReplaySeed: (seed) => {
      activeReplaySeed = seed;
    },
    setActiveLlmConfig: (config) => {
      activeLlmConfig = config;
    },
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
   * Freeze / unfreeze the interpreter. Pause is an ordinary worker message:
   * messages from one sender are delivered in order, so a pause posted before
   * a query is always applied before the query is served — at most one more
   * cycle runs first, and nobody reads state before the freeze lands. The
   * worker's `paused` reply mirrors the real state into the test hook.
   *
   * Several overlays can hold the pause at once (map, remix bubble, history
   * transport, AI settings). Each caller owns its hold: the freeze message
   * goes out when the first owner parks, and the resume only when the last
   * owner releases — nobody's pause ends while another is still open.
   */
  const pauseOwners = new Set<string>();

  function pauseEngine(owner = "generic"): void {
    if (pauseOwners.size === 0)
      link.getWorker()?.postMessage({ type: "pause", paused: true } satisfies WorkerInbound);
    pauseOwners.add(owner);
    audio.setPaused(true);
    state.paused = true;
  }

  function resumeEngine(owner = "generic"): void {
    pauseOwners.delete(owner);
    if (pauseOwners.size === 0) {
      link.getWorker()?.postMessage({ type: "pause", paused: false } satisfies WorkerInbound);
      audio.setPaused(false);
      state.paused = false;
    }
  }

  /** A replaced worker takes its freeze with it; no owner survives the swap. */
  function resetPauseOwners(): void {
    pauseOwners.clear();
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

  /**
   * Start over, and when the game's timeline already holds a session to go
   * back to, the note that offers Undo start over. The check reads the tape
   * before the fresh boot adds its own segment.
   */
  async function startOver(targetKey: string, config: LlmConfig): Promise<void> {
    const earlier = await loadTapeOutline(targetKey)
      .then((outline) => outline?.segments.some((segment) => segment.extent > 0) ?? false)
      .catch(() => false);
    await autosaveController.startOver(targetKey, config);
    if (earlier && state.phase !== "error" && lifecycle.getBootedGame() !== null)
      startOverNote.show();
  }

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
    runStudioAssist: authoringController.runStudioAssist,
    stopAgent: () => authoringController.getSession()?.task.stop(),
    continueAgent: () => authoringController.getSession()?.task.resume(),
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
    exportCurrentGame: lifecycle.exportCurrentGame,
    recoverHistory: () => link.query("historyRecover"),
    startTestRecording,
    stopTestRecording,
    cancelTestRecording,
    saveRecordedTest,
    resumeLastGame: autosaveController.resumeLastGame,
    resumeFromRecord: autosaveController.resumeFromRecord,
    startOver,
    undoStartOver,
    dismissStartOverNote: startOverNote.hide,
    /** Boot the running project again from storage under its own AI settings. */
    reloadFromStorage: () => autosaveController.reloadFromStorage(activeLlmConfig),
    flushAutosave: autosaveController.flushAutosave,
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
