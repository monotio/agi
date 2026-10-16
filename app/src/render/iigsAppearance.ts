/**
 * The Apple IIgs look, loaded on demand by `appearance.ts`: the build's
 * colour table, the project font and the player's own AGIFONT when the
 * game files carry one (docs/fidelity.md "Apple IIgs presentation").
 */
import type { Appearance } from "./look.ts";
import { IIGS_FONT } from "./fontIigs.ts";
import { readIigsFont } from "./readIigsFont.ts";

/** SQ2 1.014 SetColorTable, docs/fidelity.md "Apple IIgs presentation". */
const IIGS_PALETTE: Appearance["palette"] = [
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

const IIGS_APPEARANCE: Appearance = {
  palette: IIGS_PALETTE,
  font: IIGS_FONT,
  hasGlyph: new Uint8Array(256).fill(1),
  layout: "iigs",
};
const fontAppearances = new WeakMap<Uint8Array, Appearance>();

/** The IIgs look for these game files: their AGIFONT when it decodes, the project font otherwise. */
export function iigsAppearanceForFiles(files?: ReadonlyMap<string, Uint8Array> | null): Appearance {
  const bytes = files?.get("AGIFONT");
  if (!bytes) return IIGS_APPEARANCE;
  let appearance = fontAppearances.get(bytes);
  if (!appearance) {
    const font = readIigsFont(bytes);
    appearance = font ? { ...IIGS_APPEARANCE, font } : IIGS_APPEARANCE;
    fontAppearances.set(bytes, appearance);
  }
  return appearance;
}

