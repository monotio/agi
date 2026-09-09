import type { EngineReplayState } from "../../src/runtime/replayState.ts";
import type { RecordedOperation } from "../../src/agent/recordedReplay.ts";
import type { AgentRunState } from "./agent/agentRun.ts";
import { reactive } from "vue";
import type { GameControlBinding, EngineMenuState } from "../../src/runtime/engine.ts";
import { continuationTranscript } from "./projectArchive.ts";
import { gameRevision } from "./gameMetadata.ts";
import { clearGameSaves, readGameSaves, writeGameSave } from "./gameSaves.ts";
import { serializeAgentLog } from "../../src/agent/toolTransport.ts";
import { parseWordsTok } from "../../src/logic/words.ts";
import type { SoundOutput } from "../../src/sound/sound.ts";
import type { ReplayDriver, ReplayObservation } from "./replay.ts";
import { runReplayBatch } from "./replayRunner.ts";
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
import { isProgressPreview } from "./progressPreview.ts";
import {
  autosaveKey,
  parseAutosaveRecord,
  writeAutosave,
  type AutosaveRecord,
} from "./gameProgress.ts";
import {
  clearCachedCartridge,
  saveAuthoredCartridge,
  saveGameConversation,
  loadGameConversation,
  getCachedCartridgeMeta,
  type CachedCartridgeData,
  loadAuthoredCartridge,
  updateAuthoredCartridgeFiles,
  updateCartridgeConversation,
} from "./cartridgeStorage.ts";

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

export interface AgentLogEntry {
  id: string;
  timestamp: number;
  kind: "request" | "response" | "error" | "log";
  detail: string;
  data?: unknown;
  /** Ephemeral browser-only previews. Never copied into logs or project data. */
  audio?: AgentLogAudio[];
}

