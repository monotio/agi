import type { AgentHandler, LlmRequest } from "./agent/hostRequests.ts";
import { reactive } from "vue";
import { createAgentLogger, type AgentLogEntry, type AgentLogAudio } from "./agent/agentLog.ts";
import type { ReplayObservation } from "./replay.ts";
import { createReplayDriver } from "./useReplayDriver.ts";
import {
  useWalkthroughController,
  createInitialWalkthroughState,
  type WalkthroughUiState,
} from "./useWalkthroughController.ts";
import { useInputController } from "./useInputController.ts";
import { useTestRecorder } from "./useTestRecorder.ts";
import { useAuthoringController, type PowerUpUiState } from "./useAuthoringController.ts";
import type { LlmConfig } from "./agent/llmClient.ts";
import { AgiAudio } from "./audio/AgiAudio.ts";
import { useAudioController, type AudioController } from "./audio/useAudioController.ts";
import {
  autosaveKey,
  clearAutosave,
  lastGameKey,
  readAutosave,
  useAutosaveController,
  writeAutosave,
} from "./useAutosaveController.ts";
import { clearCachedGame } from "./gameStorage.ts";
import { clearGameSaves } from "./gameSaves.ts";
import { removeMapSidecar } from "./roomMapStore.ts";
import {
  type BootedGame,
  type CurrentGame,
  type Frame,
  type InstalledGameDescriptor,
  type ProjectId,
  findInstalledFolder,
} from "./gameTypes.ts";
export type { BootedGame, CurrentGame, Frame, InstalledGameDescriptor, ProjectId };
export { findInstalledFolder };

import { usePromptController, type PromptState } from "./usePromptController.ts";
import { useSaveSlotController } from "./useSaveSlotController.ts";
import { discoverInstalledGames } from "./gameDiscovery.ts";
import { useWorkerLink } from "./useWorkerLink.ts";
import { useGameLifecycle } from "./useGameLifecycle.ts";
import { useEngineDebug } from "./useEngineDebug.ts";
import { useRoomMap } from "./useRoomMap.ts";
import type { WorkerInbound } from "./workerProtocol.ts";
export type { PromptState };
export type { ModalKind, TextHook, EngineState } from "./useEngineTypes.ts";
import type { EngineState, TextHook } from "./useEngineTypes.ts";

export type { AgentLogEntry, AgentLogAudio };
export { useAudioController, type AudioController };
export type { WalkthroughUiState, PowerUpUiState };

