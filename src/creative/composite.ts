/**
 * The platform-free selection composite and its locally encoded original.
 *
 * `compositeSelection` is the single shared pixel transform behind Edit
 * Use: it writes the provider's canonical pixels — proportionally
 * resampled with the declared floor/ceil edge mapping — into the reviewed
 * rectangle of the base's canonical raster and leaves every byte outside
 * the rectangle untouched. No browser globals, no canvas: the composite's
 * encoded original is produced by `encodePngRgba`, a deterministic RGBA
 * PNG writer (filter 0, stored deflate blocks, sRGB chunk) so the bytes a
 * record claims can be recomputed and compared exactly at every admission
 * boundary.
 *
 * `checkCompositeSourceBytes` is the strict semantic gate used by the
 * issuer stage and by private archive admission: for every source that
 * declares a selection-composite derivation it resolves the two parent
 * records, reads their canonical bytes, recomputes the transform and
 * requires byte equality — including a byte-equal recomputation of the
 * composite's encoded PNG. A hash-correct record whose pixels were not
 * produced by the transform refuses by name.
 */
import { sha256Hex } from "../crypto.ts";
import {
  CREATIVE_LIMITS,
  CreativeCatalogError,
  SELECTION_COMPOSITE_ALGORITHM,
  versionRefKey,
  type BlobHash,
  type CreativeSource,
  type Rect,
} from "./catalog.ts";

export interface CreativeRaster {
  readonly width: number;
  readonly height: number;
  /** Tightly packed RGBA8, row-major. */
  readonly pixels: Uint8Array;
}

function invalid(message: string): never {
  throw new CreativeCatalogError("invalid", `Invalid creative catalog data: ${message}`);
}

function checkRaster(raster: CreativeRaster, label: string): void {
  const expected = raster.width * raster.height * 4;
  if (
    !Number.isInteger(raster.width) ||
    !Number.isInteger(raster.height) ||
    raster.width < 1 ||
    raster.height < 1 ||
    raster.width > CREATIVE_LIMITS.maxDecodedSide ||
    raster.height > CREATIVE_LIMITS.maxDecodedSide ||
    raster.width * raster.height > CREATIVE_LIMITS.maxDecodedPixels
  )
    invalid(`${label} declares invalid raster dimensions ${raster.width}x${raster.height}.`);
  if (raster.pixels.length !== expected)
    invalid(`${label} holds ${raster.pixels.length} pixel bytes, expected ${expected}.`);
}

/** Half-open integer rectangle inside `width`x`height`, or a named refusal. */
export function checkCompositeSelection(selection: Rect, width: number, height: number): Rect {
  const { x, y, width: w, height: h } = selection;
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    x < 0 ||
    y < 0 ||
    w < 1 ||
    h < 1 ||
    x + w > width ||
    y + h > height
  )
    invalid(
      `the composite selection ${w}x${h} at ${x},${y} does not fit inside ${width}x${height}.`,
    );
  return { x, y, width: w, height: h };
}

/** The provider rectangle the base selection maps to, floor origin / ceil far edge. */
export function compositeRegion(
  selection: Rect,
  baseWidth: number,
  baseHeight: number,
  providerWidth: number,
  providerHeight: number,
): Rect {
  return {
    x: Math.floor((selection.x * providerWidth) / baseWidth),
    y: Math.floor((selection.y * providerHeight) / baseHeight),
    width:
      Math.ceil(((selection.x + selection.width) * providerWidth) / baseWidth) -
      Math.floor((selection.x * providerWidth) / baseWidth),
    height:
      Math.ceil(((selection.y + selection.height) * providerHeight) / baseHeight) -
      Math.floor((selection.y * providerHeight) / baseHeight),
  };
}

export interface SelectionCompositeResult {
  readonly width: number;
  readonly height: number;
  /** Owned pixel copy: base everywhere except the selected region. */
  readonly pixels: Uint8Array;
  /** The provider-coordinate region that was sampled. */
  readonly region: Rect;
  readonly algorithm: typeof SELECTION_COMPOSITE_ALGORITHM;
}

/**
 * Compute the composite raster: the base, except inside the reviewed
 * selection, which takes the provider's pixels resampled to the mapped
 * region. All four channels copy verbatim — this is replacement, not
 * source-over blending — and every byte outside the selection is the
 * base's byte. Inputs are never mutated.
 */
export function compositeSelection(
  base: CreativeRaster,
  provider: CreativeRaster,
  selection: Rect,
): SelectionCompositeResult {
  checkRaster(base, "The base source");
  checkRaster(provider, "The provider source");
  const rect = checkCompositeSelection(selection, base.width, base.height);
  const region = compositeRegion(rect, base.width, base.height, provider.width, provider.height);
  const pixels = new Uint8Array(base.pixels);
  for (let dy = 0; dy < rect.height; dy++)
    for (let dx = 0; dx < rect.width; dx++) {
      const sx = region.x + Math.floor((dx * region.width) / rect.width);
      const sy = region.y + Math.floor((dy * region.height) / rect.height);
      const source = (sy * provider.width + sx) * 4;
      const target = ((rect.y + dy) * base.width + rect.x + dx) * 4;
      pixels[target] = provider.pixels[source]!;
      pixels[target + 1] = provider.pixels[source + 1]!;
      pixels[target + 2] = provider.pixels[source + 2]!;
      pixels[target + 3] = provider.pixels[source + 3]!;
    }
  return {
    width: base.width,
    height: base.height,
    pixels,
    region,
    algorithm: SELECTION_COMPOSITE_ALGORITHM,
  };
}

