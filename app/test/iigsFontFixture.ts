/** Original synthetic QuickDraw II strike: A has a two-pixel diagonal; B is blank. */
export function iigsFontFixture(): Uint8Array {
  const bytes = new Uint8Array(70);
  const view = new DataView(bytes.buffer);
  const word = (offset: number, value: number) => view.setInt16(offset, value, true);
  word(0, 6); // Macintosh record starts at byte 12.
  word(14, 65);
  word(16, 66);
  word(18, 8);
  word(20, -1);
  word(26, 8);
  word(28, 17);
  word(30, 7);
  word(32, 1);
  word(36, 1);
  // Eight rows of a sixteen-bit strike: A uses bits 0..1, missing uses 2..3.
  bytes[38] = 0xa0;
  bytes[40] = 0x50;
  [0, 2, 2, 4].forEach((value, i) => word(54 + i * 2, value));
  word(62, 0x0208); // A: left bearing 2 + kernMax(-1) = 1; advance 8.
  word(64, 0x0108); // B: defined blank.
  word(66, 0x0108); // Missing: zero bearing.
  return bytes;
}
