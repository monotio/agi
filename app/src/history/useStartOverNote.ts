/**
 * The "Started over." note and its Undo start over, shown after a Start
 * over that left earlier sessions on the timeline. It lasts until the
 * player has actually started the new run: through the title and intro
 * screens until their first input to the game, then for ten seconds of
 * running game time. Game time is counted in interpreter cycles at the
 * game's own cycle delay, so a pause, a dialog or the open map (which all
 * stop the cycle) freeze the countdown. Entering another room after that
 * first input, dismissing it, or using it closes it sooner. Afterwards the
 * timeline's Started over mark is the way back.
 */
import { TIMER_INCREMENT_MS } from "../../../src/runtime/cycleClock.ts";
import type { RoomTransitionNotice } from "../worker/workerProtocol.ts";

/** Running game time the note stays for after the player's first input. */
export const START_OVER_NOTE_MS = 10_000;

/**
 * Game time one cycle stands for: v10 twentieths of a second, or one host
 * poll when the delay is zero (docs/fidelity.md, "Original scheduler and
 * modal timing").
 */
function cycleMs(delay: number): number {
  return delay > 0 ? delay * TIMER_INCREMENT_MS : 1000 / 60;
}

export function useStartOverNote(state: { startOverNote: boolean }) {
  /** Waiting for the first input, then counting game time; null while hidden. */
  let phase: "waiting" | "counting" | null = null;
  /** The newest heartbeat's cycle count — the first input counts from it. */
  let latest: number | null = null;
  /** The cycle count the countdown last measured from. */
  let from: number | null = null;
  let played = 0;

  function show(): void {
    state.startOverNote = true;
    phase = "waiting";
    from = null;
    played = 0;
  }

  /** Also called when the worker is replaced: its last heartbeat is forgotten. */
  function hide(): void {
    state.startOverNote = false;
    phase = null;
    latest = null;
  }

  /** The player's first key, click or command starts the countdown. */
  function noteInput(): void {
    if (phase !== "waiting") return;
    phase = "counting";
    from = latest;
  }

  /** The worker's cycle heartbeat: completed cycles and the cycle delay (v10). */
  function observeCycle(report: { cycle: number; delay: number }): void {
    latest = report.cycle;
    if (phase !== "counting") return;
    if (from !== null) played += Math.max(0, report.cycle - from) * cycleMs(report.delay);
    from = report.cycle;
    if (played >= START_OVER_NOTE_MS) hide();
  }

  /**
   * A room transition: once the player has started, entering another room
   * closes the note. Rooms the title and intro pass through before the
   * first input keep it, as does a remix re-entering the same room.
   */
  function observeRoom(transition: Pick<RoomTransitionNotice, "from" | "to" | "cause">): void {
    if (phase !== "counting") return;
    if (transition.cause === "boot" || transition.cause === "reenter") return;
    if (transition.to !== transition.from) hide();
  }

  return { show, hide, noteInput, observeCycle, observeRoom };
}
