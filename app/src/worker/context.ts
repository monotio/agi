/**
 * Worker context: every piece of mutable worker state, grouped by the module
 * that owns it, plus the ports out of the worker and the cross-module
 * function table. Modules are plain functions of the context, importable
 * under Node — no `self`, `postMessage`, `window` or `document` here.
 */
import type { Engine, EngineHost } from "../../../src/runtime/engine.ts";
import { CycleClock } from "../../../src/runtime/cycleClock.ts";
import { SoundClock } from "../soundClock.ts";
import { FrameRing } from "../frameRing.ts";
import type { OperationRecorder } from "../../../src/agent/recordedReplay.ts";
import type { RecordedEvent } from "../gameRecording.ts";
import type {
  DebugEvent,
  HostRequestOp,
  StampedTrace,
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
} from "../workerProtocol.ts";
import { createInput } from "./input.ts";

/** The only platform access worker modules get: the post boundary and a clock. */
export interface WorkerPorts {
  control(message: WorkerControl, transfer?: Transferable[]): void;
  presentation(message: WorkerPresentation, transfer?: Transferable[]): void;
  /** performance.now */
  now(): number;
}

/** Settings the boot message owns; a replay reset keeps them. */
export interface BootState {
  authorRooms: boolean;
  selectedSoundDevice: number;
  liveDictionary: Map<string, number>;
  authoredWords: Uint8Array | null;
  currentBootFiles: Map<string, Uint8Array> | null;
  currentDictionary: Map<string, number> | null;
}

/** worker/input.ts */
export interface InputState {
  /** Queued key presses; a parked key wait is answered straight from here. */
  keyQueue: number[];
  /** Admitted walking releases and later walking keys wait for ordinary input. */
  deferredMovement: number[];
  inputBuffer: string[];
  /** The suspended interaction waits on a player key, not a host request. */
  keyWaiting: boolean;
}

/** worker/hostRequests.ts */
export interface HostRequestsState {
  hostRequestSerial: number;
  /**
   * The host request currently in flight, or null when none is. The engine's
   * pendingInteraction armed before the request posted; the matching
   * hostAnswer message feeds deliverHostResponse.
   */
  hostRequestOutstanding: { id: number; op: string; authoring: boolean } | null;
  /** A reenter suspended on room authoring owes the host a `reentered`. */
  pendingReenter: boolean;
}

/** worker/replay.ts */
export interface ReplayState {
  replay: { tick: number; revision: number; random: number } | null;
  replayRequest: number | null;
  lastReplaySeed: number | null;
  isSeeking: boolean;
  currentSessionId: number;
}

/** worker/cycle.ts */
export interface CycleState {
  timer: number | null;
  soundTimer: number | null;
  /** Interpreter cycles completed since boot; the frame ring's timeline. */
  cycleCount: number;
  lastCycleReportAt: number;
  lastHistoryAt: number;
  initialLogicStarted: boolean;
  lastInputReady: boolean;
  /**
   * The remix freeze. A `pause` message sets it; messages from one sender are
   * delivered in order, so a pause posted before a query is always applied
   * before the query is served — at most one more cycle runs first, and that
   * cycle is invisible since nobody reads state before the freeze lands.
   */
  paused: boolean;
}

/** worker/autosave.ts */
export interface AutosaveState {
  autosaveIntervalMs: number;
  autosaveFiles: boolean;
  lastAutosaveAt: number;
  lastAutosaveCycle: number;
  lastPatchGeneration: number;
}

/** worker/presentation.ts — the frame sameness cache. */
export interface PresentationState {
  recentRing: FrameRing;
  historyRing: FrameRing;
  lastVisual: Uint8Array | null;
  lastText: Uint8Array | null;
  lastOwnership: Uint16Array | null;
  lastPicture: Uint8Array | null;
  lastPicturePriority: Uint8Array | null;
  lastObjectsJson: string;
  lastPicRow: number;
  lastTextMode: boolean;
  lastInputEnabled: boolean;
  lastReleaseGate: number;
  lastModal: string | null;
  lastControls: string;
  lastInputEdit: string;
  lastSoundEnabled: boolean | null;
}