export interface AgentLogAudio {
  url: string;
  caption: string;
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
  installedGames: string[] | null;
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
 * the two never share a key. `monotio_agi.lastGame` names the slug to resume.
 * The record and its store live in gameProgress.ts, since a project archive
 * carries them too.
 */
const LAST_GAME_KEY = "monotio_agi.lastGame";
/** How long the "Resumed where you left off" caption stays up. */
const RESUME_CAPTION_MS = 10_000;

export { autosaveKey, writeAutosave };
export type { AutosaveRecord };

/** Every storage read is a maybe: a blocked, full or corrupt store is normal. */
export function readAutosave(slug: string): AutosaveRecord | null {
  try {
    const parsed = parseAutosaveRecord(localStorage.getItem(autosaveKey(slug)));
    return parsed?.game.slug === slug ? parsed : null;
  } catch {
    return null;
  }
}

export function clearAutosave(slug: string): void {
  try {
    localStorage.removeItem(autosaveKey(slug));
    if (localStorage.getItem(LAST_GAME_KEY) === slug) localStorage.removeItem(LAST_GAME_KEY);
  } catch {
    /* nothing to clear in a store we cannot reach */
  }
}

/** The slug an autosave exists for, or null. Used by the picker. */
export function lastGameSlug(): string | null {
  try {
    return localStorage.getItem(LAST_GAME_KEY);
  } catch {
    return null;
  }
}

/**
 * Forget a library game completely: its project body and conversation, its
 * checkpoint, its numbered saves and the resume pointer. Slugs are
 * deterministic, so anything left behind would resurface on the next import.
 */
export async function removeLibraryGame(slug: string): Promise<void> {
  await clearCachedCartridge(slug);
  clearAutosave(slug);
  clearGameSaves(localStorage, slug);
}

export function useEngine(onFrame: (frame: Frame) => void) {
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
  });

  let worker: Worker | null = null;
  let bridge: Bridge | null = null;
  /** The authoring session for the game currently in the slot, if one exists. */
  let session: AgentSession | null = null;
  /** Every worker bridge follows the current idle-boundary session replacement. */
  const currentSessionAgent: AgentHandler = {
    handle: async (request) => session?.handle(request) ?? "",
  };
  /** What booted, so a remix can build a session for an installed original. */
  let booted: {
    slug: string;
    installed: boolean;
    files: Record<string, Uint8Array>;
    words: [string, number][];
    cartridge?: CachedCartridgeData;
  } | null = null;
  /** In-flight worker queries (frames / state / objects), keyed by request id. */
  const pendingQueries = new Map<number, (value: unknown) => void>();
  let nextQueryId = 1;
  const replaySeedText =
    import.meta.env.MODE === "test" ? new URLSearchParams(location.search).get("replaySeed") : null;
  const replaySeed = replaySeedText === null ? null : Number(replaySeedText);
  const observationListeners = new Set<(obs: ReplayObservation) => void>();
  let latestFrame: Frame | null = null;
  const replayDriver: ReplayDriver | null =
    replaySeed !== null && Number.isInteger(replaySeed)
      ? {
          latest: null,
          advance: (ticks) => query<ReplayObservation>("replayAdvance", { ticks }),
          waitForRevision: (minRevision: number) => {
            if (replayDriver!.latest && replayDriver!.latest.revision > minRevision) {
              return Promise.resolve(replayDriver!.latest);
            }
            return new Promise<ReplayObservation>((resolve, reject) => {
              const timer = setTimeout(() => {
                observationListeners.delete(listener);
                reject(
                  new Error(
                    `Timeout waiting for revision > ${minRevision} (current: ${replayDriver!.latest?.revision})`,
                  ),
                );
              }, 10_000);
              const listener = (obs: ReplayObservation) => {
                if (obs.revision > minRevision) {
                  clearTimeout(timer);
                  observationListeners.delete(listener);
                  resolve(obs);
                }
              };
              observationListeners.add(listener);
            });
          },
          playBatch: (actions, options) =>
            runReplayBatch(replayDriver!, actions, {
              ...options,
              getLatestFrame: () => latestFrame,
            }),
        }
      : null;
  if (replayDriver) window.__AGI_REPLAY__ = replayDriver;
  let shakeTimer: number | null = null;
  /** Resolves the pending getnum/getstring bridge request. */
  let promptResolver: ((value: string) => void) | null = null;
  /**
   * Resolves the pending waitkey bridge request (a have.key busy loop blocked
   * the worker); sendKey resolves it in graphics mode as well as text mode.
   */
  let keyWaitResolver: ((value: string) => void) | null = null;
  // Keys remain here until the worker acknowledges receipt. A synchronous
  // AGI wait can claim a key whose postMessage is still waiting to dispatch.
  const pendingKeys = new Map<number, number>();
  let nextKeyId = 0;
  const audioPreviewUrls: { entryId: string; url: string }[] = [];
  const MAX_AUDIO_PREVIEWS = 8;
  const MAX_AUDIO_PREVIEW_BYTES = 8 * 1024 * 1024;

  function isWave(bytes: Uint8Array): boolean {
    if (!(
      bytes.length >= 44 &&
      bytes.length <= MAX_AUDIO_PREVIEW_BYTES &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x41 &&
      bytes[10] === 0x56 &&
      bytes[11] === 0x45 &&
      bytes[12] === 0x66 &&
      bytes[13] === 0x6d &&
      bytes[14] === 0x74 &&
      bytes[15] === 0x20 &&
      bytes[36] === 0x64 &&
      bytes[37] === 0x61 &&
      bytes[38] === 0x74 &&
      bytes[39] === 0x61
    ))
      return false;
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const byteRate = header.getUint32(28, true);
    const dataBytes = header.getUint32(40, true);
    return (
      header.getUint32(4, true) + 8 === bytes.length &&
      header.getUint16(20, true) === 1 &&
      byteRate > 0 &&
      dataBytes + 44 === bytes.length &&
      dataBytes / byteRate <= 30
    );
  }

  function takeAudio(data: unknown): { previews: AgentLogAudio[]; serializable: unknown } {
    if (!data || typeof data !== "object" || Array.isArray(data))
      return { previews: [], serializable: data };
    const record = data as Record<string, unknown>;
    const result = record["result"];
    if (!result || typeof result !== "object" || Array.isArray(result))
      return { previews: [], serializable: data };
    const resultRecord = result as Record<string, unknown>;
    const attachments = resultRecord["audio"];
    if (!Array.isArray(attachments)) return { previews: [], serializable: data };

    const cleanResult = { ...resultRecord };
    delete cleanResult["audio"];
    const previews: AgentLogAudio[] = [];
    for (const attachment of attachments.slice(0, MAX_AUDIO_PREVIEWS)) {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) continue;
      const candidate = attachment as Record<string, unknown>;
      const wav = candidate["wav"];
      const caption = candidate["caption"];
      if (
        candidate["mimeType"] !== "audio/wav" ||
        !(wav instanceof Uint8Array) ||
        !isWave(wav) ||
        typeof caption !== "string" ||
        !caption.trim()
      )
        continue;
      previews.push({
        url: URL.createObjectURL(new Blob([wav.slice()], { type: "audio/wav" })),
        caption: caption.trim().slice(0, 300),
      });
    }
    return { previews, serializable: { ...record, result: cleanResult } };
  }

  function traceAgentLog(): AgentLogEntry[] {
    return state.agentLog.map((entry) => {
      const copy = { ...entry };
      delete copy.audio;
      return copy;
    });
  }

  function releaseAgentAudioPreviews(): void {
    for (const { url } of audioPreviewUrls) URL.revokeObjectURL(url);
    audioPreviewUrls.length = 0;
    for (const entry of state.agentLog) delete entry.audio;
  }

  function logAgent(
    kind: "request" | "response" | "error" | "log",
    detail: string,
    data?: unknown,
  ): void {
    if (data && typeof data === "object" && "task" in data) {
      state.agentTask = (data as { task: AgentRunState }).task;
      return;
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const extracted = takeAudio(data);
    const entry: AgentLogEntry = {
      id,
      timestamp: Date.now(),
      kind,
      detail,
      data:
        extracted.serializable !== undefined
          ? JSON.parse(serializeAgentLog(extracted.serializable))
          : undefined,
    };
    if (extracted.previews.length) entry.audio = extracted.previews;
    state.agentLog.push(entry);
    for (const preview of extracted.previews)
      audioPreviewUrls.push({ entryId: id, url: preview.url });
    while (audioPreviewUrls.length > MAX_AUDIO_PREVIEWS) {
      const evicted = audioPreviewUrls.shift()!;
      URL.revokeObjectURL(evicted.url);
      const oldEntry = state.agentLog.find(({ id: entryId }) => entryId === evicted.entryId);
      if (!oldEntry?.audio) continue;
      oldEntry.audio = oldEntry.audio.filter(({ url }) => url !== evicted.url);
      if (!oldEntry.audio.length) delete oldEntry.audio;
    }
    if (typeof window !== "undefined") {
      window.__AGI_TRACE__ = traceAgentLog();
    }
  }

  function clearAgentLog(): void {
    releaseAgentAudioPreviews();
    state.agentLog = [];
    if (typeof window !== "undefined") {
      window.__AGI_TRACE__ = [];
    }
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
        if (req.op === "restore") {
          // The stored value is the base64 save-file image itself; an empty
          // reply is the engine's "cancelled / no save" answer.
          let saved: string | undefined | null;
          try {
            const slot = Number(req.context["slot"]);
            saved =
              booted && Number.isInteger(slot)
                ? readGameSaves(localStorage, booted.slug)[String(slot)]
                : null;
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
            const slots = readGameSaves(localStorage, booted.slug);
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
          return String(
            Boolean(
              booted &&
              writeGameSave(
                localStorage,
                booted.slug,
                Number(req.context["slot"]),
                String(req.context["image"]),
              ),
            ),
          );
        }
        if (req.op === "waitkey") {
          const queued = pendingKeys.entries().next().value;
          if (queued) {
            pendingKeys.delete(queued[0]);
            return JSON.stringify({ id: queued[0], code: queued[1] });
          }
          return new Promise<string>((resolve) => {
            state.waitingForKey = true;
            keyWaitResolver = resolve;
          });
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
                !(await updateCartridgeConversation(
                  game.slug,
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
      state.installedGames = res.ok ? await res.json() : [];
    } catch {
      state.installedGames = [];
    }
  }

  async function bootGame(slug: string): Promise<void> {
    if (!import.meta.env.DEV) throw new Error("Installed fixtures are development-only");
    state.phase = "loading";
    state.error = "";
    try {
      // Directory manifest lists every file (no 404 probing).
      const manifest: string[] = await (await fetch(`/fixtures/${slug}/`)).json();
      const names = manifest.filter((name) =>
        /^([A-Z0-9_]*DIR|[A-Z0-9_]*VOL\.(?:[0-9]|1[0-5])|WORDS\.TOK|OBJECT|AGIDATA\.OVL|AGI|[A-Z0-9_-]+\.COM)$/i.test(
          name,
        ),
      );
      const files: Record<string, Uint8Array> = {};
      for (const name of names) {
        const res = await fetch(`/fixtures/${slug}/${name}`);
        if (!res.ok) throw new Error(`fixture fetch failed: ${name}`);
        files[name.toUpperCase()] = new Uint8Array(await res.arrayBuffer());
      }
      // Parse the dictionary on the main thread; ship entries to the worker.
      const words = parseWordsTok(files["WORDS.TOK"]!).map(
        (e) => [e.word, e.id] as [string, number],
      );

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
      booted = { slug, installed: true, files, words };
      bridge = createBridge(hostBridgeHandler(currentSessionAgent), logAgent);
      // A successful remix is saved as its own local cartridge before playback resumes.
      worker.postMessage({
        type: "boot",
        ...(replayDriver ? { replaySeed } : {}),
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
    pendingKeys.clear();
    state.gameEdit = null;
    state.rows = [];
    state.prompt = null;
    state.soundPlaying = false;
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
        if (!(await updateAuthoredCartridgeFiles(game.slug, msg.files))) return false;
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
          slug: game.slug,
          installed: game.installed,
          revision: await gameRevision(game.files),
        },
      };
      if (booted !== game) return false;
      const stored = writeAutosave(localStorage, record);
      if (!stored) {
        logAgent("log", "autosave failed: browser storage rejected the save record");
        return false;
      }
      try {
        localStorage.setItem(LAST_GAME_KEY, game.slug);
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
    pendingQueries.clear();
    for (const done of flushWaiters.values()) done(false);
    flushWaiters.clear();
  }

  /** Keep the selected provider and its key together; archives carry no credentials. */
  function configForCartridge(slug: string, config: LlmConfig): LlmConfig {
    const cached = getCachedCartridgeMeta(slug);
    return cached?.provider === "stub" && !cached.imported
      ? { provider: "stub", model: "offline-stub", apiKey: "" }
      : config;
  }

  /**
   * Resume whatever was being played when the page went away: boot that game
   * and hand the worker the stored image to restore once it is up. Returns
   * false when there is nothing to resume, or when the game it names is no
   * longer available (an installed fixture that is gone, an authored world
   * whose container was cleared) — the caller then shows the picker.
   */
  async function resumeLastGame(config: LlmConfig): Promise<boolean> {
    const slug = lastGameSlug();
    if (!slug) return false;
    const record = readAutosave(slug);
    if (!record) return false;
    if (record.game.installed ? !isInstalledGame(slug) : !getCachedCartridgeMeta(slug)) {
      logAgent("log", `Autosave for "${slug}" has no game to boot; starting fresh.`);
      clearAutosave(slug);
      return false;
    }
    pendingResumeRecord = record;
    try {
      if (record.game.installed) await bootGame(slug);
      else await bootCartridgeGame("", configForCartridge(slug, config), { slug, useCached: true });
    } finally {
      if (state.phase === "error") pendingResumeRecord = null;
    }
    return state.phase !== "error";
  }

  /**
   * Resume from a record handed over in memory rather than read back from
   * storage (the HMR module handover). Same boot path as `resumeLastGame`.
   */
  async function resumeFromRecord(record: AutosaveRecord, config: LlmConfig): Promise<boolean> {
    const slug = record.game.slug;
    if (record.game.installed ? !isInstalledGame(slug) : !getCachedCartridgeMeta(slug))
      return false;
    pendingResumeRecord = record;
    try {
      if (record.game.installed) await bootGame(slug);
      else await bootCartridgeGame("", configForCartridge(slug, config), { slug, useCached: true });
    } finally {
      if (state.phase === "error") pendingResumeRecord = null;
    }
    return state.phase !== "error";
  }

  /** Discard a game's autosave and boot it from the beginning. */
  async function startOver(slug: string, config: LlmConfig): Promise<void> {
    const record = readAutosave(slug);
    clearAutosave(slug);
    pendingResumeRecord = null;
    state.resumed = false;
    clearTimeout(resumeCaptionTimer ?? undefined);
    if (record?.game.installed ?? isInstalledGame(slug)) await bootGame(slug);
    else if (getCachedCartridgeMeta(slug))
      await bootCartridgeGame("", configForCartridge(slug, config), { slug, useCached: true });
  }

  function wireWorker(w: Worker): void {
    w.onmessage = (ev: MessageEvent) => {
      if (worker !== w) return;
      const msg = ev.data;
      if (msg.type === "keyAccepted") {
        pendingKeys.delete(Number(msg.id));
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
        logAgent("log", `print: ${String(msg.text).slice(0, 80)}`);
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
          if (booted) clearAutosave(booted.slug);
        }
      } else if (msg.type === "recordingStarted" || msg.type === "recordingStopped") {
        const resolve = pendingQueries.get(Number(msg.id));
        if (resolve) {
          pendingQueries.delete(Number(msg.id));
          resolve(msg);
        }
      } else if (msg.type === "log") {
        logAgent("log", String(msg.text));
      } else if (msg.type === "replay" && replayDriver) {
        replayDriver.latest = msg.observation as ReplayObservation;
        hook.cycle = replayDriver.latest.cycle;
        hook.room = replayDriver.latest.state.room;
        hook.egoX = replayDriver.latest.state.egoX;
        hook.egoY = replayDriver.latest.state.egoY;
        publishHook();
        for (const listener of observationListeners) listener(replayDriver.latest);
        const resolve = pendingQueries.get(Number(msg.id));
        if (resolve) {
          pendingQueries.delete(Number(msg.id));
          resolve(replayDriver.latest);
        }
      } else if (
        msg.type === "frames" ||
        msg.type === "engineState" ||
        msg.type === "objects" ||
        msg.type === "exportFiles"
      ) {
        const resolve = pendingQueries.get(Number(msg.id));
        if (resolve) {
          pendingQueries.delete(Number(msg.id));
          resolve(
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
            localStorage.setItem(LAST_GAME_KEY, booted.slug);
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
      pendingQueries.set(id, (value) => {
        clearTimeout(timer);
        resolve(value as T);
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
  function isInstalledGame(slug: string): boolean {
    return (state.installedGames ?? []).includes(slug);
  }

  /** The game currently in the slot, or null when nothing is booted. */
  function currentGame(): { slug: string; installed: boolean } | null {
    return booted ? { slug: booted.slug, installed: booted.installed } : null;
  }

  async function exportCurrentGame() {
    if (state.powerUp.busy || state.phase !== "running")
      throw new Error("Wait for the current authoring turn to finish before saving.");
    const game = booted;
    if (!game) throw new Error("No game is running.");
    const data: CachedCartridgeData | null = game.installed
      ? {
          slug: game.slug,
          title: game.slug.toUpperCase(),
          provider: "stub",
          model: state.profile ?? "unknown",
          authoredAt: "",
          files: game.files,
          words: game.words,
        }
      : ((await loadAuthoredCartridge(game.slug).catch(() => null)) ?? game.cartridge ?? null);
    if (!data) throw new Error("The current cartridge metadata is unavailable.");
    const files = await query<Record<string, Uint8Array> | null>("exportFiles");
    if (!files || booted !== game) throw new Error("The game changed during export. Try again.");
    game.files = files;
    if (!game.installed && !(await updateAuthoredCartridgeFiles(game.slug, files))) {
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

  /**
   * Open the remix: freeze the world and make sure an authoring session
   * exists for whatever is loaded. An installed original has none (it was
   * never authored), so one is built over its real container. Orientation is
   * included with the first submitted instruction; opening stays local.
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
        const cached = booted.installed
          ? await loadGameConversation(booted.slug)
          : await loadAuthoredCartridge(booted.slug);
        session = AgentSession.fromAuthoredData(
          config,
          logAgent,
          booted.files,
          booted.words,
          cached ? continuationTranscript(cached, config.provider, config.model) : undefined,
          cached?.provider === config.provider && cached.model === config.model
            ? cached.sessionId
            : undefined,
          cached?.authoringState,
        );
      }
      if (!session) throw new Error("no game is running");
      state.powerUp.messages = session.getMessages();
      if (!session.isConfigured()) {
        state.powerUp.needsConfig = true;
        return;
      }
      session.setRuntime({ frames: { read: readFrames }, engine: engineSource });
      if (booted?.installed || (booted && getCachedCartridgeMeta(booted.slug)?.imported)) {
        session.setOrientation({
          gameId: booted.slug,
          profile: String(engineState?.profile ?? "unknown"),
        });
      }
    } catch (e) {
      state.powerUp.error = String(e);
    } finally {
      state.powerUp.busy = false;
    }
  }

  const engineSource = {
    objects: () => query<unknown>("objects"),
    state: () => query<unknown>("state"),
  };

  /** Apply shared AI settings to the next turn without replacing authored game state. */
  async function updateAiConfig(config: LlmConfig): Promise<void> {
    if (state.powerUp.busy)
      throw new Error("Wait for the current agent task to finish before changing AI settings.");

    const current = session;
    let replacement: AgentSession;
    if (current) {
      replacement = current.reconfigure(config);
    } else {
      const game = booted;
      if (!game) return;
      const cached = game.installed
        ? await loadGameConversation(game.slug)
        : await loadAuthoredCartridge(game.slug);
      if (booted !== game || session)
        throw new Error("The game changed while applying AI settings. Try again.");
      replacement = AgentSession.fromAuthoredData(
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
      if (game.installed || getCachedCartridgeMeta(game.slug)?.imported) {
        replacement.setOrientation({
          gameId: game.slug,
          profile: state.profile ?? "unknown",
        });
      }
    }

    replacement.setRuntime({ frames: { read: readFrames }, engine: engineSource });
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
        await saveGameConversation(game.slug, {
          ...context,
          transcript: replacement.getTranscript(),
          sessionId: replacement.getSessionId(),
          authoringState: replacement.getAuthoringState(),
        });
      } else if (
        !(await updateCartridgeConversation(
          game.slug,
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
    const original = game.installed ? null : await loadAuthoredCartridge(game.slug);
    const revision = await gameRevision(files);
    const catalogChanged =
      original?.library?.source === "catalog" && original.library.revision !== revision;
    if (game.installed || catalogChanged) {
      const slug = `remix-${crypto.randomUUID()}`;
      const data: Omit<CachedCartridgeData, "slug" | "authoredAt"> = {
        title: `${original?.title ?? game.slug.toUpperCase()} Remix`,
        library: {
          ...original?.library,
          version: 1,
          gameId: slug,
          revision,
          source: "remix",
          catalog: undefined,
          preview: undefined,
          parent: {
            gameId: original?.library?.gameId ?? game.slug,
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
      if (!(await saveAuthoredCartridge(slug, data)))
        throw new Error(
          "Browser storage could not save this remix. Use Game actions → Project to keep it.",
        );
      // The checkpoint moves with the progress: the original card must never
      // offer a snapshot taken under resources its own container does not have.
      clearAutosave(game.slug);
      game.slug = slug;
      game.installed = false;
      game.cartridge = { ...data, slug, authoredAt: new Date().toISOString() };
      // An original-game snapshot must never stand in for the new cartridge's checkpoint.
      localStorage.setItem(LAST_GAME_KEY, slug);
      lastAutosave = null;
      hook.autosave = -1;
    } else if (
      !(await updateCartridgeConversation(
        game.slug,
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
          await saveGameConversation(booted.slug, {
            ...session.getProviderContext(),
            transcript: session.getTranscript(),
            sessionId: session.getSessionId(),
            authoringState: session.getAuthoringState(),
          });
        }
        if (booted && !booted.installed) {
          const context = session.getProviderContext();
          if (
            !(await updateCartridgeConversation(
              booted.slug,
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
    pendingQueries.clear();
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
    if (keyWaitResolver) {
      keyWaitResolver("0");
      keyWaitResolver = null;
    }
  }

  /**
   * Boot an agent-authored adventure using the unified AgentSession.
   * Can run either with live LLM (Anthropic / OpenAI) or offline deterministic stub.
   */
  async function bootCartridgeGame(
    cartridgeMarkdown: string,
    config: LlmConfig,
    options?: { slug?: string; title?: string; useCached?: boolean },
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

      const slug = options?.slug || "custom";
      const title = options?.title || slug;

      if (options?.useCached) {
        const cached = await loadAuthoredCartridge(slug);
        if (cached) {
          logAgent(
            "log",
            `⚡ Booting saved world for "${cached.title}" (authored ${new Date(cached.authoredAt).toLocaleTimeString()}${cached.transcript ? `, ${cached.transcript.length} saved messages` : ""})`,
          );
          const cachedConfig = configForCartridge(slug, config);
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
          booted = {
            slug,
            installed: false,
            files: cached.files,
            words: cached.words,
            cartridge: cached,
          };
          worker.postMessage({
            type: "boot",
            ...(replayDriver ? { replaySeed } : {}),
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
        await authoring.startGenesis(cartridgeMarkdown);
      const cartridge: CachedCartridgeData = {
        slug,
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
      booted = { slug, installed: false, files, words, cartridge };

      const saved = await saveAuthoredCartridge(slug, {
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
          `Saved the world and its authoring conversation in this browser (${slug}).`,
        );

      worker.postMessage({
        type: "boot",
        soundDevice: state.soundMode === "pc-speaker" ? 0 : 1,
        files,
        words,
        sab: bridge.sab,
        autosaveFiles: true,
        authorRooms: true,
        ...(replayDriver ? { replaySeed } : {}),
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
    return bootCartridgeGame("", stubConfig);
  }

  function sendInput(text: string): void {
    worker?.postMessage({ type: "input", text });
  }

  /** Mirror the host input widget's live text onto the engine's input row. */
  function sendEdit(text: string): void {
    worker?.postMessage({ type: "edit", text });
  }

  function sendDirection(dir: number): void {
    worker?.postMessage({ type: "direction", dir, releaseEligible: state.holdToMove });
  }

  function sendKey(code: number): void {
    if (!worker) return;
    const id = ++nextKeyId;
    pendingKeys.set(id, code);
    if (keyWaitResolver) {
      const resolve = keyWaitResolver;
      keyWaitResolver = null;
      state.waitingForKey = false;
      const queued = pendingKeys.entries().next().value!;
      pendingKeys.delete(queued[0]);
      resolve(JSON.stringify({ id: queued[0], code: queued[1] }));
      // If the worker resumes normal execution instead of waiting again, it
      // still receives this key. The sequence ID suppresses bridge duplicates.
      worker.postMessage({ type: "key", id, code });
      return;
    }
    worker.postMessage({ type: "key", id, code });
  }

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
   * writable cartridge copy, since originals cannot store tests.
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
      const cached = game.installed
        ? await loadGameConversation(game.slug)
        : await loadAuthoredCartridge(game.slug);
      session = AgentSession.fromAuthoredData(
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

  function toggleMute(): boolean {
    const muted = audio.toggleMute();
    state.soundMuted = muted;
    worker?.postMessage({ type: "soundEnabled", enabled: !muted });
    return muted;
  }

  function setAudioMode(mode: AudioMode): void {
    audio.setMode(mode);
    state.soundMode = mode;
    worker?.postMessage({ type: "soundDevice", device: mode === "pc-speaker" ? 0 : 1 });
  }

  function setAudioVolume(vol: number): void {
    audio.setVolume(vol);
  }

  function resumeAudio(): Promise<void> {
    return audio.resume();
  }

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
    bootCartridgeGame,
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
