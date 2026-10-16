import { IIGS_FONT } from "./fontIigs.ts";
import { PROFILES, type ProfileId } from "../../../src/runtime/profile.ts";
import { FONT, HAS_GLYPH } from "./font8x8.ts";
import { EGA_PALETTE } from "./palette.ts";
import { readIigsFont } from "./readIigsFont.ts";

/** Resolved presentation assets; font rows are MSB-first in 256 eight-row cells. */
export interface Appearance {
  readonly palette: readonly [number, number, number][];
  readonly font: Uint8Array;
  readonly hasGlyph: Uint8Array;
  readonly layout: "pc" | "amiga" | "iigs";
}

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

export const PC_APPEARANCE: Appearance = {
  palette: EGA_PALETTE,
  font: FONT,
  hasGlyph: HAS_GLYPH,
  layout: "pc",
};
const IIGS_APPEARANCE: Appearance = {
  palette: IIGS_PALETTE,
  font: IIGS_FONT,
  hasGlyph: new Uint8Array(256).fill(1),
  layout: "iigs",
};
const fontAppearances = new WeakMap<Uint8Array, Appearance>();

/** Shared platform hook. Optional player files supply a game-owned IIgs font. */
export function appearanceForProfile(
  id: string | null | undefined,
  files?: ReadonlyMap<string, Uint8Array>,
): Appearance {
  if (!id || !Object.hasOwn(PROFILES, id) || PROFILES[id as ProfileId].presentation !== "iigs")
    return PC_APPEARANCE;
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
