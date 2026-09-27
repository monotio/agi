/**
 * Phone keyboards shrink the visible viewport without changing the page's
 * layout width. The game is sized from the tallest visible height seen at the
 * current width, so opening the keyboard never shrinks the screen; a width
 * change (rotation) starts over.
 */
export interface ViewportLayout {
  readonly width: number;
  /** The tallest visible height at this width. */
  readonly height: number;
  /** The visible height is well below it: an on-screen keyboard is up. */
  readonly keyboard: boolean;
}

/** A keyboard takes far more than browser chrome settling (about 60 px). */
const KEYBOARD_PX = 150;

export function nextViewportLayout(
  previous: ViewportLayout | null,
  width: number,
  visible: number,
): ViewportLayout {
  const height =
    previous && previous.width === width ? Math.max(previous.height, visible) : visible;
  return { width, height, keyboard: height - visible > KEYBOARD_PX };
}

/** The composed frame every interpreter profile draws: 320×200 cells of the 40×25 text grid. */
const FRAME_WIDTH = 320;

/** Below two whole steps a fixed 1× screen wastes most of the stage, so it fits fluidly. */
const MIN_INTEGER_SCALE = 2;

/**
 * A whole step keeps the screen only while it fills this share of the area
 * the largest fit would cover. Below it — 2× in a 780-pixel column fills 67% —
 * the screen takes the largest fit instead: at 2× and up nearest-neighbour
 * scaling stays crisp, and a small screen floating in a large stage does not.
 */
const MIN_WHOLE_STEP_FILL = 0.8;

/**
 * The desktop stage, in Play and in Create's centre column alike: the largest
 * whole multiple of the 320-pixel frame width whose screen fits the space left
 * by the top bar and transport strip, as long as it fills most of what fits.
 * With square pixels (ratio 1.6) every frame pixel becomes an exact k×k block;
 * the Original 4:3 option (ratio 4/3) stretches the height by 6/5, as the
 * monitors of the day did. A stage too small for 2×, or one where the whole
 * step would leave too much of it empty, fits the screen fluidly instead.
 */
export function stageScreenWidth(
  available: number,
  availableHeight: number,
  ratio: number,
): number {
  const fit = Math.floor(Math.max(0, Math.min(available, availableHeight * ratio)));
  const whole = Math.floor(fit / FRAME_WIDTH) * FRAME_WIDTH;
  const fill = fit > 0 ? (whole / fit) ** 2 : 0;
  if (whole >= MIN_INTEGER_SCALE * FRAME_WIDTH && fill >= MIN_WHOLE_STEP_FILL) return whole;
  return fit;
}
