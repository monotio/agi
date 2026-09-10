import type { AgentRunState } from "./agent/agentRun.ts";
import { reactive } from "vue";
import type { GameControlBinding } from "../../src/runtime/engine.ts";
import { continuationTranscript } from "./projectArchive.ts";
import { gameRevision } from "./gameMetadata.ts";
import { detectKnownGame } from "./knownGames.ts";
import { clearGameSaves, readGameSaves, writeGameSave } from "./gameSaves.ts";
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
  updateGameConversation,
} from "./gameStorage.ts";
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
      reply: "",
      room: 0,
      error: "",
    },
    resumed: false,
    recording: { active: false, starting: false, error: "" },
    walkthrough: createInitialWalkthroughState(),
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
  interface PendingQuery {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  /** In-flight worker queries (frames / state / objects), keyed by request id. */
  const pendingQueries = new Map<number, PendingQuery>();
  let nextQueryId = 1;

  function drainPendingQueries(err: Error = new Error("Operation aborted")): void {
    for (const q of pendingQueries.values()) {
      clearTimeout(q.timer);
      q.reject(err);
    }
    pendingQueries.clear();
  }

  const { logAgent, clearAgentLog, releaseAgentAudioPreviews } = createAgentLogger(state);
  const promptController = usePromptController({ state, logAgent });

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
  window.__AGI_REPLAY__ = replayDriver;
  (window as unknown as { __AGI_STATE__: EngineState }).__AGI_STATE__ = state;
  (window as unknown as { __AGI_AUDIO__: AgiAudio }).__AGI_AUDIO__ = audio;
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
    getInstalledFolder,
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
    const rows: string[] = [];
    for (let r = 0; r < 25; r++) {
      let line = "";
      for (let c = 0; c < 40; c++) {
        const ch = text[(r * 40 + c) * 2]!;
        line += ch === 0 ? " " : ch >= 0x80 ? "#" : String.fromCharCode(ch);
      }
      rows.push(line);
    }
    state.rows = rows;
    state.modal = modal;
    state.textMode = textMode;
    hook.rows = rows;
    hook.modal = modal;
    hook.textMode = textMode;
    publishHook();
  }

  /** Mirror the test/debug hook onto the window (tests read window.__AGI_TEXT__). */
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
        const activeSaveKey = (): string | null => {
          if (!booted) return null;
          return booted.installed ? (booted.hash ?? null) : (booted.projectId ?? null);
        };
        const readActiveSlots = (): Record<string, string> => {
          const key = activeSaveKey();
          if (!key) return {};
          return readGameSaves(localStorage, key);
        };

        if (req.op === "restore") {
          // The stored value is the base64 save-file image itself; an empty
          // reply is the engine's "cancelled / no save" answer.
          let saved: string | undefined | null;
          try {
            const slot = Number(req.context["slot"]);
            saved = Number.isInteger(slot) ? readActiveSlots()[String(slot)] : null;
          } catch {
            saved = null;
          }
          if (!saved) {
            logAgent("log", "No saved game found in local storage.");
            return Promise.resolve("");
          }
          logAgent("log", "Restoring saved game from local storage...");
          return Promise.resolve(saved);
        }
        if (req.op === "saveList") {
          if (!booted) return "[]";
          try {
            const slots = readActiveSlots();
            // Only the description/signature header is needed for the selector.
            // Full images are fetched on restore, keeping the SAB reply bounded.
            return JSON.stringify(
              Object.entries(slots).flatMap(([slot, image]) => {
                try {
                  return [{ slot: Number(slot), image: btoa(atob(image).slice(0, 40)) }];
                } catch {
                  return [];
                }
              }),
            );
          } catch {
            return "storage-error";
          }
        }
        if (req.op === "saveWrite") {
          const key = activeSaveKey();
          return String(
            Boolean(
              key &&
              writeGameSave(
                localStorage,
                key,
                Number(req.context["slot"]),
                String(req.context["image"]),
              ),
            ),
          );
        }
        if (req.op === "waitkey") {
          return input.handleWaitKey();
        }
        if (req.op === "getnum" || req.op === "getstring" || req.op === "saveDescription") {
          return promptController.handlePromptRequest(req.op, req.context);
        }
        const game = booted;
        const author = authoringController.getSession();
        state.powerUp = {
          mode: "room",
          messages: [],
          open: true,
          needsConfig: false,
          busy: true,
          feedStart: state.agentLog.length,
          reply: "",
          room: Number(req.context["room"]),
          error: "",
        };
        const progress = state.powerUp;
        sendDirection(0);
        try {
          const result = await agent.handle(req);
          if (!result)
            throw new Error(
              "The next room could not be created. Connect your model and try again.",
            );
          if (state.powerUp === progress) {
            state.powerUp.open = false;
            if (game && booted === game && author) {
              if (
                !(await updateGameConversation(
                  game.projectId!,
                  author.getTranscript(),
                  author.getSessionId(),
                  author.getAuthoringState(),
                  author.getProviderContext().provider,
                  author.getProviderContext().model,
                  Object.fromEntries(author.state.getFiles()),
                ))
              )
                logAgent("error", "Browser storage could not save the room conversation.");
            }
          }
          return result;
        } catch (error) {
          if (state.powerUp === progress) state.powerUp.error = String(error);
          throw error;
        } finally {
          if (state.powerUp === progress) state.powerUp.busy = false;
        }
      },
    };
  }

  /** Player submitted (or cancelled) the blocking prompt modal. */
  function submitPrompt(value: string, cancelled = false): void {
    promptController.submitPrompt(value, cancelled);
  }

  async function discoverGames(): Promise<void> {
    if (!import.meta.env.DEV) return;
    try {
      const res = await fetch("/fixtures/");
      if (!res.ok) {
        state.installedGames = [];
        return;
      }
      const raw = await res.json();
      state.installedGames = Array.isArray(raw)
        ? raw.map((item) => {
            if (typeof item === "string") {
              return { hash: item, alias: item, title: item.toUpperCase() };
            }
            return {
              hash: item.hash ?? item.wordsSha256 ?? item.folder,
              alias: item.alias ?? item.folder,
              title: item.title ?? (item.folder ? item.folder.toUpperCase() : "AGI GAME"),
              ...(item.author ? { author: item.author } : {}),
              ...(item.walkthroughLabel ? { walkthroughLabel: item.walkthroughLabel } : {}),
              ...(item.wordsSha256 ? { wordsSha256: item.wordsSha256 } : {}),
              ...(item.objectSha256 ? { objectSha256: item.objectSha256 } : {}),
              ...(item.folder ? { folder: item.folder } : {}),
            } as InstalledGameDescriptor;
          })
        : [];
    } catch {
      state.installedGames = [];
    }
  }

  async function bootGame(hashOrAlias: string): Promise<void> {
    if (!import.meta.env.DEV) throw new Error("Installed fixtures are development-only");
    state.phase = "loading";
    state.error = "";
    try {
      const norm = hashOrAlias.toLowerCase();
      const match = (state.installedGames ?? []).find(
        (g) =>
          g.hash.toLowerCase() === norm ||
          g.alias.toLowerCase() === norm ||
          g.wordsSha256?.toLowerCase() === norm ||
          g.folder?.toLowerCase() === norm,
      );
      const target = match?.wordsSha256 ?? match?.hash ?? hashOrAlias;
      // Directory manifest lists every file (no 404 probing).
      const manifest: string[] = await (await fetch(`/fixtures/${target}/`)).json();
      const names = manifest.filter((name) =>
        /^([A-Z0-9_]*DIR|[A-Z0-9_]*VOL\.(?:[0-9]|1[0-5])|WORDS\.TOK|OBJECT|AGIDATA\.OVL|AGI|[A-Z0-9_-]+\.COM)$/i.test(
          name,
        ),
      );
      const files: Record<string, Uint8Array> = {};
      for (const name of names) {
        const res = await fetch(`/fixtures/${target}/${name}`);
        if (!res.ok) throw new Error(`fixture fetch failed: ${name}`);
        files[name.toUpperCase()] = new Uint8Array(await res.arrayBuffer());
      }
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

      worker?.terminate();
      bridge?.dispose();
      audio.stop();
      resetScreenState();
      worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
      wireWorker(worker);
      // Installed games use only host services; the bridge carries the host
      // services (getnum/getstring/restore) and satisfies the boot contract.
      // No authoring session exists yet: the remix builds and orients one
      // over this container on first use.
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
      worker.postMessage({
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
    autosaveController.reset();
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
  }

  /** Keep the selected provider and its key together; archives carry no credentials. */
  function configForGame(projectId: ProjectId, config: LlmConfig): LlmConfig {
    const cached = getCachedGameMeta(projectId);
    return cached?.provider === "stub" && !cached.imported
      ? { provider: "stub", model: "offline-stub", apiKey: "" }
      : config;
  }

  function getInstalledFolder(aliasOrHash: string): string {
    return findInstalledFolder(state.installedGames, aliasOrHash);
  }

  function wireWorker(w: Worker): void {
    w.onmessage = (ev: MessageEvent) => {
      if (worker !== w) return;
      const msg = ev.data;
      if (
        typeof msg.sessionId === "number" &&
        msg.sessionId > 0 &&
        msg.sessionId !== activeWalkthroughSession
      ) {
        return;
      }
      if (msg.type === "keyAccepted") {
        input.acknowledgeKey(Number(msg.id));
      } else if (msg.type === "frame") {
        state.inputEnabled = Boolean(msg.inputEnabled);
        state.inputReady = Boolean(msg.inputReady);
        state.holdToMove = Boolean(msg.holdToMove);
        publishText(msg.text, msg.modal ?? null, Boolean(msg.textMode));
        latestFrame = {
          visual: msg.visual,
          priority: msg.priority,
          text: msg.text,
          picRow: Number(msg.picRow),
        };
        onFrame(latestFrame);
        // Counted after the frame is drawn, so tests can poll for painted pixels.
        hook.frame++;
        publishHook();
      } else if (msg.type === "controls") {
        state.controls = msg.controls;
      } else if (msg.type === "inputEdit") {
        state.gameEdit = { text: String(msg.text) };
      } else if (msg.type === "print") {
        logAgent("log", `print: ${String(msg.text)}`);
      } else if (msg.type === "status") {
        state.status = msg.text;
      } else if (msg.type === "shake") {
        state.shake = true;
        clearTimeout(shakeTimer ?? undefined);
        shakeTimer = setTimeout(
          () => {
            state.shake = false;
            shakeTimer = null;
          },
          Number(msg.count) * 100,
        ) as unknown as number;
      } else if (msg.type === "soundEnabled") {
        state.soundMuted = !msg.enabled;
        audio.setMuted(state.soundMuted);
      } else if (msg.type === "sound") {
        state.soundPlaying = true;
      } else if (msg.type === "soundOutput") {
        audio.output(msg.output as SoundOutput);
      } else if (msg.type === "soundPaused") {
        audio.setPaused(Boolean(msg.paused) || state.paused);
      } else if (msg.type === "stopSound") {
        state.soundPlaying = false;
        audio.stop();
      } else if (msg.type === "autosave") {
        autosaveController.handleAutosave(msg);
      } else if (msg.type === "flushed") {
        autosaveController.handleFlushed(msg);
      } else if (msg.type === "restored") {
        autosaveController.handleRestored(msg);
      } else if (msg.type === "recordingStarted" || msg.type === "recordingStopped") {
        const q = pendingQueries.get(Number(msg.id));
        if (q) {
          pendingQueries.delete(Number(msg.id));
          q.resolve(msg);
        }
      } else if (msg.type === "log") {
        logAgent("log", String(msg.text));
      } else if (msg.type === "replay" && replayDriver) {
        const obs = msg.observation as ReplayObservation;
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
        state.rows = obs.rows;
        hook.modal = state.modal;
        hook.rows = obs.rows;
        hook.cycle = obs.cycle;
        hook.room = obs.state.room;
        hook.egoX = obs.state.egoX;
        hook.egoY = obs.state.egoY;
        publishHook();
        for (const listener of observationListeners) listener(replayDriver.latest);
        const q = pendingQueries.get(Number(msg.id));
        if (q) {
          pendingQueries.delete(Number(msg.id));
          q.resolve(replayDriver.latest);
        }
      } else if (
        msg.type === "frames" ||
        msg.type === "engineState" ||
        msg.type === "objects" ||
        msg.type === "exportFiles"
      ) {
        const q = pendingQueries.get(Number(msg.id));
        if (q) {
          pendingQueries.delete(Number(msg.id));
          q.resolve(
            msg.type === "frames"
              ? msg.frames
              : msg.type === "objects"
                ? msg.objects
                : msg.type === "exportFiles"
                  ? msg.files
                  : msg.state,
          );
        }
      } else if (msg.type === "cycle") {
        hook.cycle = Number(msg.cycle);
        hook.room = Number(msg.room ?? 0);
        hook.egoX = Number(msg.egoX ?? 0);
        hook.egoY = Number(msg.egoY ?? 0);
        if (typeof window !== "undefined") window.__AGI_TEXT__ = hook;
      } else if (msg.type === "booted") {
        if (booted) {
          try {
            localStorage.setItem(
              LAST_GAME_KEY,
              booted.installed ? (booted.hash ?? booted.alias!) : booted.projectId!,
            );
          } catch {
            /* Playback can continue without browser storage. */
          }
        }
        state.phase = "running";
        state.error = "";
        // The worker reports the profile it detected from the shipped files.
        const profile = typeof msg.profile === "string" ? msg.profile : null;
        state.profile = profile;
        hook.profile = profile;
        publishHook();
      } else if (msg.type === "error") {
        state.phase = "error";
        state.error = msg.message;
      } else if (msg.type === "quit") {
        ejectGame();
      }
    };
  }

  /**
   * Ask the worker a question and await its reply. Queries are answered
   * between cycles and work while the interpreter is paused, which is the
   * whole point: the agent inspects a frozen game.
   */
  function query<T>(type: string, extra: Record<string, unknown> = {}): Promise<T> {
    if (!worker) return Promise.reject(new Error("no engine running"));
    const id = nextQueryId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingQueries.delete(id);
        reject(new Error(`engine query '${type}' timed out`));
      }, 5_000);
      pendingQueries.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });
      worker!.postMessage({ type, id, ...extra });
    });
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

  async function exportCurrentGame() {
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
    game.files = files;
    if (!game.installed && !(await updateAuthoredGameFiles(game.projectId!, files))) {
      logAgent("error", "Browser storage could not save this world. Keep the downloaded ZIP.");
    }
    return {
      ...data,
      files,
      words: game.words,
      roomGeneration: data.roomGeneration ?? false,
      conversationHistory:
        session &&
        (data.provider !== session.getProviderContext().provider ||
          data.model !== session.getProviderContext().model) &&
        data.transcript?.length
          ? [
              ...(data.conversationHistory ?? []),
              { provider: data.provider, model: data.model, transcript: data.transcript },
            ]
          : data.conversationHistory,
      ...(session
        ? {
            transcript: session.getTranscript(),
            authoringState: session.getAuthoringState(),
            ...session.getProviderContext(),
          }
        : {}),
    };
  }

  const { openPowerUp, closePowerUp, submitPowerUp, updateAiConfig } = authoringController;

  async function ejectGame(): Promise<void> {
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
      await autosaveController.flushAutosave(2000);
      await autosaveController.getAutosaveWrite();
    } catch (error) {
      state.leaving = false;
      state.powerUp.error = String(error);
      state.powerUp.open = true;
      return;
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
    options?: { projectId?: ProjectId; title?: string; useCached?: boolean },
  ): Promise<void> {
    state.phase = "loading";
    state.error = "";
    try {
      worker?.terminate();
      bridge?.dispose();
      audio.stop();
      resetScreenState();
      worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
      wireWorker(worker);

      const projectId = options?.projectId || "custom";
      const title = options?.title || projectId;

      if (options?.useCached) {
        const cached = await loadAuthoredGame(projectId);
        if (cached) {
          logAgent(
            "log",
            `⚡ Booting saved world for "${cached.title}" (authored ${new Date(cached.authoredAt).toLocaleTimeString()}${cached.transcript ? `, ${cached.transcript.length} saved messages` : ""})`,
          );
          const cachedConfig = configForGame(projectId, config);
          const cachedSession =
            cached.imported || (cachedConfig.provider !== "stub" && !cachedConfig.apiKey.trim())
              ? null
              : AgentSession.fromAuthoredData(
                  cachedConfig,
                  logAgent,
                  cached.files,
                  cached.words,
                  continuationTranscript(cached, cachedConfig.provider, cachedConfig.model),
                  cached.provider === cachedConfig.provider && cached.model === cachedConfig.model
                    ? cached.sessionId
                    : undefined,
                  cached.authoringState,
                );
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
          worker.postMessage({
            type: "boot",
            sessionId: activeWalkthroughSession,
            ...(activeReplaySeed !== null ? { replaySeed: activeReplaySeed } : {}),
            soundDevice: state.soundMode === "pc-speaker" ? 0 : 1,
            files: cached.files,
            words: cached.words,
            sab: bridge.sab,
            autosaveFiles: true,
            authorRooms: cached.roomGeneration ?? !cached.imported,
            ...(await autosaveController.takeResumeState(cached.files)),
          });
          return;
        }
        throw new Error(
          "This saved game is no longer available. Import it again or choose a catalog game.",
        );
      }

      const genesisSession = new AgentSession(config, logAgent);
      authoringController.setSession(genesisSession);
      bridge = createBridge(hostBridgeHandler(currentSessionAgent), logAgent);

      const { files, words, transcript, sessionId } =
        await genesisSession.startGenesis(templateMarkdown);
      const authoredGame: CachedGameData = {
        projectId,
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

      const saved = await saveAuthoredGame(projectId, {
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

      worker.postMessage({
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
    lastAutosaveRecord: autosaveController.lastAutosaveRecord,
    shutdownEngine,
  };
}
