/**
 * The brand's wordmark as the interpreter draws text: glyphs from the
 * engine's own 8×8 font (font8x8.ts), one cell per character, no smoothing.
 * The full stop is the one accent — the cyan square that is also the app's
 * mark and favicon. Pure, so the boot card only paints what this returns.
 */
import { FONT } from "../font8x8.ts";

/** Font pixels, row-major: 0 dark, 1 lit, 2 lit accent (the full stop). */
export interface WordmarkRaster {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

const GLYPH = 8;

export function wordmarkRaster(text: string): WordmarkRaster {
  const width = text.length * GLYPH;
  const pixels = new Uint8Array(width * GLYPH);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i) & 0xff;
    const ink = text[i] === "." ? 2 : 1;
    for (let y = 0; y < GLYPH; y++) {
      const bits = FONT[code * GLYPH + y]!;
      for (let x = 0; x < GLYPH; x++)
        if (bits & (0x80 >> x)) pixels[y * width + i * GLYPH + x] = ink;
    }
  }
  return { width, height: GLYPH, pixels };
}
