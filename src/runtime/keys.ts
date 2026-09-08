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
