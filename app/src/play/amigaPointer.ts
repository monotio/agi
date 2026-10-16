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

/** RGBA pixels of the arrow at `scale` (nearest neighbour), `16·scale` square. */
export function amigaPointerRgba(scale: number): Uint8ClampedArray<ArrayBuffer> {
  const size = AMIGA_POINTER_SIZE * scale;
  const out = new Uint8ClampedArray(new ArrayBuffer(size * size * 4));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = COLOURS[ARROW[Math.floor(y / scale)]![Math.floor(x / scale)]!];
      if (!c) continue;
      const o = (y * size + x) * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
    }
  }
  return out;
}

const cursors = new Map<number, string>();

/**
 * A CSS `cursor` value showing the arrow at the given integer scale (1..8,
 * browsers cap cursor images at 128 px), or undefined where canvases are
 * unavailable. Cached per scale.
 */
export function amigaPointerCursor(scale: number): string | undefined {
  const s = Math.max(1, Math.min(8, Math.round(scale)));
  const cached = cursors.get(s);
  if (cached) return cached;
  if (typeof document === "undefined") return undefined;
  const size = AMIGA_POINTER_SIZE * s;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.putImageData(new ImageData(amigaPointerRgba(s), size, size), 0, 0);
  const value = `url(${canvas.toDataURL("image/png")}) ${AMIGA_POINTER_HOTSPOT.x * s} ${AMIGA_POINTER_HOTSPOT.y * s}, auto`;
  cursors.set(s, value);
  return value;
}
