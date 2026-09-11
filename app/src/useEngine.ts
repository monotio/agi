import type { AgentRunState } from "./agent/agentRun.ts";
import { reactive } from "vue";
import type {
  GameControlBinding,
  ScreenObjectState,
  TraceRecord,
} from "../../src/runtime/engine.ts";
import { continuationTranscript } from "./projectArchive.ts";
import { detectKnownGame, gameRevision, updateBootedResources } from "./gameMetadata.ts";
import { clearGameSaves } from "./gameSaves.ts";
import { createAgentLogger, type AgentLogEntry, type AgentLogAudio } from "./agent/agentLog.ts";
import { parseWordsTok } from "../../src/logic/words.ts";
import type { SoundOutput } from "../../src/sound/sound.ts";
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
import { createBridge, type AgentHandler, type Bridge } from "./agent/sabBridge.ts";
import { AgentSession } from "./agent/agentSession.ts";
import type { LlmConfig } from "./agent/llmClient.ts";
import type { AgentFrame, FrameRequest } from "../../src/agent/frames.ts";
import type { RingFrame } from "./frameRing.ts";
import { AgiAudio, type AudioMode } from "./audio/AgiAudio.ts";
import { useAudioController, type AudioController } from "./audio/useAudioController.ts";
import {
  autosaveKey,
  clearAutosave,
  LAST_GAME_KEY,
  lastGameKey,
  readAutosave,
  useAutosaveController,
  writeAutosave,
} from "./useAutosaveController.ts";
import {
  clearCachedGame,
  saveAuthoredGame,
  getCachedGameMeta,
  type CachedGameData,
  loadAuthoredGame,
  updateAuthoredGameFiles,
} from "./gameStorage.ts";
import {
  type BootedGame,
  type CurrentGame,
  type Frame,
  type InstalledGameDescriptor,
  type ProjectId,
  findInstalledFolder,
  gameStorageKey,
  decodeTextRows,
} from "./gameTypes.ts";
export type { BootedGame, CurrentGame, Frame, InstalledGameDescriptor, ProjectId };
export { findInstalledFolder };

import { usePromptController, type PromptState } from "./usePromptController.ts";
import { useSaveSlotController } from "./useSaveSlotController.ts";
import {
  discoverInstalledGames,
  fetchFixtureFiles,
  resolveFixtureTarget,
} from "./gameDiscovery.ts";
import { createWorkerQueries } from "./workerQueries.ts";
export type { PromptState };

/** Engine modal kinds (the engine draws them on its text surface). */
export type ModalKind = "print" | "inventory" | "menu" | "showObj" | "showPri" | "save" | "restore";

/** Test/debug hook mirrored onto window.__AGI_TEXT__ every frame. */
export interface TextHook {
  rows: string[];
  modal: ModalKind | null;
  textMode: boolean;
  /** Interpreter profile the engine detected for the booted game, e.g. "2.917". */
  profile: string | null;
  /** The interpreter is parked between cycles (remix freeze). */
  paused: boolean;
  /** Interpreter cycles completed since boot; stops advancing while paused. */
  cycle: number;
  /**
   * Frames presented on the probe canvas since boot. Monotonic; the counter
   * ticks only after the frame has been composited and drawn, so a test that
   * waits for it to advance is reading painted pixels, never a blank canvas.
   */
  frame: number;
  /**
   * Interpreter cycle of the newest autosave the host has STORED, or -1 when
   * this session has stored none. A reload is only safe to trust once this has
   * passed the cycle whose state you want back.
   */
  autosave: number;
  /** Current room and ego's position, from the worker's cycle heartbeat. */
  room: number;
  egoX: number;
  egoY: number;
}

export type { AgentLogEntry, AgentLogAudio };
export { useAudioController, type AudioController };
export type { WalkthroughUiState, PowerUpUiState };

