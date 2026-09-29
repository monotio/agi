/**
 * Shortcut labels in the viewer's own keyboard words. The Studio key
 * handlers take ⌘ and Ctrl alike (studioKeys.ts, spriteKeys.ts); what a
 * label names follows the platform: ⌘ ⇧ ⌥ on a Mac, iPhone or iPad, Ctrl
 * Shift Alt everywhere else.
 */

interface PlatformNavigator {
  readonly platform?: string;
  readonly userAgentData?: { readonly platform?: string } | undefined;
}

/** Whether `nav` reports an Apple platform: macOS, iOS or iPadOS. */
export function isApplePlatform(nav: PlatformNavigator | undefined): boolean {
  const platform = nav?.userAgentData?.platform || nav?.platform || "";
  return /mac|iphone|ipad|ipod|ios/i.test(platform);
}

const APPLE = isApplePlatform((globalThis as { navigator?: PlatformNavigator }).navigator);

type Modifier = "Mod" | "Alt" | "Shift";
/** Apple lists Option, Shift, Command in that order, run together. */
const APPLE_GLYPHS: Record<Modifier, string> = { Alt: "⌥", Shift: "⇧", Mod: "⌘" };
/** Elsewhere: Ctrl, Alt, Shift, each joined with +. */
const OTHER_NAMES: Record<Modifier, string> = { Mod: "Ctrl", Alt: "Alt", Shift: "Shift" };
const APPLE_ORDER: readonly Modifier[] = ["Alt", "Shift", "Mod"];
const OTHER_ORDER: readonly Modifier[] = ["Mod", "Alt", "Shift"];

const isModifier = (token: string): token is Modifier =>
  token === "Mod" || token === "Alt" || token === "Shift";

/**
 * A shortcut label from its written form: modifiers `Mod` (⌘ or Ctrl),
 * `Shift` and `Alt`, then at most one key, joined with `+` — "Mod+Shift+G"
 * reads "⇧⌘G" on Apple platforms and "Ctrl+Shift+G" elsewhere. A pointer
 * word ("Shift+click") takes a hyphen after Apple glyphs: "⇧-click". A
 * modifier alone ("Shift") names that key.
 */
export function keyLabel(combo: string, apple: boolean = APPLE): string {
  const tokens = combo.split("+");
  const last = tokens.at(-1) ?? "";
  const key = isModifier(last) ? "" : last;
  const held = new Set(tokens.filter(isModifier));
  if (apple) {
    const glyphs = APPLE_ORDER.filter((mod) => held.has(mod))
      .map((mod) => APPLE_GLYPHS[mod])
      .join("");
    return glyphs && /^[a-z]{2,}$/.test(key) ? `${glyphs}-${key}` : glyphs + key;
  }
  return [
    ...OTHER_ORDER.filter((mod) => held.has(mod)).map((mod) => OTHER_NAMES[mod]),
    ...(key ? [key] : []),
  ].join("+");
}
