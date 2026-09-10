import type { EngineReplayState } from "../../src/runtime/replayState.ts";
import type { RecordedOperation } from "../../src/agent/recordedReplay.ts";
import type { AgentRunState } from "./agent/agentRun.ts";
import { reactive } from "vue";
import type { GameControlBinding, EngineMenuState } from "../../src/runtime/engine.ts";
import { continuationTranscript } from "./projectArchive.ts";
import { gameRevision } from "./gameMetadata.ts";
import { detectKnownGame, resolveGameHash } from "./knownGames.ts";
import { clearGameSaves, readGameSaves, writeGameSave } from "./gameSaves.ts";
import { createAgentLogger, type AgentLogEntry, type AgentLogAudio } from "./agent/agentLog.ts";
import { parseWordsTok } from "../../src/logic/words.ts";
import type { SoundOutput } from "../../src/sound/sound.ts";
import type { ReplayDriver, ReplayObservation } from "./replay.ts";
import { runReplayBatch } from "./replayRunner.ts";
import {
  useWalkthroughController,
  createInitialWalkthroughState,
  type WalkthroughUiState,
} from "./useWalkthroughController.ts";
import { useInputController } from "./useInputController.ts";
import { createBridge, type AgentHandler, type Bridge } from "./agent/sabBridge.ts";
import { AgentSession } from "./agent/agentSession.ts";
import type { LlmConfig } from "./agent/llmClient.ts";
import type { AgentFrame, FrameRequest } from "../../src/agent/frames.ts";
import { executeAgentTool } from "../../src/agent/tools.ts";
import {
  buildRecordedTest,
  type AssertionSuggestion,
  type RecordedEvent,
  type RecorderStateSnapshot,
  type RecordingSnapshot,
} from "./gameRecording.ts";
import type { RingFrame } from "./frameRing.ts";
import { AgiAudio, type AudioMode } from "./audio/AgiAudio.ts";
import { useAudioController, type AudioController } from "./audio/useAudioController.ts";
import { isProgressPreview } from "./progressPreview.ts";
import {
  autosaveKey,
  parseAutosaveRecord,
  writeAutosave,
  type AutosaveGame,
  type AutosaveRecord,
} from "./gameProgress.ts";
import {
  clearCachedGame,
  saveAuthoredGame,
  saveGameConversation,
  loadGameConversation,
  getCachedGameMeta,
  type CachedGameData,
  loadAuthoredGame,
  updateAuthoredGameFiles,
  updateGameConversation,
} from "./gameStorage.ts";
import type { ProjectId } from "./gameTypes.ts";

/** Engine modal kinds (the engine draws them on its text surface). */
export type ModalKind = "print" | "inventory" | "menu" | "showObj" | "showPri" | "save" | "restore";

/**
 * Blocking get.num / get.string prompt awaiting player input. The engine has
 * drawn the prompt at (row, col); the host echoes the live edit after it.
 */
export interface PromptState {
  kind: "getnum" | "getstring" | "saveDescription";
  prompt: string;
  maxLen: number;
  row: number;
  col: number;
}

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
export type { WalkthroughUiState };

export interface InstalledGameDescriptor {
  readonly hash: string;
  readonly alias: string;
  readonly title: string;
  readonly author?: string | undefined;
  readonly walkthroughLabel?: string | undefined;
  readonly wordsSha256?: string | undefined;
  readonly objectSha256?: string | undefined;
  readonly folder?: string | undefined;
}

export interface CurrentGame {
  readonly installed: boolean;
  readonly title: string;
  readonly revision: string;
  readonly hash?: string | undefined;
  readonly alias?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly folder?: string | undefined;
}

export function findInstalledFolder(
  installedGames: readonly (string | InstalledGameDescriptor)[] | null | undefined,
  aliasOrHash: string,
): string {
  const norm = aliasOrHash.toLowerCase();
  const match = (installedGames ?? []).find((g) => {
    if (typeof g === "string") return g.toLowerCase() === norm;
    return (
      g.hash.toLowerCase() === norm ||
      g.alias.toLowerCase() === norm ||
      g.folder?.toLowerCase() === norm ||
      g.wordsSha256?.toLowerCase() === norm
    );
  });
  return typeof match === "string" ? match : (match?.folder ?? aliasOrHash);
}

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

/** Remix bubble state; the transcript slice is the live tool-call feed. */
export interface PowerUpUiState {
  mode: "ask" | "remix" | "room";
  messages: { role: "user" | "assistant"; text: string }[];
  open: boolean;
  needsConfig: boolean;
  /** An agent turn is in flight; the prompt line is disabled. */
  busy: boolean;
  /** Index into agentLog where this remix turn's feed begins. */
  feedStart: number;
  /** The agent's closing sentence, once it has one. */
  reply: string;
  /** Room the world froze in. */
  room: number;
  error: string;
}

export interface Frame {
  visual: Uint8Array;
  priority: Uint8Array;
  /** 40x25 [char, attr] text cells. */
  text: Uint8Array;
  /** Text row where picture row 0 is presented. */
  picRow: number;
}

