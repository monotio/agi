/**
 * Pure header inspection for creative image intake.
 *
 * Reads just enough length-checked container structure from encoded bytes to
 * admit or refuse an upload before any browser decode or canvas allocation:
 * the format is sniffed from the file signature (never the caller's MIME or
 * file name), dimensions come from each format's declared fields, and every
 * offset is checked against the offered byte count so truncated or oversized
 * input is refused by name.
 *
 * Supported: PNG (IHDR, plus APNG `acTL` in its canonical pre-IDAT position),
 * JPEG (marker walk to the SOF segment, with a bounded EXIF orientation read
 * out of APP1) and WebP (VP8, VP8L and VP8X forms inside RIFF). Animation is
 * reported honestly — this module is a gate, not an animation importer.
 *
 * Zero runtime dependencies; runs in browser, worker and Node.
 */

import { CREATIVE_LIMITS } from "./catalog.ts";

export type CreativeImageFormat = "png" | "jpeg" | "webp";

/** Canonical MIME for each sniffed format; the caller's claim is never trusted. */
export const CREATIVE_IMAGE_MIME: Record<CreativeImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Why encoded bytes were refused at header inspection. */
export type ImageHeaderReason =
  /** More than CREATIVE_LIMITS.maxFileBytes of encoded data. */
  | "oversize"
  /** Not a PNG, JPEG or WebP byte stream. */
  | "signature"
  /** A declared structure continues past the offered bytes. */
  | "truncated"
  /** The signature matched but required fields are malformed. */
  | "invalid"
  /** Declared dimensions exceed the decoded pixel or side budget. */
  | "dimensions";

export interface CreativeImageHeader {
  readonly format: CreativeImageFormat;
  /** Stored pixels as the container declares them, before EXIF orientation. */
  readonly width: number;
  readonly height: number;
  /** EXIF orientation 1..8; 1 when the file carries none. */
  readonly orientation: number;
  /** Animation markers were observed in canonical position. */
  readonly animated: boolean;
  /** The declared or counted frame count when the container carries one. */
  readonly frames?: number | undefined;
}

export type ImageHeaderVerdict =
  | { readonly ok: true; readonly header: CreativeImageHeader }
  | { readonly ok: false; readonly reason: ImageHeaderReason; readonly message: string };

/** Display dimensions once the declared orientation is applied. */
export function orientedImageDimensions(header: {
  readonly width: number;
  readonly height: number;
  readonly orientation: number;
}): { width: number; height: number } {
  return header.orientation >= 5 && header.orientation <= 8
    ? { width: header.height, height: header.width }
    : { width: header.width, height: header.height };
}

function refused(reason: ImageHeaderReason, message: string): ImageHeaderVerdict {
  return { ok: false, reason, message };
}

function admit(header: CreativeImageHeader): ImageHeaderVerdict {
  return { ok: true, header };
}

// Big-endian four-octet tags, written out so reads stay byte-literal.
const PNG_IHDR = 0x49484452;
const PNG_IDAT = 0x49444154;
const PNG_IEND = 0x49454e44;
const PNG_ACTL = 0x6163544c;
const PNG_EXIF = 0x65584966;

const RIFF_FORM = 0x52494646;
const WEBP_FORM = 0x57454250;
const WEBP_VP8 = 0x56503820;
const WEBP_VP8L = 0x5650384c;
const WEBP_VP8X = 0x56503858;
const WEBP_ANIM = 0x414e494d;
const WEBP_ANMF = 0x414e4d46;
const WEBP_EXIF = 0x45584946;

const MAX_FILE = CREATIVE_LIMITS.maxFileBytes;
const MAX_SIDE = CREATIVE_LIMITS.maxDecodedSide;
const MAX_PIXELS = CREATIVE_LIMITS.maxDecodedPixels;

function checkDimensions(width: number, height: number): ImageHeaderVerdict | undefined {
  if (width < 1 || height < 1) return refused("invalid", "That image declares a zero-sized frame.");
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS)
    return refused(
      "dimensions",
      `That image is ${width}x${height}; imports accept up to ${MAX_SIDE} pixels per side and ${MAX_PIXELS} pixels in total.`,
    );
  return undefined;
}

