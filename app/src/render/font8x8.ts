/**
 * Recreation of the IBM PC BIOS graphics bitmap typeface, pixel for pixel
 * in eight-pixel cells. The interpreter reads F000:FA6E for printable text
 * (docs/fidelity.md "PC fonts and display adapters"). The source table is
 * credited as a recreation; no ROM or font file ships or is read at build
 * or runtime. Optional local-reference tests check the recreation.
 *
 * Engine glyph codes 0x01..0x07 retain the released checkpoint masks.
 */
import {
  GLYPH_BL,
  GLYPH_BR,
  GLYPH_CURSOR,
  GLYPH_H,
  GLYPH_TL,
  GLYPH_TR,
  GLYPH_V,
} from "../../../src/runtime/textSurface.ts";

// Printable BIOS graphics typeface, codes 0x20..0x7f in order. Each pair
// is one row, bit 7 leftmost. This is a recreation, not a ROM/font file.
const ASCII = `
0000000000000000 183c3c1818001800 3636360000000000 36367f367f363600
183e603c067c1800 0063660c18336300 1c361c3b6e663b00 1818300000000000
0c18303030180c00 30180c0c0c183000 00663cff3c660000 0018187e18180000
0000000000181830 0000007e00000000 0000000000181800 03060c183060c000
3e63676f7b733e00 1838181818187e00 3c66061c30667e00 3c66061c06663c00
0e1e36667f060f00 7e607c0606663c00 1c30607c66663c00 7e66060c18181800
3c66663c66663c00 3c66663e060c3800 0018180000181800 0018180000181830
060c1830180c0600 00007e007e000000 30180c060c183000 3c66060c18001800
3e636f6f6f603c00 1c3663637f636300 7e33333e33337e00 1e33606060331e00
7c36333333367c00 7f31343c34317f00 7f31343c34307800 1e33606067331f00
6666667e66666600 3c18181818183c00 0f06060666663c00 7333363c36337300
7830303031337f00 63777f7f6b636300 63737b6f67636300 3e63636363633e00
7e33333e30307800 3e636363636f3e03 7e33333e36337300 3c6670380e663c00
7e5a181818183c00 6363636363633e00 66666666663c1800 6363636b7f776300
6363361c1c366300 6666663c18183c00 7f63460c19337f00 3c30303030303c00
6030180c06030100 3c0c0c0c0c0c3c00 081c360000000000 00000000000000ff
18180c0000000000 00003c063e663b00 70303e3333336e00 00003c6660663c00
0e063e6666663b00 00003c667e603c00 1c36307830307800 00003b66663e067c
7030363b33337300 1800381818183c00 06000e060666663c 703033363c367300
3818181818183c00 0000e67f7f6b6300 00006e3333333300 00003c6666663c00
00006e33333e3078 00003b66663e060f 00006e3b33307800 00003e603c067c00
10307c3030361c00 0000666666663b00 00006666663c1800 0000636b7f7f3600
000063361c366300 00006666663e067c 00007e4c18327e00 0e18187018180e00
1818180018181800 7018180e18187000 3b6e000000000000 00081c3663637f00`;

const GLYPHS: [number | string, string][] = [
  // Engine box-drawing and cursor glyphs at the 1.x checkpoint codes
  // 0x01..0x07: host-image checkpoints (format version 1) store these bytes
  // verbatim, so the masks stay the pre-9f506052 thin single lines through
  // cell row 3 / column 3 and the solid two-row cursor forever.
  [GLYPH_H, "........ ........ ........ ######## ........ ........ ........ ........"],
  [GLYPH_V, "...#.... ...#.... ...#.... ...#.... ...#.... ...#.... ...#.... ...#...."],
  [GLYPH_TL, "........ ........ ........ ...##### ...#.... ...#.... ...#.... ...#...."],
  [GLYPH_TR, "........ ........ ........ ####.... ...#.... ...#.... ...#.... ...#...."],
  [GLYPH_BL, "...#.... ...#.... ...#.... ...##### ........ ........ ........ ........"],
  [GLYPH_BR, "...#.... ...#.... ...#.... ####.... ........ ........ ........ ........"],
  [GLYPH_CURSOR, "........ ........ ........ ........ ........ ........ ######## ########"],
  // The PC code page's box drawing that Gold Rush! prints in its messages
  // (docs/fidelity.md "Text beyond ASCII"), in the same line style: single
  // lines through row 3 / column 3, double verticals in columns 2 and 4.
  [0xb3, "...#.... ...#.... ...#.... ...#.... ...#.... ...#.... ...#.... ...#...."],
  [0xb7, "........ ........ ........ #####... ..#.#... ..#.#... ..#.#... ..#.#..."],
  [0xba, "..#.#... ..#.#... ..#.#... ..#.#... ..#.#... ..#.#... ..#.#... ..#.#..."],
  [0xbd, "..#.#... ..#.#... ..#.#... #####... ........ ........ ........ ........"],
  [0xc1, "...#.... ...#.... ...#.... ######## ........ ........ ........ ........"],
  [0xc2, "........ ........ ........ ######## ...#.... ...#.... ...#.... ...#...."],
  [0xc4, "........ ........ ........ ######## ........ ........ ........ ........"],
  [0xd0, "..#.#... ..#.#... ..#.#... ######## ........ ........ ........ ........"],
  [0xd2, "........ ........ ........ ######## ..#.#... ..#.#... ..#.#... ..#.#..."],
  [0xd3, "..#.#... ..#.#... ..#.#... ..###### ........ ........ ........ ........"],
  [0xd6, "........ ........ ........ ..###### ..#.#... ..#.#... ..#.#... ..#.#..."],
  // The code page's non-breaking space, which King's Quest II prints.
  [0xff, "........ ........ ........ ........ ........ ........ ........ ........"],
];

/** Packed glyph rows: FONT[code * 8 + row], bit 7 = leftmost pixel. */
export const FONT = new Uint8Array(256 * 8);
/** 1 for each code this font draws. */
export const HAS_GLYPH = new Uint8Array(256);

for (const [key, art] of GLYPHS) {
  const code = typeof key === "number" ? key : key.charCodeAt(0);
  HAS_GLYPH[code] = 1;
  const rows = art.split(" ");
  if (rows.length !== 8) throw new Error(`glyph ${key}: expected 8 rows`);
  rows.forEach((r, y) => {
    if (r.length !== 8) throw new Error(`glyph ${key} row ${y}: expected 8 columns`);
    let bits = 0;
    for (let x = 0; x < 8; x++) if (r[x] === "#") bits |= 0x80 >> x;
    FONT[code * 8 + y] = bits;
  });
}

for (const [index, glyph] of ASCII.trim().split(/\s+/).entries()) {
  const code = index + 0x20;
  HAS_GLYPH[code] = 1;
  for (let row = 0; row < 8; row++)
    FONT[code * 8 + row] = parseInt(glyph.slice(row * 2, row * 2 + 2), 16);
}
