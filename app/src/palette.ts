/** The authentic 16-color EGA palette, RGB. */
export const EGA_PALETTE: readonly [number, number, number][] = [
  [0x00, 0x00, 0x00], // 0 black
  [0x00, 0x00, 0xaa], // 1 blue
  [0x00, 0xaa, 0x00], // 2 green
  [0x00, 0xaa, 0xaa], // 3 cyan
  [0xaa, 0x00, 0x00], // 4 red
  [0xaa, 0x00, 0xaa], // 5 magenta
  [0xaa, 0x55, 0x00], // 6 brown
  [0xaa, 0xaa, 0xaa], // 7 light gray
  [0x55, 0x55, 0x55], // 8 dark gray
  [0x55, 0x55, 0xff], // 9 light blue
  [0x55, 0xff, 0x55], // 10 light green
  [0x55, 0xff, 0xff], // 11 light cyan
  [0xff, 0x55, 0x55], // 12 light red
  [0xff, 0x55, 0xff], // 13 light magenta
  [0xff, 0xff, 0x55], // 14 yellow
  [0xff, 0xff, 0xff], // 15 white
];

/** Expand a 160x168 nibble buffer into an RGBA ImageData buffer. */
export function surfaceToRgba(visual: Uint8Array, out: Uint8ClampedArray): void {
  for (let i = 0; i < visual.length; i++) {
    const [r, g, b] = EGA_PALETTE[visual[i]! & 0x0f]!;
    const o = i * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = 255;
  }
}
