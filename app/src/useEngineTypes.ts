/**
 * The engine's shared state types, re-exported through useEngine.ts so the
 * public surface is unchanged. Kept apart from the composition root so the
 * worker link and lifecycle composables can type their options without an
 * import cycle.
 */
import type { AgentRunState } from "./agent/agentRun.ts";
import type { AgentLogEntry } from "./agent/agentLog.ts";
import type {
  GameControlBinding,
  ScreenObjectState,
  TraceRecord,
} from "../../src/runtime/engine.ts";
import type { AudioMode } from "./audio/AgiAudio.ts";
import type { RoomTransitionNotice } from "./workerProtocol.ts";
import type { InstalledGameDescriptor } from "./gameTypes.ts";
import type { PowerUpUiState } from "./useAuthoringController.ts";
import type { PromptState } from "./usePromptController.ts";
import type { WalkthroughUiState } from "./useWalkthroughController.ts";

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
  /** View the show.obj modal previews, or null when none is open. */
  showObjView: number | null;
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
  /** Trace records the worker evicted while the host was stalled. */
  debugTraceDropped: number;
  /**
   * The world-map journal: every room transition the worker observed, in
   * order. Entries carry the session and resource revision they were made
   * under; useRoomMap keys them to the game identity and owns the durable
   * per-game journal.
   */
  roomJournal: RoomTransitionNotice[];
  /**
   * Bumped when the worker reports a resource patch — surfaces that cache a
   * scan of the booted resources (the world map) subscribe to re-derive.
   */
  patchTick: number;
  /** Debug channels the app has armed on the worker. */
  debugChannels: { ownership: boolean; objects: boolean; trace: boolean; picture: boolean };
  /**
   * Inspector surfaces that need debug payloads; the armed channels are the
   * union of their needs, derived in one place so no control disarms a
   * channel another consumer still uses (e.g. exploded Layers need
   * picture/ownership even when Objects and Inspect are off).
   */
  debugConsumers: {
    dock: boolean;
    overlay: boolean;
    inspect: boolean;
    exploded: boolean;
    trace: boolean;
  };
}
