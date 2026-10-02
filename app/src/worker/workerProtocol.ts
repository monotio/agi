import type { PortableProjectWorkspace } from "../../../src/authoring/projectWorkspace.ts";
import type { ResourceRevision } from "../../../src/gameIdentity.ts";
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
 *   click               pointer click in 320x200 screen pixels (click-to-walk)
 *   direction           movement key press (0 = tracked key release)
 *   edit                live mirror of the host input widget
 *   dismissPrint        acknowledge the engine's open modal (click path)
 *   hostAnswer          reply to a posted hostRequest
 *   reenter             re-enter the current room after a live patch
 *   playHere            jump the live game to a room and ego spot
 *   patch               replace container resources all or none; acknowledged by "patched"
 *   patchMetadata       replace WORDS.TOK / OBJECT / TESTS.JSON
 *   state / objects / frames / checkpoint / exportFiles
 *                       read-only queries, answered by id
 *   flush               take an autosave now (page is going away)
 *   startRecording / stopRecording / cancelRecording
 *                       player-action capture for a stored game test
 *   replayAdvance / resetReplay / exitReplay / renderFrame
 *                       deterministic replay and seeking
 *   soundEnabled / soundDevice
 *   debug / debugWrite / debugTrace / debugEvents / traceAck
 *   previewUpdate / previewUpdateStatus
 *                       same-Engine Play-preview candidate admission
 *
 * Messages out:
 *   WorkerControl — hostRequest, interactionCancelled, replay, frames,
 *   engineState, objects, checkpoint, exportFiles, debugWritten, playedHere,
 *   debugEvents, debugTrace, recordingStarted, recordingStopped, flushed,
 *   restored, booted, metadataPatched, patched, paused, previewUpdateResult,
 *   previewUpdateStatus, error.
 *   WorkerPresentation — frame, trace, print, status, shake, showObj,
 *   autosave, controls, inputEdit, cycle, soundEnabled, sound,
 *   soundOutput, soundPaused, stopSound, waitingForKey, log, quit.
 */
import type {
  EngineMenuState,
  EngineStateReport,
  ExecutionBoundary,
  GameControlBinding,
  ScreenObjectState,
  TraceRecord,
} from "../../../src/runtime/engine.ts";
import type {
  ExecutionCause,
  ExecutionWaitKind,
} from "../../../src/runtime/executionObservation.ts";
import type {
  DebugBreakpointSpec,
  DebugBreakpointStatus,
} from "../../../src/runtime/debugBreakpoints.ts";
import type {
  DebugWatchChange,
  DebugWatchSpec,
  DebugWatchStatus,
} from "../../../src/runtime/debugWatchpoints.ts";
import type { DebugValue } from "../../../src/runtime/debugExpression.ts";
import type { EngineReplayState } from "../../../src/runtime/replayState.ts";
import type { SoundOutput } from "../../../src/sound/sound.ts";
import type { SoundTick } from "../audio/soundTiming.ts";
import type { RecordedOperation } from "../../../src/agent/recordedReplay.ts";
import type { RecordedEvent } from "../authoring/gameRecording.ts";
import type { LlmRequest } from "../agent/hostRequests.ts";
import type { ReplayObservation } from "../walkthrough/replay.ts";
import type { RingFrame } from "./frameRing.ts";
import type { PortableProjectHistory } from "../../../src/authoring/projectHistoryCodec.ts";
import type { HistoryBatch, HistoryBoot, HistoryRecording } from "../../../src/agent/history.ts";
import type { ProfileDetectionKind, ProfileId } from "../../../src/runtime/profile.ts";
import type { PreviewUpdateStatus } from "../../../src/runtime/previewAdmission.ts";
import type { BindingKind } from "../../../src/agent/authoringState.ts";

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

// ---------- execution-controller (debugger) protocol ----------
//
// One debug session owns the live engine's execution gate and observer.
// Every request echoes the attach-time `epoch` and is answered on the
// reliable control channel — `debugAck` on success, `debugError` with a
// structured `code` on refusal — never the presentation-credit stream.
// Session replacement, restart and history adoption mint a fresh epoch,
// which invalidates every request, stop, snapshot and run-to target the
// old epoch issued.

/** Why one visible stop was reported. Order is engine completion order. */
export type DebugStopReason =
  | { kind: "pause" }
  | { kind: "step"; mode: DebugResumeAction; unwind?: boolean }
  | { kind: "breakpoint"; id: string; hitCount: number; error?: string }
  | { kind: "watch"; changes: readonly DebugWatchChange[] }
  | { kind: "runTo" }
  /** An explicit debugSetValues produced a fresh stop identity + snapshot. */
  | { kind: "mutated" };

