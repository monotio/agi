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

/**
 * Active 320×200 image, separate from the monitor's blank border. NTSC/EGA
 * pixels have width:height 5:6; PAL Amiga pixels 16:15. The Amiga opens a
 * 200-line window even on a PAL display (docs/fidelity.md "Display geometry").
 */
export function displayAspect(
  profile: string | null,
  region: "ntsc" | "pal",
  monitorShape: boolean,
): number {
  if (!monitorShape) return 8 / 5;
  return profile?.startsWith("amiga-") && region === "pal" ? 128 / 75 : 4 / 3;
}

/** The `--game-ratio` and `--game-aspect` custom properties for one display aspect. */
export function gameAspectStyle(ratio: number): Record<"--game-ratio" | "--game-aspect", string> {
  const aspect = ratio === 8 / 5 ? "8 / 5" : ratio === 4 / 3 ? "4 / 3" : "128 / 75";
  return { "--game-ratio": `calc(${aspect})`, "--game-aspect": aspect };
}

/** Fit the active image without allowing it to cover the controls around it. */
export function computeStageFit(
  availableWidth: number,
  availableHeight: number,
  ratio: number,
): { width: number; height: number } {
  const width = stageScreenWidth(availableWidth, availableHeight, ratio);
  return { width, height: Math.floor(width / ratio) };
}
