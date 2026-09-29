/**
 * Start over: throw away the game's checkpoint and boot it from the top.
 * useEngine wires the dependencies; the flow lives here so its refusal can
 * be driven with a real pause-hold set and a real history seal.
 */
import type { LlmConfig } from "../agent/llmClient.ts";
import type { BootedGame } from "../project/gameTypes.ts";
import type { EngineState } from "./useEngineTypes.ts";

export interface StartOverDeps {
  readonly state: Pick<EngineState, "phase">;
  readonly getBootedGame: () => BootedGame | null;
  readonly getWorker: () => Worker | null;
  /** Seal the running session's timeline (useGameLifecycle.sealHistory). */
  readonly sealHistory: () => Promise<void>;
  /** Wait out history commits already in flight, sealing nothing more. */
  readonly drainHistoryCommits: () => Promise<void>;
  readonly pauseEngine: (owner: string) => void;
  readonly resumeEngine: (owner: string) => void;
  /** The game's timeline already holds a session Undo start over can return to. */
  readonly hasEarlierSession: (targetKey: string) => Promise<boolean>;
  /** Tell the timeline the next fresh boot is a Start over (false: none came). */
  readonly expectStartOver: (expected?: boolean) => void;
  /** Clear the checkpoint and boot afresh (useAutosaveController.startOver). */
  readonly bootFresh: (targetKey: string, config: LlmConfig) => Promise<void>;
  /** Offer Undo start over. */
  readonly showNote: () => void;
}

export function createStartOver(deps: StartOverDeps) {
  /**
   * Start over, and when the game's timeline already holds a session to go
   * back to, the note that offers Undo start over. A running session is
   * sealed first, as Exit seals it, so Undo returns to its last moment; the
   * check then reads the tape before the fresh boot adds its own segment.
   *
   * A seal that fails refuses Start over as it refuses Exit: the checkpoint
   * and the worker are untouched, only this call's pause hold is released
   * (a game the player paused stays paused), and the HistoryUnsavedError
   * reaches the caller. `abandonHistory` starts over without the unsaved
   * tail, as `ejectGame({ abandonHistory: true })` leaves without it.
   */
  return async function startOver(
    targetKey: string,
    config: LlmConfig,
    options?: { abandonHistory?: boolean },
  ): Promise<void> {
    const running = deps.getBootedGame() !== null ? deps.getWorker() : null;
    if (running) {
      deps.pauseEngine("startOver");
      try {
        if (options?.abandonHistory) await deps.drainHistoryCommits();
        else await deps.sealHistory();
      } catch (error) {
        deps.resumeEngine("startOver");
        throw error;
      }
    }
    const earlier = await deps.hasEarlierSession(targetKey);
    // Only this tab knows the fresh boot it is about to make is a Start over.
    deps.expectStartOver();
    await deps.bootFresh(targetKey, config);
    const rebooted = deps.getWorker() !== running && deps.state.phase !== "error";
    if (!rebooted) deps.expectStartOver(false);
    // No boot replaced the sealed worker: it plays on under a new segment.
    if (running && deps.getWorker() === running) deps.resumeEngine("startOver");
    if (earlier && deps.state.phase !== "error" && deps.getBootedGame() !== null) deps.showNote();
  };
}
