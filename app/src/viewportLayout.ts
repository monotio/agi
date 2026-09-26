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
 * The desktop stage: the largest whole multiple of the 320-pixel frame width
 * whose screen fits the space left by the top bar and transport strip. With
 * square pixels (ratio 1.6) every frame pixel becomes an exact k×k block; the
 * Original 4:3 option (ratio 4/3) keeps the width a whole multiple and
 * stretches the height by 6/5, as the monitors of the day did. A stage too
 * small for 2× fits the screen fluidly instead.
 */
export function stageScreenWidth(
  available: number,
  availableHeight: number,
  ratio: number,
): number {
  const width = Math.max(0, available);
  const height = Math.max(0, availableHeight);
  const scale = Math.floor(Math.min(width / FRAME_WIDTH, (height * ratio) / FRAME_WIDTH));
  if (scale >= MIN_INTEGER_SCALE) return scale * FRAME_WIDTH;
  return Math.floor(Math.min(width, height * ratio));
}
