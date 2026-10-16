/**
 * The Amiga text font: this project's own 8×8 bitmap, designed to the
 * metrics of the system font the six Amiga interpreters open (`topaz.font`,
 * 8 px, from the Kickstart ROM; docs/fidelity.md "Amiga screen, font and
 * pointer"): an 8 px cell and advance, capitals and ascenders on rows 0..6,
 * the baseline on row 6, lowercase bodies on rows 2..6 and descenders on
 * row 7, the same character coverage. The glyph bitmaps are an independent
 * design, drawn without the ROM's strike in view and checked against it by
 * `app/test/font-amiga-provenance.test.ts` (only single-stroke marks may
 * coincide): a two-pixel stroke on a six-column body with one-pixel corner
 * cuts, square counters, no serifs, a dotted zero and a tailed Q, which
 * reads as bold and boxy the way the Amiga's own text did.
 *
 * Each glyph is 16 hex digits, two per row from the top, bit 7 the leftmost
 * pixel. Codes 0x01..0x07 (the engine's window glyphs) and the PC code-page
 * glyphs come from the project font, so an engine-owned window or a Gold
 * Rush! box character draws the same on every platform.
 */
import { FONT as PC_FONT, HAS_GLYPH as PC_HAS_GLYPH } from "./font8x8.ts";

// prettier-ignore
const GLYPHS: Record<string, string> = {
  " ": "0000000000000000",
  "!": "3030303030003000",
  '"': "6c6c480000000000",
  "#": "0028fc28fc280000",
  "$": "107c907c147c1000",
  "%": "c4c80810204c8c00",
  "&": "3048483048d49800",
  "'": "3030100000000000",
  "(": "1c30606060301c00",
  ")": "c060303030c0c000",
  "*": "006c38fe386c0000",
  "+": "0030307830300000",
  ",": "0000000000303060",
  "-": "0000007800000000",
  ".": "0000000000303000",
  "/": "0408102040800000",
  "0": "78ccccdceccc7800",
  "1": "30f030303030fc00",
  "2": "78cc0c187060fc00",
  "3": "fc180c380ccc7800",
  "4": "1c3c6cccfe0c0c00",
  "5": "fcc0f80c0ccc7800",
  "6": "3860c0f8cccc7800",
  "7": "fccc0c1830303000",
  "8": "78cccc78cccc7800",
  "9": "78cccc7c0c187000",
  ":": "0030300030300000",
  ";": "0030300030306000",
  "<": "1830 60c0603018 00",
  "=": "0000fc00fc000000",
  ">": "c06030183060c000",
  "?": "78cc0c1830003000",
  "@": "7884b4b4b8807800",
  "A": "3078ccccfccccc00",
  "B": "f8ccccf8ccccf800",
  "C": "78ccc0c0c0cc7800",
  "D": "f0d8ccccccd8f000",
  "E": "fcc0c0f8c0c0fc00",
  "F": "fcc0c0f8c0c0c000",
  "G": "78ccc0dcccccfc00",
  "H": "ccccccfccccccc00",
  "I": "fc30303030 30fc00",
  "J": "0c0c0c0c0ccc7800",
  "K": "ccd8f0e0f0d8cc00",
  "L": "c0c0c0c0c0c0fc00",
  "M": "c6eefed6c6c6c600",
  "N": "c6e6f6dececec600",
  "O": "78cccccccccc7800",
  "P": "f8ccccf8c0c0c000",
  "Q": "78cccccccccc780c",
  "R": "f8ccccf8d8cccc00",
  "S": "78ccc0780ccc7800",
  "T": "fc30303030303000",
  "U": "cccccccccccc7800",
  "V": "cccccccccc783000",
  "W": "c6c6c6d6fefec600",
  "X": "cccc783078cccc00",
  "Y": "cccccc7830303000",
  "Z": "fc0c183060c0fc00",
  "[": "7860606060607800",
  "\\": "8040201008040000",
  "]": "780c0c0c0c0c7800",
  "^": "30786c0000000000",
  "_": "00000000000000fc",
  "`": "6030180000000000",
  "a": "0000780c7ccc7c00",
  "b": "c0c0f8ccccccf800",
  "c": "000078ccc0cc7800",
  "d": "0c0c7ccccccc7c00",
  "e": "000078ccfcc07800",
  "f": "3860f86060606000",
  "g": "00007ccccc7c0c78",
  "h": "c0c0f8cccccccc00",
  "i": "3000703030307800",
  "j": "0c003c0c0c0ccc78",
  "k": "c0c0ccd8f0d8cc00",
  "l": "7030303030307800",
  "m": "0000ecfed6d6c600",
  "n": "0000f8cccccccc00",
  "o": "000078cccccc7800",
  "p": "0000f8ccccf8c0c0",
  "q": "00007ccccc7c0c0c",
  "r": "0000d8ecc0c0c000",
  "s": "00007cc0780cf800",
  "t": "3030fc3030301c00",
  "u": "0000cccccccc7c00",
  "v": "0000cccccc783000",
  "w": "0000c6d6d6fe6c00",
  "x": "0000cc783078cc00",
  "y": "0000cccccc7c0c78",
  "z": "0000fc183060fc00",
  "{": "1c30306030301c00",
  "|": "3030303030303000",
  "}": "e03030183030e000",
  "~": "76dc000000000000",
};

/** Packed glyph rows: FONT[code * 8 + row], bit 7 = leftmost pixel. */
export const AMIGA_FONT = new Uint8Array(PC_FONT);
/** 1 for each code this font draws. */
export const AMIGA_HAS_GLYPH = new Uint8Array(PC_HAS_GLYPH);

for (const [key, hex] of Object.entries(GLYPHS)) {
  const code = key.charCodeAt(0);
  const digits = hex.replaceAll(" ", "");
  if (digits.length !== 16) throw new Error(`glyph ${key}: expected 16 hex digits`);
  AMIGA_HAS_GLYPH[code] = 1;
  for (let y = 0; y < 8; y++)
    AMIGA_FONT[code * 8 + y] = parseInt(digits.slice(y * 2, y * 2 + 2), 16);
}
