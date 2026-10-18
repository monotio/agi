/**
 * The game's own colours in Studio: a picture, view or room preview shows the
 * palette the running profile draws with, so an Amiga or Apple IIgs game reads
 * the same in Studio as in Play. The look is Play's presentation look
 * (`appearanceForProfile`), which already carries a lazy Amiga table and an
 * IIgs game's own font. A harness mounted without Play shows the PC look.
 */
import { computed, onScopeDispose, watchEffect, type ComputedRef } from "vue";
import { PC_APPEARANCE, gamePaletteId, type Appearance } from "./appearance.ts";
import { colourTableForId } from "../../../src/runtime/colourTables.ts";
import { useOptionalPresentation } from "../play/usePresentation.ts";

export type Palette = Appearance["palette"];

/** The current game's look. */
function useGameLook(): ComputedRef<Appearance> {
  const presentation = useOptionalPresentation();
  return computed(() => presentation?.look.value ?? PC_APPEARANCE);
}

/** The current game's 16 colours. */
export function useGamePalette(): ComputedRef<Palette> {
  const look = useGameLook();
  return computed(() => look.value.palette);
}

/** The game's colours with the id a preparation recipe records, for matching imported art. */
export function useGamePaletteLook(): ComputedRef<{ id: string; table: Palette }> {
  const presentation = useOptionalPresentation();
  return computed(() => {
    const id = gamePaletteId(presentation?.profileId.value);
    return { id, table: colourTableForId(id) };
  });
}

/** `rgb(r g b)` of one palette entry. */
export function paletteCss(palette: Palette, index: number): string {
  return `rgb(${(palette[index & 0x0f] ?? palette[0]!).join(" ")})`;
}

/** The `--agi-N` custom properties for a palette, as CSS declarations. */
export function paletteVars(palette: Palette): Record<string, string> {
  const vars: Record<string, string> = {};
  for (let i = 0; i < 16; i++) vars[`--agi-${i}`] = paletteCss(palette, i);
  return vars;
}

/** The minimal style surface `applyPaletteVars` writes, so tests need no DOM. */
export interface PaletteStyle {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): unknown;
}

/** Set `--agi-0..15` to the palette, or remove them all (the tokens.css defaults return) for null. */
export function applyPaletteVars(style: PaletteStyle, palette: Palette | null): void {
  if (palette === null) {
    for (let i = 0; i < 16; i++) style.removeProperty(`--agi-${i}`);
    return;
  }
  for (const [name, value] of Object.entries(paletteVars(palette))) style.setProperty(name, value);
}

/**
 * Redefine `--agi-0..15` on the document while `active()` is true, so every
 * swatch drawn with `var(--agi-N)` in Studio uses the game's colours. The
 * tokens.css defaults return when it turns false or the scope ends: Play's
 * own chrome never wears the game's colours.
 */
export function useGamePaletteVars(active: () => boolean): void {
  const palette = useGamePalette();
  const root = document.documentElement.style;
  watchEffect(() => applyPaletteVars(root, active() ? palette.value : null));
  onScopeDispose(() => applyPaletteVars(root, null));
}
