/**
 * Frame compositor: the engine's 160x168 visual buffer and 40x25 text
 * surface become one 320x200 RGBA frame, exactly the EGA presentation the
 * spec describes (a text column is four logical picture pixels, a text row
 * eight logical rows; the display base row offsets the picture).
 *
 * Both presentation paths draw this same frame: the three.js stage uploads
 * it as a texture, the Canvas2D fallback (and the Playwright pixel probe)
 * putImageData it.
 */
import { EGA_PALETTE } from "./palette.ts";
import { FONT } from "./font8x8.ts";
import { TEXT_COLS, TEXT_ROWS } from "../../src/runtime/textSurface.ts";

export const FRAME_WIDTH = 320;
export const FRAME_HEIGHT = 200;
const PIC_WIDTH = 160;
const PIC_HEIGHT = 168;

/**
 * Inspector view modes. "visual" is the game; "priority" shows the priority
 * surface exactly as Sierra's show.pri.screen did (priority values in EGA);
 * "blend" washes a depth ramp over the game with control lines (0-3) hatched
 * hot; "split" is a visual/priority wipe at `splitAt` of the picture width.
 * The exploded layer view is GPU-only (see three/AgiStage.ts).
 */
export type ScreenViewMode = "visual" | "priority" | "blend" | "split";

/**
 * Blend-mode tints: control lines 0-3 read as hot signals, depth bands 4-15
 * run a cool-to-warm ramp so nearer (higher) priority reads brighter.
 */
const PRIORITY_TINTS: readonly [number, number, number][] = [
  [0xff, 0x40, 0x40],
  [0xff, 0xb0, 0x20],
  [0x40, 0xe0, 0x60],
  [0x40, 0xa0, 0xff],
  [0x30, 0x30, 0xb0],
  [0x30, 0x48, 0xc8],
  [0x30, 0x60, 0xd8],
  [0x28, 0x78, 0xe0],
  [0x28, 0x90, 0xe8],
  [0x30, 0xa8, 0xd8],
  [0x48, 0xc0, 0xb8],
  [0x70, 0xd0, 0x90],
  [0xa0, 0xd8, 0x68],
  [0xd0, 0xd0, 0x50],
  [0xf0, 0xb8, 0x40],
  [0xff, 0x90, 0x30],
];

export interface CompositeInput {
  /** 160x168 visual nibbles. */
  visual: Uint8Array;
  /** 160x168 priority nibbles; required by the debug view modes. */
  priority?: Uint8Array | undefined;
  /** 40x25 [char, attr] cells; char 0 is transparent. */
  text: Uint8Array;
  /** Text row at which picture row 0 is presented (configure.screen). */
  picRow: number;
}

/**
 * Fill `out` (320*200*4 bytes) with the composed frame. `text` selects how
 * the text surface participates: "compose" (default) merges cells over the
 * picture; "skip" leaves the picture only (the exploded GPU view, which draws
 * text on its own front plane so dialogs don't smear across depth layers);
 * "only" renders just text cells — glyph pixels opaque, everything else
 * transparent — for that front plane's texture.
 */
export function compositeFrame(
  input: CompositeInput,
  out: Uint8ClampedArray | Uint8Array,
  mode: ScreenViewMode = "visual",
  splitAt = 0.5,
  text: "compose" | "skip" | "only" = "compose",
): void {
  out.fill(0);
  const priority = mode === "visual" ? undefined : input.priority;
  const splitX = Math.round(Math.min(Math.max(splitAt, 0), 1) * PIC_WIDTH);
  // Picture band: each logical pixel doubled horizontally.
  const top = input.picRow * 8;
  for (let py = 0; text !== "only" && py < PIC_HEIGHT; py++) {
    const y = top + py;
    if (y < 0 || y >= FRAME_HEIGHT) continue;
    const src = py * PIC_WIDTH;
    let o = y * FRAME_WIDTH * 4;
    for (let px = 0; px < PIC_WIDTH; px++) {
      const i = src + px;
      let [r, g, b] = EGA_PALETTE[input.visual[i]! & 0x0f]!;
      if (mode === "priority") {
        [r, g, b] = EGA_PALETTE[(priority?.[i] ?? 15) & 0x0f]!;
      } else if (mode === "split") {
        if (px === splitX || px === splitX + 1) {
          r = g = b = 0xff;
        } else if (px > splitX) {
          [r, g, b] = EGA_PALETTE[(priority?.[i] ?? 15) & 0x0f]!;
        }
      } else if (mode === "blend") {
        const pri = (priority?.[i] ?? 15) & 0x0f;
        const [tr, tg, tb] = PRIORITY_TINTS[pri]!;
        // Control lines get a parity hatch on top of a stronger wash.
        const a = pri <= 3 ? 0.55 + (((px + py) & 1) === 0 ? 0.25 : 0) : 0.34;
        r = Math.round(r * (1 - a) + tr * a);
        g = Math.round(g * (1 - a) + tg * a);
        b = Math.round(b * (1 - a) + tb * a);
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
      out[o + 4] = r;
      out[o + 5] = g;
      out[o + 6] = b;
      out[o + 7] = 255;
      o += 8;
    }
  }
  // Opaque text cells on top. In "only" mode the picture stayed transparent,
  // so written cells (window backgrounds included) are the sole opaque pixels.
  for (let row = 0; text !== "skip" && row < TEXT_ROWS; row++) {
    for (let col = 0; col < TEXT_COLS; col++) {
      const at = (row * TEXT_COLS + col) * 2;
      const ch = input.text[at]!;
      if (ch === 0) continue;
      const a = input.text[at + 1]!;
      const fg = EGA_PALETTE[a & 0x0f]!;
      const bg = EGA_PALETTE[(a >> 4) & 0x0f]!;
      for (let gy = 0; gy < 8; gy++) {
        const bits = FONT[ch * 8 + gy]!;
        let o = ((row * 8 + gy) * FRAME_WIDTH + col * 8) * 4;
        for (let gx = 0; gx < 8; gx++) {
          const c = bits & (0x80 >> gx) ? fg : bg;
          out[o] = c[0];
          out[o + 1] = c[1];
          out[o + 2] = c[2];
          out[o + 3] = 255;
          o += 4;
        }
      }
    }
  }
}