export interface EngineState {
  agentTask: AgentRunState | null;
  leaving: boolean;
  controls: GameControlBinding[];
  inputEnabled: boolean;
  /** The worker has started logic and published its input mode. */
  inputReady: boolean;
  holdToMove: boolean;
  waitingForKey: boolean;
  gameEdit: { text: string } | null;
  phase: "idle" | "loading" | "running" | "error";
  error: string;
  /** Status line text as the engine last reported it (debug/test aid). */
  status: string;
  /** Full-screen text mode (0x6a text.screen / 0x6b graphics) */
  textMode: boolean;
  /** The engine's open modal, or null while the interpreter runs. */
  modal: ModalKind | null;
  /** Text rows of the engine's surface (transparent cells read as spaces). */
  rows: string[];
  /** Installed games autodiscovered under games/. */
  installedGames: InstalledGameDescriptor[] | null;
  /** Interpreter profile the engine detected for the booted game, e.g. "2.917". */
  profile: string | null;
  /** Debug screen: live agent activity (requests, responses, patches). */
  agentLog: AgentLogEntry[];
  omittedLogEntries?: number;
  /** True while a shake.screen effect is animating. */
  shake: boolean;
  /** Active blocking prompt (0x76 get.num / 0x73 get.string), if any. */
  prompt: PromptState | null;
  /** Active sound playback state */
  soundPlaying: boolean;
  soundMuted: boolean;
  soundMode: AudioMode;
  /** The interpreter is parked between cycles (remix mode). */
  paused: boolean;
  /** The remix bubble. */
  powerUp: PowerUpUiState;
  /** This boot restored an autosave: the resume caption is showing. */
  resumed: boolean;
  /** Player-action recording for a stored game test. */
  recording: { active: boolean; starting: boolean; error: string };
  /** Real-time walkthrough playback. */
  walkthrough: WalkthroughUiState;
  /** Live screen-object table while the objects debug channel is armed. */
  debugObjects: ScreenObjectState[];
  /** Structured instruction records while the trace debug channel is armed. */
  debugTrace: (TraceRecord & { seq: number; cycle: number })[];
  /** Debug channels the app has armed on the worker. */
  debugChannels: { ownership: boolean; objects: boolean; trace: boolean; picture: boolean };
}

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
}

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
    debugChannels: { ownership: false, objects: false, trace: false, picture: false },
  });

  let activeWalkthroughSession = 0;
  let walkthroughAbort: () => void = () => {};
  let worker: Worker | null = null;
  let bridge: Bridge | null = null;
  /** Every worker bridge follows the current idle-boundary session replacement. */
  const currentSessionAgent: AgentHandler = {
    handle: async (request) => authoringController.getSession()?.handle(request) ?? "",
  };
  let booted: BootedGame | null = null;
  let activeLlmConfig: LlmConfig = { provider: "stub", apiKey: "", model: "offline-stub" };
  const workerQueries = createWorkerQueries();
  const drainPendingQueries = (err?: Error) => workerQueries.drainPendingQueries(err);

  const { logAgent, clearAgentLog, releaseAgentAudioPreviews } = createAgentLogger(state);
  const promptController = usePromptController({ state, logAgent });
  const saveSlotController = useSaveSlotController({ getBootedGame: () => booted, logAgent });

  function cancelPendingBridgeWaits(): void {
    bridge?.cancel();
    input.resetKeys();
    promptController.cancelPrompt();
  }

  const urlReplaySeedText =
    import.meta.env.MODE === "test" ? new URLSearchParams(location.search).get("replaySeed") : null;
  const urlReplaySeed = urlReplaySeedText === null ? null : Number(urlReplaySeedText);
  let activeReplaySeed: number | null =
    urlReplaySeed !== null && Number.isInteger(urlReplaySeed) ? urlReplaySeed : null;
  const observationListeners = new Set<(obs: ReplayObservation) => void>();
  let latestFrame: Frame | null = null;
  const replayDriver = createReplayDriver({
    query,
    sendKey: (code, sessionId) => sendKey(code, sessionId),
    sendDirection: (dir, sessionId) => sendDirection(dir, sessionId),
    submitPrompt: (text) => promptController.submitPrompt(text),
    setPromptEcho: (text) => engineOptions?.onPromptType?.(text),
    isPromptPending: () => promptController.isPromptPending(),
    pollNow: () => {
      bridge?.pollNow();
    },
    getActiveWalkthroughSession: () => activeWalkthroughSession,
    getLatestFrame: () => latestFrame,
    observationListeners,
  });
  // Test/debug automation surface; dev and e2e only, never in production builds.
  if (import.meta.env?.DEV) {
    window.__AGI_REPLAY__ = replayDriver;
    (window as unknown as { __AGI_STATE__: EngineState }).__AGI_STATE__ = state;
    (window as unknown as { __AGI_AUDIO__: AgiAudio }).__AGI_AUDIO__ = audio;
  }
  let shakeTimer: number | null = null;

  const input = useInputController({
    getWorker: () => worker,
    getBridge: () => bridge,
    isSeeking: () => state.walkthrough.seeking,
    isHoldToMove: () => state.holdToMove,
    setWaitingForKey: (waiting) => {
      state.waitingForKey = waiting;
    },
    logAgent,
    getActiveWalkthroughSession: () => activeWalkthroughSession,
  });

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

  const autosaveController = useAutosaveController({
    state,
    getBootedGame: () => booted,
    getWorker: () => worker,
    onAutosaveStored: (cycle) => {
      hook.autosave = cycle;
      publishHook();
    },
    onAutosaveRestored: (room, egoX, egoY) => {
      hook.room = room;
      hook.egoX = egoX;
      hook.egoY = egoY;
      publishHook();
    },
    logAgent,
    isInstalledGame,
    bootGame,
    bootAuthoredGame,
    configForGame,
  });

  const authoringController = useAuthoringController({
    state,
    getWorker: () => worker,
    query,
    logAgent,
    readFrames,
    pauseEngine,
    resumeEngine,
    getBootedGame: () => booted,
    setBootedGame: (game) => {
      booted = game;
    },
    flushAutosave: () => autosaveController.flushAutosave(),
    getAutosaveWrite: () => autosaveController.getAutosaveWrite(),
    clearAutosave,
    onRemixCreated: (remixProjectId) => {
      localStorage.setItem("monotio_agi.lastGame", remixProjectId);
      autosaveController.reset();
      hook.autosave = -1;
    },
    configForGame,
    getLlmConfig: () => activeLlmConfig,
  });

  const testRecorder = useTestRecorder({
    state,
    getWorker: () => worker,
    query,
    logAgent,
    getBootedGame: () => booted,
    getOrCreateSession: authoringController.getOrCreateSession,
    markRemixNeedsSave: () => authoringController.setRemixNeedsSave(true),
    persistRemix: authoringController.persistRemix,
    flushAutosave: () => autosaveController.flushAutosave(),
  });

  /** Publish the engine's text surface for tests and the debug bundle. */
  function publishText(text: Uint8Array, modal: ModalKind | null, textMode: boolean): void {
    const rows = decodeTextRows(text);
    state.rows = rows;
    state.modal = modal;
    state.textMode = textMode;
    hook.rows = rows;
    hook.modal = modal;
    hook.textMode = textMode;
    publishHook();
  }

  /** Mirror the text hook onto the window: production e2e verifies engine text through it. */
  function publishHook(): void {
    if (typeof window !== "undefined") window.__AGI_TEXT__ = hook;
  }

  /**
   * Host bridge services: getnum/getstring open a modal input and block the
   * worker until the player submits; restore reads the localStorage save.
   * Everything else passes through to the game agent.
   */
  function hostBridgeHandler(agent: AgentHandler): AgentHandler {
    return {
      async handle(req) {
        if (req.op === "restore" || req.op === "saveList" || req.op === "saveWrite") {
          return saveSlotController.handleSaveSlotRequest(req.op, req.context);
        }
        if (req.op === "waitkey") {
          return input.handleWaitKey();
        }
        if (req.op === "getnum" || req.op === "getstring" || req.op === "saveDescription") {
          return promptController.handlePromptRequest(req.op, req.context);
        }
        return authoringController.handleRoomAuthoring(req, agent, (dir) => sendDirection(dir));
      },
    };
  }

  /** Player submitted (or cancelled) the blocking prompt modal. */
  function submitPrompt(value: string, cancelled = false): void {
    promptController.submitPrompt(value, cancelled);
  }

  function spawnWorker(): Worker {
    worker?.terminate();
    bridge?.dispose();
    audio.stop();
    resetScreenState();
    const w = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
    wireWorker(w);
    worker = w;
    return w;
  }

  async function discoverGames(): Promise<void> {
    state.installedGames = await discoverInstalledGames();
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

      const w = spawnWorker();
      authoringController.resetSession();
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
      bridge = createBridge(hostBridgeHandler(currentSessionAgent), logAgent);
      // A successful remix is saved as its own local game before playback resumes.
      w.postMessage({
        type: "boot",
        sessionId: activeWalkthroughSession,
        ...(activeReplaySeed !== null ? { replaySeed: activeReplaySeed } : {}),
        soundDevice: state.soundMode === "pc-speaker" ? 0 : 1,
        files,
        words,
        sab: bridge.sab,
        autosaveFiles: true,
        ...(await autosaveController.takeResumeState(files)),
      });
    } catch (e) {
      state.phase = "error";
      state.error = String(e);
    }
  }

  /** Acknowledge the engine's open modal (click path); the worker resumes ticking. */
  function dismissModal(): void {
    if (state.modal === null) return;
    worker?.postMessage({ type: "dismissPrint" });
  }

  function resetScreenState(): void {
    autosaveController.resetScreen();
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
    input.resetKeys();
    state.gameEdit = null;
    state.rows = [];
    promptController.cancelPrompt();
    state.soundPlaying = false;
    state.shake = false;
    clearTimeout(shakeTimer ?? undefined);
    shakeTimer = null;
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
    worker?.terminate();
    bridge?.dispose();
    audio.stop();
    releaseAgentAudioPreviews();
    worker = null;
    bridge = null;
    authoringController.resetSession();
    drainPendingQueries();
    autosaveController.drainFlushWaiters();
    state.debugObjects = [];
    state.debugTrace = [];
    state.debugChannels = { ownership: false, objects: false, trace: false, picture: false };
  }

  /** Keep the selected provider and its key together; archives carry no credentials. */
  function configForGame(projectId: ProjectId, config: LlmConfig): LlmConfig {
    const cached = getCachedGameMeta(projectId);
    return cached?.provider === "stub" && !cached.imported
      ? { provider: "stub", model: "offline-stub", apiKey: "" }
      : config;
  }

  function wireWorker(w: Worker): void {
    const resolveQueryPayload = (msg: Record<string, unknown>) =>
      msg["type"] === "frames"
        ? msg["frames"]
        : msg["type"] === "objects"
          ? msg["objects"]
          : msg["type"] === "exportFiles"
            ? msg["files"]
            : msg["type"] === "checkpoint"
              ? msg["image"]
              : msg["state"];
    const handlers: Record<string, (msg: Record<string, unknown>) => void> = {
      keyAccepted: (msg) => input.acknowledgeKey(Number(msg["id"])),
      // The worker abandoned a suspended interaction (reenter, bridge cancel):
      // resolve the prompt widgets its in-flight request opened so the UI
      // stops waiting on an answer that is no longer consumed.
      interactionCancelled: () => {
        input.resetKeys();
        promptController.cancelPrompt();
      },
      frame: (msg) => {
        state.inputEnabled = Boolean(msg["inputEnabled"]);
        state.inputReady = Boolean(msg["inputReady"]);
        state.holdToMove = Boolean(msg["holdToMove"]);
        publishText(
          msg["text"] as Uint8Array,
          (msg["modal"] as ModalKind | null) ?? null,
          Boolean(msg["textMode"]),
        );
        latestFrame = {
          visual: msg["visual"] as Uint8Array,
          priority: msg["priority"] as Uint8Array,
          text: msg["text"] as Uint8Array,
          picRow: Number(msg["picRow"]),
          cycle: Number(msg["cycle"] ?? 0),
        };
        // Armed debug channels ride the frame; absence clears the mirror so a
        // disarmed channel never leaves stale data in the inspector.
        const ownership = msg["ownership"] as Uint16Array | undefined;
        if (ownership) latestFrame.ownership = ownership;
        const objects = msg["objects"] as Frame["objects"];
        if (objects) latestFrame.objects = objects;
        const picVisual = msg["picVisual"] as Uint8Array | undefined;
        const picPriority = msg["picPriority"] as Uint8Array | undefined;
        if (picVisual && picPriority) {
          latestFrame.picVisual = picVisual;
          latestFrame.picPriority = picPriority;
        }
        state.debugObjects = objects ?? [];
        onFrame(latestFrame);
        // Counted after the frame is drawn, so tests can poll for painted pixels.
        hook.frame++;
        publishHook();
      },
      controls: (msg) => {
        state.controls = msg["controls"] as typeof state.controls;
      },
      inputEdit: (msg) => {
        state.gameEdit = { text: String(msg["text"]) };
      },
      print: (msg) => logAgent("log", `print: ${String(msg["text"])}`),
      status: (msg) => {
        state.status = msg["text"] as string;
      },
      shake: (msg) => {
        state.shake = true;
        clearTimeout(shakeTimer ?? undefined);
        shakeTimer = setTimeout(
          () => {
            state.shake = false;
            shakeTimer = null;
          },
          Number(msg["count"]) * 100,
        ) as unknown as number;
      },
      soundEnabled: (msg) => {
        state.soundMuted = !msg["enabled"];
        audio.setMuted(state.soundMuted);
      },
      sound: () => {
        state.soundPlaying = true;
      },
      soundOutput: (msg) => audio.output(msg["output"] as SoundOutput),
      soundPaused: (msg) => audio.setPaused(Boolean(msg["paused"]) || state.paused),
      stopSound: () => {
        state.soundPlaying = false;
        audio.stop();
      },
      autosave: (msg) =>
        autosaveController.handleAutosave(
          msg as Parameters<typeof autosaveController.handleAutosave>[0],
        ),
      flushed: (msg) =>
        autosaveController.handleFlushed(
          msg as Parameters<typeof autosaveController.handleFlushed>[0],
        ),
      restored: (msg) =>
        autosaveController.handleRestored(
          msg as Parameters<typeof autosaveController.handleRestored>[0],
        ),
      recordingStarted: (msg) => workerQueries.resolveQuery(Number(msg["id"]), msg),
      recordingStopped: (msg) => workerQueries.resolveQuery(Number(msg["id"]), msg),
      log: (msg) => logAgent("log", String(msg["text"])),
      replay: (msg) => {
        if (!replayDriver) return;
        const obs = msg["observation"] as ReplayObservation;
        if (
          typeof obs.sessionId === "number" &&
          obs.sessionId !== 0 &&
          obs.sessionId !== activeWalkthroughSession
        ) {
          return;
        }
        if (obs.blocked !== null) {
          bridge?.pollNow();
        }
        replayDriver.latest = obs;
        state.inputReady = true;
        state.inputEnabled = Boolean(obs.state.inputEnabled);
        state.modal = (obs.state.modalKind as ModalKind | null) ?? null;
        // Lean observations carry no rows; frame messages keep the surface fresh.
        if (obs.rows.length > 0) {
          state.rows = obs.rows;
          hook.rows = obs.rows;
        }
        hook.modal = state.modal;
        hook.cycle = obs.cycle;
        hook.room = obs.state.room;
        hook.egoX = obs.state.egoX;
        hook.egoY = obs.state.egoY;
        publishHook();
        for (const listener of observationListeners) listener(replayDriver.latest);
        workerQueries.resolveQuery(Number(msg["id"]), replayDriver.latest);
      },
      frames: (msg) => workerQueries.resolveQuery(Number(msg["id"]), resolveQueryPayload(msg)),
      engineState: (msg) => workerQueries.resolveQuery(Number(msg["id"]), resolveQueryPayload(msg)),
      objects: (msg) => workerQueries.resolveQuery(Number(msg["id"]), resolveQueryPayload(msg)),
      trace: (msg) => {
        const records = msg["records"] as typeof state.debugTrace;
        state.debugTrace.push(...records);
        if (state.debugTrace.length > 4000)
          state.debugTrace.splice(0, state.debugTrace.length - 4000);
      },
      debugEvents: (msg) => workerQueries.resolveQuery(Number(msg["id"]), msg),
      debugTrace: (msg) => workerQueries.resolveQuery(Number(msg["id"]), msg),
      debugWritten: (msg) => workerQueries.resolveQuery(Number(msg["id"]), msg),
      exportFiles: (msg) => workerQueries.resolveQuery(Number(msg["id"]), resolveQueryPayload(msg)),
      cycle: (msg) => {
        hook.cycle = Number(msg["cycle"]);
        hook.room = Number(msg["room"] ?? 0);
        hook.egoX = Number(msg["egoX"] ?? 0);
        hook.egoY = Number(msg["egoY"] ?? 0);
        if (typeof window !== "undefined") window.__AGI_TEXT__ = hook;
      },
      booted: (msg) => {
        if (booted) {
          try {
            localStorage.setItem(LAST_GAME_KEY, gameStorageKey(booted));
          } catch {
            /* Playback can continue without browser storage. */
          }
        }
        state.phase = "running";
        state.error = "";
        // The worker reports the profile it detected from the shipped files.
        const profile = typeof msg["profile"] === "string" ? msg["profile"] : null;
        state.profile = profile;
        hook.profile = profile;
        publishHook();
      },
      error: (msg) => {
        state.phase = "error";
        state.error = msg["message"] as string;
      },
      quit: () => {
        ejectGame();
      },
    };
    w.onmessage = (ev: MessageEvent) => {
      if (worker !== w) return;
      const msg = ev.data as Record<string, unknown>;
      if (
        typeof msg["sessionId"] === "number" &&
        msg["sessionId"] > 0 &&
        msg["sessionId"] !== activeWalkthroughSession
      ) {
        return;
      }
      handlers[String(msg["type"])]?.(msg);
    };
  }

  /**
   * Ask the worker a question and await its reply. Queries are answered
   * between cycles and work while the interpreter is paused, which is the
   * whole point: the agent inspects a frozen game.
   */
  function query<T>(
    type: string,
    extra: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    const effectiveTimeout =
      timeoutMs ??
      (type === "replayAdvance"
        ? Math.max(20_000, Math.ceil(Number(extra["ticks"] ?? 0) / 2))
        : 5000);
    return workerQueries.query<T>(() => worker, type, extra, effectiveTimeout);
  }

  /**
   * Arm or disarm worker debug channels. ownership and objects ride on frame
   * posts; trace streams structured instruction records. Channels cost real
   * per-cycle work in the worker — arm only while an inspector view is open.
   */
  function setDebugChannels(
    channels: Partial<{ ownership: boolean; objects: boolean; trace: boolean; picture: boolean }>,
  ): void {
    Object.assign(state.debugChannels, channels);
    worker?.postMessage({ type: "debug", channels: { ...state.debugChannels } });
  }

  /**
   * Sierra's SET VAR / SET FLAG debug actions: [index, value] pairs applied at
   * the next cycle boundary and attributed to the current cycle in the diff
   * ring. Resolves when the worker acknowledges the write.
   */
  function debugWrite(
    vars: [number, number][] = [],
    flags: [number, number][] = [],
  ): Promise<Record<string, unknown>> {
    return query<Record<string, unknown>>("debugWrite", { vars, flags });
  }

  /** Var/flag diff events newer than `since` (a previous latestSeq). */
  function debugEventsSince(since: number): Promise<Record<string, unknown>> {
    return query<Record<string, unknown>>("debugEvents", { since });
  }

  /** Full scalar state snapshot (vars, flags, strings, objects' summary). */
  function readEngineState(): Promise<Record<string, unknown>> {
    return query<Record<string, unknown>>("state");
  }

  /** Trace ring records newer than `since` — the catch-up path for the live stream. */
  function debugTraceSince(since: number): Promise<Record<string, unknown>> {
    return query<Record<string, unknown>>("debugTrace", { since });
  }

  /**
   * Freeze / unfreeze the interpreter. The pause flag is a dedicated slot in
   * the SAB the worker already blocks on, so the store lands immediately and
   * the world stops at the very next cycle boundary rather than whenever a
   * postMessage happens to be delivered. See agent/sabBridge.ts for why the
   * worker polls the slot instead of parking in Atomics.wait on it.
   */
  function pauseEngine(): void {
    bridge?.setPaused(true);
    audio.setPaused(true);
    state.paused = true;
    hook.paused = true;
  }

  function resumeEngine(): void {
    bridge?.setPaused(false);
    audio.setPaused(false);
    state.paused = false;
    hook.paused = false;
  }

  /** Live frames out of the worker ring, adapted to the agent's frame shape. */
  async function readFrames(req: FrameRequest): Promise<AgentFrame[]> {
    const frames = await query<RingFrame[]>("frames", { count: req.count, stride: req.stride });
    return frames.map((f) => ({
      cycle: f.cycle,
      visual: new Uint8Array(f.visual),
      priority: new Uint8Array(f.priority),
      text: new Uint8Array(f.text),
      picRow: f.picRow,
    }));
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
    const session = authoringController.getSession();
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
    const files = await query<Record<string, Uint8Array> | null>("exportFiles");
    if (!files || booted !== game) throw new Error("The game changed during export. Try again.");
    await updateBootedResources(game, files);
    if (!game.installed && !(await updateAuthoredGameFiles(game.projectId!, files))) {
      logAgent("error", "Browser storage could not save this world. Keep the downloaded ZIP.");
    }
    const assembled = authoringController.assembleExportData(data, game, session, files);
    const progressKey = game.installed ? (game.hash ?? game.alias ?? "installed") : game.projectId!;
    return { data: assembled, progressKey };
  }

  const { openPowerUp, closePowerUp, submitPowerUp } = authoringController;

  async function updateAiConfig(config: LlmConfig): Promise<void> {
    activeLlmConfig = config;
    await authoringController.updateAiConfig(config);
  }

  async function ejectGame(options?: { abandonUnsaved?: boolean }): Promise<void> {
    if (state.leaving || state.powerUp.busy) return;
    state.leaving = true;
    pauseEngine();
    try {
      const game = booted;
      const session = authoringController.getSession();
      if (game && session && (!game.installed || authoringController.isRemixNeedsSave())) {
        const files = await query<Record<string, Uint8Array> | null>("exportFiles");
        if (!files)
          throw new Error(
            "The current game could not be saved. Try Game actions → Project before leaving.",
          );
        await authoringController.persistRemix(game, session, files);
      }
      if (!options?.abandonUnsaved) {
        const flushResult = await autosaveController.flushAutosaveDetailed(2000);
        if (flushResult.status === "storage_failure") {
          throw new Error(
            "Browser storage could not save latest progress. Download a Project backup, or leave with previously saved progress.",
          );
        } else if (flushResult.status === "timeout") {
          throw new Error(
            "Autosave timed out. Try again, download a Project backup, or leave with previously saved progress.",
          );
        } else if (flushResult.status === "not_checkpointable") {
          if (autosaveController.lastAutosaveRecord() !== null) {
            throw new Error(
              `Current progress cannot be saved: ${flushResult.reason} Close any open game window and try again, download a Project backup, or leave with previously saved progress.`,
            );
          }
        }
      }
    } catch (error) {
      state.leaving = false;
      resumeEngine();
      throw error;
    }
    state.leaving = false;
    activeWalkthroughSession++;
    walkthroughAbort();
    cancelPendingBridgeWaits();
    drainPendingQueries();
    state.walkthrough.active = false;
    state.walkthrough.status = "stopped";
    activeReplaySeed = null;
    // Keep the player's saved position available from the menu.
    autosaveController.reset();
    worker?.terminate();
    bridge?.dispose();
    audio.stop();
    authoringController.resetSession();
    booted = null;
    worker = null;
    bridge = null;
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
    options?: {
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
      const w = spawnWorker();

      let projectId = options?.projectId || "custom";
      const title = options?.title || projectId;
      const templateId = options?.templateId;

      if (options?.useCached) {
        const cached = await loadAuthoredGame(projectId);
        if (cached) {
          logAgent(
            "log",
            `⚡ Booting saved world for "${cached.title}" (authored ${new Date(cached.authoredAt).toLocaleTimeString()}${cached.transcript ? `, ${cached.transcript.length} saved messages` : ""})`,
          );
          const cachedConfig = configForGame(projectId, config);
          activeLlmConfig = cachedConfig;
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
          authoringController.setSession(cachedSession);
          bridge = createBridge(hostBridgeHandler(currentSessionAgent), logAgent);
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
            authoringController.attachSessionRuntime(cachedSession, booted);
          }
          w.postMessage({
            type: "boot",
            sessionId: activeWalkthroughSession,
            ...(activeReplaySeed !== null ? { replaySeed: activeReplaySeed } : {}),
            soundDevice: state.soundMode === "pc-speaker" ? 0 : 1,
            files: cached.files,
            words: cached.words,
            sab: bridge.sab,
            autosaveFiles: true,
            authorRooms: Boolean(cached.roomGeneration),
            ...(await autosaveController.takeResumeState(cached.files)),
          });
          return;
        }
        throw new Error(
          "This saved game is no longer available. Import it again or choose a catalog game.",
        );
      }

      if (!options?.overwrite && (await loadAuthoredGame(projectId))) {
        let safeId = projectId;
        do safeId = `${projectId}-${crypto.randomUUID().slice(0, 8)}`;
        while (await loadAuthoredGame(safeId));
        projectId = safeId;
      }

      activeLlmConfig = config;
      const genesisSession = new AgentSession(config, logAgent);
      authoringController.setSession(genesisSession);
      bridge = createBridge(hostBridgeHandler(currentSessionAgent), logAgent);

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
      authoringController.attachSessionRuntime(genesisSession, booted);

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

      w.postMessage({
        type: "boot",
        sessionId: activeWalkthroughSession,
        soundDevice: state.soundMode === "pc-speaker" ? 0 : 1,
        files,
        words,
        sab: bridge.sab,
        autosaveFiles: true,
        authorRooms: true,
        ...(activeReplaySeed !== null ? { replaySeed: activeReplaySeed } : {}),
      });
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

  const { sendInput, sendEdit, sendDirection, sendKey } = input;

  const { startTestRecording, stopTestRecording, cancelTestRecording, saveRecordedTest } =
    testRecorder;

  const { toggleMute, setAudioMode, setAudioVolume, resumeAudio } = useAudioController(
    audio,
    state,
    (msg) => worker?.postMessage(msg),
  );

  const walkthrough = useWalkthroughController({
    state,
    audio,
    replayDriver,
    getWorker: () => worker,
    getBootedGame: () => booted,
    isCurrentGame: (target) =>
      Boolean(
        worker &&
        (booted?.alias === target ||
          booted?.projectId === target ||
          booted?.hash === target ||
          booted?.folder === target),
      ),
    nextSessionId: () => ++activeWalkthroughSession,
    getActiveSessionId: () => activeWalkthroughSession,
    setActiveReplaySeed: (seed) => {
      activeReplaySeed = seed;
    },
    observationListeners,
    cancelPendingBridgeWaits,
    drainPendingQueries,
    bootGame,
    bootAuthoredGame,
    configForGame,
    ejectGame,
    sendDirection,
    logAgent,
    isInstalledGame,
    onWalkthroughReset: () => {
      autosaveController.reset();
    },
  });
  walkthroughAbort = walkthrough.abort;

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
    bootGame,
    bootAgentGame,
    bootAuthoredGame,
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
    ejectGame,
    clearAgentLog,
    releaseAgentAudioPreviews,
    pauseEngine,
    resumeEngine,
    readFrames,
    updateAiConfig,
    openPowerUp,
    closePowerUp,
    submitPowerUp,
    isInstalledGame,
    currentGame,
    exportCurrentGame,
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
    setDebugChannels,
    debugWrite,
    debugEventsSince,
    debugTraceSince,
    readEngineState,
    shutdownEngine,
  };
}
