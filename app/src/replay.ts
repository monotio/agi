import type { EngineStateReport } from "../../src/runtime/engine.ts";

/** Test-only clock observations. The replay driver cannot write interpreter state. */
export interface ReplayObservation {
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
  phone?: boolean;
  /** Speed multiplier for real-time watching: 1 = 1x real time, 2 = 2x, etc. 0 = unthrottled fast-forward (default) */
  speed?: number | (() => number);
  /** Callback fired whenever a checkpoint is reached */
  onCheckpoint?: (checkpoint: ReplayCheckpointEvent) => void;
  /** Callback fired for progress updates */
  onProgress?: (progress: ReplayProgressEvent) => void;
  /** Signal to pause or abort playback cleanly */
  signal?: AbortSignal;
}

export interface ReplayDriver {
  latest: ReplayObservation | null;
  advance(ticks: number): Promise<ReplayObservation>;
  waitForRevision?(minRevision: number): Promise<ReplayObservation>;
  playBatch(
    actions: readonly ReplayAction[],
    options?: ReplayBatchOptions,
  ): Promise<ReplayBatchResult>;
}
