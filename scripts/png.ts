/**
 * Minimal PNG encoder for eval tooling (Node only: uses node:zlib for the
 * IDAT stream). Encodes an AGI 160x168 nibble surface as an RGB PNG using
 * the EGA palette, scaled 4x horizontally and 2x vertically (640x336) so the
 * 2:1 logical pixel aspect of the original display is preserved.
 */

import { deflateSync, inflateSync } from "node:zlib";

/** The authentic 16-colour EGA palette, RGB. */
const EGA_RGB: readonly [number, number, number][] = [
  [0x00, 0x00, 0x00],
  [0x00, 0x00, 0xaa],
  [0x00, 0xaa, 0x00],
  [0x00, 0xaa, 0xaa],
  [0xaa, 0x00, 0x00],
  [0xaa, 0x00, 0xaa],
  [0xaa, 0x55, 0x00],
  [0xaa, 0xaa, 0xaa],
  [0x55, 0x55, 0x55],
  [0x55, 0x55, 0xff],
  [0x55, 0xff, 0x55],
  [0x55, 0xff, 0xff],
  [0xff, 0x55, 0x55],
  [0xff, 0x55, 0xff],
  [0xff, 0xff, 0x55],
  [0xff, 0xff, 0xff],
];

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode 8-bit RGB pixels (row-major, 3 bytes per pixel) as a PNG file. */
export function encodePngRgb(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const idat = new Uint8Array(deflateSync(raw));
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}

export interface SurfacePngOptions {
  scaleX?: number;
  scaleY?: number;
  /** Map a nibble to RGB; default EGA. Priority views pass a band palette. */
  palette?: readonly [number, number, number][];
}

/** Encode a 160x168 nibble surface as a scaled PNG. */
export function surfaceToPng(
  nibbles: Uint8Array,
  width: number,
  height: number,
  opts?: SurfacePngOptions,
): Uint8Array {
  const sx = opts?.scaleX ?? 4;
  const sy = opts?.scaleY ?? 2;
  const palette = opts?.palette ?? EGA_RGB;
  const w = width * sx;
  const h = height * sy;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const srcRow = Math.floor(y / sy) * width;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = palette[nibbles[srcRow + Math.floor(x / sx)]! & 0x0f]!;
      const o = (y * w + x) * 3;
      rgb[o] = r;
      rgb[o + 1] = g;
      rgb[o + 2] = b;
    }
  }
  return encodePngRgb(w, h, rgb);
}

/**
 * Two surfaces side by side with a 8-pixel white gutter (left = A, right = B),
 * for the vision judge.
 */
export function sideBySidePng(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const sx = 4;
  const sy = 2;
  const gutter = 8;
  const w = width * sx * 2 + gutter;
  const h = height * sy;
  const rgb = new Uint8Array(w * h * 3).fill(0xff);
  const blit = (src: Uint8Array, offsetX: number): void => {
    for (let y = 0; y < h; y++) {
      const srcRow = Math.floor(y / sy) * width;
      for (let x = 0; x < width * sx; x++) {
        const [r, g, bl] = EGA_RGB[src[srcRow + Math.floor(x / sx)]! & 0x0f]!;
        const o = (y * w + offsetX + x) * 3;
        rgb[o] = r;
        rgb[o + 1] = g;
        rgb[o + 2] = bl;
      }
    }
  };
  blit(a, 0);
  blit(b, width * sx + gutter);
  return encodePngRgb(w, h, rgb);
}

/** Side-by-side crop of two surfaces over the same box (padded), scaled 4x2. */
export function cropSideBySidePng(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  box: { x0: number; y0: number; x1: number; y1: number },
  pad = 6,
): Uint8Array {
  const x0 = Math.max(0, box.x0 - pad);
  const y0 = Math.max(0, box.y0 - pad);
  const x1 = Math.min(width - 1, box.x1 + pad);
  const y1 = Math.min(height - 1, box.y1 + pad);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const sub = (src: Uint8Array): Uint8Array => {
    const out = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) out[y * cw + x] = src[(y0 + y) * width + x0 + x]!;
    return out;
  };
  return sideBySidePng(sub(a), sub(b), cw, ch);
}

interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  rgba: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Decode an 8-bit non-interlaced RGB or RGBA PNG to RGBA. */
export function decodePng(bytes: Uint8Array): DecodedPng {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("not a PNG file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (data[10] !== 0) throw new Error("compressed PNGs only (method 0)");
      if (data[12] !== 0) throw new Error("interlaced PNGs are not supported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(
      `unsupported PNG: bit depth ${bitDepth}, colour type ${colorType} (need 8-bit RGB or RGBA)`,
    );
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;

  const concat = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of idat) {
    concat.set(c, off);
    off += c.length;
  }
  const raw = new Uint8Array(inflateSync(concat));
  if (raw.length < (stride + 1) * height) throw new Error("truncated PNG image data");

  // Undo the per-scanline filters (PNG spec 9.2); `prior` is the reconstructed
  // previous row, all zero for the first.
  const out = new Uint8Array(stride * height);
  let prior = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels]! : 0;
      const b = prior[i]!;
      const c = i >= channels ? prior[i - channels]! : 0;
      const x = src[i]!;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`unknown PNG filter type ${filter} on row ${y}`);
      }
      row[i] = value & 0xff;
    }
    prior = row;
  }

  if (channels === 4) return { width, height, rgba: out };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = out[i * 3]!;
    rgba[i * 4 + 1] = out[i * 3 + 1]!;
    rgba[i * 4 + 2] = out[i * 3 + 2]!;
    rgba[i * 4 + 3] = 0xff;
  }
  return { width, height, rgba };
}