export type DebugResumeAction = "continue" | "into" | "over" | "out" | "cycle";
export type DebugStepGranularity = "statement" | "instruction";
export type DebugInspectSection = "stack" | "state" | "objects" | "parser" | "strings" | "all";

/** Structured refusal codes the controller reports on `debugError`. */
export type DebugErrorCode =
  | "noEngine"
  | "notAttached"
  | "staleEpoch"
  | "staleStop"
  | "notStopped"
  | "staleRevision"
  | "invalidConfig"
  | "invalidExpression"
  | "invalidRequest"
  | "unavailable";

/**
 * The complete authored name→number map a project's sources compile under:
 * resource bindings (logic/picture/view/sound) plus the value slots
 * (flag/variable/string) the expression evaluator also uses. `bindings` on
 * debugAttach is the expression-only subview; `sourceBindings` is the full
 * map the build identity is captured under.
 */
export type SourceBindingKind = BindingKind | "string";

// ---------- same-Engine Play-preview admission protocol ----------
//
// A frozen-test boot may grant the play-preview lane (`lane:
// "play-preview"`): the attached session then also owns live update
// authority for the physical run the boot minted, named by its `runToken`.
// Every `previewUpdate` settles in exactly one `previewUpdateResult`; a
// `previewUpdateStatus` query is a read-only reconciliation answer.

/**
 * The identity tuple a preview request pins and a result reports: the
 * lane's source epoch, the verified build identity, the installed native
 * resource revision and the lane-local update serial.
 */
export interface PreviewLaneIdentity {
  /** Complete project document identity; legacy isolated previews omit it. */
  documentId?: string;
  epoch: number;
  buildId: string;
  revision: string;
  updateSerial: number;
}

/** The settled outcome of one previewUpdate — the wire body of its result. */
export interface PreviewUpdateOutcome {
  status: PreviewUpdateStatus;
  /** The request's claimed previous identity, null when it could not be read. */
  expected: PreviewLaneIdentity | null;
  /** The lane's actual identity at settle time, null when no lane exists. */
  current: PreviewLaneIdentity | null;
  /** Engine native-image generation observed at the verdict. */
  patchGeneration: number;
  reason?: string;
  /** A deliberate replacement acknowledges the new physical Engine authority. */
  replacementRunToken?: string;
  roomReentry?: true;
}

/** The complete immutable candidate a previewUpdate ships. */
export interface PreviewUpdateCandidateMessage {
  /** Complete ProjectImage documents and exact identity, required by project admission. */
  documents?: PortableProjectWorkspace;
  documentId?: string;
  /** Complete detached container image: directories, volumes, aux files. */
  files: Record<string, Uint8Array>;
  /** Known target profile; a change from the running profile needs a full restart. */
  profile?: ProfileId;
  /** Authored source per LOGIC number (string keys). */
  sources: Record<string, string>;
  /** The complete authored binding map the candidate build is captured under. */
  sourceBindings: Record<string, { kind: SourceBindingKind; num: number }>;
  /** Claimed verified build identity — checked against the real capture. */
  buildId: string;
  /** Claimed native resource revision — recomputed and checked. */
  revision: string;
  /** Host document versions the candidate was assembled under. */
  origins: { key: string; version: number }[];
}

/**
 * Isolated-test admission policy, consumed synchronously inside the boot
 * branch BEFORE any timer, input, sound clock or logic runs: the debugger
 * attaches under the verified build, the initial breakpoint/watchpoint
 * configuration lands atomically, and (unless `stopOnEntry` is explicitly
 * false) the engine latches an idle stop — `booted` posts only after all of
 * it. A refused admission posts `debugError` under `id` and never falls back
 * to running play: no timers start and no `booted` is posted. The policy
 * also pins room authoring off and disables ordinary history recording and
 * autosave for the run.
 */
export interface FrozenTestBoot {
  /** Correlates the admission replies (debugAttached / debugConfigured / debugAck / debugError). */
  id: number;
  /**
   * The lane this isolated run serves. Absent or `"debug"` is the frozen
   * test session; `"play-preview"` additionally grants same-Engine preview
   * update authority — the `debugAttached` reply then carries the run's
   * `preview` block (token + lane identity) the update protocol pins.
   * `stopOnEntry:false` alone does not grant the lane.
   */
  lane?: "debug" | "play-preview";
  /** Authored source per LOGIC number (string keys); each must reproduce the booted bytes. */
  sources?: Record<string, string>;
  /** The complete authored binding map — every kind, verified as the capture identity. */
  sourceBindings?: Record<string, { kind: SourceBindingKind; num: number }>;
  /** The expression-evaluator subview of sourceBindings; must agree exactly where they overlap. */
  bindings?: Record<string, { kind: "variable" | "flag" | "string"; num: number }>;
  breakpoints?: DebugBreakpointSpec[];
  watchpoints?: DebugWatchSpec[];
  /** Latch the pre-first-cycle idle stop at admission (default true). */
  stopOnEntry?: boolean;
}

