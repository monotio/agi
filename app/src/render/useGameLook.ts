/**
 * The game's own colours in Studio: a picture, view or room preview shows the
 * palette the running profile draws with, so an Amiga or Apple IIgs game reads
 * the same in Studio as in Play. The look is Play's presentation look
 * (`appearanceForProfile`), which already carries a lazy Amiga table and an
 * IIgs game's own font. A harness mounted without Play shows the PC look.
 */
import { computed, onScopeDispose, watchEffect, type ComputedRef } from "vue";
import { PC_APPEARANCE, type Appearance } from "./appearance.ts";
import { useOptionalPresentation } from "../play/usePresentation.ts";

export type Palette = Appearance["palette"];

/** The current game's look. */
export function useStudioLook(): ComputedRef<Appearance> {
  const presentation = useOptionalPresentation();
  return computed(() => presentation?.look.value ?? PC_APPEARANCE);
}

/** The current game's 16 colours. */
export function useStudioPalette(): ComputedRef<Palette> {
  const look = useStudioLook();
  return computed(() => look.value.palette);
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

/**
 * Redefine `--agi-0..15` on the document while the calling component lives, so
 * every swatch drawn with `var(--agi-N)` in Studio uses the game's colours.
 * The tokens.css defaults return when the scope ends.
 */
export function useStudioPaletteVars(): void {
  const palette = useStudioPalette();
  const root = document.documentElement.style;
  watchEffect(() => {
    for (const [name, value] of Object.entries(paletteVars(palette.value)))
      root.setProperty(name, value);
  });
  onScopeDispose(() => {
    for (let i = 0; i < 16; i++) root.removeProperty(`--agi-${i}`);
  });
}
