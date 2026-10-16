import type { AgiProfile, AmigaRegion } from "./profile.ts";

/**
 * The Amiga and IIgs picture dissolve (docs/fidelity.md "Original picture
 * dissolve"). After `draw.pic`, `show.pic` copies the picture to the screen
 * in two-pixel cells (80 per row, 13,440 for 168 rows): first the cells at
 * the top left, then cell s for each state s of a 14-bit Galois shift
 * register (shift right, `eor 0x3500` on carry) from state 1 until it comes
 * back to 1, skipping states at or past the limit. The loop has no waits:
 * the interpreter blocks for as long as the CPU takes, while the timer
 * interrupt keeps the clock and sound running.
 */
export type PictureReveal = AgiProfile["showPictureReveal"];

/** Cells per picture row: each cell is two picture pixels wide. */
const CELLS_PER_ROW = 80;
const CELLS = CELLS_PER_ROW * 168;
/** Register states the loop walks: every nonzero 14-bit state, 1 last. */
const DISSOLVE_STEPS = 16383;

/**
 * 68000 cycles of the whole Amiga loop, summed over the 16,383 states from
 * the instruction timings (docs/fidelity.md "Original picture dissolve"):
 * 2.082 compares against an immediate limit, the later builds against a
 * longword in memory, and skipping two rows leaves 159 fewer states to copy.
 */
const AMIGA_LOOP_CYCLES = {
  "2.082": 5_084_134,
  full: 5_259_678,
  skip: 5_215_198,
} as const;
/**
 * The Amiga's effective rate, calibrated by MAME (a500n, NTSC): the 2.202
 * skip loop took 794.2 ms, about 9% over the bare 7.159 MHz count for bus
 * contention and interrupts. A PAL machine's CPU clock is 7.094 MHz.
 */
const AMIGA_NTSC_CYCLES_PER_MS = AMIGA_LOOP_CYCLES.skip / 794.2;
const AMIGA_PAL_CLOCK_RATIO = 7.09379 / 7.15909;
/** IIgs 1.014: MAME (apple2gsr1) measured 448.2 and 447.5 ms. */
const IIGS_DISSOLVE_MS = 447.9;

/** One dissolve: whether it skips the top two picture rows, and its length. */
export interface DissolveRun {
  readonly skipRows: boolean;
  readonly durationMs: number;
}

/**
 * The dissolve `show.pic` (or restore.game) runs now, or null when the
 * profile shows pictures at once. The Amiga loop skips picture rows 0 and 1
 * on 2.082 always, on 2.176/2.202 whenever the picture starts below row 0,
 * and on 2.310/2.316 only while the status line is also on.
 */
export function dissolveRun(
  reveal: PictureReveal,
  state: { displayBaseRow: number; statusEnabled: boolean },
  region: AmigaRegion,
): DissolveRun | null {
  if (reveal === "instant") return null;
  if (reveal === "iigs") return { skipRows: false, durationMs: IIGS_DISSOLVE_MS };
  const skipRows =
    reveal === "amiga-2.082" ||
    (state.displayBaseRow !== 0 && (reveal === "amiga-pic-top" || state.statusEnabled));
  const cycles =
    reveal === "amiga-2.082"
      ? AMIGA_LOOP_CYCLES["2.082"]
      : skipRows
        ? AMIGA_LOOP_CYCLES.skip
        : AMIGA_LOOP_CYCLES.full;
  const perMs = AMIGA_NTSC_CYCLES_PER_MS * (region === "pal" ? AMIGA_PAL_CLOCK_RATIO : 1);
  return { skipRows, durationMs: cycles / perMs };
}

/** Register states finished after `elapsedMs` of a dissolve lasting `durationMs`. */
export function dissolveSteps(elapsedMs: number, durationMs: number): number {
  if (elapsedMs >= durationMs - 1e-7) return DISSOLVE_STEPS;
  return Math.floor((elapsedMs * DISSOLVE_STEPS) / durationMs);
}

const orders = new Map<string, Uint16Array>();

/**
 * The step at which each picture cell (row * 80 + column) takes the new
 * picture: 0 for the cells copied before the loop. The Amiga copies one
 * byte of each bitplane first, two cells; the IIgs copies one word, one
 * cell. While rows 0 and 1 are skipped, state s is cell s + 160, and those
 * two rows change at once (as `show.pic` shows them here).
 */
export function dissolveOrder(reveal: PictureReveal, skipRows: boolean): Uint16Array {
  const key = `${reveal === "iigs" ? "iigs" : "amiga"}:${skipRows}`;
  const cached = orders.get(key);
  if (cached) return cached;
  const base = skipRows ? 2 * CELLS_PER_ROW : 0;
  const limit = CELLS - base;
  const order = new Uint16Array(CELLS).fill(0xffff);
  for (let cell = 0; cell <= base; cell++) order[cell] = 0;
  if (reveal !== "iigs") order[base + 1] = 0;
  let state = 1;
  for (let step = 1; step <= DISSOLVE_STEPS; step++) {
    state = (state >>> 1) ^ (state & 1 ? 0x3500 : 0);
    const cell = state + base;
    if (state < limit && order[cell] === 0xffff) order[cell] = step;
  }
  orders.set(key, order);
  return order;
}

/**
 * Overlay the cells the dissolve has not reached with the screen it started
 * from. Both buffers are 160x168 picture pixels.
 */
export function applyDissolve(
  visual: Uint8Array,
  from: Uint8Array,
  order: Uint16Array,
  steps: number,
): void {
  if (steps >= DISSOLVE_STEPS) return;
  for (let cell = 0; cell < CELLS; cell++) {
    if (order[cell]! <= steps) continue;
    const pixel = ((cell / CELLS_PER_ROW) | 0) * 160 + (cell % CELLS_PER_ROW) * 2;
    visual[pixel] = from[pixel]!;
    visual[pixel + 1] = from[pixel + 1]!;
  }
}

/** A 160x168 frame of colour nibbles as one hex digit a pixel, for checkpoints. */
export function packDissolveFrame(frame: Uint8Array): string {
  let text = "";
  for (const pixel of frame) text += (pixel & 15).toString(16);
  return text;
}

export function unpackDissolveFrame(packed: string): Uint8Array {
  if (packed.length !== CELLS * 2 || !/^[0-9a-f]*$/.test(packed))
    throw new Error("Replay dissolve frame is invalid.");
  return Uint8Array.from(packed, (digit) => parseInt(digit, 16));
}