export interface BootMessage {
  type: "boot";
  files: Record<string, Uint8Array>;
  words: [string, number][];
  sessionId?: number;
  /** Explicit interpreter profile override; null/undefined detects from files. */
  profile?: ProfileId | undefined;
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
  /**
   * Live-session PRNG seed for the recorded history stream — the original's
   * 16-bit word (docs/fidelity.md, "Original RNG"); recorded into the
   * segment's boot so the same random sequence replays offline. Under a
   * frozenTest policy it seeds the run's RNG directly.
   */
  rngSeed?: number;
  /**
   * Isolated-test admission: when present the boot is a frozen test run —
   * debugger attached, configured and paused before the first tick, room
   * authoring pinned off, history/autosave disabled. Replay seeds, autosave
   * resume images and session ids are refused: a test run boots the actual
   * LOGIC 0 of the shipped build, never a parked continuation.
   */
  frozenTest?: FrozenTestBoot;
  /** Explicit live authoring authority for the MAIN run. */
  projectMode?: "create";
  projectDocuments?: PortableProjectWorkspace;
  projectHistory?: PortableProjectHistory;
}

/** A container resource the `patch` message replaces. */
export type PatchKind = "logic" | "picture" | "view" | "sound";

/** One resource of a `patch` message. */
export interface PatchResource {
  kind: PatchKind;
  num: number;
  payload: Uint8Array;
}

