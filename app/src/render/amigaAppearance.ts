/**
 * The Amiga look, loaded on demand by `appearance.ts`: the build's colour
 * table, the project's Amiga font and the title bar's depth gadget art
 * (docs/fidelity.md "Amiga screen, font and pointer").
 */
import type { PaletteId } from "../../../src/runtime/profile.ts";
import { tableForPaletteId } from "../../../src/runtime/colourTables.ts";
import { AMIGA_DEPTH_GADGET_WIDTH, AMIGA_TITLE_BAR_ROWS, type Appearance } from "./look.ts";
import { AMIGA_FONT, AMIGA_HAS_GLYPH } from "./fontAmiga.ts";

/**
 * The two screen depth gadgets, this project's own drawing of Kickstart
 * 1.3's "to back" and "to front" symbols: two overlapping squares, one
 * filled in pen 2, one outlined in pen 0 over the pen 1 ground, each on a
 * two-pixel pen 0 left border. Rows of 17 pens for the 10 bar rows; the
 * left gadget sends the screen back, the right brings it to the front.
 */
const DEPTH_GADGET_ART: readonly string[] = [
  "00111111111111111" + "00111111111111111",
  "00110000001111111" + "00112222221111111",
  "00110111101111111" + "00112222220000011",
  "00110111222222211" + "00112222220111011",
  "00110111222222211" + "00112222220111011",
  "00110111222222211" + "00112222220111011",
  "00110000222222211" + "00111111110111011",
  "00111111222222211" + "00111111110111011",
  "00111111222222211" + "00111111110000011",
  "00111111111111111" + "00111111111111111",
];

/** Pens of both depth gadgets, row-major, `AMIGA_TITLE_BAR_ROWS` rows of 34. */
const AMIGA_DEPTH_GADGETS: Uint8Array = (() => {
  const width = 2 * AMIGA_DEPTH_GADGET_WIDTH;
  const out = new Uint8Array(AMIGA_TITLE_BAR_ROWS * width);
  DEPTH_GADGET_ART.forEach((row, y) => {
    if (row.length !== width) throw new Error(`depth gadget row ${y}`);
    for (let x = 0; x < width; x++) out[y * width + x] = Number(row[x]);
  });
  return out;
})();

/** The Amiga look for a build's colour table. */
export function amigaAppearance(palette: PaletteId): Appearance {
  return {
    palette: tableForPaletteId(palette),
    font: AMIGA_FONT,
    hasGlyph: AMIGA_HAS_GLYPH,
    layout: "amiga",
    titleGadgets: AMIGA_DEPTH_GADGETS,
  };
}
