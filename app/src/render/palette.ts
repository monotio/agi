import type { SpriteCel } from "../../../src/view/spriteDocument.ts";

/** The authentic 16-color EGA palette, RGB. */
export const EGA_PALETTE: readonly [number, number, number][] = [
  [0x00, 0x00, 0x00], // 0 black
  [0x00, 0x00, 0xaa], // 1 blue
  [0x00, 0xaa, 0x00], // 2 green
  [0x00, 0xaa, 0xaa], // 3 cyan
  [0xaa, 0x00, 0x00], // 4 red
  [0xaa, 0x00, 0xaa], // 5 magenta
  [0xaa, 0x55, 0x00], // 6 brown
  [0xaa, 0xaa, 0xaa], // 7 light gray
  [0x55, 0x55, 0x55], // 8 dark gray
  [0x55, 0x55, 0xff], // 9 light blue
  [0x55, 0xff, 0x55], // 10 light green
  [0x55, 0xff, 0xff], // 11 light cyan
  [0xff, 0x55, 0x55], // 12 light red
  [0xff, 0x55, 0xff], // 13 light magenta
  [0xff, 0xff, 0x55], // 14 yellow
  [0xff, 0xff, 0xff], // 15 white
];

/** Expand a 160x168 nibble buffer into an RGBA ImageData buffer. */

/**
 * The cel's colours into RGBA, transparent pixels left fully transparent;
 * `tint` blends every opaque pixel toward that colour (onion skins).
 */
export function celRgba(
  cel: Pick<SpriteCel, "pixels" | "transparent">,
  out: Uint8ClampedArray,
  tint?: { readonly rgb: readonly [number, number, number]; readonly alpha: number },
): void {
  for (let i = 0; i < cel.pixels.length; i++) {
    const value = cel.pixels[i]!;
    const o = i * 4;
    if (value === cel.transparent) {
      out[o + 3] = 0;
      continue;
    }
    const [r, g, b] = EGA_PALETTE[value & 0x0f]!;
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