export type WorkerInbound =
  | { type: "observeSentences"; enabled: boolean }
  | BootMessage
  | { type: "pause"; paused: boolean }
  | { type: "key"; code: number; sessionId?: number }
  | { type: "click"; x: number; y: number; sessionId?: number }
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
  /**
   * Play here: enter `room`, run its entry cycle and place ego's baseline at
   * (x, y), keeping the session's flags. Answered by `playedHere`.
   */
  | { type: "playHere"; id: number; room: number; x: number; y: number }
  /**
   * Replace every listed resource, or none: the worker stages the whole set
   * before the live container changes, so a refusal (a full volume, an
   * oversized payload) leaves the running game on its old bytes for all of
   * them. One `patched` answers the message.
   */
  | {
      type: "patch";
      resources: PatchResource[];
    }
  | {
      type: "patchMetadata";
      files: Partial<Record<"WORDS.TOK" | "OBJECT" | "TESTS.JSON", Uint8Array>>;
    }
  | { type: "state"; id: number }
  | {
      type: "imageHeroPreview";
      runToken: string;
      bytes: Uint8Array | null;
      loops?: readonly number[];
    }
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
  /**
   * Record a restore point at the replay's current position — sent by the
   * runner at each walkthrough checkpoint so a backward seek replays only
   * the gap instead of the whole tape. Fire-and-forget: a boundary the
   * engine refuses to snapshot simply stores nothing.
   */
  | { type: "replaySnapshot"; sessionId?: number }
  /**
   * Rebuild the replay session at the nearest snapshot at or before `tick`
   * (a fresh boot when none covers it). The reply is the restored head's
   * `replay` observation — the runner resumes the tape from there.
   */
  | { type: "replayRestore"; id: number; tick: number; sessionId?: number }
  | { type: "exitReplay" }
  | { type: "renderFrame" }
  | { type: "soundEnabled"; enabled: boolean }
  | { type: "soundDevice"; device: number }
  | { type: "debug"; channels?: DebugChannels }
  | { type: "debugWrite"; id: number; vars?: [number, number][]; flags?: [number, number][] }
  | { type: "debugTrace"; id: number; since?: number }
  | { type: "debugEvents"; id: number; since?: number }
  /**
   * Flow control for the trace stream: the host acknowledges each posted
   * batch so the worker's posted-but-undelivered queue stays bounded while
   * the consumer is stalled. epoch invalidates acks from a replaced session.
   */
  | { type: "traceAck"; epoch: number; batch: number }
  /**
   * Attach the execution controller to the live engine: captures the running
   * build (sources are verified against the live bytes), mints a session
   * epoch, and ends the live history segment with reason "debugger" —
   * normal recording stays in hiatus until detach. Answered by
   * `debugAttached`, or `debugError` when the build cannot be verified.
   */
  | {
      type: "debugAttach";
      id: number;
      /** Authored source per LOGIC number (string keys); each must reproduce the live bytes. */
      sources?: Record<string, string>;
      /** Named var/flag/string slots the expression evaluator and conditions resolve. */
      bindings?: Record<string, { kind: "variable" | "flag" | "string"; num: number }>;
      /**
       * The complete authored binding map (resource and value names alike).
       * When present it is the map the build identity is captured under and
       * `bindings` must be its exact flag/variable/string subview — a name
       * that disagrees or is missing refuses the attach. Old callers omitting
       * it capture under `bindings` alone, unchanged.
       */
      sourceBindings?: Record<string, { kind: SourceBindingKind; num: number }>;
    }
  /** Release the controller's latch, control hooks and history hiatus. */
  | { type: "debugDetach"; id: number; epoch: number }
  /**
   * Atomically replace the breakpoint/watchpoint configuration. `revision`
   * is a session-monotonic serial — a stale revision is refused and the
   * previous configuration survives any invalid replacement untouched.
   * An absent list keeps that domain's current specs.
   */
  | {
      type: "debugConfigure";
      id: number;
      epoch: number;
      revision: number;
      breakpoints?: DebugBreakpointSpec[];
      watchpoints?: DebugWatchSpec[];
    }
  /** Latch a stop over whatever the engine is doing — a wait stop when parked. */
  | { type: "debugPause"; id: number; epoch: number }
  /**
   * Release the stop named by `stopId`. `continue` clears the latch only;
   * the step actions install a one-shot plan relative to the stop's resume
   * location (null origin is legal for `into`/`cycle`, refused for
   * `over`/`out`). Queued host answers apply once after release.
   */
  | {
      type: "debugResume";
      id: number;
      epoch: number;
      stopId: number;
      action: DebugResumeAction;
      granularity?: DebugStepGranularity;
    }
  /** Continue until the next boundary at `location`; the target dies on resume/replace. */
  | {
      type: "debugRunTo";
      id: number;
      epoch: number;
      stopId: number;
      location: { logic: number; pc: number };
    }
  /** Read one detached section of the pinned stop state. */
  | {
      type: "debugInspect";
      id: number;
      epoch: number;
      stopId: number;
      section?: DebugInspectSection;
    }
  /** Pure expression evaluation against the pinned stop snapshot. */
  | {
      type: "debugEvaluate";
      id: number;
      epoch: number;
      stopId: number;
      expression: string;
    }
  /**
   * The one legal mutation while the debugger owns execution: validates the
   * whole change set before any write, then publishes a fresh stop
   * identity/snapshot. Supersedes the legacy `debugWrite` while attached.
   */
  | {
      type: "debugSetValues";
      id: number;
      epoch: number;
      stopId: number;
      vars?: [number, number][];
      flags?: [number, number][];
    }
  /**
   * The host persisted one history batch — frees the worker's in-flight
   * credit so the next queued batch posts. epoch invalidates stale acks.
   */
  | { type: "historyAck"; epoch: number; batch: number }
  /**
   * The player's retry on the "history not saved" notice: repost the oldest
   * un-acked batch now rather than waiting out the resend backoff.
   */
  | { type: "historyRetry" }
  /**
   * Open a history-viewing session: the live engine is already paused and
   * parked; a scratch session on the side replays the recorded stream to
   * `tick` in `segment` (an index into recording.segments). Progress posts
   * as non-final historyView notices; the terminal one answers the query.
   */
  | {
      type: "historyViewStart";
      id: number;
      recording: HistoryRecording;
      segment: number;
      tick: number;
    }
  /** Scrub to a recorded position; a later seek supersedes one in flight. */
  | { type: "historyViewSeek"; id: number; segment: number; tick: number }
  /** Watch the recording unfold: advance the viewed position by `ticks`. */
  | { type: "historyViewAdvance"; id: number; ticks: number }
  /** Close the viewing session: the scratch session is discarded. */
  | { type: "historyViewEnd" }
  /**
   * Take control at the viewed moment: the viewed state becomes live. The
   * position fields pin the request to the settled position the host
   * confirmed and `generation` pins it to the view session that confirmed
   * it — the worker refuses a take naming a position the drive no longer
   * sits on, one still settling, one the tape failed to verify, or one a
   * stale view session issued.
   */
  | {
      type: "historyViewTake";
      id: number;
      segment: number;
      tick: number;
      seq: number;
      generation: number;
    }
  /** Snapshot the parked live session as the retained original. */
  | { type: "historyRetain"; id: number }
  /**
   * Close the live segment with an "eject" end marker and post its final
   * batch before the host terminates the worker — the tape ends where play
   * stopped instead of dropping the queued tail.
   */
  | { type: "historyEnd"; id: number }
  | { type: "historyRecover"; id: number }
  /** Swap the live session back to a retained original. */
  | {
      type: "historyViewRestore";
      id: number;
      boot: HistoryBoot;
      from: { segment: string; seq: number; tick: number } | null;
    }
  /**
   * The authoring session committed a state change — sources, bindings and
   * world plan — that the tape records as an `authoring` cause. Posted after
   * the commit's patch/answer traffic so the snapshot describes the state
   * those causes produced; a later Resume here reinstalls the checkpoint
   * that belongs to the adopted bytes.
   */
  | { type: "authoring"; snapshot: Record<string, unknown> }
  /**
   * Project admission pins one complete candidate to the running identity.
   * Create boots and isolated play-preview boots grant it; deliberate
   * restart and room-entry actions require Create authority. Every settled request is
   * answered by exactly one `previewUpdateResult`. `id` is a strictly
   * increasing run-local transaction id; the exact request digest dedupes
   * retransmission, so a duplicate replays its settled outcome and an id
   * reused with different content refuses.
   */
  | {
      type: "previewUpdate";
      id: number;
      runToken: string;
      expected: PreviewLaneIdentity;
      candidate: PreviewUpdateCandidateMessage;
      mode?: "restart" | "reenter";
    }
  /**
   * Read-only reconciliation: reports the lane's actual current identity —
   * always recomputed, never a cached ACK — plus, when `transactionId`
   * names a prior update, that transaction's retained outcome,
   * `unavailable` when the id is at or below the lane's admission mark but
   * no result is retained, or `unknown` for an id above the mark that was
   * never admitted. The bounded ledger cannot separate an evicted outcome
   * from a skipped lower id: `unavailable` asserts neither execution nor
   * commit, and no caller may infer rollback from it.
   */
  | { type: "previewUpdateStatus"; id: number; transactionId?: number }
  | {
      type: "projectCreate";
      id: number;
      documents?: PortableProjectWorkspace;
      history?: PortableProjectHistory;
    };