export { autosaveKey, clearAutosave, lastGameKey, readAutosave, writeAutosave };
export type { AutosaveGame, AutosaveRecord } from "./useAutosaveController.ts";

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
    recording: { active: false, starting: false, error: "" },
    walkthrough: createInitialWalkthroughState(),
    debugObjects: [],
    debugTrace: [],
    debugTraceDropped: 0,
    roomJournal: [],
    patchTick: 0,
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

  const hook: TextHook = {
    rows: [],
    modal: null,
    textMode: false,
    profile: null,
    paused: false,
    cycle: 0,
    frame: 0,
    autosave: -1,
    room: 0,
    egoX: 0,
    egoY: 0,
  };

  const link = useWorkerLink({
    state,
    hook,
    audio,
    onFrame,
    logAgent,
    getBootedGame: () => lifecycle.getBootedGame(),
    getActiveWalkthroughSession: () => activeWalkthroughSession,
    observationListeners,
  });

  const input = useInputController({
    getWorker: link.getWorker,
    isSeeking: () => state.walkthrough.seeking,
    isHoldToMove: () => state.holdToMove,
    logAgent,
    getActiveWalkthroughSession: () => activeWalkthroughSession,
  });
  const { sendInput, sendEdit, sendDirection, sendKey } = input;

  const debug = useEngineDebug({ state, link });

  const replayDriver = createReplayDriver({
    query: link.query,
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
    logAgent,
    isInstalledGame: (target) => lifecycle.isInstalledGame(target),
    bootGame: (target) => lifecycle.bootGame(target),
    bootAuthoredGame: (template, config, bootOptions) =>
      lifecycle.bootAuthoredGame(template, config, bootOptions),
    configForGame: (projectId, config) => lifecycle.configForGame(projectId, config),
  });

  const authoringController = useAuthoringController({
    state,
    getWorker: link.getWorker,
    query: link.query,
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
  });

  // The wire dispatches to controllers that did not exist when the link was
  // constructed; filling the table now keeps construction acyclic.
  Object.assign(link.deps, {
    resetScreenState: lifecycle.resetScreenState,
    cancelPrompt: cancelPendingPrompts,
    handleAutosave: autosaveController.handleAutosave,
    handleFlushed: autosaveController.handleFlushed,
    handleRestored: autosaveController.handleRestored,
    handleSaveSlotRequest: saveSlotController.handleSaveSlotRequest,
    handlePromptRequest: promptController.handlePromptRequest,
    handleRoomAuthoring: (req: LlmRequest, agent: AgentHandler) =>
      authoringController.handleRoomAuthoring(req, agent, (dir) => sendDirection(dir)),
    getAgentSession: () => authoringController.getSession(),
    getReplayDriver: () => replayDriver,
    ejectGame: () => lifecycle.ejectGame(),
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
   */
  function pauseEngine(): void {
    link.getWorker()?.postMessage({ type: "pause", paused: true } satisfies WorkerInbound);
    audio.setPaused(true);
    state.paused = true;
  }

  function resumeEngine(): void {
    link.getWorker()?.postMessage({ type: "pause", paused: false } satisfies WorkerInbound);
    audio.setPaused(false);
    state.paused = false;
  }

  const { openPowerUp, closePowerUp, submitPowerUp } = authoringController;

  async function updateAiConfig(config: LlmConfig): Promise<void> {
    activeLlmConfig = config;
    await authoringController.updateAiConfig(config);
  }

  const { startTestRecording, stopTestRecording, cancelTestRecording, saveRecordedTest } =
    testRecorder;

  const { toggleMute, setAudioMode, setAudioVolume, resumeAudio } = useAudioController(
    audio,
    state,
    (msg) => link.getWorker()?.postMessage(msg),
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
  });

  return {
    stopAgent: () => authoringController.getSession()?.task.stop(),
    continueAgent: () => authoringController.getSession()?.task.resume(),
    discardAgent: () => authoringController.getSession()?.task.cancel(),
    state,
    audio,
    toggleMute,
    setAudioMode,
    setAudioVolume,
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
    sendInput,
    sendEdit,
    sendDirection,
    sendKey,
    dismissModal,
    submitPrompt,
    ejectGame: lifecycle.ejectGame,
    clearAgentLog,
    releaseAgentAudioPreviews,
    pauseEngine,
    resumeEngine,
    roomMap,
    observeMapFrame: roomMap.observeFrame,
    readFrames: debug.readFrames,
    updateAiConfig,
    openPowerUp,
    closePowerUp,
    submitPowerUp,
    isInstalledGame: lifecycle.isInstalledGame,
    currentGame: lifecycle.currentGame,
    exportCurrentGame: lifecycle.exportCurrentGame,
    startTestRecording,
    stopTestRecording,
    cancelTestRecording,
    saveRecordedTest,
    resumeLastGame: autosaveController.resumeLastGame,
    resumeFromRecord: autosaveController.resumeFromRecord,
    startOver: autosaveController.startOver,
    flushAutosave: autosaveController.flushAutosave,
    flushAutosaveDetailed: autosaveController.flushAutosaveDetailed,
    lastAutosaveRecord: autosaveController.lastAutosaveRecord,
    setDebugConsumer: debug.setDebugConsumer,
    debugWrite: debug.debugWrite,
    debugEventsSince: debug.debugEventsSince,
    debugTraceSince: debug.debugTraceSince,
    readEngineState: debug.readEngineState,
    shutdownEngine: lifecycle.shutdownEngine,
  };
}