/** PNG: signature, a 13-byte IHDR first, then a chunk walk bounded by IDAT. */
function inspectPng(view: DataView, length: number): ImageHeaderVerdict {
  if (length < 16) return refused("truncated", "That PNG file ends inside its first chunk.");
  if (view.getUint32(8, false) !== 13 || view.getUint32(12, false) !== PNG_IHDR)
    return refused("invalid", "That PNG file's first chunk is not the image header.");
  if (33 > length) return refused("truncated", "That PNG file ends inside its image header.");
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  const size = checkDimensions(width, height);
  if (size !== undefined) return size;
  let animated = false;
  let orientation = 1;
  let exifRead = false;
  let frames: number | undefined;
  let pos = 33; // signature + IHDR chunk + CRC
  while (pos < length) {
    if (pos + 8 > length) return refused("truncated", "That PNG file ends inside a chunk header.");
    const chunkLength = view.getUint32(pos, false);
    const type = view.getUint32(pos + 4, false);
    const end = pos + 12 + chunkLength;
    if (end > length) return refused("truncated", "That PNG file ends inside a chunk.");
    // acTL counts only in its canonical position; APNG decoders do the same.
    if (type === PNG_IDAT || type === PNG_IEND) break;
    if (type === PNG_ACTL) {
      animated = true;
      if (chunkLength >= 8) frames = view.getUint32(pos + 8, false);
    } else if (type === PNG_EXIF && !exifRead) {
      // eXIf carries a bare TIFF structure; its pre-IDAT position is the
      // canonical one.
      exifRead = true;
      orientation = metadataOrientation(view, pos + 8, pos + 8 + chunkLength);
    }
    pos = end;
  }
  return admit({ format: "png", width, height, orientation, animated, frames });
}

/**
 * A bounded TIFF orientation read: byte order, magic 42, IFD0 entry table,
 * tag 0x0112. Anything malformed yields 1 — browsers ignore bad metadata
 * the same way — so the read is never a refusal reason of its own.
 */
