/**
 * Decode a player's AGIFONT QuickDraw II strike into fixed 8×8 cells.
 * SQ2 1.014 metrics and record layout: docs/fidelity.md "Apple IIgs presentation".
 * Unsupported or malformed auxiliary data leaves the project font available.
 */
export function readIigsFont(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.length < 38 || bytes.length > 65_536) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (at: number) => view.getUint16(at, true);
  const record = word(0) * 2;
  if (record < 12 || record + 26 > bytes.length) return undefined;
  const first = word(record + 2);
  const last = word(record + 4);
  const kern = view.getInt16(record + 8, true);
  const stride = word(record + 24) * 2;
  if (
    first > last ||
    last > 255 ||
    word(record + 6) !== 8 ||
    word(record + 14) !== 8 ||
    word(record + 18) !== 7 ||
    word(record + 20) !== 1 ||
    word(record + 22) !== 0 ||
    stride === 0
  )
    return undefined;
  const count = last - first + 2; // Including the missing-character glyph.
  const strike = record + 26;
  const widths = record + 16 + word(record + 16) * 2;
  const locations = widths - (count + 1) * 2;
  if (locations < strike + stride * 8 || widths + (count + 1) * 2 > bytes.length) return undefined;
  for (let i = 0; i < count; i++) {
    const left = word(locations + i * 2);
    const right = word(locations + (i + 1) * 2);
    if (left > right || right > stride * 8) return undefined;
  }
  if (word(widths + (count - 1) * 2) === 0xffff) return undefined;
  const font = new Uint8Array(256 * 8);
  for (let code = 0; code < 256; code++) {
    let index = code >= first && code <= last ? code - first : count - 1;
    if (word(widths + index * 2) === 0xffff) index = count - 1;
    const offset = (word(widths + index * 2) >> 8) + kern;
    const left = word(locations + index * 2);
    const right = word(locations + (index + 1) * 2);
    for (let x = Math.max(0, -offset); x < Math.min(right - left, 8 - offset); x++) {
      const bit = left + x;
      for (let y = 0; y < 8; y++) {
        if (bytes[strike + y * stride + (bit >> 3)]! & (0x80 >> (bit & 7)))
          font[code * 8 + y]! |= 0x80 >> (offset + x);
      }
    }
  }
  return font;
}
