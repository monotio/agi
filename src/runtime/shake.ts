import type { AgiProfile } from "./profile.ts";

/**
 * shake.screen per platform (docs/fidelity.md "Original shake.screen and picture reveal"). The
 * action blocks the interpreter while timer services keep running. Each step
 * shows the whole 320x200 display displaced by (dx, dy) screen pixels, with
 * black where nothing is shown, or (IIgs) recolours it with sixteen random
 * colours. A step lasts until the next timer tick, or a fixed time on PC EGA,
 * whose page flips wait on vertical retraces.
 */
export interface ShakePlan {
  /** Steps per unit of the operand. */
  readonly stepsPerUnit: number;
  /** Fixed step length in milliseconds, or null when a step ends at the next timer tick. */
  readonly stepMs: number | null;
  /** Displacement of step i is offsets[i % offsets.length]. */
  readonly offsets: readonly (readonly [number, number])[];
  /** Whether each step replaces the palette with sixteen RNG colours (IIgs). */
  readonly randomPalette: boolean;
}

/** PC EGA: page 1 holds the screen 8 px right and 4 lines down; 4 retraces per page. */
const PC_EGA: ShakePlan = {
  stepsPerUnit: 8,
  stepMs: 4000 / 60,
  offsets: [
    [8, 4],
    [0, 0],
  ],
  randomPalette: false,
};

/** 2.001 booter EGA: four diagonal copies per unit, one BIOS tick each. */
const BOOTER_EGA: ShakePlan = {
  stepsPerUnit: 4,
  stepMs: null,
  offsets: [
    [8, 4],
    [-8, -4],
    [-8, 4],
    [8, -4],
  ],
  randomPalette: false,
};

/** Amiga: ViewPort DxOffset/DyOffset by ten lores pixels and lines, one timer tick each. */
const AMIGA: ShakePlan = {
  stepsPerUnit: 5,
  stepMs: null,
  offsets: [
    [10, 10],
    [-10, 10],
    [10, -10],
    [-10, -10],
    [0, 0],
  ],
  randomPalette: false,
};

/** IIgs: colour table 0 gets sixteen random colours per timer tick; nothing moves. */
const IIGS: ShakePlan = {
  stepsPerUnit: 5,
  stepMs: null,
  offsets: [[0, 0]],
  randomPalette: true,
};

export function shakePlan(profile: Pick<AgiProfile, "presentation" | "frameTiming">): ShakePlan {
  if (profile.presentation === "amiga") return AMIGA;
  if (profile.presentation === "iigs") return IIGS;
  return profile.frameTiming === "booter-int1c" ? BOOTER_EGA : PC_EGA;
}

/** The IIgs shake colour for one RNG byte: (r * 17) & 0xfff as a 12-bit $0RGB word. */
export function iigsShakeColour(byte: number): number {
  return (byte * 17) & 0xfff;
}

/** What the display shows during a shake step. */
export interface ShakeFrame {
  /** Displacement in 320x200 screen pixels; uncovered edges are black. */
  readonly dx: number;
  readonly dy: number;
  /** Sixteen IIgs 12-bit colours replacing the palette, or null. */
  readonly palette: readonly number[] | null;
}
