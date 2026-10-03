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

/** Largest aspect-correct screen that fits the stage's available width and height. */
export function stageScreenWidth(
  available: number,
  availableHeight: number,
  ratio: number,
): number {
  return Math.floor(Math.max(0, Math.min(available, availableHeight * ratio)));
}
