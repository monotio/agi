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

export interface ReplayDriver {
  latest: ReplayObservation | null;
  advance(ticks: number): Promise<ReplayObservation>;
}