/**
 * Worker → host control channel: request/response traffic and lifecycle
 * notices. Posted through sendControl; not suppressed while seeking.
 */
export type WorkerControl =
  | { type: "missedSentence"; text: string; room: number; unknown: string }
  | { type: "paused"; paused: boolean; cycle: number }
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
  | { type: "frames"; id: number; source: "history" | "recent"; frames: RingFrame[] }
  | { type: "engineState"; id: number; state: EngineStateReport | null }
  | { type: "objects"; id: number; objects: ScreenObjectState[] }
  | { type: "debugWritten"; id: number; error?: string }
  /** ok: ego stands at the spot; otherwise `reason`, and where the game is now. */
  | {
      type: "playedHere";
      id: number;
      ok: boolean;
      room: number;
      x: number;
      y: number;
      reason?: string;
    }
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
  | {
      type: "booted";
      profile: string;
      kind: ProfileDetectionKind;
      projectAdmission?: { runToken: string; identity: PreviewLaneIdentity };
    }
  /**
   * One posted history batch: the always-on recording's transport unit.
   * Batches are committed with the anchor they carry, then acknowledged with
   * historyAck so the worker's ring stays bounded.
   */
  | { type: "historyBatch"; epoch: number; batch: HistoryBatch; profile?: ProfileId }
  | RoomTransitionNotice
  | {
      type: "flushed";
      id: number;
      taken: boolean;
      cycle: number;
    }
  | { type: "metadataPatched" }
  /**
   * The acknowledgement of one `patch`, posted after the engine installed
   * the whole set (or refused it whole). Each resource's `hint` is
   * `resourceCacheHint` of the bytes the engine now holds for it — every hint
   * null with `error` when the install was refused — so a caller awaiting the
   * ack verifies it installed exactly what it sent. `patchGen` is the
   * engine's patch generation after the message.
   */
  | {
      type: "patched";
      resources: { kind: PatchKind; num: number; hint: string | null }[];
      patchGen: number;
      error?: string;
    }
  /**
   * The history-viewing session's position report: progress while a seek is
   * in flight (final:false), the terminal answer to the query that asked
   * (final:true — superseded when a newer request cut it short).
   */
  | {
      type: "historyView";
      id: number;
      final: boolean;
      superseded?: boolean;
      /** The view session this report belongs to — echoed back by a take. */
      generation: number;
      segment: number;
      tick: number;
      seq: number;
      cycle: number;
      room: number;
      score: number;
      modal: string | null;
      /** The viewed moment is a boundary the live session could resume from. */
      canResume: boolean;
      diverged: HistoryViewDivergence | null;
      error: string | null;
    }
  /**
   * The parked live session's retained-original snapshot (null boot = not
   * resumable). `from` is the position the departing session sits at in its
   * own open segment — the restore's provenance.
   */
  | {
      type: "historyRetained";
      id: number;
      boot: HistoryBoot | null;
      from: { segment: string; seq: number; tick: number } | null;
    }
  | {
      type: "historyTaken";
      id: number;
      ok: boolean;
      message?: string;
      /** The adopted boot — the revision both sides now run. */
      boot?: HistoryBoot;
      /** The tape's last authoring checkpoint at-or-before the taken position. */
      session?: unknown;
    }
  /** The segment's end batch was posted; it commits before the worker dies. */
  | { type: "historyEnded"; id: number }
  | {
      type: "historyRecovery";
      id: number;
      batches: HistoryBatch[];
      boot: HistoryBoot | null;
      cycle: number;
      room: number;
    }
  | {
      type: "historyViewRestored";
      id: number;
      ok: boolean;
      message?: string;
      /** The resourceSet revision the worker adopted — checked against the record's. */
      resourceSet?: string;
    }
  // ---------- execution-controller replies and events ----------
  /**
   * The attach handshake: session epoch and verified build identity. On a
   * play-preview boot the `preview` block reports the granted lane's own
   * identity — its physical run token and the tuple every previewUpdate
   * pins its `expected` claim against.
   */
  | {
      type: "debugAttached";
      id: number;
      epoch: number;
      buildId: string;
      preview?: PreviewLaneIdentity & { runToken: string };
    }
  /** Success reply for detach/pause/resume/runTo. */
  | { type: "debugAck"; id: number; epoch: number; buildId: string }
  /**
   * Structured refusal: echoes the request's epoch/build when they are
   * knowable so the caller can match stale traffic to its session.
   */
  | {
      type: "debugError";
      id: number;
      epoch: number | null;
      buildId: string | null;
      code: DebugErrorCode;
      error: string;
    }
  /** A configure reply carries the applied revision and resolved bindings. */
  | {
      type: "debugConfigured";
      id: number;
      epoch: number;
      buildId: string;
      revision: number;
      breakpoints: readonly DebugBreakpointStatus[];
      watchpoints: readonly DebugWatchStatus[];
    }
  | {
      type: "debugInspection";
      id: number;
      epoch: number;
      buildId: string;
      stopId: number;
      section: DebugInspectSection;
      data: unknown;
    }
  | {
      type: "debugEvaluation";
      id: number;
      epoch: number;
      buildId: string;
      stopId: number;
      ok: boolean;
      value?: DebugValue;
      error?: string;
    }
  /** Set-values applied; `stopId` is the fresh identity that supersedes the old one. */
  | {
      type: "debugSetValuesAck";
      id: number;
      epoch: number;
      buildId: string;
      stopId: number;
    }
  /**
   * One visible execution stop — reliable control traffic, never credit-
   * limited. `stopId` is the session's monotonic stop serial; `boundarySeq`
   * is the resume boundary's occurrence serial, null when no resumable
   * LOGIC encounter exists (a pure phase or idle stop fabricates none).
   */
  | {
      type: "debugStopped";
      epoch: number;
      buildId: string;
      stopId: number;
      boundarySeq: number | null;
      cause: ExecutionCause;
      location: ExecutionBoundary | null;
      wait: ExecutionWaitKind | null;
      reasons: readonly DebugStopReason[];
      state: EngineStateReport;
      /** Host-request ids queued while stopped — applied once on resume. */
      answerReady: number[];
    }
  /** The session ended: requested, superseded by an engine replacement, or build-invalid. */
  | { type: "debugDetached"; epoch: number; buildId: string; reason: string }
  /**
   * The session survived an engine replacement under a new epoch: prior
   * stops, snapshots and run-to targets are invalid, and breakpoints were
   * rebound against the recaptured build.
   */
  | {
      type: "debugSessionReset";
      /** Exact source image adopted at a live update. */
      sources?: Record<string, string>;
      epoch: number;
      buildId: string;
      breakpoints: readonly DebugBreakpointStatus[];
      watchpoints: readonly DebugWatchStatus[];
    }
  /** A host answer arrived while stopped: raw-queued until the latch releases. */
  | { type: "debugAnswerReady"; epoch: number; stopId: number; id: number; op: string }
  /**
   * The one terminal settlement of a `previewUpdate` — committed, unchanged,
   * deferred, restartRequired or refused — correlated by the request's id
   * and run token. A busy boundary settles `deferred` immediately; the
   * worker keeps no pending-commit queue and retries come as fresh ids.
   * `expected` echoes the request's claimed identity; `current` is always
   * the lane's actual recomputed identity.
   */
  | {
      type: "projectCreated";
      id: number;
      grant?: { runToken: string; identity: PreviewLaneIdentity };
      reason?: string;
    }
  | ({ type: "previewUpdateResult"; id: number; runToken: string } & PreviewUpdateOutcome)
  /**
   * The read-only reconciliation answer. `current` is recomputed from the
   * live engine and lane — a lost ACK is reconciled here, never by
   * inferring rollback. `transaction` reports the retained outcome for the
   * queried id, "unavailable" for an id at or below the lane's admission
   * mark with no retained result (bounded retention cannot tell an evicted
   * outcome from a skipped id), or "unknown" for an id above the mark the
   * lane never admitted.
   */
  | {
      type: "previewUpdateStatus";
      id: number;
      runToken: string | null;
      current: PreviewLaneIdentity | null;
      transaction: { id: number; outcome: PreviewUpdateOutcome } | "unavailable" | "unknown" | null;
    }
  /** A logpoint's text, stamped with the boundary sequence that produced it. */
  | { type: "debugLog"; epoch: number; sequence: number; breakpoint: string; text: string }
  /**
   * The debugger's audio hold — a named pause owner distinct from the
   * ambient channel and the worker-authoring hold. Set while stopped;
   * the main thread clears it only for the epoch that set it.
   */
  | { type: "debugAudio"; epoch: number; paused: boolean };

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
      /** Container patch revision at capture; part of the frame's identity. */
      patchGeneration: number;
      ownership?: Uint16Array;
      objects?: ScreenObjectState[];
      picVisual?: Uint8Array;
      picPriority?: Uint8Array;
      /**
       * Logical pixels the show.obj preview cel wrote — present on every
       * frame while that modal is open so layered renderers can isolate it.
       */
      preview?: Uint8Array;
    }
  /**
   * One acknowledged batch of trace records. `dropped` counts records the
   * worker evicted from its bounded backlog since the previous batch; seq
   * gaps in `records` expose the same loss. `epoch` identifies the stream
   * instance so a replaced session's batches cannot leak into the new one.
   */
  | {
      type: "trace";
      epoch: number;
      batch: number;
      dropped: number;
      records: StampedTrace[];
    }
  | { type: "print"; text: string }
  | { type: "status"; text: string }
  | { type: "shake"; count: number }
  | { type: "showObj"; viewNum: number }
  | {
      type: "autosave";
      image: string;
      revision?: ResourceRevision;
      menus: EngineMenuState;
      cycle: number;
      room: number;
      preview?: string;
      files?: Record<string, Uint8Array>;
    }
  | { type: "soundEnabled"; enabled: boolean }
  | { type: "controls"; controls: GameControlBinding[] }
  | { type: "inputEdit"; text: string }
  /**
   * The liveness heartbeat: completed cycles, the room and ego's position,
   * and the game's cycle delay (v10) so the host can tell game time.
   */
  | { type: "cycle"; cycle: number; room: number; egoX: number; egoY: number; delay: number }
  | { type: "waitingForKey"; waiting: boolean }
  | { type: "soundPaused"; paused: boolean }
  | { type: "sound"; soundNum: number }
  | { type: "soundOutput"; output: SoundOutput }
  | ({ type: "soundTick" } & SoundTick)
  | { type: "stopSound" }
  | { type: "quit" }
  | { type: "log"; text: string };

