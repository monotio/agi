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

export interface CompositeInput {
  /** 160x168 visual nibbles. */
  visual: Uint8Array;
  /** 40x25 [char, attr] cells; char 0 is transparent. */
  text: Uint8Array;
  /** Text row at which picture row 0 is presented (configure.screen). */
  picRow: number;
}

/** Fill `out` (320*200*4 bytes) with the composed frame. */
export function compositeFrame(input: CompositeInput, out: Uint8ClampedArray | Uint8Array): void {
  out.fill(0);
  // Picture band: each logical pixel doubled horizontally.
  const top = input.picRow * 8;
  for (let py = 0; py < PIC_HEIGHT; py++) {
    const y = top + py;
    if (y < 0 || y >= FRAME_HEIGHT) continue;
    const src = py * PIC_WIDTH;
    let o = y * FRAME_WIDTH * 4;
    for (let px = 0; px < PIC_WIDTH; px++) {
      const [r, g, b] = EGA_PALETTE[input.visual[src + px]! & 0x0f]!;
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
  // Opaque text cells on top.
  for (let row = 0; row < TEXT_ROWS; row++) {
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
