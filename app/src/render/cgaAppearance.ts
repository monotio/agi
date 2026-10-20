/** On-demand CGA RGB driver mapping; the EGA boot path carries no tables. */
import { FONT, HAS_GLYPH } from "./font8x8.ts";
import { EGA_PALETTE } from "./palette.ts";
import type { Appearance } from "./appearance.ts";

// CGA_GRAF initialization selects background blue and palette 0: green,
// red, brown. AGIDATA's RGB picture permutation packs two hardware pixels
// per AGI pixel. Text attributes use their own four-colour grouping.
// docs/fidelity.md "PC fonts and display adapters".
const CGA_RGB = [EGA_PALETTE[1]!, EGA_PALETTE[2]!, EGA_PALETTE[4]!, EGA_PALETTE[6]!] as const;
const CGA_TEXT = [0, 1, 1, 1, 2, 2, 2, 3, 3, 1, 1, 1, 2, 2, 2, 3];
const CGA_PICTURE_EVEN = [0, 0, 5, 0, 10, 12, 14, 4, 3, 0, 4, 5, 14, 8, 7, 15];
const CGA_PICTURE_ODD = [0, 0, 4, 1, 10, 3, 11, 3, 4, 13, 1, 5, 14, 2, 13, 15];
function cgaPairs(patterns: readonly number[]): NonNullable<Appearance["picturePairs"]> {
  return patterns.map(
    (pair) =>
      [CGA_RGB[(pair >> 2) as 0 | 1 | 2 | 3], CGA_RGB[(pair & 3) as 0 | 1 | 2 | 3]] as const,
  );
}
export const CGA_RGB_APPEARANCE: Appearance = {
  font: FONT,
  hasGlyph: HAS_GLYPH,
  layout: "pc",
  cgaRgb: true,
  // CGA_GRAF sets the background register to blue, which mode 4 shows for code 0.
  background: CGA_RGB[0],
  palette: CGA_TEXT.map((index) => CGA_RGB[index as 0 | 1 | 2 | 3]),
  picturePairs: cgaPairs(CGA_PICTURE_EVEN),
  alternatePicturePairs: cgaPairs(CGA_PICTURE_ODD),
  viewPairs: cgaPairs([0, 0, 12, 1, 10, 2, 9, 13, 0, 3, 5, 7, 14, 14, 15, 15]),
};
