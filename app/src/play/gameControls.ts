import type { GameControlBinding } from "../../../src/runtime/engine.ts";
import { AGI_KEY } from "../../../src/runtime/keys.ts";

/** PC key words used by the browser's AGI input adapter. */
export const FUNCTION_KEYS: Record<string, number> = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [`F${i + 1}`, AGI_KEY.F1 + (i << 8)]),
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
  [AGI_KEY.BACKSPACE]: "Backspace",
  [AGI_KEY.TAB]: "Tab",
  [AGI_KEY.ENTER]: "Enter",
  [AGI_KEY.ESCAPE]: "Esc",
  [AGI_KEY.SPACE]: "Space",
  0x2000: "Alt+D",
  0x2c00: "Alt+Z",
  0x4600: "Scroll Lock",
  [AGI_KEY.HOME]: "Home",
  [AGI_KEY.UP]: "↑",
  [AGI_KEY.PAGE_UP]: "Page Up",
  [AGI_KEY.LEFT]: "←",
  [AGI_KEY.RIGHT]: "→",
  [AGI_KEY.END]: "End",
  [AGI_KEY.DOWN]: "↓",
  [AGI_KEY.PAGE_DOWN]: "Page Down",
  [AGI_KEY.INSERT]: "Insert",
  [AGI_KEY.DELETE]: "Delete",
};

const MOVEMENT_KEYS: Record<string, number> = {
  ArrowUp: 1,
  PageUp: 2,
  ArrowRight: 3,
  PageDown: 4,
  ArrowDown: 5,
  End: 6,
  ArrowLeft: 7,
  Home: 8,
};

const NUMPAD_MOVEMENT_CODES: Record<string, number> = {
  Numpad8: 1,
  Numpad9: 2,
  Numpad6: 3,
  Numpad3: 4,
  Numpad2: 5,
  Numpad1: 6,
  Numpad4: 7,
  Numpad7: 8,
};

const NUMPAD_MOVEMENT_DIGITS: Record<string, number> = {
  "8": 1,
  "9": 2,
  "6": 3,
  "3": 4,
  "2": 5,
  "1": 6,
  "4": 7,
  "7": 8,
};

/** Translate an unmodified navigation or numeric-keypad event to an AGI direction. */
export function movementDirection(event: KeyboardEvent): number | undefined {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing)
    return undefined;
  const keypadDirection = NUMPAD_MOVEMENT_CODES[event.code];
  if (keypadDirection !== undefined) return keypadDirection;
  const navigationDirection = MOVEMENT_KEYS[event.key];
  if (navigationDirection !== undefined) return navigationDirection;
  if (event.location === 3 && (!event.code || event.code === "Unidentified"))
    return NUMPAD_MOVEMENT_DIGITS[event.key];
  return undefined;
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
