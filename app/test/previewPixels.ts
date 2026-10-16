import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

export function previewPixels(dataUrl: string): { width: number; height: number; rgb: Uint8Array } {
  const png = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (char) =>
    char.charCodeAt(0),
  );
  const chunks = new Map<string, Uint8Array>();
  let offset = 8;
  while (offset < png.length) {
    const view = new DataView(png.buffer, png.byteOffset + offset);
    const length = view.getUint32(0);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    chunks.set(type, png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const header = chunks.get("IHDR")!;
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = headerView.getUint32(0);
  const height = headerView.getUint32(4);
  assert.equal(header[8], 8);
  assert.equal(header[9], 3);
  const palette = chunks.get("PLTE")!;
  const raw = new Uint8Array(inflateSync(chunks.get("IDAT")!));
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1);
    assert.equal(raw[row], 0);
    for (let x = 0; x < width; x++) {
      const color = raw[row + x + 1]! * 3;
      rgb.set(palette.subarray(color, color + 3), (y * width + x) * 3);
    }
  }
  return { width, height, rgb };
}
