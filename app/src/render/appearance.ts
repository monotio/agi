/**
 * The look a profile's frame is drawn with: its colour table, its font and
 * its platform layout (`AgiProfile.presentation` and `palette`;
 * docs/fidelity.md "Amiga screen, font and pointer"). The compositor takes
 * one of these next to the engine's cells, so the engine stays a
 * platform-neutral cell surface and the app owns the pixels.
 *
 * The PC look is built in; a platform look loads on demand
 * (`loadAppearance`) and stays cached, so the Play boot path carries no
 * Amiga or IIgs font. `appearanceForProfile` answers synchronously with whatever is
 * loaded and the PC look until then.
 */
import { PROFILES, type ProfileId } from "../../../src/runtime/profile.ts";
import { FONT, HAS_GLYPH } from "./font8x8.ts";
import { EGA_PALETTE } from "./palette.ts";
import { colourIdForProfile, colourTableForId } from "../../../src/runtime/colourTables.ts";
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
  /** Hardware colour of screen areas nothing has drawn; transparent when absent. */
  readonly background?: readonly [number, number, number];
};

const PC_EARLY_DISPLAYS: readonly PcDisplay[] = ["ega", "cga-rgb", "tandy", "pcjr"];
const PC_MCGA_DISPLAYS: readonly PcDisplay[] = [...PC_EARLY_DISPLAYS, "mcga"];

/** Available renderer choices, constrained to the selected build's drivers. */
export function pcDisplayChoices(id?: string | null): readonly PcDisplay[] {
  if (id?.startsWith("amiga-") || id === "iigs-1.014" || id === "2.001") return [];
  return id === "2.089" || id === "2.230" || id === "2.272" || id === "2.411" || id === "2.440"
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

export const PC_APPEARANCE: Appearance = {
  palette: EGA_PALETTE,
  font: FONT,
  hasGlyph: HAS_GLYPH,
  layout: "pc",
};
/**
 * The id a preparation recipe records for the colours a profile shows: the
 * profile's palette id ("ega", "amiga", ...), or "iigs" for the Apple IIgs table.
 */
export function gamePaletteId(id?: string | null): string {
  if (id === null || id === undefined || !Object.hasOwn(PROFILES, id)) return "ega";
  return colourIdForProfile(PROFILES[id as ProfileId]);
}

/** The sixteen colours a recorded palette id names; EGA for an id this build does not know. */
export function paletteTableForId(id: string): Appearance["palette"] {
  return colourTableForId(id);
}

const loaded = new Map<string, Appearance>();
/** The IIgs look, once its chunk has loaded; it depends on the game's AGIFONT. */
let iigsLook: ((files?: ReadonlyMap<string, Uint8Array> | null) => Appearance) | undefined;
let iigsLoading: Promise<Appearance> | undefined;
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
  if (id === "iigs-1.014") return iigsLook?.(files) ?? PC_APPEARANCE;
  if (display === "cga-rgb" && pcDisplayChoices(id).includes(display))
    return loaded.get("pc:cga-rgb") ?? PC_APPEARANCE;
  return loaded.get(lookKey(id)) ?? PC_APPEARANCE;
}

/** Load (once) and return the look of the profile with this id. */
export function loadAppearance(
  id?: string | null,
  files?: ReadonlyMap<string, Uint8Array> | null,
  display: PcDisplay = "ega",
): Promise<Appearance> {
  if (id === "iigs-1.014") {
    if (iigsLook) return Promise.resolve(iigsLook(files));
    iigsLoading ??= import("./iigsAppearance.ts").then(({ iigsAppearanceForFiles }) => {
      iigsLook = iigsAppearanceForFiles;
      return iigsAppearanceForFiles(files);
    });
    return iigsLoading.then(() => iigsLook!(files));
  }
  const key =
    display === "cga-rgb" && pcDisplayChoices(id).includes(display) ? "pc:cga-rgb" : lookKey(id);
  const ready = loaded.get(key);
  if (ready) return Promise.resolve(ready);
  if (key === "pc") return Promise.resolve(appearanceForProfile(id, files, display));
  let pending = loading.get(key);
  if (!pending) {
    pending =
      key === "pc:cga-rgb"
        ? import("./cgaAppearance.ts").then(({ CGA_RGB_APPEARANCE }) => CGA_RGB_APPEARANCE)
        : import("./amigaAppearance.ts").then(({ amigaAppearance }) =>
            amigaAppearance(PROFILES[id as ProfileId].palette),
          );
    pending = pending.then((look) => {
      loaded.set(key, look);
      loading.delete(key);
      return look;
    });
    loading.set(key, pending);
  }
  return pending;
}
