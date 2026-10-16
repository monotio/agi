import type { SpriteCel } from "../../../src/view/spriteDocument.ts";
import type { PaletteId } from "../../../src/runtime/profile.ts";
import {
  AMIGA_TABLE,
  AMIGA_TABLE_2_082,
  AMIGA_TABLE_2_31X,
  EGA_TABLE,
  tableForPaletteId,
} from "../../../src/runtime/colourTables.ts";

/** The authentic 16-color EGA palette, RGB. */
export const EGA_PALETTE: readonly [number, number, number][] = EGA_TABLE;

/** The colour table KQ2 2.176 and SQ2 2.202 load at start-up (docs/fidelity.md "Amiga screen, font and pointer"). */
export const AMIGA_PALETTE = AMIGA_TABLE;
/** SQ1 2.082's table: colour 13 is orange, every other entry matches `AMIGA_PALETTE`. */
export const AMIGA_PALETTE_2_082 = AMIGA_TABLE_2_082;
/** The EGA-like table PQ1 2.310, Gold Rush! 2.316 and Manhunter 2 2.333 load. */
export const AMIGA_PALETTE_2_31X = AMIGA_TABLE_2_31X;

/** The RGB table a profile's `palette` id names. */
export function paletteFor(id: PaletteId): readonly [number, number, number][] {
  return tableForPaletteId(id);
}

/**
 * The cel's colours into RGBA, transparent pixels left fully transparent;
 * `tint` blends every opaque pixel toward that colour (onion skins).
 */
export function celRgba(
  cel: Pick<SpriteCel, "pixels" | "transparent">,
  out: Uint8ClampedArray,
  tint?: { readonly rgb: readonly [number, number, number]; readonly alpha: number },
  palette: readonly (readonly [number, number, number])[] = EGA_PALETTE,
): void {
  for (let i = 0; i < cel.pixels.length; i++) {
    const value = cel.pixels[i]!;
    const o = i * 4;
    if (value === cel.transparent) {
      out[o + 3] = 0;
      continue;
    }
    const [r, g, b] = palette[value & 0x0f]!;
    if (tint) {
      out[o] = (r + tint.rgb[0]) / 2;
      out[o + 1] = (g + tint.rgb[1]) / 2;
      out[o + 2] = (b + tint.rgb[2]) / 2;
      out[o + 3] = Math.round(tint.alpha * 255);
    } else {
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
}
