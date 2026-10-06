import { PSG_BASE_FREQ } from "./sound.ts";

export type PsgChip = "sn76489" | "sn76496" | "ncr8496" | "pssj3";

// Bit 0 is the output. Width includes the output delay stages after the
// 15-stage feedback ring. See docs/fidelity.md, "PCjr and Tandy noise".
const CHIPS: Record<PsgChip, { width: number; tap: number; xnor: boolean; sign: number }> = {
  sn76489: { width: 15, tap: 1, xnor: false, sign: -1 },
  sn76496: { width: 17, tap: 3, xnor: false, sign: 1 },
  ncr8496: { width: 16, tap: 5, xnor: true, sign: -1 },
  pssj3: { width: 16, tap: 5, xnor: true, sign: 1 },
};

export class PsgNoise {
  output = 0;
  readonly chip: PsgChip;
  private control = 0;
  private state: number;
  constructor(chip: PsgChip) {
    this.chip = chip;
    this.state = 1 << (CHIPS[chip].width - 1);
  }
  /** TI resets on every write; NCR resets when white/periodic changes. */
  write(control: number): void {
    const spec = CHIPS[this.chip];
    if (!spec.xnor || ((control ^ this.control) & 4) !== 0) this.state = 1 << (spec.width - 1);
    this.control = control & 7;
  }
  shift(): number {
    const spec = CHIPS[this.chip];
    const first = (this.state >> (spec.width - 15)) & 1;
    const second = (this.state >> spec.tap) & 1;
    const feedback = (this.control & 4) !== 0 ? first ^ second ^ Number(spec.xnor) : first;
    this.state = (this.state >> 1) | (feedback << (spec.width - 1));
    this.output = (this.state & 1) === 0 ? 0 : spec.sign;
    return this.output;
  }

  /** Exact finite sequence, with its transient prefix outside the loop. */
  waveform(): { samples: Float32Array; loop: number } {
    const visited = new Map<number, number>();
    const samples: number[] = [];
    while (!visited.has(this.state)) {
      visited.set(this.state, samples.length);
      samples.push(this.output);
      this.shift();
    }
    return { samples: Float32Array.from(samples), loop: visited.get(this.state)! };
  }
}

export interface NoiseChange {
  readonly at: number;
  readonly index: number;
}

/** Shift counter state on the context timeline; writes preserve its pending edge. */
export class PsgNoiseClock {
  readonly chip: PsgChip;
  private control = 0;
  private divisor = 1024;
  private index = 0;
  private next: number;
  constructor(chip: PsgChip, at: number) {
    this.chip = chip;
    this.next = at + 1 / this.shiftHz;
  }
  get white(): boolean {
    return (this.control & 4) !== 0;
  }
  get shiftHz(): number {
    return (this.control & 3) === 3
      ? PSG_BASE_FREQ / this.divisor
      : (PSG_BASE_FREQ * 32) / (512 << (this.control & 3));
  }
  private advance(at: number): void {
    if (at < this.next) return;
    const count = Math.floor((at - this.next) * this.shiftHz + 1e-9) + 1;
    this.index += count;
    this.next += count / this.shiftHz;
  }
  write(control: number, at: number): NoiseChange | null {
    this.advance(at);
    control &= 7;
    const reset = !CHIPS[this.chip].xnor || ((control ^ this.control) & 4) !== 0;
    if (!reset && control === this.control) return null;
    if (reset) this.index = 0;
    this.control = control;
    return { at: this.next, index: this.index + 1 };
  }
  tone2(divisor: number, at: number): NoiseChange | null {
    this.advance(at);
    const next = divisor === 0 ? 1024 : divisor;
    if (next === this.divisor) return null;
    this.divisor = next;
    return (this.control & 3) === 3 ? { at: this.next, index: this.index + 1 } : null;
  }
}
