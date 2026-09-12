/**
 * The engine-worker message protocol, shared by both threads.
 *
 * `WorkerInbound` is every message the main thread may post to the worker;
 * `WorkerControl` and `WorkerPresentation` are the worker's two outbound
 * channels — control answers and requests, presentation the frame/status
 * stream that seeking suppresses. Both dispatchers are typed against these
 * unions, so a message shape only exists once.
 *
 * Messages in (WorkerInbound):
 *   boot                files, words, autosave/resume options, replay seed
 *   pause               remix freeze; acknowledged by "paused"
 *   input               player pressed Enter on the input line
 *   key                 key press; answers a parked key wait
 *   direction           movement key press (0 = tracked key release)
 *   edit                live mirror of the host input widget
 *   dismissPrint        acknowledge the engine's open modal (click path)
 *   hostAnswer          reply to a posted hostRequest
 *   reenter             re-enter the current room after a live patch
 *   patch               replace one container resource
 *   patchMetadata       replace WORDS.TOK / OBJECT / TESTS.JSON
 *   state / objects / frames / checkpoint / exportFiles
 *                       read-only queries, answered by id
 *   flush               take an autosave now (page is going away)
 *   startRecording / stopRecording / cancelRecording
 *                       player-action capture for a stored game test
 *   replayAdvance / resetReplay / exitReplay / renderFrame
 *                       deterministic replay and seeking
 *   soundEnabled / soundDevice
 *   debug / debugWrite / debugTrace / debugEvents
 *
 * Messages out:
 *   WorkerControl — hostRequest, interactionCancelled, replay, frames,
 *   engineState, objects, checkpoint, exportFiles, debugWritten,
 *   debugEvents, debugTrace, recordingStarted, recordingStopped, flushed,
 *   restored, reentered, booted, exitedReplay, metadataPatched, paused,
 *   error.
 *   WorkerPresentation — frame, trace, print, display, clearText,
 *   clearLines, textMode, status, shake, showObj, showPri, statusScreen,
 *   autosave, controls, inputEdit, cycle, soundEnabled, sound,
 *   soundOutput, soundPaused, stopSound, waitingForKey, log, quit.
 */
import type {
  EngineMenuState,
  EngineStateReport,
  GameControlBinding,
  ScreenObjectState,
  TraceRecord,
} from "../../src/runtime/engine.ts";
import type { EngineReplayState } from "../../src/runtime/replayState.ts";
import type { SoundOutput } from "../../src/sound/sound.ts";
import type { RecordedOperation } from "../../src/agent/recordedReplay.ts";
import type { RecordedEvent } from "./gameRecording.ts";
import type { LlmRequest } from "./agent/hostRequests.ts";
import type { ReplayObservation } from "./replay.ts";
import type { RingFrame } from "./frameRing.ts";

/** Ops the worker may suspend on; see agent/hostRequests.ts. */
export type HostRequestOp = LlmRequest["op"];

/** Debug channels the host can arm; each costs real per-cycle work. */
export interface DebugChannels {
  ownership?: boolean;
  objects?: boolean;
  trace?: boolean;
  picture?: boolean;
}

/** One observed interpreter-state write, attributed to a completed cycle. */
export interface DebugEvent {
  seq: number;
  cycle: number;
  kind: "var" | "flag";
  index: number;
  from: number;
  to: number;
}

/** Trace records carry their interpreter cycle plus a stream sequence. */
export type StampedTrace = TraceRecord & { seq: number; cycle: number };

export interface BootMessage {
  type: "boot";
  files: Record<string, Uint8Array>;
  words: [string, number][];
  sessionId?: number;
  /** Browser-selected sound device: 0 speaker, 1 four-channel output. */
  soundDevice?: number;
  /** Autosave cadence override; the host owns the policy, the worker the timing. */
  autosaveMs?: number;
  /**
   * Ship the patched container along with an autosave when a patch landed.
   * Enabled for cached worlds, including locally imported ZIPs.
   * Explicit export uses a separate request and works for any loaded game.
   */
  autosaveFiles?: boolean;
  authorRooms?: boolean;
  /**
   * base64 save image to restore into the freshly booted engine (autosave
   * resume). Applied BEFORE the first cycle: the alternative, a message sent
   * once `booted` arrives, races the game's own first cycles — and a title
   * screen that parks on have.key() would block the worker before it could be
   * delivered at all.
   */
  restoreImage?: string;
  restoreMenus?: EngineMenuState;
  /** Test-mode host clock and reproducible random input. */
  replaySeed?: number;
}

