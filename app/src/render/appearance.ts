/**
 * The look a profile's frame is drawn with: its colour table, its font and
 * its platform layout (`AgiProfile.presentation` and `palette`;
 * docs/fidelity.md "Amiga screen, font and pointer"). The compositor takes
 * one of these next to the engine's cells, so the engine stays a
 * platform-neutral cell surface and the app owns the pixels.
 */
import { PROFILES, type ProfileId, type Presentation } from "../../../src/runtime/profile.ts";
import { FONT, HAS_GLYPH } from "./font8x8.ts";
import { AMIGA_FONT, AMIGA_HAS_GLYPH } from "./fontAmiga.ts";
import { EGA_PALETTE, paletteFor } from "./palette.ts";

export interface Appearance {
  /** AGI colours 0..15 as RGB. */
  readonly palette: readonly [number, number, number][];
  /** Packed 8×8 glyph rows, `font[code * 8 + row]`, bit 7 leftmost. */
  readonly font: Uint8Array;
  /** 1 for each code the font draws. */
  readonly hasGlyph: Uint8Array;
  /** Platform layout: where the status line and gadget labels go. */
  readonly layout: Presentation;
}

/** The PC look: EGA colours, the project font, text cells everywhere. */
export const PC_APPEARANCE: Appearance = {
  palette: EGA_PALETTE,
  font: FONT,
  hasGlyph: HAS_GLYPH,
  layout: "pc",
};

/** The look of the profile with this id; unknown ids draw as the PC. */
export function appearanceForProfile(id: string | null | undefined): Appearance {
  if (id === null || id === undefined || !Object.hasOwn(PROFILES, id)) return PC_APPEARANCE;
  const profile = PROFILES[id as ProfileId];
  if (profile.presentation !== "amiga") return PC_APPEARANCE;
  return {
    palette: paletteFor(profile.palette),
    font: AMIGA_FONT,
    hasGlyph: AMIGA_HAS_GLYPH,
    layout: "amiga",
  };
}

/**
 * Amiga screen title bar (docs/fidelity.md "Amiga screen, font and
 * pointer"): the interpreter's status line is the Intuition screen title,
 * which Kickstart 1.3 draws as ten rows of the screen's block pen (15)
 * with the text one row down and two pixels in, a bottom line in the
 * detail pen (0), and the two screen depth gadgets at the right edge.
 */
export const AMIGA_TITLE_BAR_ROWS = 10;
/** Rows 0..10 belong to the bar: the bottom line is row 10. */
export const AMIGA_TITLE_BAR_HEIGHT = 11;
export const AMIGA_TITLE_TEXT_X = 2;
export const AMIGA_TITLE_TEXT_Y = 1;
/** Width of each depth gadget; the pair ends at the right screen edge. */
export const AMIGA_DEPTH_GADGET_WIDTH = 17;

/**
 * The two screen depth gadgets, this project's own drawing of Kickstart
 * 1.3's "to back" and "to front" symbols: two overlapping squares, one
 * filled in pen 2, one outlined in pen 0 over the pen 1 ground, each on a
 * two-pixel pen 0 left border. Rows of 17 pens for the 10 bar rows; the
 * left gadget sends the screen back, the right brings it to the front.
 */
const DEPTH_GADGET_ART: readonly [string, string] = [
  [
    "00111111111111111",
    "00110000001111111",
    "00110111101111111",
    "00110111222222211",
    "00110111222222211",
    "00110111222222211",
    "00110000222222211",
    "00111111222222211",
    "00111111222222211",
    "00111111111111111",
  ].join(" "),
  [
    "00111111111111111",
    "00112222221111111",
    "00112222220000011",
    "00112222220111011",
    "00112222220111011",
    "00112222220111011",
    "00111111110111011",
    "00111111110111011",
    "00111111110000011",
    "00111111111111111",
  ].join(" "),
];

/** Pens of both depth gadgets, row-major, `AMIGA_TITLE_BAR_ROWS` rows of 34. */
export const AMIGA_DEPTH_GADGETS: Uint8Array = (() => {
  const rows = DEPTH_GADGET_ART.map((art) => art.split(" "));
  const out = new Uint8Array(AMIGA_TITLE_BAR_ROWS * 2 * AMIGA_DEPTH_GADGET_WIDTH);
  for (let y = 0; y < AMIGA_TITLE_BAR_ROWS; y++) {
    for (let g = 0; g < 2; g++) {
      const row = rows[g]![y]!;
      if (row.length !== AMIGA_DEPTH_GADGET_WIDTH) throw new Error(`depth gadget ${g} row ${y}`);
      for (let x = 0; x < AMIGA_DEPTH_GADGET_WIDTH; x++)
        out[y * 2 * AMIGA_DEPTH_GADGET_WIDTH + g * AMIGA_DEPTH_GADGET_WIDTH + x] = Number(row[x]);
    }
  }
  return out;
})();
