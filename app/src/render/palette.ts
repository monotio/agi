import type { SpriteCel } from "../../../src/view/spriteDocument.ts";
import type { PaletteId } from "../../../src/runtime/profile.ts";

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

/**
 * An Amiga 16×3 nibble colour table as the interpreter passes it to
 * SetRGB4, expanded to 8-bit channels the way the 12-bit hardware shows
 * them (each nibble doubled: `$f` is 0xff, `$b` is 0xbb).
 */
function amigaTable(nibbles: string): readonly [number, number, number][] {
  return nibbles.split(" ").map((rgb) => {
    const [r, g, b] = [...rgb].map((n) => parseInt(n, 16) * 0x11);
    return [r!, g!, b!];
  });
}

/**
 * The colour table KQ2 2.176 and SQ2 2.202 load at start-up
 * (docs/fidelity.md "Amiga screen, font and pointer").
 */
export const AMIGA_PALETTE = amigaTable(
  "000 00f 080 0db c00 b7d 850 bbb 777 0bf 0e0 0fd f98 d0f ee0 fff",
);

/** SQ1 2.082's table: colour 13 is orange, every other entry matches `AMIGA_PALETTE`. */
export const AMIGA_PALETTE_2_082 = amigaTable(
  "000 00f 080 0db c00 b7d 850 bbb 777 0bf 0e0 0fd f98 f70 ee0 fff",
);

/** The EGA-like table PQ1 2.310, Gold Rush! 2.316 and Manhunter 2 2.333 load. */
export const AMIGA_PALETTE_2_31X = amigaTable(
  "000 00b 0b0 0bb b00 b0b c70 bbb 777 00f 0f0 0ff f00 f0f ff0 fff",
);

/** The RGB table a profile's `palette` id names. */
export function paletteFor(id: PaletteId): readonly [number, number, number][] {
  switch (id) {
    case "ega":
      return EGA_PALETTE;
    case "amiga":
      return AMIGA_PALETTE;
    case "amiga-2.082":
      return AMIGA_PALETTE_2_082;
    case "amiga-2.31x":
      return AMIGA_PALETTE_2_31X;
  }
}

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
