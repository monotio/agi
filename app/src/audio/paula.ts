/** Colour clocks; see docs/fidelity.md, "Paula onset and A500 output". */
export type AmigaRegion = "ntsc" | "pal";
export const PAULA_CLOCKS: Record<AmigaRegion, number> = { ntsc: 3579545, pal: 3546895 };
export const PAULA_MIN_PERIOD = 124;
/** Subdivide held DAC bytes for browser reconstruction; see the same fidelity entry. */
export const PAULA_HOLD_FRAMES = 32;

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

/** A500 C324/C325 and R324/R325; normalized passband keeps the host volume scale. */
export function paulaCouplingCoefficients(sampleRate: number): {
  feedforward: number[];
  feedback: number[];
} {
  const k = 2 * sampleRate * (1000 + 390) * (22 + 0.33) * 1e-6;
  return { feedforward: [k / (1 + k), -k / (1 + k)], feedback: [1, (1 - k) / (1 + k)] };
}

/** Byte position and period reload boundary; setting an enabled DMA bit keeps phase. */
export class PaulaClock {
  private period: number | null = null;
  private at = 0;
  private byte = 0;
  private startedAt = 0;
  private heldByte: number | null = null;
  private disabling: { period: number; until: number } | null = null;

  private frequency: number;

  constructor(region: AmigaRegion = "ntsc") {
    this.frequency = PAULA_CLOCKS[region];
  }

  /** Preserve the remaining fraction of the current byte when the clock changes. */
  setRegion(region: AmigaRegion, at: number): void {
    const ratio = this.frequency / PAULA_CLOCKS[region];
    this.at = at + (this.at - at) * ratio;
    if (this.disabling) this.disabling.until = at + (this.disabling.until - at) * ratio;
    this.frequency = PAULA_CLOCKS[region];
  }

  write(period: number, at: number): { at: number; byte: number; restart: boolean } {
    if (this.disabling && at < this.disabling.until) this.period = this.disabling.period;
    this.disabling = null;
    const restart = this.period === null;
    if (this.period !== null) {
      const steps = Math.max(0, Math.ceil(((at - this.at) * this.frequency) / this.period - 1e-8));
      this.byte += steps;
      this.at += (steps * this.period) / this.frequency;
    } else {
      this.byte = 0;
      this.at = at;
      this.startedAt = at;
    }
    this.period = period === 0 ? 65536 : Math.max(PAULA_MIN_PERIOD, period);
    return { at: this.at, byte: this.byte, restart };
  }

  disable(at?: number): { at: number; byte: number | null } | null {
    let held: { at: number; byte: number | null } | null = null;
    if (this.period !== null && at !== undefined) {
      if (at <= this.startedAt) {
        held = { at, byte: this.heldByte };
        this.disabling = null;
      } else {
        // Figure 5-8 exits from low-byte state 011. Finish the current word;
        // idle keeps that low byte in the DAC, with its existing volume.
        const steps = Math.max(
          0,
          Math.ceil(((at - this.at) * this.frequency) / this.period - 1e-8),
        );
        const nextByte = this.byte + steps;
        const endByte = nextByte + (nextByte & 1);
        held = {
          at: this.at + ((endByte - this.byte) * this.period) / this.frequency,
          byte: endByte - 1,
        };
        this.disabling = { period: this.period, until: held.at };
        this.heldByte = held.byte;
      }
    }
    if (at === undefined) this.disabling = null;
    this.period = null;
    return held;
  }
}
