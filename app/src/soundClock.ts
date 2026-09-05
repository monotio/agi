/** Elapsed-time source for asynchronous AGI sound ticks, independent of logic cycles. */
export class SoundClock {
  private previous: number;
  private remainder = 0;

  constructor(now: number) {
    this.previous = now;
  }

  reset(now: number): void {
    this.previous = now;
    this.remainder = 0;
  }

  /** Return whole 60Hz ticks since the previous observation, preserving fractions. */
  advance(now: number, paused = false): number {
    const elapsed = Math.max(0, now - this.previous);
    this.previous = now;
    if (paused) return 0;
    // Keep units in milliseconds * 60 to avoid rounding every timer callback.
    const total = this.remainder + elapsed * 60;
    const ticks = Math.floor((total + 1e-7) / 1000);
    this.remainder = Math.max(0, total - ticks * 1000);
    return ticks;
  }
}
