/**
 * AGI v10 uses 1/20-second increments, per Peter Kelly's AGI Studio reference:
 * https://agistudio.sourceforge.net/help/special_variables.html
 * The agi-re runtime-state contract specifies accumulation and counter clearing.
 */
export const TIMER_INCREMENT_MS = 50;

/** Host adapter for the pacing-counter contract in the agi-re runtime-state specification. */
export class CycleClock {
  private previous: number;
  private remainder = 0;
  private increments = 0;
  private paused = false;

  constructor(now: number) {
    if (!Number.isFinite(now)) throw new Error("Cycle clock time must be finite.");
    this.previous = now;
  }

  reset(now: number): void {
    if (!Number.isFinite(now)) throw new Error("Cycle clock time must be finite.");
    this.previous = now;
    this.remainder = 0;
    this.increments = 0;
    this.paused = false;
  }

  /**
   * Advance from monotonic host time and consume at most one due logic cycle.
   * A delayed callback clears surplus increments rather than replaying a burst.
   * Delay zero imposes no wait; the host polling rate bounds its throughput.
   * Harness pauses discard elapsed time and start a fresh period when resumed.
   */
  poll(now: number, delay: number, paused = false): boolean {
    if (!Number.isFinite(now)) throw new Error("Cycle clock time must be finite.");
    if (!Number.isInteger(delay) || delay < 0 || delay > 255)
      throw new Error("Cycle delay must be an integer from 0 to 255.");
    const monotonic = Math.max(now, this.previous);
    const elapsed = monotonic - this.previous;
    this.previous = monotonic;
    if (paused || this.paused) {
      this.remainder = 0;
      this.increments = 0;
      this.paused = paused;
      return false;
    }
    const elapsedMs = this.remainder + elapsed;
    const whole = Math.floor((elapsedMs + 1e-7) / TIMER_INCREMENT_MS);
    this.remainder = Math.max(0, elapsedMs - whole * TIMER_INCREMENT_MS);
    this.increments += whole;
    if (this.increments < delay) return false;
    this.increments = 0;
    return true;
  }
}