function tiffOrientation(view: DataView, start: number, end: number): number {
  if (end - start < 8) return 1;
  const order = view.getUint16(start, false);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return 1;
  if (view.getUint16(start + 2, little) !== 42) return 1;
  const ifd = start + view.getUint32(start + 4, little);
  if (ifd < start + 8 || ifd + 2 > end) return 1;
  const count = view.getUint16(ifd, little);
  if (ifd + 2 + count * 12 > end) return 1;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    if (view.getUint16(entry + 2, little) !== 3) return 1;
    if (view.getUint32(entry + 4, little) < 1) return 1;
    const value = view.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

/**
 * Orientation inside an EXIF metadata chunk: PNG eXIf and WebP EXIF carry a
 * bare TIFF structure; a stray "Exif\0\0" prefix is tolerated.
 */
function metadataOrientation(view: DataView, start: number, end: number): number {
  if (
    end - start >= 14 &&
    view.getUint32(start, false) === 0x45786966 &&
    view.getUint16(start + 4, false) === 0
  )
    return tiffOrientation(view, start + 6, end);
  return tiffOrientation(view, start, end);
}

/** JPEG EXIF lives in an APP1 segment behind a required "Exif\0\0" prefix. */
function exifOrientation(view: DataView, start: number, end: number): number {
  return tiffOrientation(view, start + 6, end);
}

const JPEG_SOF_MASK = 0xf0;
const JPEG_SOF_BASE = 0xc0;

/** JPEG: SOI, then a marker walk that reads SOF dimensions and APP1 EXIF. */
function inspectJpeg(view: DataView, length: number): ImageHeaderVerdict {
  let pos = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let orientation = 1;
  let exifSeen = false;
  while (pos < length) {
    if (view.getUint8(pos) !== 0xff)
      return refused("invalid", "That JPEG file's marker stream is malformed.");
    while (pos < length && view.getUint8(pos) === 0xff) pos++;
    if (pos >= length) return refused("truncated", "That JPEG file ends inside a marker.");
    const marker = view.getUint8(pos);
    pos++;
    if (marker === 0xd9) break; // EOI
    if (marker === 0xda) break; // SOS: entropy data follows
    if (marker === 0x00 || marker === 0xd8)
      return refused("invalid", "That JPEG file's marker stream is malformed.");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (pos + 2 > length)
      return refused("truncated", "That JPEG file ends inside a segment length.");
    const segmentLength = view.getUint16(pos, false);
    pos += 2;
    if (segmentLength < 2)
      return refused("invalid", "That JPEG file's segment length is malformed.");
    const segmentStart = pos;
    const segmentEnd = pos + segmentLength - 2;
    if (segmentEnd > length) return refused("truncated", "That JPEG file ends inside a segment.");
    if (
      (marker & JPEG_SOF_MASK) === JPEG_SOF_BASE &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (sawFrame) return refused("invalid", "That JPEG file declares more than one frame.");
      if (segmentLength - 2 < 6)
        return refused("invalid", "That JPEG file's frame header is malformed.");
      height = view.getUint16(segmentStart + 1, false);
      width = view.getUint16(segmentStart + 3, false);
      sawFrame = true;
    } else if (
      marker === 0xe1 &&
      !exifSeen &&
      segmentEnd - segmentStart >= 6 &&
      view.getUint32(segmentStart, false) === 0x45786966 &&
      view.getUint16(segmentStart + 4, false) === 0
    ) {
      exifSeen = true;
      orientation = exifOrientation(view, segmentStart, segmentEnd);
    }
    pos = segmentEnd;
  }
  if (!sawFrame) return refused("invalid", "That JPEG file has no frame header to read.");
  const size = checkDimensions(width, height);
  if (size !== undefined) return size;
  return admit({ format: "jpeg", width, height, orientation, animated: false });
}

/** WebP: RIFF/WEBP with VP8, VP8L or VP8X dimension fields. */
function inspectWebp(view: DataView, length: number): ImageHeaderVerdict {
  if (length < 12) return refused("truncated", "That WebP file ends inside its header.");
  const riffEnd = 8 + view.getUint32(4, true);
  if (riffEnd > length)
    return refused("truncated", "That WebP file is cut short inside its container.");
  let pos = 12;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let stillWidth = 0;
  let stillHeight = 0;
  let animated = false;
  let orientation = 1;
  let exifRead = false;
  let frames = 0;
  while (pos < riffEnd) {
    if (pos + 8 > riffEnd) return refused("invalid", "That WebP file's chunk table is malformed.");
    const fourcc = view.getUint32(pos, false);
    const chunkLength = view.getUint32(pos + 4, true);
    const dataStart = pos + 8;
    // The odd-size pad byte belongs to the container: the padded extent must
    // still land inside the declared RIFF bounds.
    const next = dataStart + chunkLength + (chunkLength & 1);
    if (next > riffEnd)
      return refused("invalid", "That WebP file's chunk runs past its container.");
    if (fourcc === WEBP_VP8X) {
      if (chunkLength !== 10)
        return refused("invalid", "That WebP file's extended header is malformed.");
      const flags = view.getUint8(dataStart);
      if ((flags & 0x02) !== 0) animated = true;
      canvasWidth =
        (view.getUint8(dataStart + 4) |
          (view.getUint8(dataStart + 5) << 8) |
          (view.getUint8(dataStart + 6) << 16)) +
        1;
      canvasHeight =
        (view.getUint8(dataStart + 7) |
          (view.getUint8(dataStart + 8) << 8) |
          (view.getUint8(dataStart + 9) << 16)) +
        1;
      const size = checkDimensions(canvasWidth, canvasHeight);
      if (size !== undefined) return size;
    } else if (fourcc === WEBP_VP8) {
      if (chunkLength < 10)
        return refused("invalid", "That WebP file's lossy frame header is malformed.");
      if (
        view.getUint8(dataStart + 3) !== 0x9d ||
        view.getUint8(dataStart + 4) !== 0x01 ||
        view.getUint8(dataStart + 5) !== 0x2a
      )
        return refused("invalid", "That WebP file's lossy frame header is malformed.");
      stillWidth = view.getUint16(dataStart + 6, true) & 0x3fff;
      stillHeight = view.getUint16(dataStart + 8, true) & 0x3fff;
      const size = checkDimensions(stillWidth, stillHeight);
      if (size !== undefined) return size;
    } else if (fourcc === WEBP_VP8L) {
      if (chunkLength < 5 || view.getUint8(dataStart) !== 0x2f)
        return refused("invalid", "That WebP file's lossless header is malformed.");
      const packed = view.getUint32(dataStart + 1, true);
      if (packed >>> 29 !== 0)
        return refused("invalid", "That WebP file's lossless header is malformed.");
      stillWidth = (packed & 0x3fff) + 1;
      stillHeight = ((packed >>> 14) & 0x3fff) + 1;
      const size = checkDimensions(stillWidth, stillHeight);
      if (size !== undefined) return size;
    } else if (fourcc === WEBP_ANIM) {
      animated = true;
    } else if (fourcc === WEBP_EXIF && !exifRead) {
      // WebP EXIF carries a bare TIFF structure inside the chunk.
      exifRead = true;
      orientation = metadataOrientation(view, dataStart, dataStart + chunkLength);
    } else if (fourcc === WEBP_ANMF) {
      // Frame header: 16 bytes of position/duration/flags whose width and
      // height sit at offsets 6 and 9 as 24-bit minus-one fields.
      if (chunkLength < 16)
        return refused("invalid", "That WebP file's frame header is malformed.");
      const frameWidth =
        (view.getUint8(dataStart + 6) |
          (view.getUint8(dataStart + 7) << 8) |
          (view.getUint8(dataStart + 8) << 16)) +
        1;
      const frameHeight =
        (view.getUint8(dataStart + 9) |
          (view.getUint8(dataStart + 10) << 8) |
          (view.getUint8(dataStart + 11) << 16)) +
        1;
      const size = checkDimensions(frameWidth, frameHeight);
      if (size !== undefined) return size;
      animated = true;
      frames++;
    }
    pos = next;
  }
  const width = canvasWidth > 0 ? canvasWidth : stillWidth;
  const height = canvasHeight > 0 ? canvasHeight : stillHeight;
  if (width === 0 || height === 0)
    return refused("invalid", "That WebP file has no image data to read.");
  if (canvasWidth > 0 && !animated) {
    // A still in an extended container declares one canvas and one
    // bitstream extent; they must agree before any decode.
    if (stillWidth === 0)
      return refused("invalid", "That WebP file's extended header has no image data.");
    if (stillWidth !== canvasWidth || stillHeight !== canvasHeight)
      return refused("invalid", "That WebP file's image does not match its declared canvas.");
  }
  return admit({
    format: "webp",
    width,
    height,
    orientation,
    animated,
    ...(frames > 0 ? { frames } : {}),
  });
}

/** Copy `bytes` minus each `[start, end)` pair in ascending `cuts`. */
function exciseRanges(bytes: Uint8Array, cuts: number[]): Uint8Array<ArrayBuffer> {
  let removed = 0;
  for (let i = 0; i + 1 < cuts.length; i += 2) removed += cuts[i + 1]! - cuts[i]!;
  const out = new Uint8Array(bytes.length - removed);
  let w = 0;
  let read = 0;
  for (let i = 0; i + 1 < cuts.length; i += 2) {
    out.set(bytes.subarray(read, cuts[i]), w);
    w += cuts[i]! - read;
    read = cuts[i + 1]!;
  }
  out.set(bytes.subarray(read), w);
  return out;
}

/** JPEG: drop every Exif APP1 segment; all other segments stay verbatim. */
function jpegWithoutOrientation(
  bytes: Uint8Array<ArrayBuffer>,
  view: DataView,
  length: number,
): Uint8Array<ArrayBuffer> {
  const cuts: number[] = [];
  let pos = 2;
  while (pos < length) {
    if (view.getUint8(pos) !== 0xff) break;
    const markerStart = pos;
    while (pos < length && view.getUint8(pos) === 0xff) pos++;
    if (pos >= length) break;
    const marker = view.getUint8(pos);
    pos++;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0xd8) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (pos + 2 > length) break;
    const segmentLength = view.getUint16(pos, false);
    pos += 2;
    if (segmentLength < 2) break;
    const segmentEnd = pos + segmentLength - 2;
    if (segmentEnd > length) break;
    if (
      marker === 0xe1 &&
      segmentEnd - pos >= 6 &&
      view.getUint32(pos, false) === 0x45786966 &&
      view.getUint16(pos + 4, false) === 0
    )
      cuts.push(markerStart, segmentEnd);
    pos = segmentEnd;
  }
  return cuts.length === 0 ? bytes : exciseRanges(bytes, cuts);
}

