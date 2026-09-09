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

export interface ReplayDriver {
  latest: ReplayObservation | null;
  advance(ticks: number): Promise<ReplayObservation>;
  waitForRevision?(minRevision: number): Promise<ReplayObservation>;
  playBatch(
    actions: readonly ReplayAction[],
    options?: { phone?: boolean },
  ): Promise<ReplayBatchResult>;
}
