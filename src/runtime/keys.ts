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

/** The navigation key word each compass direction (1..8) maps back to. */
export const NAV_KEY_CODES: Record<number, number> = Object.fromEntries(
  DIRECTION_KEYS.flatMap((word, direction) =>
    direction === 0 ? [] : [[direction, word] as [number, number]],
  ),
);

/**
 * Keypad direction words emitted by Amiga RAWKEY (h79/h107 + h154) and Apple
 * IIgs TranslateKey (~arrays+0x1019 + ~arrays+0x1c15), plus 0xf500 for
 * unmodified Keypad 5 (stop ego, direction 0).
 */
export const KEYPAD_DIRECTION_WORDS: Record<number, number> = {
  0xf500: 0,
  0xf800: 1,
  0xf900: 2,
  0xf600: 3,
  0xf300: 4,
  0xf200: 5,
  0xf100: 6,
  0xf400: 7,
  0xf700: 8,
};

/**
 * Whether unmodified Keypad 5 stops the hero (0xf500, direction 0). The INT 9
 * hooks of 2.272 and later post it; 2.001, 2.089 and 2.230 have neither the
 * hook check nor a keypad-5 table entry (docs/fidelity.md F-IN-07).
 */
export function hasKeypadStop(profileId: string | null | undefined): boolean {
  return profileId !== "2.001" && profileId !== "2.089" && profileId !== "2.230";
}

/**
 * The keypad/joystick duplicates of the accept/cancel keys:
 * - On PC (all 13 builds) and Amiga (2.082 h76+0x278, 2.176..2.333 h103+0x28e),
 *   ButtonToChar maps 0x0101/0x0301 -> CR (0x0d) and 0x0201/0x0401 -> ESC (0x1b).
 * - On Apple IIgs 1.014 (eventseg+0x351..0x39d), ButtonToChar maps all four
 *   0x0101..0x0401 -> CR (0x0d).
 * ButtonToChar runs inside GetKey — so have.key, the get.string/get.num
 * editors, all modal windows, the inventory selector and the menus normalize —
 * while the input-phase line editor does not call ButtonToChar (docs/fidelity.md
 * "Original input, menu and modal handling", F-IN-04).
 */
export function normalizeKeyWord(
  word: number,
  presentation: "pc" | "amiga" | "iigs" = "pc",
): number {
  if (word === 0x0101 || word === 0x0301) return AGI_KEY.ENTER;
  if (word === 0x0201 || word === 0x0401)
    return presentation === "iigs" ? AGI_KEY.ENTER : AGI_KEY.ESCAPE;
  return word;
}

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

const LETTER_ALT_SCANS: Record<string, number> = Object.fromEntries(
  Object.entries(ALT_SCAN_LETTERS).map(([scan, ch]) => [ch, Number(scan)]),
);

const TOP_ROW_ALT_SCANS: Record<string, number> = {
  "1": 0x7800,
  "2": 0x7900,
  "3": 0x7a00,
  "4": 0x7b00,
  "5": 0x7c00,
  "6": 0x7d00,
  "7": 0x7e00,
  "8": 0x7f00,
  "9": 0x8000,
  "0": 0x8100,
  "-": 0x8200,
  "=": 0x8300,
  Digit1: 0x7800,
  Digit2: 0x7900,
  Digit3: 0x7a00,
  Digit4: 0x7b00,
  Digit5: 0x7c00,
  Digit6: 0x7d00,
  Digit7: 0x7e00,
  Digit8: 0x7f00,
  Digit9: 0x8000,
  Digit0: 0x8100,
  Minus: 0x8200,
  Equal: 0x8300,
};

/** Apple IIgs shifted top-row symbols -> F1..F10 (~arrays+0x1041, seg3+0x0c88). */
const IIGS_SHIFT_SYMBOL_FUNCTION_KEYS: Record<string, number> = {
  "!": AGI_KEY.F1,
  "@": AGI_KEY.F2,
  "#": AGI_KEY.F3,
  $: AGI_KEY.F4,
  "%": AGI_KEY.F5,
  "^": AGI_KEY.F6,
  "&": AGI_KEY.F7,
  "*": AGI_KEY.F8,
  "(": AGI_KEY.F9,
  ")": AGI_KEY.F10,
};