/** PNG: drop every eXIf chunk; remaining chunks keep their bytes and CRC. */
function pngWithoutOrientation(
  bytes: Uint8Array<ArrayBuffer>,
  view: DataView,
  length: number,
): Uint8Array<ArrayBuffer> {
  const cuts: number[] = [];
  let pos = 8;
  while (pos + 8 <= length) {
    const end = pos + 12 + view.getUint32(pos, false);
    if (end > length) break;
    if (view.getUint32(pos + 4, false) === PNG_EXIF) cuts.push(pos, end);
    pos = end;
  }
  return cuts.length === 0 ? bytes : exciseRanges(bytes, cuts);
}

/**
 * WebP: drop every EXIF chunk inside the declared RIFF bounds, clear the
 * VP8X EXIF flag in the copy and shrink the RIFF size by the removed bytes.
 */
function webpWithoutOrientation(
  bytes: Uint8Array<ArrayBuffer>,
  view: DataView,
  length: number,
): Uint8Array<ArrayBuffer> {
  if (length < 12) return bytes;
  const riffSize = view.getUint32(4, true);
  const riffEnd = Math.min(8 + riffSize, length);
  const cuts: number[] = [];
  let pos = 12;
  while (pos + 8 <= riffEnd) {
    const chunkLength = view.getUint32(pos + 4, true);
    const next = pos + 8 + chunkLength + (chunkLength & 1);
    if (next > riffEnd) break;
    if (view.getUint32(pos, false) === WEBP_EXIF) cuts.push(pos, next);
    pos = next;
  }
  if (cuts.length === 0) return bytes;
  let removed = 0;
  for (let i = 0; i + 1 < cuts.length; i += 2) removed += cuts[i + 1]! - cuts[i]!;
  const out = exciseRanges(bytes, cuts);
  const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
  outView.setUint32(4, riffSize - removed, true);
  const newEnd = 8 + riffSize - removed;
  let p = 12;
  while (p + 8 <= newEnd) {
    const chunkLength = outView.getUint32(p + 4, true);
    const next = p + 8 + chunkLength + (chunkLength & 1);
    if (next > newEnd) break;
    if (outView.getUint32(p, false) === WEBP_VP8X && p + 8 < newEnd)
      out[p + 8] = out[p + 8]! & ~0x08;
    p = next;
  }
  return out;
}