/** worker/debug.ts */
export interface DebugState {
  /** Inspector channels armed by the host; each costs real per-cycle work. */
  channels: { ownership: boolean; objects: boolean; trace: boolean; picture: boolean };
  debugEvents: DebugEvent[];
  debugEventSeq: number;
  prevVars: Uint8Array | null;
  prevFlags: Uint8Array | null;
  traceRing: StampedTrace[];
  traceSeq: number;
  pendingTrace: StampedTrace[];
}

/** worker/recording.ts */
export interface RecordingState {
  /**
   * The active player-action recording for a stored game test: every player
   * action the interpreter receives, stamped with the interpreter cycle at
   * the moment it arrives, plus the messages the game printed while
   * recording. null while not recording.
   */
  recording: {
    tape: OperationRecorder;
    events: RecordedEvent[];
    printed: string[];
    tainted: string | null;
    usedGetnum: boolean;
  } | null;
}

export type Inbound<T extends WorkerInbound["type"]> = Extract<WorkerInbound, { type: T }>;

/**
 * The context's function table: the only way one module reaches another's
 * functions. createWorkerContext fills it from the modules that have landed;
 * engine.worker.ts seeds the rest while they still live there.
 */
export interface WorkerFns {
  // input.ts
  setKeyWaiting(waiting: boolean): void;
  flushDeferredMovement(): void;
  deliverQueuedKey(): void;
  onKey(msg: Inbound<"key">): void;
  onDirection(msg: Inbound<"direction">): void;
  onInput(msg: Inbound<"input">): void;
  onEdit(msg: Inbound<"edit">): void;
  onDismissPrint(): void;
  // hostRequests.ts
  postHostRequest(op: HostRequestOp, context: Record<string, unknown>): never;
  settleHostRequest(outstanding: { op: string; authoring: boolean }): void;
  abandonHostRequest(): void;
  deliverHostResponse(op: string, response: string): void;
  onHostAnswer(msg: Inbound<"hostAnswer">): void;
  onReenter(msg: Inbound<"reenter">): void;
  // replay.ts
  postReplay(blocked: string | null, fullState?: boolean): void;
  onReplayAdvance(msg: Inbound<"replayAdvance">): void;
  onResetReplay(msg: Inbound<"resetReplay">): void;
  onExitReplay(): void;
  // cycle.ts
  tickEngine(): void;
  recordedClock(): void;
  advanceSoundClock(authoring?: boolean): void;
  finishCycle(): void;
  startTimers(): void;
  stopTimers(): void;
  onPause(msg: Inbound<"pause">): void;
  // autosave.ts
  autosave(force: boolean): boolean;
  onFlush(msg: Inbound<"flush">): void;
  onCheckpoint(msg: Inbound<"checkpoint">): void;
  // presentation.ts
  postFrame(capture?: boolean): void;
  onFrames(msg: Inbound<"frames">): void;
  onRenderFrame(): void;
  // debug.ts
  captureStateDiffs(): void;
  applyTraceChannel(): void;
  flushTraceBatch(): void;
  onDebug(msg: Inbound<"debug">): void;
  onDebugWrite(msg: Inbound<"debugWrite">): void;
  onDebugTrace(msg: Inbound<"debugTrace">): void;
  onDebugEvents(msg: Inbound<"debugEvents">): void;
  // recording.ts
  recordEvent(event: RecordedEvent): void;
  onStartRecording(msg: Inbound<"startRecording">): void;
  onStopRecording(msg: Inbound<"stopRecording">): void;
  onCancelRecording(): void;
}

export interface WorkerContext {
  ports: WorkerPorts;
  engine: Engine | null;
  /** The engine's host facade; assigned right after creation (it closes over ctx). */
  host: EngineHost;
  boot: BootState;
  clocks: { sound: SoundClock; cycle: CycleClock };
  input: InputState;
  hostRequests: HostRequestsState;
  replay: ReplayState;
  cycle: CycleState;
  autosave: AutosaveState;
  presentation: PresentationState;
  debug: DebugState;
  recording: RecordingState;
  fns: WorkerFns;
}

