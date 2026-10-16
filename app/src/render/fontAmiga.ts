/**
 * The Amiga text font: a recreation of the Amiga Topaz 8 bitmap design, the
 * system font the six Amiga interpreters open (`topaz.font`, 8 px, from the
 * Kickstart ROM; docs/fidelity.md "Amiga screen, font and pointer"). The
 * table is this project's own source, matched pixel for pixel to the
 * original's printable ASCII so game text lands exactly where the Amiga put
 * it: an 8 px cell and advance, capitals on rows 0..6, the baseline on row
 * 6, lowercase bodies on rows 2..6 and descenders on row 7. Bitmap typeface
 * designs carry no ROM data: no ROM or font file ships, and nothing is read
 * from a ROM at build or run time. `app/test/font-amiga-provenance.test.ts`
 * checks the table against a contributor's local Kickstart 1.3 ROM when one
 * is present.
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
  "!": "183c3c1818001800",
  '"': "6c6c000000000000",
  "#": "6c6cfe6cfe6c6c00",
  "$": "183e603c067c1800",
  "%": "00c6cc183066c600",
  "&": "386c6876dccc7600",
  "'": "1818300000000000",
  "(": "0c18303030180c00",
  ")": "30180c0c0c183000",
  "*": "00663cff3c660000",
  "+": "0018187e18180000",
  ",": "0000000000181830",
  "-": "0000007e00000000",
  ".": "0000000000181800",
  "/": "03060c183060c000",
  "0": "3c666e7e76663c00",
  "1": "1838181818187e00",
  "2": "3c66061c30667e00",
  "3": "3c66061c06663c00",
  "4": "1c3c6cccfe0c1e00",
  "5": "7e607c0606663c00",
  "6": "1c30607c66663c00",
  "7": "7e66060c18181800",
  "8": "3c66663c66663c00",
  "9": "3c66663e060c3800",
  ":": "0018180000181800",
  ";": "0018180000181830",
  "<": "0c18306030180c00",
  "=": "00007e00007e0000",
  ">": "30180c060c183000",
  "?": "3c66060c18001800",
  "@": "7cc6dededec07800",
  "A": "183c3c667ec3c300",
  "B": "fc66667c6666fc00",
  "C": "3c66c0c0c0663c00",
  "D": "f86c6666666cf800",
  "E": "fe6660786066fe00",
  "F": "fe6660786060f000",
  "G": "3c66c0cec6663e00",
  "H": "6666667e66666600",
  "I": "7e18181818187e00",
  "J": "0e06060666663c00",
  "K": "e6666c786c66e600",
  "L": "f06060606266fe00",
  "M": "82c6eefed6c6c600",
  "N": "c6e6f6decec6c600",
  "O": "386cc6c6c66c3800",
  "P": "fc66667c6060f000",
  "Q": "386cc6c6c66c3c06",
  "R": "fc66667c6c66e300",
  "S": "3c6670380e663c00",
  "T": "7e5a181818183c00",
  "U": "6666666666663e00",
  "V": "c3c366663c3c1800",
  "W": "c6c6c6d6feeec600",
  "X": "c3663c183c66c300",
  "Y": "c3c3663c18183c00",
  "Z": "fec68c183266fe00",
  "[": "3c30303030303c00",
  "\\": "c06030180c060300",
  "]": "3c0c0c0c0c0c3c00",
  "^": "10386cc600000000",
  "_": "00000000000000fe",
  "`": "18180c0000000000",
  "a": "00003c061e663b00",
  "b": "e0606c7666663c00",
  "c": "00003c6660663c00",
  "d": "0e06366e66663b00",
  "e": "00003c667e603c00",
  "f": "1c36307830307800",
  "g": "00003b66663cc67c",
  "h": "e0606c766666e600",
  "i": "1800381818183c00",
  "j": "060006060606663c",
  "k": "e060666c786ce600",
  "l": "3818181818183c00",
  "m": "000066776b636300",
  "n": "00007c6666666600",
  "o": "00003c6666663c00",
  "p": "0000dc66667c60f0",
  "q": "00003d66663e0607",
  "r": "0000ec766660f000",
  "s": "00003e603c067c00",
  "t": "08183e18181a0c00",
  "u": "0000666666663b00",
  "v": "00006666663c1800",
  "w": "0000636b6b363600",
  "x": "000063361c366300",
  "y": "00006666663c1870",
  "z": "00007e4c18327e00",
  "{": "0e18187018180e00",
  "|": "1818181818181800",
  "}": "7018180e18187000",
  "~": "729c000000000000",
};

/** Packed glyph rows: FONT[code * 8 + row], bit 7 = leftmost pixel. */
export const AMIGA_FONT = new Uint8Array(PC_FONT);
/** 1 for each code this font draws. */
export const AMIGA_HAS_GLYPH = new Uint8Array(PC_HAS_GLYPH);

// The save dialog's slot pointer, read off a MAME frame of SQ2 2.202's slot
// window (docs/fidelity.md "Original Amiga save and restore dialogs").
GLYPHS["\u00bb"] = "00cc663366cc0000";

for (const [key, hex] of Object.entries(GLYPHS)) {
  const code = key.charCodeAt(0);
  if (hex.length !== 16) throw new Error(`glyph ${key}: expected 16 hex digits`);
  AMIGA_HAS_GLYPH[code] = 1;
  for (let y = 0; y < 8; y++) AMIGA_FONT[code * 8 + y] = parseInt(hex.slice(y * 2, y * 2 + 2), 16);
}
