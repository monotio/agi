/**
 * Start over: throw away the game's checkpoint and boot it from the top.
 * useEngine wires the dependencies; the flow lives here so its refusal can
 * be driven with a real pause-hold set and a real history seal.
 */
import type { LlmConfig } from "../agent/llmClient.ts";
import type { BootedGame } from "../project/gameTypes.ts";
import type {
  SelectedProgressTarget,
  StartOverAdmission,
  StartOverOutcome,
} from "../saves/useAutosaveController.ts";
import type { EngineState } from "./useEngineTypes.ts";

export interface StartOverDeps {
  readonly state: Pick<EngineState, "phase">;
  readonly getBootedGame: () => BootedGame | null;
  readonly getWorker: () => Worker | null;
  /**
   * The running worker-session incarnation (useEngine's session counter):
   * every boot moves it, so a superseding boot that reuses a worker shape
   * still supersedes a parked call. Absent deps skip the session fence.
   */
  readonly getSessionId?: () => number;
  /** Seal the running session's timeline (useGameLifecycle.sealHistory). */
  readonly sealHistory: () => Promise<void>;
  /** Wait out history commits already in flight, sealing nothing more. */
  readonly drainHistoryCommits: () => Promise<void>;
  readonly pauseEngine: (owner: string) => void;
  readonly resumeEngine: (owner: string) => void;
  /**
   * Prove the physical target the selection names while the captured game
   * still owns the slot (useAutosaveController.selectProgressTarget): a
   * locator resolves by digest/epoch evidence, a released spelling through
   * the running game's bound target or the single instance it resolves to.
   * Null refuses the call before anything is paused or cleared. Absent deps
   * fall back to the released spelling as the read key.
   */
  readonly selectTarget?: (
    targetKey: string,
    booted: BootedGame | null,
  ) => Promise<SelectedProgressTarget | null>;
  /** The selected target's timeline already holds a session Undo start over can return to. */
  readonly hasEarlierSession: (targetLocator: string) => Promise<boolean>;
  /**
   * Load the timeline view before marking. Start over from Home can run before
   * any game has played on this page, when the view does not exist yet.
   */
  readonly prepareTimeline?: () => Promise<void>;
  /** Tell the timeline the next fresh boot is a Start over (false: none came). */
  readonly expectStartOver: (expected?: boolean) => void;
  /**
   * Clear the selected checkpoint and boot afresh
   * (useAutosaveController.startOver). `admission` is re-run inside the boot
   * after its last awaited binding step; a typed outcome reports completed,
   * refused or superseded — a legacy dep resolves void and the worker swap
   * itself is the boot's evidence, exactly as before.
   */
  readonly bootFresh: (
    targetKey: string,
    config: LlmConfig,
    admission?: StartOverAdmission,
  ) => Promise<StartOverOutcome | void>;
  /** Offer Undo start over. */
  readonly showNote: () => void;
}

export function createStartOver(deps: StartOverDeps) {
  /**
   * Start over, and when the game's timeline already holds a session to go
   * back to, the note that offers Undo start over. A running session is
   * sealed first, as Exit seals it, so Undo returns to its last moment; the
   * check then reads the selected target's own tape before the fresh boot
   * adds its own segment.
   *
   * The call captures its world before the first awaited admission: the
   * game in the slot, the worker its pause hold posts to, the session
   * incarnation and the selection's physical target. A replacement of any
   * captured piece — another game taking the slot, a swapped worker, a
   * moved session, a body rebound under a new epoch — supersedes the call:
   * it clears no checkpoint, moves no timeline intent, boots nothing,
   * publishes no note and releases only its own pause hold, and only while
   * the worker it took the hold on still runs. The same physical locator
   * resolving again never re-admits a superseded call.
   *
   * A seal that fails refuses Start over as it refuses Exit: the checkpoint
   * and the worker are untouched, only this call's pause hold is released
   * (a game the player paused stays paused), and the HistoryUnsavedError
   * reaches the caller — unless the call was superseded first, in which
   * case the failure stays with the world it described. `abandonHistory`
   * starts over without the unsaved tail, as `ejectGame({ abandonHistory:
   * true })` leaves without it.
   */
  return async function startOver(
    targetKey: string,
    config: LlmConfig,
    options?: { abandonHistory?: boolean },
  ): Promise<void> {
    const game = deps.getBootedGame();
    const running = game !== null ? deps.getWorker() : null;
    const session = deps.getSessionId?.();
    const stillOwner = (): boolean =>
      deps.getSessionId?.() === session &&
      deps.getBootedGame() === game &&
      deps.getWorker() === running;
    const releaseOwnHold = (): void => {
      if (running !== null && deps.getWorker() === running) deps.resumeEngine("startOver");
    };
    // The physical target the selection names, proven before the seal and
    // the tape read — a missing or ambiguous selection refuses with nothing
    // paused and nothing cleared.
    const selected =
      deps.selectTarget !== undefined ? await deps.selectTarget(targetKey, game) : undefined;
    if (selected === null || !stillOwner()) return;
    const targetLocator = selected?.locator ?? targetKey;
    if (running) {
      deps.pauseEngine("startOver");
      try {
        if (options?.abandonHistory) await deps.drainHistoryCommits();
        else await deps.sealHistory();
      } catch (error) {
        releaseOwnHold();
        if (!stillOwner()) return;
        throw error;
      }
      if (!stillOwner()) {
        releaseOwnHold();
        return;
      }
    }
    const earlier = await deps.hasEarlierSession(targetLocator);
    if (!stillOwner()) {
      releaseOwnHold();
      return;
    }
    try {
      await deps.prepareTimeline?.();
    } catch (error) {
      releaseOwnHold();
      if (!stillOwner()) return;
      throw error;
    }
    if (!stillOwner()) {
      releaseOwnHold();
      return;
    }
    // Only this tab knows the fresh boot it is about to make is a Start over.
    deps.expectStartOver();
    let outcome: StartOverOutcome | void;
    try {
      outcome = await deps.bootFresh(targetKey, config, {
        admitted: (resolved) =>
          stillOwner() && resolved !== null && resolved.locator === targetLocator,
      });
    } catch (error) {
      // The boot never landed: withdraw this call's intent mark and release
      // its own pause hold — only while the captured world still owns the
      // slot — then let the failure reach the caller. A superseded call
      // leaves the newer owner's mark and holds alone.
      if (stillOwner()) deps.expectStartOver(false);
      releaseOwnHold();
      throw error;
    }
    // Revalidate the landed game against the captured target: a booted game
    // carrying a binding must carry the same physical locator, so a slot
    // that moved to another game behind the boot never collects this call's
    // note. An unbound one only has the worker swap to speak for it, as
    // before; without a target resolver the spelling itself is all there is.
    const landed = deps.getBootedGame();
    const ours =
      landed !== null &&
      (selected === undefined ||
        landed.progressTarget === undefined ||
        landed.progressTarget.locator === targetLocator);
    const rebooted =
      (outcome === undefined || outcome.status === "completed") &&
      ours &&
      deps.getWorker() !== running &&
      deps.state.phase !== "error";
    // Retract the intent this call marked — unless the slot already belongs
    // to a newer owner, whose own start-over mark is not ours to clear. A
    // supersession inside a still-owned world (the captured target's body
    // was replaced, the same game object still in the slot) retracts as a
    // refusal does.
    if (!rebooted && (outcome?.status !== "superseded" || stillOwner())) {
      deps.expectStartOver(false);
    }
    // No boot replaced the sealed worker: it plays on under a new segment.
    releaseOwnHold();
    if (rebooted && earlier) deps.showNote();
  };
}