export function createWorkerContext(ports: WorkerPorts): WorkerContext {
  const now = ports.now();
  const ctx: WorkerContext = {
    ports,
    engine: null,
    host: undefined as unknown as EngineHost,
    boot: {
      authorRooms: false,
      selectedSoundDevice: 1,
      liveDictionary: new Map(),
      authoredWords: null,
      currentBootFiles: null,
      currentDictionary: null,
    },
    clocks: { sound: new SoundClock(now), cycle: new CycleClock(now) },
    input: { keyQueue: [], deferredMovement: [], inputBuffer: [], keyWaiting: false },
    hostRequests: { hostRequestSerial: 0, hostRequestOutstanding: null, pendingReenter: false },
    replay: {
      replay: null,
      replayRequest: null,
      lastReplaySeed: null,
      isSeeking: false,
      currentSessionId: 0,
    },
    cycle: {
      timer: null,
      soundTimer: null,
      cycleCount: 0,
      lastCycleReportAt: 0,
      lastHistoryAt: 0,
      initialLogicStarted: false,
      lastInputReady: false,
      paused: false,
    },
    autosave: {
      autosaveIntervalMs: 5_000,
      autosaveFiles: false,
      lastAutosaveAt: 0,
      lastAutosaveCycle: -1,
      lastPatchGeneration: 0,
    },
    presentation: {
      recentRing: new FrameRing(100),
      historyRing: new FrameRing(60),
      lastVisual: null,
      lastText: null,
      lastOwnership: null,
      lastPicture: null,
      lastPicturePriority: null,
      lastObjectsJson: "",
      lastPicRow: -1,
      lastTextMode: false,
      lastInputEnabled: false,
      lastReleaseGate: 0,
      lastModal: null,
      lastControls: "",
      lastInputEdit: "",
      lastSoundEnabled: null,
    },
    debug: {
      channels: { ownership: false, objects: false, trace: false, picture: false },
      debugEvents: [],
      debugEventSeq: 0,
      prevVars: null,
      prevFlags: null,
      traceRing: [],
      traceSeq: 0,
      pendingTrace: [],
    },
    recording: { recording: null },
    fns: {} as WorkerFns,
  };
  Object.assign(ctx.fns, createInput(ctx));
  return ctx;
}

/**
 * The session reset both boot and resetReplay share: every field the two
 * handlers cleared identically lives here. Fields they reset differently —
 * isSeeking, currentSessionId, replay, keyWaiting, hostRequestOutstanding and
 * the boot-owned settings — stay in the handlers. applyTraceChannel and
 * captureStateDiffs run last so the diff ring baselines the fresh engine.
 */
export function resetSession(ctx: WorkerContext): void {
  const now = ctx.ports.now();
  ctx.cycle.initialLogicStarted = false;
  ctx.cycle.paused = false;
  ctx.input.inputBuffer = [];
  ctx.input.keyQueue = [];
  ctx.input.deferredMovement.length = 0;
  ctx.recording.recording = null;
  ctx.hostRequests.pendingReenter = false;
  const p = ctx.presentation;
  p.lastVisual = null;
  p.lastText = null;
  p.lastOwnership = null;
  p.lastPicture = null;
  p.lastPicturePriority = null;
  p.lastPicRow = -1;
  p.lastTextMode = false;
  p.lastInputEnabled = false;
  p.lastReleaseGate = 0;
  p.lastModal = null;
  p.lastControls = "";
  p.lastInputEdit = "";
  p.lastSoundEnabled = null;
  ctx.fns.stopTimers();
  ctx.clocks.sound.reset(now);
  ctx.clocks.cycle.reset(ctx.replay.replay ? 0 : now);
  ctx.cycle.lastCycleReportAt = now;
  ctx.cycle.lastHistoryAt = now;
  ctx.cycle.cycleCount = 0;
  p.recentRing.reset();
  p.historyRing.reset();
  const d = ctx.debug;
  d.debugEvents.length = 0;
  d.debugEventSeq = 0;
  d.prevVars = null;
  d.prevFlags = null;
  d.traceRing.length = 0;
  d.traceSeq = 0;
  d.pendingTrace = [];
  ctx.fns.applyTraceChannel();
  ctx.fns.captureStateDiffs();
}
