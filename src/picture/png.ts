/**
 * Minimal PNG encoder for the engine core: zero dependencies, no `node:*`,
 * no browser APIs. Runs in the browser, a Web Worker and Node.
 *
 * The agent's `write_picture` tool returns the rendered room to the model as
 * an image block, so the encoder has to live in `src/` next to the renderer
 * rather than in `scripts/` (which may use `node:zlib`). Compression is not
 * worth a DEFLATE implementation here: the IDAT stream uses *stored* (BTYPE
 * 00, uncompressed) deflate blocks wrapped in a zlib container, which every
 * PNG decoder accepts. A 320x336 RGB frame is ~320 KB — fine for one tool
 * result, and exact.
 */

/** The authentic 16-colour EGA palette, RGB. */
export const EGA_RGB: readonly (readonly [number, number, number])[] = [
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

/** Adler-32 over the uncompressed data, as the zlib trailer requires. */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Max payload of one stored deflate block (LEN is u16). */
const STORED_BLOCK_MAX = 0xffff;

/** zlib stream (CMF/FLG + stored deflate blocks + Adler-32) over `raw`. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / STORED_BLOCK_MAX));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  let p = 0;
  out[p++] = 0x78; // CM=8 (deflate), CINFO=7 (32K window)
  out[p++] = 0x01; // FCHECK so (0x78<<8|0x01) % 31 === 0, no preset dict, level 0
  for (let i = 0; i < blocks; i++) {
    const start = i * STORED_BLOCK_MAX;
    const len = Math.min(STORED_BLOCK_MAX, raw.length - start);
    out[p++] = i === blocks - 1 ? 1 : 0; // BFINAL, BTYPE=00 (stored)
    out[p++] = len & 0xff;
    out[p++] = (len >> 8) & 0xff;
    out[p++] = ~len & 0xff;
    out[p++] = (~len >> 8) & 0xff;
    out.set(raw.subarray(start, start + len), p);
    p += len;
  }
  const sum = adler32(raw);
  out[p] = (sum >>> 24) & 0xff;
  out[p + 1] = (sum >>> 16) & 0xff;
  out[p + 2] = (sum >>> 8) & 0xff;
  out[p + 3] = sum & 0xff;
  return out;
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
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`png: bad dimensions ${width}x${height}`);
  }
  const stride = width * 3;
  if (rgb.length !== stride * height) {
    throw new RangeError(`png: expected ${stride * height} RGB bytes, got ${rgb.length}`);
  }
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
  ihdr[9] = 2; // colour type: truecolour RGB
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}

export interface SurfacePngOptions {
  /** Integer nearest-neighbour scale, both axes. Default 2. */
  scale?: number;
  /** Map a nibble to RGB; default EGA. */
  palette?: readonly (readonly [number, number, number])[];
}

/**
 * Encode a nibble surface (one byte per logical pixel, values 0..15) as a
 * nearest-neighbour upscaled RGB PNG using the EGA palette.
 */
export function surfaceToPng(
  nibbles: Uint8Array,
  width: number,
  height: number,
  opts?: SurfacePngOptions,
): Uint8Array {
  const scale = Math.max(1, Math.floor(opts?.scale ?? 2));
  const palette = opts?.palette ?? EGA_RGB;
  const w = width * scale;
  const h = height * scale;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const srcRow = ((y / scale) | 0) * width;
    for (let x = 0; x < w; x++) {
      const entry = palette[nibbles[srcRow + ((x / scale) | 0)]! & 0x0f]!;
      const o = (y * w + x) * 3;
      rgb[o] = entry[0];
      rgb[o + 1] = entry[1];
      rgb[o + 2] = entry[2];
    }
  }
  return encodePngRgb(w, h, rgb);
}
