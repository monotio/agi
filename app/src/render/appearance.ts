/**
 * The look a profile's frame is drawn with: its colour table, its font and
 * its platform layout (`AgiProfile.presentation` and `palette`;
 * docs/fidelity.md "Amiga screen, font and pointer"). The compositor takes
 * one of these next to the engine's cells, so the engine stays a
 * platform-neutral cell surface and the app owns the pixels.
 *
 * The PC look is built in; a platform look loads on demand
 * (`loadAppearance`) and stays cached, so the Play boot path carries no
 * Amiga font. `appearanceForProfile` answers synchronously with whatever is
 * loaded and the PC look until then.
 */
import { PROFILES, type ProfileId } from "../../../src/runtime/profile.ts";
import { FONT, HAS_GLYPH } from "./font8x8.ts";
import { EGA_PALETTE } from "./palette.ts";
import type { Appearance as PlatformAppearance } from "./look.ts";

/** PC graphics drivers with a verified 320×200 presentation path. */
export type PcDisplay = "ega" | "cga-rgb" | "tandy" | "pcjr" | "mcga";
export type Appearance = PlatformAppearance & {
  /** CGA RGB picture colours are pairs of hardware pixels, not a palette swap. */
  readonly picturePairs?: readonly (readonly [
    readonly [number, number, number],
    readonly [number, number, number],
  ])[];
  readonly alternatePicturePairs?: Appearance["picturePairs"];
  readonly spritePairs?: Appearance["picturePairs"];
  readonly cgaRgb?: boolean;
};

const PC_EARLY_DISPLAYS: readonly PcDisplay[] = ["ega", "cga-rgb", "tandy", "pcjr"];
const PC_MCGA_DISPLAYS: readonly PcDisplay[] = [...PC_EARLY_DISPLAYS, "mcga"];

/** Available renderer choices, constrained to the selected build's drivers. */
export function pcDisplayChoices(id?: string | null): readonly PcDisplay[] {
  if (id?.startsWith("amiga-") || id === "iigs-1.014") return [];
  return id === "2.001" ||
    id === "2.089" ||
    id === "2.230" ||
    id === "2.272" ||
    id === "2.411" ||
    id === "2.440"
    ? PC_EARLY_DISPLAYS
    : PC_MCGA_DISPLAYS;
}
export {
  AMIGA_DEPTH_GADGET_WIDTH,
  AMIGA_TITLE_BAR_HEIGHT,
  AMIGA_TITLE_BAR_ROWS,
  AMIGA_TITLE_TEXT_X,
  AMIGA_TITLE_TEXT_Y,
} from "./look.ts";

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

export const PC_APPEARANCE: Appearance = {
  palette: EGA_PALETTE,
  font: FONT,
  hasGlyph: HAS_GLYPH,
  layout: "pc",
};
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
const CGA_RGB_APPEARANCE: Appearance = {
  ...PC_APPEARANCE,
  cgaRgb: true,
  palette: CGA_TEXT.map((index) => CGA_RGB[index as 0 | 1 | 2 | 3]),
  picturePairs: cgaPairs(CGA_PICTURE_EVEN),
  alternatePicturePairs: cgaPairs(CGA_PICTURE_ODD),
  spritePairs: cgaPairs([0, 0, 12, 1, 10, 2, 9, 13, 0, 3, 5, 7, 14, 14, 15, 15]),
};

const IIGS_APPEARANCE: Appearance = {
  palette: IIGS_PALETTE,
  font: IIGS_FONT,
  hasGlyph: new Uint8Array(256).fill(1),
  layout: "iigs",
};
const fontAppearances = new WeakMap<Uint8Array, Appearance>();

function iigsAppearanceForFiles(files?: ReadonlyMap<string, Uint8Array> | null): Appearance {
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

const loaded = new Map<string, Appearance>();
const loading = new Map<string, Promise<Appearance>>();

function lookKey(id: string | null | undefined): string {
  if (id === null || id === undefined || !Object.hasOwn(PROFILES, id)) return "pc";
  const profile = PROFILES[id as ProfileId];
  return profile.presentation === "amiga" ? `amiga:${profile.palette}` : "pc";
}

/** The look of the profile with this id as far as it is loaded; the PC look otherwise. */
export function appearanceForProfile(
  id?: string | null,
  files?: ReadonlyMap<string, Uint8Array> | null,
  display: PcDisplay = "ega",
): Appearance {
  if (id === "iigs-1.014") return iigsAppearanceForFiles(files);
  if (display === "cga-rgb" && pcDisplayChoices(id).includes(display)) return CGA_RGB_APPEARANCE;
  return loaded.get(lookKey(id)) ?? PC_APPEARANCE;
}

/** Load (once) and return the look of the profile with this id. */
export function loadAppearance(
  id?: string | null,
  files?: ReadonlyMap<string, Uint8Array> | null,
  display: PcDisplay = "ega",
): Promise<Appearance> {
  if (id === "iigs-1.014") return Promise.resolve(iigsAppearanceForFiles(files));
  const key = lookKey(id);
  const ready = loaded.get(key);
  if (ready) return Promise.resolve(ready);
  if (key === "pc") return Promise.resolve(appearanceForProfile(id, files, display));
  let pending = loading.get(key);
  if (!pending) {
    pending = import("./amigaAppearance.ts").then(({ amigaAppearance }) => {
      const look = amigaAppearance(PROFILES[id as ProfileId].palette);
      loaded.set(key, look);
      loading.delete(key);
      return look;
    });
    loading.set(key, pending);
  }
  return pending;
}