/**
 * One observed room transition — the world-map journal's raw fact. Posted at
 * the boundary where it landed: a completed cycle, a resumed host answer, a
 * restore or a re-entry. sessionId is stamped by the worker's outbound
 * wrapper like every control message.
 */
export interface RoomTransitionNotice {
  type: "roomTransition";
  /** Per-session entry order, assigned by the worker journal. */
  seq: number;
  from: number | null;
  to: number;
  cause: "boot" | "edge" | "logic" | "restore" | "restart" | "reenter" | "jump";
  /** Cause "edge": the side ego left through (v2: 1 top, 2 right, 3 bottom, 4 left). */
  edge?: "top" | "right" | "bottom" | "left";
  cycle: number;
  patchGeneration: number;
  scoreDelta: number;
  gained: number[];
  lost: number[];
  /**
   * Where this transition sits in the recorded history — the map's jump-to-
   * visit affordance. Absent only when no live segment recorded it.
   */
  history?: { segment: string; seq: number; tick: number };
  sessionId?: number;
}

/** A history replay divergence as the wire carries it. */
interface HistoryViewDivergence {
  at: { seq: number; tick: number; cycle: number };
  detail: string;
  expected?: string;
  actual?: string;
}

/** Every message the worker may post. */
export type WorkerOutbound = WorkerControl | WorkerPresentation;