/**
 * Autosave. A separate, per-game slot:
 * the player's F5 slot is theirs and is never written behind their back, so
 * the two never share a key. `monotio_agi.lastGame` names the gameId to resume.
 * The record and its store live in gameProgress.ts, since a project archive
 * carries them too.
 */
const LAST_GAME_KEY = "monotio_agi.lastGame";
/** How long the "Resumed where you left off" caption stays up. */
const RESUME_CAPTION_MS = 10_000;

export { autosaveKey, writeAutosave };
export type { AutosaveRecord };

function autosaveMatches(game: AutosaveGame, targetKey: string): boolean {
  if (game.installed) {
    const norm = targetKey.toLowerCase();
    return (
      game.hash?.toLowerCase() === norm ||
      game.alias?.toLowerCase() === norm ||
      resolveGameHash(targetKey) === game.hash
    );
  }
  return game.projectId === targetKey;
}

/** Every storage read is a maybe: a blocked, full or corrupt store is normal. */
export function readAutosave(targetKey: string): AutosaveRecord | null {
  try {
    const direct = parseAutosaveRecord(localStorage.getItem(autosaveKey(targetKey)));
    if (direct && autosaveMatches(direct.game, targetKey)) return direct;
    const resolved = resolveGameHash(targetKey);
    if (resolved && resolved !== targetKey) {
      const byHash = parseAutosaveRecord(localStorage.getItem(autosaveKey(resolved)));
      if (byHash) return byHash;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearAutosave(targetKey: string): void {
  try {
    localStorage.removeItem(autosaveKey(targetKey));
    const resolved = resolveGameHash(targetKey);
    if (resolved && resolved !== targetKey) {
      localStorage.removeItem(autosaveKey(resolved));
    }
    if (
      localStorage.getItem(LAST_GAME_KEY) === targetKey ||
      (resolved && localStorage.getItem(LAST_GAME_KEY) === resolved)
    ) {
      localStorage.removeItem(LAST_GAME_KEY);
    }
  } catch {
    /* nothing to clear in a store we cannot reach */
  }
}

/** The storage key of the game an autosave exists for, or null. Used by the picker. */
export function lastGameKey(): string | null {
  try {
    return localStorage.getItem(LAST_GAME_KEY);
  } catch {
    return null;
  }
}
export const lastGameId = lastGameKey;

/**
 * Forget a library game completely: its project body and conversation, its
 * checkpoint, its numbered saves and the resume pointer. Game IDs are
 * deterministic, so anything left behind would resurface on the next import.
 */
export async function removeLibraryGame(gameId: string): Promise<void> {
  await clearCachedGame(gameId);
  clearAutosave(gameId);
  clearGameSaves(localStorage, gameId);
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
  /** The authoring session for the game currently in the slot, if one exists. */
  let session: AgentSession | null = null;
  /** Every worker bridge follows the current idle-boundary session replacement. */
  const currentSessionAgent: AgentHandler = {
    handle: async (request) => session?.handle(request) ?? "",
  };
  let booted: {
    readonly installed: boolean;
    readonly title: string;
    readonly revision: string;
    files: Record<string, Uint8Array>;
    words: [string, number][];
    readonly hash?: string | undefined;
    readonly alias?: string | undefined;
    readonly folder?: string | undefined;
    readonly projectId?: ProjectId | undefined;
    authoredGame?: CachedGameData | undefined;
  } | null = null;
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

  function cancelPendingBridgeWaits(): void {
    bridge?.cancel();
    input.resetKeys();
    if (promptResolver) {
      promptResolver("");
      promptResolver = null;
    }
    state.prompt = null;
  }

  const urlReplaySeedText =
    import.meta.env.MODE === "test" ? new URLSearchParams(location.search).get("replaySeed") : null;
  const urlReplaySeed = urlReplaySeedText === null ? null : Number(urlReplaySeedText);
  let activeReplaySeed: number | null =
    urlReplaySeed !== null && Number.isInteger(urlReplaySeed) ? urlReplaySeed : null;
  const observationListeners = new Set<(obs: ReplayObservation) => void>();
  let latestFrame: Frame | null = null;
  const replayDriver: ReplayDriver = {
    sessionId: activeWalkthroughSession,
    latest: null,
    advance: (ticks, options) =>
      query<ReplayObservation>("replayAdvance", {
        ticks,
        ...(options?.sessionId !== undefined
          ? { sessionId: options.sessionId }
          : activeWalkthroughSession > 0
            ? { sessionId: activeWalkthroughSession }
            : {}),
        ...(options?.seeking !== undefined ? { seeking: options.seeking } : {}),
        ...(options?.renderFinal !== undefined ? { renderFinal: options.renderFinal } : {}),
      }),
    key: (code, sessionId) => sendKey(code, sessionId),
    direction: (dir, sessionId) => sendDirection(dir, sessionId),
    answer: (text) => submitPrompt(text),
    setPromptEcho: (text) => engineOptions?.onPromptType?.(text),
    promptPending: () => promptResolver !== null,
    pollNow: () => {
      bridge?.pollNow();
    },
    waitForRevision: (
      minRevision: number,
      opts?: { unblocked?: boolean; signal?: AbortSignal | undefined },
    ) => {
      const requireUnblocked = opts?.unblocked ?? false;
      const matches = (obs: ReplayObservation | null) =>
        obs !== null && obs.revision > minRevision && (!requireUnblocked || obs.blocked === null);
      if (matches(replayDriver.latest)) {
        return Promise.resolve(replayDriver.latest!);
      }
      return new Promise<ReplayObservation>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          observationListeners.delete(listener);
          opts?.signal?.removeEventListener("abort", onAbort);
          reject(new DOMException("Replay revision wait aborted", "AbortError"));
        };
        if (opts?.signal?.aborted) {
          onAbort();
          return;
        }
        opts?.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => {
          observationListeners.delete(listener);
          opts?.signal?.removeEventListener("abort", onAbort);
          reject(
            new Error(
              `Timeout waiting for revision > ${minRevision} (current: ${replayDriver.latest?.revision})`,
            ),
          );
        }, 15_000);
        const listener = (obs: ReplayObservation) => {
          if (matches(obs)) {
            clearTimeout(timer);
            opts?.signal?.removeEventListener("abort", onAbort);
            observationListeners.delete(listener);
            resolve(obs);
          }
        };
        observationListeners.add(listener);
      });
    },
    playBatch: (actions, options) =>
      runReplayBatch(replayDriver, actions, {
        sessionId: options?.sessionId ?? activeWalkthroughSession,
        isCurrentSession: options?.isCurrentSession ?? (() => true),
        ...options,
        getLatestFrame: () => latestFrame,
      }),
  };
  window.__AGI_REPLAY__ = replayDriver;
  (window as unknown as { __AGI_STATE__: EngineState }).__AGI_STATE__ = state;
  (window as unknown as { __AGI_AUDIO__: AgiAudio }).__AGI_AUDIO__ = audio;
  let shakeTimer: number | null = null;
  /** Resolves the pending getnum/getstring bridge request. */
  let promptResolver: ((value: string) => void) | null = null;
  const { logAgent, clearAgentLog, releaseAgentAudioPreviews } = createAgentLogger(state);

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

  /**
   * A save image waiting for the boot it belongs to: the resume path parks it
   * here and the next boot message carries it into the worker, which replays
   * it before the engine's first cycle.
   */
  let pendingResumeRecord: AutosaveRecord | null = null;
  let resumeCaptionTimer: number | null = null;
  /** The newest autosave this session stored; the HMR handover carries it. */
  let lastAutosave: AutosaveRecord | null = null;
  let autosaveWrite: Promise<boolean> = Promise.resolve(true);
  let remixNeedsSave = false;
  /** Record-start capture of the active game-test recording, if one is running. */
  let recordingStart: RecordingSnapshot["start"] | null = null;
  /** Resolvers waiting for the worker to acknowledge a flush request. */
  const flushWaiters = new Map<number, (saved: boolean) => void>();

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
          // Captured before the executor: narrowing of a parameter does not
          // survive into a nested closure.
          const kind = req.op;
          return new Promise<string>((resolve) => {
            promptResolver = resolve;
            state.prompt = {
              kind,
              prompt: String(req.context["prompt"] ?? ""),
              maxLen: Number(req.context["maxLen"] ?? (kind === "getnum" ? 4 : 40)),
              row: Number(req.context["row"] ?? 22),
              col: Number(req.context["col"] ?? 0),
            };
          });
        }
        const game = booted;
        const author = session;
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
    if (!promptResolver) return;
    if (!cancelled && !state.walkthrough.seeking && value.trim().length > 0) {
      logAgent("input", value.trim());
    }
    const resolve = promptResolver;
    const response =
      state.prompt?.kind === "saveDescription"
        ? JSON.stringify({ value: cancelled ? null : value })
        : value;
    promptResolver = null;
    state.prompt = null;
    resolve(response);
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
      session = null;
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
        ...(await takeResumeState(files)),
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
    lastAutosave = null;
    state.powerUp.open = false;
    state.powerUp.busy = false;
    recordingStart = null;
    state.recording.active = false;
    state.recording.starting = false;
    state.recording.error = "";
    state.walkthrough.error = "";
    audio.setPaused(false);
    state.paused = false;
    state.resumed = false;
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
    state.prompt = null;
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
   * Persist one autosave the worker just took.
   *
   * Order matters: for an agent-authored world the patched container is
   * written FIRST and the save record only if that succeeded. A record whose
   * resources were never stored is worse than no record at all — it would
   * resume into a room whose logic the container does not have.
   */
  async function storeAutosave(msg: {
    image: string;
    preview?: unknown;
    menus?: EngineMenuState;
    cycle: number;
    room: number;
    files?: Record<string, Uint8Array>;
  }): Promise<boolean> {
    try {
      if (!booted) return false;
      const game = booted;
      if (msg.files) {
        // Only cached worlds have a resource-storage slot for autosave updates.
        if (booted.installed) return false;
        // Memory follows storage: bytes the container refused (a catalog
        // original) must not become the revision a later checkpoint records.
        if (!(await updateAuthoredGameFiles(game.projectId!, msg.files))) return false;
        if (booted !== game) return false;
        game.files = msg.files;
      }
      const record: AutosaveRecord = {
        format: "monotio.agi.autosave",
        version: 1,
        image: String(msg.image),
        ...(isProgressPreview(msg.preview) ? { preview: msg.preview } : {}),
        ...(msg.menus ? { menus: msg.menus } : {}),
        cycle: Number(msg.cycle),
        room: Number(msg.room),
        savedAt: Date.now(),
        game: {
          installed: game.installed,
          revision: await gameRevision(game.files),
          ...(game.installed
            ? {
                ...(game.hash ? { hash: game.hash } : {}),
                ...(game.alias ? { alias: game.alias } : {}),
              }
            : { projectId: game.projectId! }),
        },
      };
      if (booted !== game) return false;
      const stored = writeAutosave(localStorage, record);
      if (!stored) {
        logAgent("log", "autosave failed: browser storage rejected the save record");
        return false;
      }
      try {
        const resumePointer = game.installed ? (game.hash ?? game.alias!) : game.projectId!;
        localStorage.setItem(LAST_GAME_KEY, resumePointer);
      } catch (e) {
        logAgent("log", `autosave resume pointer failed: ${String(e)}`);
      }
      hook.autosave = stored.cycle;
      lastAutosave = stored;
      publishHook();
      return true;
    } catch (error) {
      // One failed checkpoint must not poison the write chain for the session.
      logAgent("log", `autosave failed: ${String(error)}`);
      return false;
    }
  }

  /** Consume the matching image and session menus together; a boot restores once. */
  async function takeResumeState(
    files: Record<string, Uint8Array>,
  ): Promise<{ restoreImage: string; restoreMenus?: EngineMenuState }> {
    const record = pendingResumeRecord;
    pendingResumeRecord = null;
    if (record && record.game.revision !== (await gameRevision(files)))
      throw new Error(
        "This checkpoint belongs to a different revision of the game. Restore its matching project, or choose Start over to begin with the current game. Your checkpoint has been kept.",
      );
    return {
      restoreImage: record?.image ?? "",
      ...(record?.menus ? { restoreMenus: record.menus } : {}),
    };
  }

  function showResumeCaption(): void {
    state.resumed = true;
    clearTimeout(resumeCaptionTimer ?? undefined);
    resumeCaptionTimer = setTimeout(() => {
      state.resumed = false;
      resumeCaptionTimer = null;
    }, RESUME_CAPTION_MS) as unknown as number;
  }

  /**
   * Ask for a snapshot right now and wait, at most `timeoutMs`, for it to be
   * stored. Used where the page is about to go away: `visibilitychange` and
   * `pagehide` (where nothing can be awaited — the reply is a postMessage the
   * document may already be gone for, so the five-second cadence, not this, is
   * what makes the guarantee), and Vite's HMR reload, where the await is real:
   * `vite:beforeFullReload` listeners are awaited before `location.reload()`.
   */
  function flushAutosave(timeoutMs = 500): Promise<boolean> {
    if (!worker) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const id = ++nextQueryId;
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        flushWaiters.delete(id);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      flushWaiters.set(id, done);
      worker?.postMessage({ type: "flush", id });
    });
  }

  /** The newest stored autosave, for a handover that must not touch storage. */
  function lastAutosaveRecord(): AutosaveRecord | null {
    return lastAutosave;
  }

  /**
   * Tear the engine down WITHOUT touching the autosave: the game is not being
   * left, its host module is being replaced (HMR). `ejectGame` is the
   * deliberate-departure path and waits for storage before leaving.
   */
  function shutdownEngine(): void {
    session?.task.cancel();
    worker?.terminate();
    bridge?.dispose();
    audio.stop();
    releaseAgentAudioPreviews();
    worker = null;
    bridge = null;
    session = null;
    drainPendingQueries();
    for (const done of flushWaiters.values()) done(false);
    flushWaiters.clear();
  }

  /** Keep the selected provider and its key together; archives carry no credentials. */
  function configForGame(gameId: string, config: LlmConfig): LlmConfig {
    const cached = getCachedGameMeta(gameId);
    return cached?.provider === "stub" && !cached.imported
      ? { provider: "stub", model: "offline-stub", apiKey: "" }
      : config;
  }

  function getInstalledFolder(aliasOrHash: string): string {
    return findInstalledFolder(state.installedGames, aliasOrHash);
  }

  /**
   * Resume the most recently played game from its autosave. Returns
   * false when there is nothing to resume, or when the game it names is no
   * longer available (an installed fixture that is gone, an authored world
   * whose container was cleared) — the caller then shows the picker.
   */
  async function resumeLastGame(config: LlmConfig): Promise<boolean> {
    const key = lastGameKey();
    if (!key) return false;
    const record = readAutosave(key);
    if (!record) return false;
    const available = record.game.installed
      ? isInstalledGame(record.game.hash ?? record.game.alias ?? key)
      : Boolean(record.game.projectId && getCachedGameMeta(record.game.projectId));
    if (!available) {
      logAgent("log", `Autosave for "${key}" has no game to boot; starting fresh.`);
      clearAutosave(key);
      return false;
    }
    return resumeFromRecord(record, config);
  }

  /**
   * Resume from a record handed over in memory rather than read back from
   * storage (the HMR module handover). Same boot path as `resumeLastGame`.
   */
  async function resumeFromRecord(record: AutosaveRecord, config: LlmConfig): Promise<boolean> {
    if (record.game.installed) {
      const target = record.game.hash ?? record.game.alias ?? "";
      if (!isInstalledGame(target)) return false;
      pendingResumeRecord = record;
      try {
        await bootGame(getInstalledFolder(target));
        return true;
      } finally {
        pendingResumeRecord = null;
      }
    }
    const projectId = record.game.projectId;
    if (!projectId || !getCachedGameMeta(projectId)) return false;
    pendingResumeRecord = record;
    try {
      await bootAuthoredGame("", configForGame(projectId, config), {
        projectId,
        useCached: true,
      });
      return true;
    } finally {
      pendingResumeRecord = null;
    }
  }

  /** Discard a game's autosave and boot it from the beginning. */
  async function startOver(targetKey: string, config: LlmConfig): Promise<void> {
    const record = readAutosave(targetKey);
    clearAutosave(targetKey);
    pendingResumeRecord = null;
    state.resumed = false;
    clearTimeout(resumeCaptionTimer ?? undefined);
    if (!record) {
      logAgent("log", `startOver: no autosave found for "${targetKey}"; continuing`);
    }
    if (record?.game.installed ?? isInstalledGame(targetKey)) {
      await bootGame(getInstalledFolder(targetKey));
    } else if (getCachedGameMeta(targetKey)) {
      await bootAuthoredGame("", configForGame(targetKey, config), {
        projectId: targetKey,
        useCached: true,
      });
    }
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
        const game = booted;
        autosaveWrite = autosaveWrite
          .then(() => (booted === game ? storeAutosave(msg) : false))
          .catch(() => false);
      } else if (msg.type === "flushed") {
        // The worker reply follows its snapshot; wait for the browser's
        // asynchronous project write before acknowledging the flush.
        const resolve = flushWaiters.get(Number(msg.id));
        void autosaveWrite.then((saved) => {
          resolve?.(Boolean(msg.taken) && saved);
        });
      } else if (msg.type === "restored") {
        if (msg.ok) {
          hook.room = Number(msg.room);
          hook.egoX = Number(msg.egoX);
          hook.egoY = Number(msg.egoY);
          publishHook();
          showResumeCaption();
          logAgent("log", `Resumed the autosave in room ${Number(msg.room)}.`);
        } else {
          // A corrupt or profile-mismatched image is discarded, never shown:
          // the game is already running its normal boot behind this.
          logAgent("log", `Autosave discarded (${String(msg.message)}); starting a fresh game.`);
          if (booted) {
            clearAutosave(booted.installed ? (booted.hash ?? booted.alias!) : booted.projectId!);
          }
        }
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

  const engineSource = {
    objects: () => query<unknown>("objects"),
    state: () => query<unknown>("state"),
  };

  async function createGameSession(
    game: NonNullable<typeof booted>,
    config: LlmConfig,
  ): Promise<AgentSession> {
    const cached = game.installed
      ? await loadGameConversation(game.hash ?? game.alias ?? "installed")
      : await loadAuthoredGame(game.projectId!);
    return AgentSession.fromAuthoredData(
      config,
      logAgent,
      game.files,
      game.words,
      cached ? continuationTranscript(cached, config.provider, config.model) : undefined,
      cached?.provider === config.provider && cached.model === config.model
        ? cached.sessionId
        : undefined,
      cached?.authoringState,
    );
  }

  function attachSessionRuntime(
    s: AgentSession,
    game: NonNullable<typeof booted>,
    profile = state.profile ?? "unknown",
  ): void {
    s.setRuntime({ frames: { read: readFrames }, engine: engineSource });
    if (game.installed || (game.projectId && getCachedGameMeta(game.projectId)?.imported)) {
      s.setOrientation({
        gameId: game.alias ?? game.projectId ?? game.hash ?? "game",
        profile,
      });
    }
  }

  /**
   * Enter remix mode: pause the interpreter, freeze ego in place, and open
   * the assistant bubble for the current room.
   */
  async function openPowerUp(config: LlmConfig): Promise<void> {
    if (state.powerUp.open && state.powerUp.mode === "room") return;
    if (state.powerUp.mode === "room") state.powerUp.mode = "remix";
    pauseEngine();
    state.powerUp.open = true;
    // Busy until the room is known: the prompt line must not accept an
    // instruction before we know which room the world froze in.
    state.powerUp.busy = true;
    state.powerUp.reply = "";
    state.powerUp.error = "";
    state.powerUp.needsConfig = false;
    state.powerUp.feedStart = state.agentLog.length;
    try {
      const engineState = await query<{ room: number; profile: string } | null>("state");
      state.powerUp.room = Number(engineState?.room ?? 0);
      if (!session && booted) {
        if (config.provider !== "stub" && !config.apiKey.trim()) {
          state.powerUp.needsConfig = true;
          return;
        }
        session = await createGameSession(booted, config);
      }
      if (!session) throw new Error("no game is running");
      state.powerUp.messages = session.getMessages();
      if (!session.isConfigured()) {
        state.powerUp.needsConfig = true;
        return;
      }
      attachSessionRuntime(
        session,
        booted!,
        String(engineState?.profile ?? state.profile ?? "unknown"),
      );
    } catch (e) {
      state.powerUp.error = String(e);
    } finally {
      state.powerUp.busy = false;
    }
  }

  /** Apply shared AI settings to the next turn without replacing authored game state. */
  async function updateAiConfig(config: LlmConfig): Promise<void> {
    if (state.powerUp.busy)
      throw new Error("Wait for the current agent task to finish before changing AI settings.");

    const current = session;
    let replacement: AgentSession;
    if (current) {
      replacement = current.reconfigure(config);
      replacement.setRuntime({ frames: { read: readFrames }, engine: engineSource });
    } else {
      const game = booted;
      if (!game) return;
      replacement = await createGameSession(game, config);
      if (booted !== game || session)
        throw new Error("The game changed while applying AI settings. Try again.");
      attachSessionRuntime(replacement, game);
    }

    session = replacement;
    state.agentTask = replacement.task.snapshot();
    state.powerUp.messages = replacement.getMessages();
    state.powerUp.needsConfig = !replacement.isConfigured();
    state.powerUp.error = "";

    const game = booted;
    if (!game) return;
    const context = replacement.getProviderContext();
    try {
      if (game.installed) {
        await saveGameConversation(game.hash ?? game.alias ?? "installed", {
          ...context,
          transcript: replacement.getTranscript(),
          sessionId: replacement.getSessionId(),
          authoringState: replacement.getAuthoringState(),
        });
      } else if (
        !(await updateGameConversation(
          game.projectId!,
          replacement.getTranscript(),
          replacement.getSessionId(),
          replacement.getAuthoringState(),
          context.provider,
          context.model,
        ))
      ) {
        logAgent("error", "Browser storage could not save the updated AI session.");
      }
    } catch {
      logAgent("error", "Browser storage could not save the updated AI session.");
    }
  }

  /** Close the bubble without asking for anything; the world resumes untouched. */
  function closePowerUp(): void {
    if (state.powerUp.busy) return;
    state.powerUp.open = false;
    state.powerUp.busy = false;
    resumeEngine();
  }

  /** Persist resource bytes and their matching authoring history as one project snapshot. */
  async function persistRemix(
    game: NonNullable<typeof booted>,
    author: AgentSession,
    files: Record<string, Uint8Array>,
  ): Promise<void> {
    await autosaveWrite;
    if (booted !== game) throw new Error("The game changed while saving the remix.");
    const context = author.getProviderContext();
    const words = files["WORDS.TOK"]
      ? parseWordsTok(files["WORDS.TOK"]).map(({ word, id }) => [word, id] as [string, number])
      : game.words;
    const original = game.installed ? null : await loadAuthoredGame(game.projectId!);
    const revision = await gameRevision(files);
    const catalogChanged =
      original?.library?.source === "catalog" && original.library.revision !== revision;
    if (game.installed || catalogChanged) {
      const remixProjectId = `remix-${crypto.randomUUID()}`;
      const data: Omit<CachedGameData, "projectId" | "authoredAt"> = {
        title: `${original?.title ?? game.title} Remix`,
        library: {
          ...original?.library,
          version: 1,
          gameId: remixProjectId,
          revision,
          source: "remix",
          catalog: undefined,
          preview: undefined,
          parent: {
            gameId: original?.projectId ?? game.projectId ?? game.alias ?? game.hash ?? "",
            revision: original?.library?.revision ?? (await gameRevision(game.files)),
          },
          validation: {
            status: "unverified",
            message: "Remixed resources. Check the opening to create a new preview.",
          },
        },
        files,
        words,
        ...context,
        transcript: author.getTranscript(),
        sessionId: author.getSessionId(),
        authoringState: author.getAuthoringState(),
        imported: true,
        roomGeneration: false,
      };
      if (!(await saveAuthoredGame(remixProjectId, data)))
        throw new Error(
          "Browser storage could not save this remix. Use Game actions → Project to keep it.",
        );
      // The checkpoint moves with the progress: the original card must never
      // offer a snapshot taken under resources its own container does not have.
      clearAutosave(game.installed ? (game.hash ?? game.alias!) : game.projectId!);
      if (game.installed && game.alias) clearAutosave(game.alias);
      booted = {
        installed: false,
        projectId: remixProjectId,
        alias: original?.library?.gameId ?? game.alias,
        title: `${original?.title ?? game.title} Remix`,
        revision,
        files,
        words,
        authoredGame: { ...data, projectId: remixProjectId, authoredAt: new Date().toISOString() },
      };
      // An original-game snapshot must never stand in for the new game's checkpoint.
      localStorage.setItem(LAST_GAME_KEY, remixProjectId);
      lastAutosave = null;
      hook.autosave = -1;
    } else if (
      !(await updateGameConversation(
        game.projectId!,
        author.getTranscript(),
        author.getSessionId(),
        author.getAuthoringState(),
        context.provider,
        context.model,
        files,
      ))
    ) {
      throw new Error(
        "Browser storage could not save this remix. Use Game actions → Project to keep it.",
      );
    }
    game.files = files;
    game.words = words;
    remixNeedsSave = false;
  }

  /**
   * Run one remix turn: the agent loops over its tools (streamed into the
   * bubble through logAgent), then everything it patched goes into the live
   * container, the room re-enters if the current room changed underneath the
   * player, and the interpreter resumes on exactly the cycle it parked on.
   */
  async function submitPowerUp(instruction: string): Promise<void> {
    if (!session || state.powerUp.busy || state.powerUp.mode === "room") return;
    if (!session.isConfigured()) {
      state.powerUp.needsConfig = true;
      return;
    }
    state.powerUp.busy = true;
    state.powerUp.error = "";
    state.powerUp.messages.push({ role: "user", text: instruction });
    try {
      const room = state.powerUp.room;
      if (state.powerUp.mode === "ask") {
        const text = await session.runAsk(instruction, room);
        state.powerUp.reply = text;
        state.powerUp.messages.push({ role: "assistant", text });
        if (booted?.installed) {
          const key = booted.hash ?? booted.alias ?? "installed";
          await saveGameConversation(key, {
            ...session.getProviderContext(),
            transcript: session.getTranscript(),
            sessionId: session.getSessionId(),
            authoringState: session.getAuthoringState(),
          });
        }
        if (booted && !booted.installed) {
          const context = session.getProviderContext();
          if (
            !(await updateGameConversation(
              booted.projectId!,
              session.getTranscript(),
              session.getSessionId(),
              session.getAuthoringState(),
              context.provider,
              context.model,
            ))
          )
            throw new Error(
              "Conversation could not be saved. Use Game actions → Project to keep it.",
            );
        }
        return;
      }
      const { text, patched, files } = await session.runPowerUp(instruction, room);
      state.powerUp.reply = text;
      state.powerUp.messages.push({ role: "assistant", text });
      remixNeedsSave = true;
      if (files) worker?.postMessage({ type: "patchMetadata", files });
      for (const res of patched) {
        const payload = new Uint8Array(res.payload);
        worker?.postMessage(
          { type: "patch", kind: res.kind, num: res.num, payload: payload.buffer },
          [payload.buffer],
        );
      }
      // Worker messages are ordered: snapshot after every patch has landed, before persisting the matching conversation.
      if (booted) {
        const game = booted;
        const currentFiles = await query<Record<string, Uint8Array> | null>("exportFiles");
        if (!currentFiles) throw new Error("The remixed game snapshot is unavailable.");
        await persistRemix(game, session, currentFiles);
      }
      const touchedRoom = patched.some(
        (p) =>
          ((p.kind === "logic" || p.kind === "picture") && p.num === room) || p.kind === "view",
      );
      if (touchedRoom) {
        logAgent("log", `Re-entering room ${room} so the patch takes effect.`);
        worker?.postMessage({ type: "reenter", room });
      }
      await flushAutosave(2000);
      state.powerUp.open = false;
      resumeEngine();
    } catch (e) {
      state.powerUp.error = String(e);
    } finally {
      state.powerUp.busy = false;
    }
  }

  async function ejectGame(): Promise<void> {
    if (state.leaving || state.powerUp.busy) return;
    state.leaving = true;
    pauseEngine();
    try {
      const game = booted;
      if (game && session && (!game.installed || remixNeedsSave)) {
        const files = await query<Record<string, Uint8Array> | null>("exportFiles");
        if (!files)
          throw new Error(
            "The current game could not be saved. Try Game actions → Project before leaving.",
          );
        await persistRemix(game, session, files);
      }
      await flushAutosave(2000);
      await autosaveWrite;
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
    state.resumed = false;
    clearTimeout(resumeCaptionTimer ?? undefined);
    resumeCaptionTimer = null;
    pendingResumeRecord = null;
    worker?.terminate();
    bridge?.dispose();
    audio.stop();
    session = null;
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
    remixNeedsSave = false;
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
          session = cachedSession;
          bridge = createBridge(hostBridgeHandler(currentSessionAgent), logAgent);
          const known = await detectKnownGame(cached.files);
          const revision = cached.library?.revision || (await gameRevision(cached.files));
          booted = {
            installed: false,
            projectId,
            alias: cached.library?.gameId ?? known?.alias,
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
            ...(await takeResumeState(cached.files)),
          });
          return;
        }
        throw new Error(
          "This saved game is no longer available. Import it again or choose a catalog game.",
        );
      }

      const authoring = new AgentSession(config, logAgent);
      session = authoring;
      bridge = createBridge(hostBridgeHandler(currentSessionAgent), logAgent);

      const { files, words, transcript, sessionId } =
        await authoring.startGenesis(templateMarkdown);
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
        authoringState: authoring.getAuthoringState(),
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
        authoringState: authoring.getAuthoringState(),
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

  /**
   * Start capturing player actions for a stored game test. The worker takes
   * the record-start save image at a safe cycle boundary and stamps every
   * later action with the interpreter cycle; refusal (an open window, a text
   * screen, a blocking prompt) lands in state.recording.error.
   */
  async function startTestRecording(): Promise<void> {
    state.recording.error = "";
    if (!worker || state.phase !== "running") return;
    if (
      state.powerUp.open ||
      state.powerUp.busy ||
      state.modal !== null ||
      state.prompt !== null ||
      state.waitingForKey
    ) {
      state.recording.error =
        "Close the open window, prompt or assistant before recording a game test.";
      return;
    }
    state.recording.starting = true;
    try {
      const reply = await query<{
        ok: boolean;
        image?: string;
        replayState?: EngineReplayState;
        cycle?: number;
        state?: RecorderStateSnapshot;
        error?: string;
      }>("startRecording");
      if (
        !reply.ok ||
        !reply.image ||
        !reply.replayState ||
        reply.cycle === undefined ||
        !reply.state
      ) {
        state.recording.error = String(reply.error ?? "Recording could not start.");
        return;
      }
      recordingStart = {
        image: reply.image,
        cycle: reply.cycle,
        state: reply.state,
        replayState: reply.replayState,
      };
      state.recording.active = true;
      logAgent("log", `Recording a game test from room ${reply.state.room}, cycle ${reply.cycle}.`);
    } finally {
      state.recording.starting = false;
    }
  }

  /** Stop capturing and return everything the worker recorded, or null. */
  async function stopTestRecording(): Promise<RecordingSnapshot | null> {
    if (!state.recording.active || !recordingStart) return null;
    const reply = await query<{
      operations?: RecordedOperation[];
      events?: RecordedEvent[];
      printed?: string[];
      tainted?: string | null;
      usedGetnum?: boolean;
      cycle?: number;
      state?: RecorderStateSnapshot | null;
    }>("stopRecording");
    state.recording.active = false;
    const start = recordingStart;
    recordingStart = null;
    if (!reply.state || reply.cycle === undefined) return null;
    return {
      start,
      operations: reply.operations ?? [],
      events: reply.events ?? [],
      printed: reply.printed ?? [],
      endState: reply.state,
      endCycle: reply.cycle,
      tainted: reply.tainted ?? null,
      usedGetnum: Boolean(reply.usedGetnum),
    };
  }

  /** Discard the active recording without saving anything. */
  function cancelTestRecording(): void {
    if (!state.recording.active) return;
    worker?.postMessage({ type: "cancelRecording" });
    state.recording.active = false;
    recordingStart = null;
    logAgent("log", "Game test recording discarded.");
  }

  /**
   * Store a recorded test through the SAME write path write_game_tests uses
   * (validation, dictionary probe, TESTS.JSON serialization), then ship and
   * persist the updated file exactly like a remix. On an installed or catalog
   * game this is the established remix conversion: the project becomes a
   * writable project copy, since originals cannot store tests.
   */
  async function saveRecordedTest(
    snapshot: RecordingSnapshot,
    name: string,
    selected: readonly AssertionSuggestion[],
    config: LlmConfig,
  ): Promise<{ ok: boolean; message: string }> {
    const game = booted;
    if (!game || !worker) return { ok: false, message: "No game is running." };
    if (snapshot.tainted) return { ok: false, message: snapshot.tainted };
    if (!session) {
      session = await createGameSession(game, config);
    }
    const author = session;
    const result = executeAgentTool(author.state, "write_game_tests", {
      mode: "merge",
      names: null,
      tests: [buildRecordedTest(name, snapshot, selected)],
    });
    if (!result.success)
      return { ok: false, message: result.error ?? "The recorded test was rejected." };
    remixNeedsSave = true;
    worker.postMessage({
      type: "patchMetadata",
      files: { "TESTS.JSON": new Uint8Array(author.state.testsPayload!) },
    });
    const files = await query<Record<string, Uint8Array> | null>("exportFiles");
    if (!files || booted !== game)
      return { ok: false, message: "The game changed while saving the recording. Try again." };
    await persistRemix(game, author, files);
    await flushAutosave(2000);
    logAgent("response", `[Record] ${result.message}`, {
      tool: "write_game_tests",
      args: { name },
    });
    return { ok: true, message: result.message ?? "Recorded test stored." };
  }

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
      pendingResumeRecord = null;
      state.resumed = false;
      clearTimeout(resumeCaptionTimer ?? undefined);
      resumeCaptionTimer = null;
    },
  });
  walkthroughAbort = walkthrough.abort;

  return {
    stopAgent: () => session?.task.stop(),
    continueAgent: () => session?.task.resume(),
    discardAgent: () => session?.task.cancel(),
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
    resumeLastGame,
    resumeFromRecord,
    startOver,
    flushAutosave,
    lastAutosaveRecord,
    shutdownEngine,
  };
}