/**
 * The transient decode copy: `bytes` with every orientation-metadata block
 * removed. Browsers disagree on whether and how decoders apply EXIF
 * orientation, so the copy carries none and the captured header orientation
 * is applied explicitly instead. Returns the input when there is nothing to
 * remove. Never mutates or re-encodes the offered bytes.
 */
export function decodeCopyWithoutOrientation(
  bytes: Uint8Array<ArrayBuffer>,
  format: CreativeImageFormat,
): Uint8Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === "jpeg") return jpegWithoutOrientation(bytes, view, bytes.length);
  if (format === "png") return pngWithoutOrientation(bytes, view, bytes.length);
  return webpWithoutOrientation(bytes, view, bytes.length);
}

/**
 * Inspect encoded PNG, JPEG or WebP bytes. Bounded by the offered byte count:
 * every offset is checked before it is read, and refusal carries a stable
 * typed reason plus a message that can be shown as is.
 */
export function inspectCreativeImageHeader(bytes: Uint8Array): ImageHeaderVerdict {
  if (!(bytes instanceof Uint8Array))
    return refused("signature", "That file is not a PNG, JPEG or WebP image.");
  if (bytes.length > MAX_FILE)
    return refused(
      "oversize",
      `That file is ${Math.ceil(bytes.length / 1024 / 1024)} MB; imports accept up to ${MAX_FILE / 1024 / 1024} MB.`,
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.length;
  if (
    length >= 8 &&
    view.getUint32(0, false) === 0x89504e47 &&
    view.getUint32(4, false) === 0x0d0a1a0a
  )
    return inspectPng(view, length);
  if (length >= 2 && view.getUint8(0) === 0xff && view.getUint8(1) === 0xd8)
    return inspectJpeg(view, length);
  if (
    length >= 12 &&
    view.getUint32(0, false) === RIFF_FORM &&
    view.getUint32(8, false) === WEBP_FORM
  )
    return inspectWebp(view, length);
  return refused("signature", "That file is not a PNG, JPEG or WebP image.");
}