/**
 * Query requests answered through the link's pending-query table: the request
 * type, the outbound member that replies, and the payload the pending promise
 * settles with. `flushed` is not here — the autosave controller owns its own
 * waiter table because a flush can outlive the caller's await (pagehide).
 */
interface WorkerQueryReplies {
  projectCreate: Extract<WorkerControl, { type: "projectCreated" }>;
  state: Extract<WorkerControl, { type: "engineState" }>;
  objects: Extract<WorkerControl, { type: "objects" }>;
  frames: Extract<WorkerControl, { type: "frames" }>;
  checkpoint: Extract<WorkerControl, { type: "checkpoint" }>;
  exportFiles: Extract<WorkerControl, { type: "exportFiles" }>;
  startRecording: Extract<WorkerControl, { type: "recordingStarted" }>;
  stopRecording: Extract<WorkerControl, { type: "recordingStopped" }>;
  replayAdvance: Extract<WorkerControl, { type: "replay" }>;
  replayRestore: Extract<WorkerControl, { type: "replay" }>;
  historyViewStart: Extract<WorkerControl, { type: "historyView" }>;
  historyViewSeek: Extract<WorkerControl, { type: "historyView" }>;
  historyViewAdvance: Extract<WorkerControl, { type: "historyView" }>;
  historyViewTake: Extract<WorkerControl, { type: "historyTaken" }>;
  historyRetain: Extract<WorkerControl, { type: "historyRetained" }>;
  historyEnd: Extract<WorkerControl, { type: "historyEnded" }>;
  historyRecover: Extract<WorkerControl, { type: "historyRecovery" }>;
  historyViewRestore: Extract<WorkerControl, { type: "historyViewRestored" }>;
  debugWrite: Extract<WorkerControl, { type: "debugWritten" }>;
  playHere: Extract<WorkerControl, { type: "playedHere" }>;
  debugTrace: Extract<WorkerControl, { type: "debugTrace" }>;
  debugEvents: Extract<WorkerControl, { type: "debugEvents" }>;
  debugAttach: Extract<WorkerControl, { type: "debugAttached" }>;
  debugDetach: Extract<WorkerControl, { type: "debugAck" }>;
  debugConfigure: Extract<WorkerControl, { type: "debugConfigured" }>;
  debugPause: Extract<WorkerControl, { type: "debugAck" }>;
  debugResume: Extract<WorkerControl, { type: "debugAck" }>;
  debugRunTo: Extract<WorkerControl, { type: "debugAck" }>;
  debugInspect: Extract<WorkerControl, { type: "debugInspection" }>;
  debugEvaluate: Extract<WorkerControl, { type: "debugEvaluation" }>;
  debugSetValues: Extract<WorkerControl, { type: "debugSetValuesAck" }>;
  previewUpdate: Extract<WorkerControl, { type: "previewUpdateResult" }>;
  previewUpdateStatus: Extract<WorkerControl, { type: "previewUpdateStatus" }>;
}

