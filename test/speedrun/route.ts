import type { EngineStateReport } from "../../src/runtime/engine.ts";
import type { Speedrun } from "./runner.ts";

/** Observable endpoint shared by the Node, CLI and browser walkthrough runners. */
export interface WalkthroughOutcome {
  state: EngineStateReport;
  egoView: number;
}

/**
 * One catalog entry. Each game module owns its entry so routes evolve without
 * touching the shared catalog; `walkthroughs.ts` only lists them.
 */
export interface Walkthrough {
  hash: string;
  alias: string;
  label: string;
  coverage: "complete-game" | "chapter" | "partial";
  /**
   * The host RNG seed the route is tuned to — the interpreter's 16-bit
   * stream makes each seed a different roll of every timed and wandering
   * event. Defaults to 1.
   */
  seed?: number;
  route(run: Speedrun): void;
  expected: {
    room: number;
    score?: number;
    vars?: Readonly<Record<number, number>>;
    flags?: Readonly<Record<number, number>>;
    carried?: readonly number[];
    carriedExactly?: readonly number[];
    inputEnabled?: boolean;
    egoView?: number;
  };
  requiresAnswer?: boolean;
}
