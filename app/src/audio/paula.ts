/** PAL colour clock and OCS DMA limit; see docs/fidelity.md, "Paula onset and A500 output". */
export const PAULA_CLOCK = 3546895;
export const PAULA_MIN_PERIOD = 124;

/** A500 rev 6a/7 analogue components, with the power LED bright. */
export const PAULA_LED_FILTER = {
  frequency: 1 / (2 * Math.PI * 10000 * Math.sqrt(6.8e-9 * 3.9e-9)),
  q: Math.sqrt(6.8e-9 * 3.9e-9) / (2 * 3.9e-9),
};

/** Bilinear transform of the always-connected 360 ohm / 0.1 uF RC stage. */
export function paulaRcCoefficients(sampleRate: number): {
  feedforward: number[];
  feedback: number[];
} {
  const k = 2 * sampleRate * 360 * 0.1e-6;
  return { feedforward: [1 / (1 + k), 1 / (1 + k)], feedback: [1, (1 - k) / (1 + k)] };
}

/** Byte position and period reload boundary; setting an enabled DMA bit keeps phase. */
export class PaulaClock {
  private period: number | null = null;
  private at = 0;
  private byte = 0;

  write(period: number, at: number): { at: number; byte: number; restart: boolean } {
    const restart = this.period === null;
    if (this.period !== null) {
      const steps = Math.max(0, Math.ceil(((at - this.at) * PAULA_CLOCK) / this.period - 1e-8));
      this.byte += steps;
      this.at += (steps * this.period) / PAULA_CLOCK;
    } else {
      this.byte = 0;
      this.at = at;
    }
    this.period = period === 0 ? 65536 : Math.max(PAULA_MIN_PERIOD, period);
    return { at: this.at, byte: this.byte, restart };
  }

  disable(): void {
    this.period = null;
  }
}
