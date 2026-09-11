/**
 * AGI key protocol words, clean-room from Peter Kelly's agi-re behavioral
 * specification, "Input, Text and Menus" (key press encoding). A key word is
 * either an ASCII character in the low byte or an extended BIOS scan code in
 * the high byte with a zero low byte; the two encodings never mix.
 */

/** ASCII characters and extended BIOS key words the input protocol names. */
export const AGI_KEY = {
  BACKSPACE: 0x08,
  TAB: 0x09,
  ENTER: 0x0d,
  ESCAPE: 0x1b,
  SPACE: 0x20,
  F1: 0x3b00,
  F2: 0x3c00,
  F3: 0x3d00,
  F4: 0x3e00,
  F5: 0x3f00,
  F6: 0x4000,
  F7: 0x4100,
  F8: 0x4200,
  F9: 0x4300,
  F10: 0x4400,
  HOME: 0x4700,
  UP: 0x4800,
  PAGE_UP: 0x4900,
  LEFT: 0x4b00,
  RIGHT: 0x4d00,
  END: 0x4f00,
  DOWN: 0x5000,
  PAGE_DOWN: 0x5100,
  INSERT: 0x5200,
  DELETE: 0x5300,
} as const;

/** PC key words for the eight compass directions (index 1..8; 0 is unused). */
export const DIRECTION_KEYS: readonly number[] = [
  0,
  AGI_KEY.UP,
  AGI_KEY.PAGE_UP,
  AGI_KEY.RIGHT,
  AGI_KEY.PAGE_DOWN,
  AGI_KEY.DOWN,
  AGI_KEY.END,
  AGI_KEY.LEFT,
  AGI_KEY.HOME,
];

/** The compass direction (1..8) each extended navigation key word selects. */
export const NAV_KEYS: Record<number, number> = Object.fromEntries(
  DIRECTION_KEYS.flatMap((word, direction) =>
    direction === 0 ? [] : [[word, direction] as [number, number]],
  ),
);

const KEY_WORD_NAMES: Record<number, string> = {
  [AGI_KEY.BACKSPACE]: "Backspace",
  [AGI_KEY.TAB]: "Tab",
  [AGI_KEY.ENTER]: "Enter",
  [AGI_KEY.ESCAPE]: "Esc",
  [AGI_KEY.SPACE]: "Space",
  [AGI_KEY.HOME]: "Home",
  [AGI_KEY.UP]: "ArrowUp",
  [AGI_KEY.PAGE_UP]: "PageUp",
  [AGI_KEY.LEFT]: "ArrowLeft",
  [AGI_KEY.RIGHT]: "ArrowRight",
  [AGI_KEY.END]: "End",
  [AGI_KEY.DOWN]: "ArrowDown",
  [AGI_KEY.PAGE_DOWN]: "PageDown",
  [AGI_KEY.INSERT]: "Insert",
  [AGI_KEY.DELETE]: "Delete",
  0x4600: "ScrollLock",
};

/** IBM PC Alt+letter BIOS scan codes, QWERTY order. */
const ALT_SCAN_LETTERS: Record<number, string> = {
  0x10: "Q",
  0x11: "W",
  0x12: "E",
  0x13: "R",
  0x14: "T",
  0x15: "Y",
  0x16: "U",
  0x17: "I",
  0x18: "O",
  0x19: "P",
  0x1e: "A",
  0x1f: "S",
  0x20: "D",
  0x21: "F",
  0x22: "G",
  0x23: "H",
  0x24: "J",
  0x25: "K",
  0x26: "L",
  0x2c: "Z",
  0x2d: "X",
  0x2e: "C",
  0x2f: "V",
  0x30: "B",
  0x31: "N",
  0x32: "M",
};

/** A readable name for an AGI key word, for reports and scene briefs. */
export function describeKeyWord(key: number): string {
  const named = KEY_WORD_NAMES[key];
  if (named) return named;
  const scan = key >> 8;
  if ((key & 0xff) === 0 && scan > 0) {
    if (scan >= 0x3b && scan <= 0x44) return `F${scan - 0x3a}`;
    const alt = ALT_SCAN_LETTERS[scan];
    if (alt) return `Alt+${alt}`;
    return `scan 0x${scan.toString(16)}`;
  }
  if (key >= 1 && key <= 26) return `Ctrl+${String.fromCharCode(64 + key)}`;
  if (key >= 33 && key <= 126) return `'${String.fromCharCode(key)}'`;
  return `0x${key.toString(16)}`;
}
