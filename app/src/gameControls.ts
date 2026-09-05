import type { GameControlBinding } from "../../src/runtime/engine.ts";

/** PC key words used by the browser's AGI input adapter. */
export const FUNCTION_KEYS: Record<string, number> = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [`F${i + 1}`, (0x3b + i) << 8]),
);
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
};

export function gameShortcuts(bindings: GameControlBinding[]) {
  return bindings.map((binding) => {
    const key = binding.key;
    let keyLabel =
      KEY_NAMES[key] ?? Object.entries(FUNCTION_KEYS).find(([, code]) => code === key)?.[0] ?? "";
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
  if (event.metaKey) return undefined;
  let key: number | undefined;
  if (event.altKey) {
    if (event.key.toLowerCase() === "d") key = 0x2000;
    if (event.key.toLowerCase() === "z") key = 0x2c00;
  } else if (event.ctrlKey && /^[a-z]$/i.test(event.key))
    key = event.key.toUpperCase().charCodeAt(0) - 64;
  else if (!event.ctrlKey && !(event.key === "Tab" && event.shiftKey)) {
    key = KEY_EVENTS[event.key];
    if (key === undefined && event.key.length === 1) key = event.key.charCodeAt(0);
  }
  return bindings.some((binding) => binding.key === key) ? key : undefined;
}
