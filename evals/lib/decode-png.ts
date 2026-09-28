/**
 * Node stand-in for the browser image decoder: reads the stored-deflate RGB
 * PNGs the evals draw by script (encodePngRgb) back into RGBA pixels, so a
 * reference source can hand view_reference its pixels outside a browser.
 */
import { inflateSync } from "node:zlib";

export async function decodePng(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const idat: Uint8Array[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === "IDAT")
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      rgba.set([raw[at]!, raw[at + 1]!, raw[at + 2]!, 255], (y * width + x) * 4);
    }
  return { width, height, rgba };
}