export type WorkerInbound =
  | BootMessage
  | { type: "pause"; paused: boolean }
  | { type: "key"; code: number; sessionId?: number }
  | {
      type: "direction";
      dir: number;
      releaseEligible?: boolean;
      sessionId?: number;
    }
  | { type: "input"; text: string }
  | { type: "edit"; text: string }
  | { type: "dismissPrint" }
  | { type: "hostAnswer"; id: number; response: string }
  | { type: "reenter"; room?: number }
  | {
      type: "patch";
      kind: "logic" | "picture" | "view" | "sound";
      num: number;
      payload: Uint8Array;
    }
  | {
      type: "patchMetadata";
      files: Partial<Record<"WORDS.TOK" | "OBJECT" | "TESTS.JSON", Uint8Array>>;
    }
  | { type: "state"; id: number }
  | { type: "objects"; id: number }
  | { type: "frames"; id: number; count?: number; stride?: number; since?: number | null }
  | { type: "checkpoint"; id: number }
  | { type: "exportFiles"; id: number }
  | { type: "flush"; id: number }
  | { type: "startRecording"; id: number }
  | { type: "stopRecording"; id: number }
  | { type: "cancelRecording" }
  | {
      type: "replayAdvance";
      id: number;
      ticks: number;
      sessionId?: number;
      seeking?: boolean;
      renderFinal?: boolean;
      fullState?: boolean;
    }
  | { type: "resetReplay"; seed?: number; seeking?: boolean; sessionId?: number }
  | { type: "exitReplay" }
  | { type: "renderFrame" }
  | { type: "soundEnabled"; enabled: boolean }
  | { type: "soundDevice"; device: number }
  | { type: "debug"; channels?: DebugChannels }
  | { type: "debugWrite"; id: number; vars?: [number, number][]; flags?: [number, number][] }
  | { type: "debugTrace"; id: number; since?: number }
  | { type: "debugEvents"; id: number; since?: number };

/**
 * Worker → host control channel: request/response traffic and lifecycle
 * notices. Posted through sendControl; not suppressed while seeking.
 */
export type WorkerControl =
  | { type: "paused"; paused: boolean }
  | {
      type: "hostRequest";
      id: number;
      op: HostRequestOp;
      context: Record<string, unknown>;
    }
  | { type: "interactionCancelled"; id: number; op: string }
  | {
      type: "replay";
      sessionId: number;
      id: number | null;
      observation: ReplayObservation;
    }
  | { type: "error"; message: string; id?: number }
  | { type: "reentered"; room: number }
  | { type: "frames"; id: number; source: "history" | "recent"; frames: RingFrame[] }
  | { type: "engineState"; id: number; state: EngineStateReport | null }
  | { type: "objects"; id: number; objects: ScreenObjectState[] }
  | { type: "debugWritten"; id: number }
  | { type: "debugEvents"; id: number; cycle: number; latestSeq: number; events: DebugEvent[] }
  | { type: "debugTrace"; id: number; cycle: number; latestSeq: number; records: StampedTrace[] }
  | { type: "checkpoint"; id: number; image: Uint8Array | null }
  | {
      type: "recordingStarted";
      id: number;
      ok: boolean;
      error?: string;
      image?: string;
      replayState?: EngineReplayState;
      cycle?: number;
      state?: EngineStateReport;
    }
  | {
      type: "recordingStopped";
      id: number;
      operations: RecordedOperation[];
      events: RecordedEvent[];
      printed: string[];
      tainted: string | null;
      usedGetnum: boolean;
      cycle: number;
      state: EngineStateReport | null;
    }
  | { type: "exportFiles"; id: number; files: Record<string, Uint8Array> | null }
  | {
      type: "restored";
      ok: boolean;
      room?: number;
      egoX?: number;
      egoY?: number;
      message?: string;
    }
  | { type: "booted"; profile: string }
  | { type: "exitedReplay" }
  | {
      type: "flushed";
      id: number;
      taken: boolean;
      cycle: number;
      hasEngine: boolean;
      modal: boolean;
      textMode: boolean;
      pictureShown: boolean;
    }
  | { type: "metadataPatched" };

/**
 * Worker → host presentation channel: the frame stream, text-surface
 * mirrors and audio. Posted through sendPresentation; dropped while seeking.
 */
export type WorkerPresentation =
  | {
      type: "frame";
      visual: Uint8Array;
      priority: Uint8Array;
      text: Uint8Array;
      picRow: number;
      modal: string | null;
      textMode: boolean;
      inputEnabled: boolean;
      inputReady: boolean;
      holdToMove: boolean;
      edit: string;
      cycle: number;
      ownership?: Uint16Array;
      objects?: ScreenObjectState[];
      picVisual?: Uint8Array;
      picPriority?: Uint8Array;
    }
  | { type: "trace"; records: StampedTrace[] }
  | { type: "print"; text: string }
  | { type: "display"; row: number; col: number; text: string }
  | { type: "clearText" }
  | { type: "clearLines"; fromRow: number; toRow: number; color?: number | undefined }
  | { type: "textMode"; active: boolean }
  | { type: "status"; text: string }
  | { type: "shake"; count: number }
  | { type: "showObj"; viewNum: number }
  | { type: "showPri" }
  | { type: "statusScreen"; items: { num: number; name: string }[] }
  | {
      type: "autosave";
      image: string;
      menus: EngineMenuState;
      cycle: number;
      room: number;
      preview?: string;
      files?: Record<string, Uint8Array>;
    }
  | { type: "soundEnabled"; enabled: boolean }
  | { type: "controls"; controls: GameControlBinding[] }
  | { type: "inputEdit"; text: string }
  | { type: "cycle"; cycle: number; room: number; egoX: number; egoY: number }
  | { type: "waitingForKey"; waiting: boolean }
  | { type: "soundPaused"; paused: boolean }
  | { type: "sound"; soundNum: number }
  | { type: "soundOutput"; output: SoundOutput }
  | { type: "stopSound" }
  | { type: "quit" }
  | { type: "log"; text: string };

/** Every message the worker may post. */
export type WorkerOutbound = WorkerControl | WorkerPresentation;