// ---------- deterministic RGBA PNG encoding ----------

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

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const STORED_BLOCK_MAX = 0xffff;

function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / STORED_BLOCK_MAX));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  let p = 0;
  out[p++] = 0x78;
  out[p++] = 0x01;
  for (let i = 0; i < blocks; i++) {
    const start = i * STORED_BLOCK_MAX;
    const len = Math.min(STORED_BLOCK_MAX, raw.length - start);
    out[p++] = i === blocks - 1 ? 1 : 0;
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

function ihdrChunk(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  return chunk("IHDR", ihdr);
}

/** Exact encoded length — preflight it before allocating a large PNG. */
export function encodedPngRgbaSize(width: number, height: number): number {
  const raw = (width * 4 + 1) * height;
  const blocks = Math.max(1, Math.ceil(raw / STORED_BLOCK_MAX));
  return 8 + (12 + 13) + (12 + 1) + (12 + 2 + blocks * 5 + raw + 4) + 12;
}

/**
 * Deterministically encode RGBA8 pixels (row-major, 4 bytes per pixel) as a
 * PNG with an sRGB chunk, filter type 0 and stored deflate blocks. Same
 * container discipline as the engine's RGB encoder, plus the alpha channel
 * the creative originals keep.
 */
export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new RangeError(`png: bad dimensions ${width}x${height}`);
  const stride = width * 4;
  if (rgba.length !== stride * height)
    throw new RangeError(`png: expected ${stride * height} RGBA bytes, got ${rgba.length}`);
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdrChunk(width, height),
    chunk("sRGB", new Uint8Array([0])), // perceptual rendering intent
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

/**
 * The strict byte-level admission gate for composite sources. For each
 * source carrying a selection-composite derivation in `sources`:
 *
 * - its two parents resolve inside the same source pool;
 * - the parents' canonical raster bytes are available through `readBlob`;
 * - recomputing the transform from those exact bytes equals the
 *   composite's carried canonical bytes;
 * - the deterministic encoder over those pixels equals the composite's
 *   carried encoded bytes, and the descriptor agrees.
 *
 * Any hash-correct record that does not satisfy the transform refuses.
 */
export function checkCompositeSourceBytes(
  sources: readonly CreativeSource[],
  readBlob: (hash: BlobHash) => Uint8Array | undefined,
  label = "creative sources",
): void {
  const pool = new Map<string, CreativeSource>();
  for (const source of sources) pool.set(versionRefKey(source.identity), source);
  const canonical = (source: CreativeSource, role: string): CreativeRaster => {
    const raster = source.normalized;
    const bytes = readBlob(raster.blob.hash);
    if (bytes === undefined)
      invalid(`${label}: the ${role} raster bytes of '${source.identity.id}' are not carried.`);
    if (bytes.length !== raster.blob.byteLength || sha256Hex(bytes) !== raster.blob.hash)
      invalid(
        `${label}: the ${role} raster bytes of '${source.identity.id}' do not match the record.`,
      );
    return { width: raster.width, height: raster.height, pixels: bytes };
  };
  for (const source of sources) {
    const derivation = source.derivation;
    if (derivation === undefined) continue;
    const base = pool.get(versionRefKey(derivation.base));
    if (base === undefined)
      invalid(`${label}: composite '${source.identity.id}' does not carry its base parent.`);
    const provider = pool.get(versionRefKey(derivation.provider));
    if (provider === undefined)
      invalid(`${label}: composite '${source.identity.id}' does not carry its provider parent.`);
    const expected = compositeSelection(
      canonical(base, "base parent's"),
      canonical(provider, "provider parent's"),
      derivation.selection,
    );
    const carried = canonical(source, "composite's");
    if (!bytesEqual(expected.pixels, carried.pixels))
      invalid(
        `${label}: composite '${source.identity.id}' canonical bytes were not produced by '${SELECTION_COMPOSITE_ALGORITHM}' from its parents.`,
      );
    const png = encodePngRgba(expected.width, expected.height, expected.pixels);
    const encoded = readBlob(source.encoded.hash);
    if (encoded === undefined)
      invalid(
        `${label}: composite '${source.identity.id}' encoded original bytes are not carried.`,
      );
    if (
      encoded.length !== source.encoded.byteLength ||
      source.encoded.mime !== "image/png" ||
      sha256Hex(encoded) !== source.encoded.hash
    )
      invalid(`${label}: composite '${source.identity.id}' encoded bytes do not match the record.`);
    if (!bytesEqual(encoded, png))
      invalid(
        `${label}: composite '${source.identity.id}' encoded original is not the deterministic RGBA PNG of its canonical pixels.`,
      );
  }
}
