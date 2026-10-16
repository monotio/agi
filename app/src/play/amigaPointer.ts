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

/**
 * RGBA pixels of the arrow scaled like the frame's pixels (nearest
 * neighbour), `16·sx` wide and `16·sy` high.
 */
export function amigaPointerRgba(sx: number, sy: number): Uint8ClampedArray<ArrayBuffer> {
  const width = AMIGA_POINTER_SIZE * sx;
  const height = AMIGA_POINTER_SIZE * sy;
  const out = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = COLOURS[ARROW[Math.floor(y / sy)]![Math.floor(x / sx)]!];
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
 * A CSS `cursor` value showing the arrow scaled like the frame's pixels:
 * `sx` and `sy` are the screen's horizontal and vertical pixels per frame
 * pixel, rounded to integers and capped at 8 (browsers cap cursor images at
 * 128 px). The hot spot scales with them. Undefined where canvases are
 * unavailable. Cached per size.
 */
export function amigaPointerCursor(sx: number, sy: number): string | undefined {
  const cx = Math.max(1, Math.min(8, Math.round(sx)));
  const cy = Math.max(1, Math.min(8, Math.round(sy)));
  const key = `${cx}x${cy}`;
  const cached = cursors.get(key);
  if (cached) return cached;
  if (typeof document === "undefined") return undefined;
  const width = AMIGA_POINTER_SIZE * cx;
  const height = AMIGA_POINTER_SIZE * cy;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.putImageData(new ImageData(amigaPointerRgba(cx, cy), width, height), 0, 0);
  const value = `url(${canvas.toDataURL("image/png")}) ${AMIGA_POINTER_HOTSPOT.x * cx} ${AMIGA_POINTER_HOTSPOT.y * cy}, auto`;
  cursors.set(key, value);
  return value;
}
