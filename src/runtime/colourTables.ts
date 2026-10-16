/**
 * The sixteen colours each original platform shows for AGI colour indices
 * 0..15, as data the engine's tools and the app share (docs/fidelity.md
 * "Amiga screen, font and pointer" and "Apple IIgs presentation"). The app
 * adds fonts and layout; image tools in `src/` only need these colours.
 */
import type { AgiProfile, PaletteId } from "./profile.ts";

export type ColourTable = readonly [number, number, number][];

/** The authentic 16-color EGA palette, RGB. */
export const EGA_TABLE: ColourTable = [
  [0x00, 0x00, 0x00],
  [0x00, 0x00, 0xaa],
  [0x00, 0xaa, 0x00],
  [0x00, 0xaa, 0xaa],
  [0xaa, 0x00, 0x00],
  [0xaa, 0x00, 0xaa],
  [0xaa, 0x55, 0x00],
  [0xaa, 0xaa, 0xaa],
  [0x55, 0x55, 0x55],
  [0x55, 0x55, 0xff],
  [0x55, 0xff, 0x55],
  [0x55, 0xff, 0xff],
  [0xff, 0x55, 0x55],
  [0xff, 0x55, 0xff],
  [0xff, 0xff, 0x55],
  [0xff, 0xff, 0xff],
];

/**
 * An Amiga 16×3 nibble colour table as the interpreter passes it to
 * SetRGB4, expanded to 8-bit channels the way the 12-bit hardware shows
 * them (each nibble doubled: `$f` is 0xff, `$b` is 0xbb).
 */
function amigaTable(nibbles: string): [number, number, number][] {
  return nibbles.split(" ").map((rgb) => {
    const [r, g, b] = [...rgb].map((n) => parseInt(n, 16) * 0x11);
    return [r!, g!, b!];
  });
}

/** KQ2 2.176 and SQ2 2.202 start-up table. */
export const AMIGA_TABLE = amigaTable(
  "000 00f 080 0db c00 b7d 850 bbb 777 0bf 0e0 0fd f98 d0f ee0 fff",
);
/** SQ1 2.082's table: colour 13 is orange. */
export const AMIGA_TABLE_2_082 = amigaTable(
  "000 00f 080 0db c00 b7d 850 bbb 777 0bf 0e0 0fd f98 f70 ee0 fff",
);
/** The EGA-like table PQ1 2.310, Gold Rush! 2.316 and Manhunter 2 2.333 load. */
export const AMIGA_TABLE_2_31X = amigaTable(
  "000 00b 0b0 0bb b00 b0b c70 bbb 777 00f 0f0 0ff f00 f0f ff0 fff",
);

/** SQ2 1.014 SetColorTable. */
export const IIGS_TABLE: ColourTable = [
  [0x00, 0x00, 0x00],
  [0x00, 0x00, 0xff],
  [0x00, 0x88, 0x00],
  [0x00, 0xdd, 0xbb],
  [0xcc, 0x00, 0x00],
  [0xbb, 0x77, 0xdd],
  [0x88, 0x55, 0x00],
  [0xbb, 0xbb, 0xbb],
  [0x77, 0x77, 0x77],
  [0x00, 0xbb, 0xff],
  [0x00, 0xee, 0x00],
  [0x00, 0xff, 0xdd],
  [0xff, 0x99, 0x88],
  [0xdd, 0x99, 0xff],
  [0xee, 0xee, 0x00],
  [0xff, 0xff, 0xff],
];

/** The table a profile's `palette` id names. */
export function tableForPaletteId(id: PaletteId): ColourTable {
  switch (id) {
    case "ega":
      return EGA_TABLE;
    case "amiga":
      return AMIGA_TABLE;
    case "amiga-2.082":
      return AMIGA_TABLE_2_082;
    case "amiga-2.31x":
      return AMIGA_TABLE_2_31X;
  }
}

/** The colours a game under this profile shows: the IIgs table for the IIgs look, else its palette id's. */
export function colourTableForProfile(
  profile: Pick<AgiProfile, "palette" | "presentation">,
): ColourTable {
  return profile.presentation === "iigs" ? IIGS_TABLE : tableForPaletteId(profile.palette);
}

/**
 * The id a preparation recipe records for the colours a profile shows: its
 * palette id ("ega", "amiga", ...) or "iigs" for the Apple IIgs table.
 */
export function colourIdForProfile(profile: Pick<AgiProfile, "palette" | "presentation">): string {
  return profile.presentation === "iigs" ? "iigs" : profile.palette;
}

/** The colours a recorded colour id names; EGA for an id this build does not know. */
export function colourTableForId(id: string): ColourTable {
  if (id === "iigs") return IIGS_TABLE;
  if (id === "amiga" || id === "amiga-2.082" || id === "amiga-2.31x") return tableForPaletteId(id);
  return EGA_TABLE;
}
