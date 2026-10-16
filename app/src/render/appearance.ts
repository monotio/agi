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
import type { Appearance } from "./look.ts";

export type { Appearance } from "./look.ts";
export {
  AMIGA_DEPTH_GADGET_WIDTH,
  AMIGA_TITLE_BAR_HEIGHT,
  AMIGA_TITLE_BAR_ROWS,
  AMIGA_TITLE_TEXT_X,
  AMIGA_TITLE_TEXT_Y,
} from "./look.ts";

/** The PC look: EGA colours, the project font, text cells everywhere. */
export const PC_APPEARANCE: Appearance = {
  palette: EGA_PALETTE,
  font: FONT,
  hasGlyph: HAS_GLYPH,
  layout: "pc",
};

const loaded = new Map<string, Appearance>();
const loading = new Map<string, Promise<Appearance>>();

function lookKey(id: string | null | undefined): string {
  if (id === null || id === undefined || !Object.hasOwn(PROFILES, id)) return "pc";
  const profile = PROFILES[id as ProfileId];
  return profile.presentation === "amiga" ? `amiga:${profile.palette}` : "pc";
}

/** The look of the profile with this id as far as it is loaded; the PC look otherwise. */
export function appearanceForProfile(id: string | null | undefined): Appearance {
  return loaded.get(lookKey(id)) ?? PC_APPEARANCE;
}

/** Load (once) and return the look of the profile with this id. */
export function loadAppearance(id: string | null | undefined): Promise<Appearance> {
  const key = lookKey(id);
  const ready = loaded.get(key);
  if (ready) return Promise.resolve(ready);
  if (key === "pc") return Promise.resolve(PC_APPEARANCE);
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
