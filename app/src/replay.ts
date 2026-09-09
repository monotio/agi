import type { EngineStateReport } from "../../src/runtime/engine.ts";

/** Test-only clock observations. The replay driver cannot write interpreter state. */
export interface ReplayObservation {
  sessionId?: number;
  revision: number;
  tick: number;
  cycle: number;
  blocked: string | null;
  state: EngineStateReport;
  rows: string[];
  egoView: number;
  /** Current key-release gate; input adapters must preserve held movement. */
  releaseGate: number;
}

export interface ReplayStatus {
  sessionId: number;
  requestId: number | null;
  observedTick: number;
  revision: number;
  status: string;
}

export type ReplayAction =
  | { kind: "key"; code: number }
  | { kind: "command"; text: string }
  | { kind: "advance"; ticks: number }
  | { kind: "answer"; text: string }
  | { kind: "checkpoint"; label: string; room: number; score: number; x: number; y: number };

export interface ReplayBatchResult extends ReplayObservation {
  score: number;
  room: number;
  screenHash: string;
}

export interface ReplayCheckpointEvent {
  label: string;
  room: number;
  score: number;
  x: number;
  y: number;
}

export interface ReplayProgressEvent {
  actionIndex: number;
  totalActions: number;
  tick: number;
  room: number;
  score: number;
}

export interface ReplayBatchOptions {
  sessionId?: number;
  isCurrentSession?: () => boolean;
  phone?: boolean;
  /** Speed multiplier for real-time watching: 1 = 1x real time, 2 = 2x, etc. 0 = unthrottled fast-forward (default) */
  speed?: number | (() => number);
  /** Callback to check if playback is currently paused */
  isPaused?: () => boolean;
  /** Async function resolving when pause or scrub wait should wake up */
  waitForResume?: () => Promise<void>;
  /** Optional target tick to fast-forward unthrottled towards when seeking */
  getSeekTarget?: () => number | null;
  /** Callback fired when a seek target tick is reached */
  onSeekComplete?: () => void;
  /** Callback fired whenever a checkpoint is reached */
  onCheckpoint?: (checkpoint: ReplayCheckpointEvent) => void;
  /** Callback fired for progress updates */
  onProgress?: (progress: ReplayProgressEvent) => void;
  /** Signal to pause or abort playback cleanly */
  signal?: AbortSignal;
  /** Whether to pause playback whenever a story dialogue modal or waitkey opens */
  pauseOnDialog?: () => boolean;
  /** Callback fired when auto-pausing on a dialogue screen */
  onDialogPause?: () => void;
  /** Async function resolving after the calculated dialogue dwell duration or on early user advance */
  dwellOnDialog?: (ms: number) => Promise<void>;
}

export interface ReplayAdvanceOptions {
  sessionId?: number;
  seeking?: boolean;
  renderFinal?: boolean;
}

export interface ReplayDriver {
  sessionId?: number;
  latest: ReplayObservation | null;
  status?: ReplayStatus;
  advance(ticks: number, options?: ReplayAdvanceOptions): Promise<ReplayObservation>;
  waitForRevision?(
    minRevision: number,
    options?: { unblocked?: boolean },
  ): Promise<ReplayObservation>;
  playBatch(
    actions: readonly ReplayAction[],
    options?: ReplayBatchOptions,
  ): Promise<ReplayBatchResult>;
}
