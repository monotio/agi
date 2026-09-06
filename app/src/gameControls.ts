import type { GameControlBinding } from "../../src/runtime/engine.ts";

/** PC key words used by the browser's AGI input adapter. */
export const FUNCTION_KEYS: Record<string, number> = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [`F${i + 1}`, (0x3b + i) << 8]),
);
/** IBM PC letter scan codes, shared with the phone's modifier key panel. */
export const ALT_LETTER_SCANS: Record<string, number> = {
  A: 30,
  B: 48,
  C: 46,
  D: 32,
  E: 18,
  F: 33,
  G: 34,
  H: 35,
  I: 23,
  J: 36,
  K: 37,
  L: 38,
  M: 50,
  N: 49,
  O: 24,
  P: 25,
  Q: 16,
  R: 19,
  S: 31,
  T: 20,
  U: 22,
  V: 47,
  W: 17,
  X: 45,
  Y: 21,
  Z: 44,
};
const KEY_NAMES: Record<number, string> = {
  0x0008: "Backspace",
  0x0009: "Tab",
  0x000d: "Enter",
  0x001b: "Esc",
  0x0020: "Space",
  0x2000: "Alt+D",
  0x2c00: "Alt+Z",
  0x4600: "Scroll Lock",
  0x4700: "Home",
  0x4800: "↑",
  0x4900: "Page Up",
  0x4b00: "←",
  0x4d00: "→",
  0x4f00: "End",
  0x5000: "↓",
  0x5100: "Page Down",
  0x5200: "Insert",
  0x5300: "Delete",
};

const KEY_EVENTS: Record<string, number> = {
  Backspace: 0x0008,
  Tab: 0x0009,
  Enter: 0x000d,
  Escape: 0x001b,
  Home: 0x4700,
  ArrowUp: 0x4800,
  PageUp: 0x4900,
  ArrowLeft: 0x4b00,
  ArrowRight: 0x4d00,
  End: 0x4f00,
  ArrowDown: 0x5000,
  PageDown: 0x5100,
  Insert: 0x5200,
  Delete: 0x5300,
  ScrollLock: 0x4600,
};

/** IBM PC key words shared by physical and on-screen input. */
export function pcKey(event: KeyboardEvent): number | undefined {
  if (event.metaKey || event.isComposing) return undefined;
  // AltGr is native text entry. It must not trigger the unrelated Alt key.
  if (event.altKey && event.ctrlKey) return undefined;
  if (event.altKey) {
    const scan = ALT_LETTER_SCANS[event.key.toUpperCase()];
    return scan === undefined ? undefined : scan << 8;
  }
  if (event.ctrlKey)
    return /^[a-z]$/i.test(event.key) ? event.key.toUpperCase().charCodeAt(0) - 64 : undefined;
  // Modified extended keys have distinct PC words; never alias them to bare keys.
  if (event.shiftKey && event.key.length !== 1) return undefined;
  return (
    FUNCTION_KEYS[event.key] ??
    KEY_EVENTS[event.key] ??
    (event.key.length === 1 && event.key.charCodeAt(0) <= 0x7f
      ? event.key.charCodeAt(0)
      : undefined)
  );
}

export function gameShortcuts(bindings: GameControlBinding[]) {
  return bindings.map((binding) => {
    const key = binding.key;
    let keyLabel =
      KEY_NAMES[key] ?? Object.entries(FUNCTION_KEYS).find(([, code]) => code === key)?.[0] ?? "";
    if (!keyLabel) {
      const altLetter = Object.entries(ALT_LETTER_SCANS).find(([, scan]) => scan << 8 === key)?.[0];
      if (altLetter) keyLabel = `Alt+${altLetter}`;
    }
    if (!keyLabel && key >= 1 && key <= 26) keyLabel = `Ctrl+${String.fromCharCode(64 + key)}`;
    if (!keyLabel && key >= 33 && key <= 126) keyLabel = String.fromCharCode(key);
    const labels = binding.menuItems
      .map((item) => {
        let text = item.text.trim().replace(/\s+/g, " ");
        // Remove only the matching shortcut suffix supplied by the game itself.
        if (keyLabel && text.toLowerCase().endsWith(` ${keyLabel.toLowerCase()}`))
          text = text.slice(0, -keyLabel.length).trim();
        return text;
      })
      .filter(Boolean);
    if (binding.label) labels.unshift(binding.label);
    return {
      key,
      keyLabel,
      label: [...new Set(labels)].join(" / ") || keyLabel || "Game shortcut",
      hasLabel: labels.length > 0,
      disabled: binding.menuItems.length > 0 && binding.menuItems.every((item) => !item.enabled),
      heading: [...new Set(binding.menuItems.map((item) => item.heading.trim()))].join(" / "),
    };
  });
}

/** Only configured modifier/character shortcuts take precedence over normal text input. */
export function registeredKey(
  event: KeyboardEvent,
  bindings: GameControlBinding[],
): number | undefined {
  const key = pcKey(event);
  return bindings.some((binding) => binding.key === key) ? key : undefined;
}