const STANDARD_KEY_EVENTS: Record<string, number> = {
  Backspace: AGI_KEY.BACKSPACE,
  Tab: AGI_KEY.TAB,
  Enter: AGI_KEY.ENTER,
  Escape: AGI_KEY.ESCAPE,
  Home: AGI_KEY.HOME,
  ArrowUp: AGI_KEY.UP,
  PageUp: AGI_KEY.PAGE_UP,
  ArrowLeft: AGI_KEY.LEFT,
  ArrowRight: AGI_KEY.RIGHT,
  End: AGI_KEY.END,
  ArrowDown: AGI_KEY.DOWN,
  PageDown: AGI_KEY.PAGE_DOWN,
  Insert: AGI_KEY.INSERT,
  Delete: AGI_KEY.DELETE,
  ScrollLock: 0x4600,
};

export interface PlatformKeyEvent {
  readonly key: string;
  readonly code?: string;
  readonly location?: number;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
}

function functionKeyIndex(key: string): number | undefined {
  if (!/^F(?:[1-9]|10)$/.test(key)) return undefined;
  return Number(key.slice(1)) - 1;
}

function eventLetter(event: PlatformKeyEvent): string | undefined {
  if (/^[a-z]$/i.test(event.key)) return event.key.toUpperCase();
  if (event.code && /^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  return undefined;
}

/**
 * Translate a keyboard event into the profile's native 16-bit AGI key word
 * (docs/fidelity.md "Original input, menu and modal handling"):
 * - Unmodified Keypad 5 -> 0xf500 (direction 0 stop) on 2.272+, Amiga and
 *   IIgs; ignored on 2.001, 2.089 and 2.230 (`hasKeypadStop`).
 * - Amiga (2.082 h78+0x340/h79, 2.176..2.333 h106+0x358/h107): Help -> F1
 *   (0x3b00), Alt+Help -> 0xff00, Delete -> 0x7f, Ctrl+X -> 0x03 on 2.176+,
 *   Alt+letter/digit/F-key scan words, and Amiga (metaKey) bit 8 (| 0x0100).
 * - Apple IIgs 1.014 (seg3+0x0b95..0x0d2f, ~arrays+0x0ef1..0x107f):
 *   Shift+1..0 (!..)) -> F1..F10 (0x3b00..0x4400), Option (altKey) + letter /
 *   digit 1..0 / '/' (0xff00 sound toggle), and Delete -> Backspace (0x08).
 */
export function translatePlatformKey(
  event: PlatformKeyEvent,
  profileId?: string | null,
): number | undefined {
  if (event.isComposing) return undefined;
  // AltGr is native text entry; do not treat Ctrl+Alt as an Alt shortcut.
  if (event.altKey && event.ctrlKey) return undefined;

  const isKeypad =
    event.location === 3 || (event.code !== undefined && event.code.startsWith("Numpad"));
  if (
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    (event.code === "Numpad5" || (isKeypad && (event.key === "5" || event.key === "Clear")))
  ) {
    return hasKeypadStop(profileId) ? 0xf500 : undefined;
  }

  if (
    isKeypad &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    (profileId === "iigs-1.014" || profileId?.startsWith("amiga-"))
  ) {
    const digit = event.code?.match(/^Numpad([1-9])$/)?.[1] ?? event.key;
    if (/^[1-9]$/.test(digit)) return (0xf0 + Number(digit)) << 8;
  }

  if (profileId === "iigs-1.014") {
    if (event.metaKey) return undefined;
    if (event.ctrlKey) {
      const letter = eventLetter(event);
      return letter ? letter.charCodeAt(0) - 0x40 : undefined;
    }
    if (event.altKey) {
      const letter = eventLetter(event);
      if (letter) return LETTER_ALT_SCANS[letter]! << 8;
      if (event.key === "/" || event.code === "Slash") return 0xff00;
      const topScan =
        (event.code ? TOP_ROW_ALT_SCANS[event.code] : undefined) ?? TOP_ROW_ALT_SCANS[event.key];
      if (topScan !== undefined && topScan <= 0x8100) return topScan;
      return undefined;
    }
    if (!isKeypad) {
      const fnFromShift = IIGS_SHIFT_SYMBOL_FUNCTION_KEYS[event.key];
      if (fnFromShift !== undefined) return fnFromShift;
    }
    if (event.key === "Delete" || event.key === "Backspace") return AGI_KEY.BACKSPACE;
    const fIdx = functionKeyIndex(event.key);
    if (fIdx !== undefined) return AGI_KEY.F1 + (fIdx << 8);
    if (event.shiftKey && event.key.length !== 1) return undefined;
    return (
      STANDARD_KEY_EVENTS[event.key] ??
      (event.key.length === 1 && event.key.charCodeAt(0) <= 0x7f
        ? event.key.charCodeAt(0)
        : undefined)
    );
  }

  if (profileId !== undefined && profileId !== null && profileId.startsWith("amiga-")) {
    const withMeta = (word: number | undefined): number | undefined =>
      word !== undefined && word !== 0 && event.metaKey ? word | 0x0100 : word;
    if (event.ctrlKey) {
      let letter = eventLetter(event);
      if (!letter) return undefined;
      if (profileId !== "amiga-2.082" && letter === "X") letter = "C";
      return withMeta(letter.charCodeAt(0) - 0x40);
    }
    if (event.altKey) {
      if (event.key === "Help") return withMeta(0xff00);
      const fIdx = functionKeyIndex(event.key);
      if (fIdx !== undefined) return withMeta((0x68 + fIdx) << 8);
      const letter = eventLetter(event);
      if (letter) return withMeta(LETTER_ALT_SCANS[letter]! << 8);
      const topScan =
        (event.code ? TOP_ROW_ALT_SCANS[event.code] : undefined) ?? TOP_ROW_ALT_SCANS[event.key];
      return withMeta(topScan);
    }
    if (event.key === "Help") return withMeta(AGI_KEY.F1);
    if (event.key === "Delete") return withMeta(0x7f);
    const fIdx = functionKeyIndex(event.key);
    if (fIdx !== undefined) return withMeta(AGI_KEY.F1 + (fIdx << 8));
    if (event.shiftKey && event.key.length !== 1) return undefined;
    return withMeta(
      STANDARD_KEY_EVENTS[event.key] ??
        (event.key.length === 1 && event.key.charCodeAt(0) <= 0x7f
          ? event.key.charCodeAt(0)
          : undefined),
    );
  }

  // PC (2.001..3.002.149)
  if (event.metaKey) return undefined;
  const fIdx = functionKeyIndex(event.key);
  if (event.altKey) {
    if (fIdx !== undefined) return (0x68 + fIdx) << 8;
    const letter = eventLetter(event);
    if (letter) return LETTER_ALT_SCANS[letter]! << 8;
    return (event.code ? TOP_ROW_ALT_SCANS[event.code] : undefined) ?? TOP_ROW_ALT_SCANS[event.key];
  }
  if (event.ctrlKey) {
    if (fIdx !== undefined) return (0x5e + fIdx) << 8;
    const letter = eventLetter(event);
    return letter ? letter.charCodeAt(0) - 0x40 : undefined;
  }
  if (event.shiftKey) {
    if (fIdx !== undefined) return (0x54 + fIdx) << 8;
    if (event.key.length !== 1) return undefined;
  }
  if (fIdx !== undefined) return AGI_KEY.F1 + (fIdx << 8);
  return (
    STANDARD_KEY_EVENTS[event.key] ??
    (event.key.length === 1 && event.key.charCodeAt(0) <= 0x7f
      ? event.key.charCodeAt(0)
      : undefined)
  );
}

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

/** A sampled joystick position; the adapter supplies the platform's native axis scale. */
export interface JoystickSample {
  readonly x: number;
  readonly y: number;
  readonly button1?: boolean;
  readonly button2?: boolean;
}

/** Validate browser axes before an input message becomes interpreter input. */
export function isJoystickSample(value: unknown, axisLimit = 1): value is JoystickSample {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return (
    Object.keys(s).every((k) => ["x", "y", "button1", "button2"].includes(k)) &&
    typeof s["x"] === "number" &&
    Number.isFinite(s["x"]) &&
    Math.abs(s["x"]) <= axisLimit &&
    typeof s["y"] === "number" &&
    Number.isFinite(s["y"]) &&
    Math.abs(s["y"]) <= axisLimit &&
    (s["button1"] === undefined || typeof s["button1"] === "boolean") &&
    (s["button2"] === undefined || typeof s["button2"] === "boolean")
  );
}
