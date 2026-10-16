/**
 * The Amiga interpreter's mouse pointer as a CSS cursor over the game
 * screen (docs/fidelity.md "Amiga screen, font and pointer"): every Amiga
 * build loads a 16×16 three-colour hardware sprite from its `data/pointer`
 * file and shows it with SetPointer at hot spot (1, 0), in sprite colours
 * 17..19 of $d22, $000 and $fca. The arrow below is this project's own
 * drawing in those colours and metrics; the pointer position is the host's
 * mouse, so it is browser chrome rather than part of the composed frame.
 */

/** 16 rows of 16: `.` transparent, `r` red body, `k` black edge, `w` cream highlight. */
const ARROW = [
  "rk..............",
  "rrk.............",
  "rwrk............",
  "rwwrk...........",
  "rwwwrk..........",
  "rwwwwrk.........",
  "rwwwwwrk........",
  "rwwwwwwrk.......",
  "rwwwrrrrrk......",
  "rwrrwrk.........",
  "rrk.rwrk........",
  "rk...rwrk.......",
  "......rwrk......",
  ".......rrk......",
  "........k.......",
  "................",
];

const COLOURS: Record<string, [number, number, number]> = {
  r: [0xdd, 0x22, 0x22],
  k: [0x00, 0x00, 0x00],
  w: [0xff, 0xcc, 0xaa],
};

/** The sprite's hot spot: SetPointer offset (-1, 0) puts it one pixel into the image. */
export const AMIGA_POINTER_HOTSPOT = { x: 1, y: 0 };
export const AMIGA_POINTER_SIZE = 16;
/** Browsers cap cursor images at 128 px. */
const MAX_CURSOR_PX = 128;

export interface PointerSize {
  width: number;
  height: number;
  hotX: number;
  hotY: number;
}

/**
 * The cursor image for a screen whose pixels are `sx` wide and `sy` high
 * per frame pixel: the whole sprite scaled by each factor and rounded to
 * whole pixels, the hot spot scaled the same way, each side capped at
 * 128 px.
 */
export function amigaPointerSize(sx: number, sy: number): PointerSize {
  const width = Math.max(1, Math.min(MAX_CURSOR_PX, Math.round(AMIGA_POINTER_SIZE * sx)));
  const height = Math.max(1, Math.min(MAX_CURSOR_PX, Math.round(AMIGA_POINTER_SIZE * sy)));
  return {
    width,
    height,
    hotX: Math.min(width - 1, Math.round((AMIGA_POINTER_HOTSPOT.x * width) / AMIGA_POINTER_SIZE)),
    hotY: Math.min(height - 1, Math.round((AMIGA_POINTER_HOTSPOT.y * height) / AMIGA_POINTER_SIZE)),
  };
}

/** RGBA pixels of the arrow resampled (nearest neighbour) to `width` × `height`. */
export function amigaPointerRgba(width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  for (let y = 0; y < height; y++) {
    const row = ARROW[Math.floor((y * AMIGA_POINTER_SIZE) / height)]!;
    for (let x = 0; x < width; x++) {
      const c = COLOURS[row[Math.floor((x * AMIGA_POINTER_SIZE) / width)]!];
      if (!c) continue;
      const o = (y * width + x) * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
    }
  }
  return out;
}

const cursors = new Map<string, string>();

/**
 * A CSS `cursor` value showing the arrow scaled like the frame's pixels
 * (`amigaPointerSize`), or undefined where canvases are unavailable.
 * Cached per image size.
 */
export function amigaPointerCursor(sx: number, sy: number): string | undefined {
  const { width, height, hotX, hotY } = amigaPointerSize(sx, sy);
  const key = `${width}x${height}`;
  const cached = cursors.get(key);
  if (cached) return cached;
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.putImageData(new ImageData(amigaPointerRgba(width, height), width, height), 0, 0);
  const value = `url(${canvas.toDataURL("image/png")}) ${hotX} ${hotY}, auto`;
  cursors.set(key, value);
  return value;
}