export type WorkerQueryType = keyof WorkerQueryReplies;

/** The value a reply resolves its pending query with. */
export interface WorkerQueryPayload {
  projectCreate: WorkerQueryReplies["projectCreate"];
  state: WorkerQueryReplies["state"]["state"];
  objects: WorkerQueryReplies["objects"]["objects"];
  frames: WorkerQueryReplies["frames"]["frames"];
  checkpoint: WorkerQueryReplies["checkpoint"]["image"];
  exportFiles: WorkerQueryReplies["exportFiles"]["files"];
  startRecording: WorkerQueryReplies["startRecording"];
  stopRecording: WorkerQueryReplies["stopRecording"];
  replayAdvance: WorkerQueryReplies["replayAdvance"]["observation"];
  replayRestore: WorkerQueryReplies["replayRestore"]["observation"];
  historyViewStart: WorkerQueryReplies["historyViewStart"];
  historyViewSeek: WorkerQueryReplies["historyViewSeek"];
  historyViewAdvance: WorkerQueryReplies["historyViewAdvance"];
  historyViewTake: WorkerQueryReplies["historyViewTake"];
  historyRetain: WorkerQueryReplies["historyRetain"];
  historyEnd: WorkerQueryReplies["historyEnd"];
  historyRecover: WorkerQueryReplies["historyRecover"];
  historyViewRestore: WorkerQueryReplies["historyViewRestore"];
  debugWrite: WorkerQueryReplies["debugWrite"];
  playHere: WorkerQueryReplies["playHere"];
  debugTrace: WorkerQueryReplies["debugTrace"];
  debugEvents: WorkerQueryReplies["debugEvents"];
  debugAttach: WorkerQueryReplies["debugAttach"];
  debugDetach: WorkerQueryReplies["debugDetach"];
  debugConfigure: WorkerQueryReplies["debugConfigure"];
  debugPause: WorkerQueryReplies["debugPause"];
  debugResume: WorkerQueryReplies["debugResume"];
  debugRunTo: WorkerQueryReplies["debugRunTo"];
  debugInspect: WorkerQueryReplies["debugInspect"];
  debugEvaluate: WorkerQueryReplies["debugEvaluate"];
  debugSetValues: WorkerQueryReplies["debugSetValues"];
  previewUpdate: WorkerQueryReplies["previewUpdate"];
  previewUpdateStatus: WorkerQueryReplies["previewUpdateStatus"];
}

/** The typed query function the worker link hands to consumers. */
export type WorkerQueryFn = <K extends WorkerQueryType>(
  type: K,
  extra?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<WorkerQueryPayload[K]>;
