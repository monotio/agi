import assert from "node:assert/strict";
import { test } from "node:test";
import { CREATIVE_LIMITS } from "../src/creative/catalog.ts";
import {
  decodeCopyWithoutOrientation,
  inspectCreativeImageHeader,
  orientedImageDimensions,
  type ImageHeaderVerdict,
} from "../src/creative/imageHeader.ts";

/**
 * Hand-computed image headers: every fixture below is written out byte by
 * byte from the format's container rules, so a wrong read fails loudly.
 */

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const u16be = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const u24le = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32be = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
const u32le = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG chunk with a zeroed CRC — header inspection does not need it. */
function pngChunk(type: string, data: number[]): number[] {
  return [...u32be(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
}

function png(width: number, height: number, extra: number[] = []): Uint8Array<ArrayBuffer> {
  const ihdr = [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0];
  return Uint8Array.of(
    ...PNG_SIGNATURE,
    ...pngChunk("IHDR", ihdr),
    ...extra,
    ...pngChunk("IEND", []),
  );
}

/** JPEG segment: 0xff marker + u16be length covering the length field itself. */
function jpegSegment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...u16be(payload.length + 2), ...payload];
}

/** Baseline SOF0: 8-bit precision, 3 components. */
function sof(width: number, height: number, marker = 0xc0): number[] {
  return jpegSegment(marker, [
    8,
    ...u16be(height),
    ...u16be(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
}

/** A minimal EXIF APP1 body carrying one IFD0 orientation tag. */
function exifApp1(orientation: number, littleEndian: boolean): number[] {
  const entry = littleEndian
    ? [0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00]
    : [0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00];
  const tiff = [
    ...(littleEndian ? ascii("II") : ascii("MM")),
    ...(littleEndian ? u16le(42) : u16be(42)),
    ...(littleEndian ? u32le(8) : u32be(8)),
    ...(littleEndian ? u16le(1) : u16be(1)),
    ...entry,
    0,
    0,
    0,
    0,
  ];
  return jpegSegment(0xe1, [...ascii("Exif"), 0, 0, ...tiff]);
}

/** RIFF chunk: fourcc + u32le size + data + pad byte on odd sizes. */
function riffChunk(fourcc: string, data: number[]): number[] {
  const pad = data.length & 1;
  return [...ascii(fourcc), ...u32le(data.length), ...data, ...(pad === 1 ? [0] : [])];
}

function webp(chunks: number[][], riffDelta = 0): Uint8Array<ArrayBuffer> {
  const body = [...ascii("WEBP"), ...chunks.flat()];
  return Uint8Array.of(...ascii("RIFF"), ...u32le(body.length + riffDelta), ...body);
}

/** Lossy VP8 frame tag + start code + 14-bit dimensions. */
function vp8(width: number, height: number): number[] {
  return [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)];
}

/** Lossless VP8L: 0x2f signature then width-1/height-1 packed as 14-bit fields. */
function vp8l(width: number, height: number): number[] {
  const packed = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return [0x2f, ...u32le(packed)];
}

function vp8x(width: number, height: number, flags = 0): number[] {
  return [flags, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)];
}

function anmf(width: number, height: number): number[] {
  return [0, 0, 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1), 0, 0, 0, 0];
}

function refused(verdict: ImageHeaderVerdict): { reason: string; message: string } {
  assert.equal(verdict.ok, false, "expected a refusal");
  if (!verdict.ok) return verdict;
  throw new Error("unreachable");
}

function inspected(verdict: ImageHeaderVerdict) {
  assert.equal(verdict.ok, true, "expected a readable header");
  if (verdict.ok) return verdict.header;
  throw new Error("unreachable");
}

test("bytes with no known signature are refused without format claims", () => {
  assert.equal(refused(inspectCreativeImageHeader(new Uint8Array(0))).reason, "signature");
  assert.equal(
    refused(inspectCreativeImageHeader(Uint8Array.from(ascii("this is not an image")))).reason,
    "signature",
  );
  assert.equal(
    refused(inspectCreativeImageHeader(Uint8Array.from(ascii("GIF89a....")))).reason,
    "signature",
  );
  // A RIFF container that is not WEBP is a different file type entirely.
  const riffNotWebp = Uint8Array.of(...ascii("RIFF"), ...u32le(4), ...ascii("WAVE"));
  assert.equal(refused(inspectCreativeImageHeader(riffNotWebp)).reason, "signature");
  // A PNG signature that differs in the last byte is refused, not sniffed loose.
  const almostPng = [...PNG_SIGNATURE];
  almostPng[7] = 0x0b;
  assert.equal(
    refused(inspectCreativeImageHeader(Uint8Array.from([...almostPng, 0, 0, 0, 0]))).reason,
    "signature",
  );
});

test("encoded bytes over the per-file limit refuse before any header work", () => {
  const huge = new Uint8Array(CREATIVE_LIMITS.maxFileBytes + 1);
  huge.set(PNG_SIGNATURE, 0);
  const verdict = refused(inspectCreativeImageHeader(huge));
  assert.equal(verdict.reason, "oversize");
  assert.match(verdict.message, /8\s?MB|8 MiB/i);

  // Exactly at the limit still inspects: a real PNG header at the boundary.
  const atLimit = new Uint8Array(CREATIVE_LIMITS.maxFileBytes);
  atLimit.set(png(24, 8), 0);
  const header = inspected(inspectCreativeImageHeader(atLimit));
  assert.equal(header.format, "png");
});

test("PNG IHDR declares dimensions, and unknown chunks skip by checked length", () => {
  const withText = png(640, 336, [
    ...pngChunk("tEXt", [...ascii("Title"), 0, ...ascii("a drawn hill")]),
    ...pngChunk("IDAT", [0x78, 0x01, 1, 2, 3, 4]),
  ]);
  const header = inspected(inspectCreativeImageHeader(withText));
  assert.deepEqual(
    {
      format: header.format,
      width: header.width,
      height: header.height,
      orientation: header.orientation,
      animated: header.animated,
      frames: header.frames,
    },
    { format: "png", width: 640, height: 336, orientation: 1, animated: false, frames: undefined },
  );
});

test("PNG dimension bounds refuse oversized declared frames before decode", () => {
  const side = CREATIVE_LIMITS.maxDecodedSide;
  const pixels = CREATIVE_LIMITS.maxDecodedPixels;
  assert.equal(inspected(inspectCreativeImageHeader(png(side, pixels / side))).width, side);
  assert.equal(inspected(inspectCreativeImageHeader(png(pixels / side, side))).height, side);
  assert.equal(refused(inspectCreativeImageHeader(png(side + 1, 1))).reason, "dimensions");
  assert.equal(refused(inspectCreativeImageHeader(png(1, side + 1))).reason, "dimensions");
  // 4097 x 4096 exceeds 16 MiP while both sides stay under 8192.
  assert.equal(refused(inspectCreativeImageHeader(png(4097, 4096))).reason, "dimensions");
});

test("PNG structural faults name truncation or malformed fields", () => {
  // Signature then a partial chunk header.
  assert.equal(
    refused(inspectCreativeImageHeader(Uint8Array.from([...PNG_SIGNATURE, 0, 0]))).reason,
    "truncated",
  );
  // IHDR declares 13 bytes but the file ends inside the data.
  const cut = png(8, 8).subarray(0, 20);
  assert.equal(refused(inspectCreativeImageHeader(cut)).reason, "truncated");
  // The first chunk is not IHDR.
  const foreign = Uint8Array.of(...PNG_SIGNATURE, ...pngChunk("tEXt", [0]));
  assert.equal(refused(inspectCreativeImageHeader(foreign)).reason, "invalid");
  // IHDR with the wrong declared length.
  const wrongLength = Uint8Array.of(
    ...PNG_SIGNATURE,
    ...u32be(12),
    ...ascii("IHDR"),
    ...u32be(4),
    ...u32be(4),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  assert.equal(refused(inspectCreativeImageHeader(wrongLength)).reason, "invalid");
  // Zero dimensions are malformed, not small.
  assert.equal(refused(inspectCreativeImageHeader(png(0, 10))).reason, "invalid");
  assert.equal(refused(inspectCreativeImageHeader(png(10, 0))).reason, "invalid");
  // A later chunk whose length runs past the offered bytes.
  const overrun = Uint8Array.of(...png(8, 8).subarray(0, 33), ...u32be(1024), ...ascii("IDAT"), 0);
  assert.equal(refused(inspectCreativeImageHeader(overrun)).reason, "truncated");
});

test("APNG animation markers are reported honestly in canonical position", () => {
  // acTL before IDAT: 24 declared frames.
  const animatedPng = png(96, 48, [
    ...pngChunk("acTL", [...u32be(24), ...u32be(0)]),
    ...pngChunk("IDAT", [0x78, 0x01, 1]),
  ]);
  const header = inspected(inspectCreativeImageHeader(animatedPng));
  assert.equal(header.animated, true);
  assert.equal(header.frames, 24);

  // An acTL after IDAT is out of position; the stream plays as a still image.
  const misplaced = png(96, 48, [
    ...pngChunk("IDAT", [0x78, 0x01, 1]),
    ...pngChunk("acTL", [...u32be(24), ...u32be(0)]),
  ]);
  assert.equal(inspected(inspectCreativeImageHeader(misplaced)).animated, false);
});

test("JPEG marker walk finds SOF dimensions for baseline and progressive", () => {
  const baseline = Uint8Array.of(
    0xff,
    0xd8,
    ...jpegSegment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...sof(32, 20),
    0xff,
    0xd9,
  );
  const header = inspected(inspectCreativeImageHeader(baseline));
  assert.deepEqual(
    [header.format, header.width, header.height, header.orientation, header.animated],
    ["jpeg", 32, 20, 1, false],
  );

  const progressive = Uint8Array.of(0xff, 0xd8, ...sof(48, 12, 0xc2), 0xff, 0xd9);
  const progressiveHeader = inspected(inspectCreativeImageHeader(progressive));
  assert.deepEqual([progressiveHeader.width, progressiveHeader.height], [48, 12]);

  // A view into a larger buffer must not read past its own bytes.
  const padded = new Uint8Array(baseline.length + 40);
  padded.set(baseline, 20);
  assert.equal(
    inspected(inspectCreativeImageHeader(padded.subarray(20, 20 + baseline.length))).width,
    32,
  );
});

test("JPEG structural faults refuse cleanly", () => {
  // SOI then EOI: a marker stream with no frame.
  assert.equal(
    refused(inspectCreativeImageHeader(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).reason,
    "invalid",
  );
  // A declared segment length runs past the offered bytes.
  const cut = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x40, 1, 2, 3);
  assert.equal(refused(inspectCreativeImageHeader(cut)).reason, "truncated");
  // No 0xff where a marker must start.
  const stray = Uint8Array.of(0xff, 0xd8, 0x10, 0xe0, 0, 0, 0, 0);
  assert.equal(refused(inspectCreativeImageHeader(stray)).reason, "invalid");
  // An SOF segment too short to carry dimensions.
  const shortSof = Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0, 4, 8, 0, 0xff, 0xd9);
  assert.equal(refused(inspectCreativeImageHeader(shortSof)).reason, "invalid");
  // SOS before any SOF: entropy data is where the dimensions should have been.
  const scan = Uint8Array.of(0xff, 0xd8, ...jpegSegment(0xda, [1, 0, 0]), 0xff, 0xd9);
  assert.equal(refused(inspectCreativeImageHeader(scan)).reason, "invalid");
});

test("JPEG EXIF orientation is read once through a bounded TIFF walk", () => {
  const big = Uint8Array.of(0xff, 0xd8, ...exifApp1(6, false), ...sof(32, 20), 0xff, 0xd9);
  const header = inspected(inspectCreativeImageHeader(big));
  assert.equal(header.orientation, 6);
  // Stored dimensions stay raw; orientation swaps them for display.
  assert.deepEqual([header.width, header.height], [32, 20]);
  assert.deepEqual(orientedImageDimensions(header), { width: 20, height: 32 });

  const little = Uint8Array.of(0xff, 0xd8, ...exifApp1(3, true), ...sof(32, 20), 0xff, 0xd9);
  const leHeader = inspected(inspectCreativeImageHeader(little));
  assert.equal(leHeader.orientation, 3);
  assert.deepEqual(orientedImageDimensions(leHeader), { width: 32, height: 20 });
});

test("malformed EXIF falls back to plain orientation without refusing", () => {
  const sofPart = sof(32, 20);
  // TIFF magic is not 42.
  const badMagic = [
    ...ascii("Exif"),
    0,
    0,
    ...ascii("MM"),
    0,
    0,
    0,
    0,
    0,
    8,
    0,
    1,
    0x01,
    0x12,
    0,
    3,
    0,
    0,
    0,
    1,
    0,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  const withBadMagic = Uint8Array.of(
    0xff,
    0xd8,
    ...jpegSegment(0xe1, badMagic),
    ...sofPart,
    0xff,
    0xd9,
  );
  assert.equal(inspected(inspectCreativeImageHeader(withBadMagic)).orientation, 1);

  // IFD0 declares more entries than the segment could hold.
  const overlong = [...ascii("Exif"), 0, 0, ...ascii("MM"), 0, 0x2a, 0, 0, 0, 8, 0xff, 0xff];
  const withOverlong = Uint8Array.of(
    0xff,
    0xd8,
    ...jpegSegment(0xe1, overlong),
    ...sofPart,
    0xff,
    0xd9,
  );
  assert.equal(inspected(inspectCreativeImageHeader(withOverlong)).orientation, 1);

  // An out-of-range orientation value is ignored, not trusted.
  const absurd = Uint8Array.of(0xff, 0xd8, ...exifApp1(9, false), ...sofPart, 0xff, 0xd9);
  assert.equal(inspected(inspectCreativeImageHeader(absurd)).orientation, 1);

  // A non-Exif APP1 payload (XMP) is skipped untouched.
  const xmp = Uint8Array.of(
    0xff,
    0xd8,
    ...jpegSegment(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/"), 0, 1, 2]),
    ...sofPart,
    0xff,
    0xd9,
  );
  assert.equal(inspected(inspectCreativeImageHeader(xmp)).orientation, 1);
});

test("WebP reads VP8, VP8L and VP8X dimension forms", () => {
  const lossy = webp([riffChunk("VP8 ", vp8(550, 368))]);
  const lossyHeader = inspected(inspectCreativeImageHeader(lossy));
  assert.deepEqual(
    [lossyHeader.format, lossyHeader.width, lossyHeader.height, lossyHeader.animated],
    ["webp", 550, 368, false],
  );

  const lossless = webp([riffChunk("VP8L", vp8l(160, 90))]);
  assert.deepEqual(
    [inspected(inspectCreativeImageHeader(lossless)).width].concat([
      inspected(inspectCreativeImageHeader(lossless)).height,
    ]),
    [160, 90],
  );

  // Extended container: canvas size is authoritative over the still image.
  const extended = webp([
    riffChunk("VP8X", vp8x(320, 240, 0x10)),
    riffChunk("VP8 ", vp8(320, 240)),
  ]);
  const extendedHeader = inspected(inspectCreativeImageHeader(extended));
  assert.deepEqual([extendedHeader.width, extendedHeader.height], [320, 240]);
  assert.equal(extendedHeader.animated, false);
});

test("WebP animation markers refuse a ready-looking still", () => {
  const flagged = webp([
    riffChunk("VP8X", vp8x(320, 240, 0x02)),
    riffChunk("ANIM", [...u32le(0), ...u16le(0)]),
    riffChunk("ANMF", anmf(320, 240)),
    riffChunk("ANMF", anmf(320, 240)),
  ]);
  const header = inspected(inspectCreativeImageHeader(flagged));
  assert.equal(header.animated, true);
  assert.equal(header.frames, 2);
  assert.deepEqual([header.width, header.height], [320, 240]);
});

test("WebP structural faults refuse with truncation or malformed fields", () => {
  // RIFF declares more bytes than the file carries.
  const short = webp([riffChunk("VP8 ", vp8(10, 10))], 100);
  assert.equal(refused(inspectCreativeImageHeader(short)).reason, "truncated");

  // A chunk length that runs past the RIFF payload the file declared.
  const corrupt = Uint8Array.of(
    ...ascii("RIFF"),
    ...u32le(12),
    ...ascii("WEBP"),
    ...ascii("VP8 "),
    ...u32le(64),
    ...new Array(8).fill(0),
  );
  assert.equal(refused(inspectCreativeImageHeader(corrupt)).reason, "invalid");

  // Lossy data without the 0x9d012a start code.
  const noStart = webp([riffChunk("VP8 ", [0, 0, 0, 1, 2, 3, ...u16le(10), ...u16le(10)])]);
  assert.equal(refused(inspectCreativeImageHeader(noStart)).reason, "invalid");

  // VP8L without the 0x2f signature byte.
  const badLossless = webp([riffChunk("VP8L", [0x30, ...u32le(0)])]);
  assert.equal(refused(inspectCreativeImageHeader(badLossless)).reason, "invalid");

  // VP8X must be exactly ten bytes.
  const badExtended = webp([riffChunk("VP8X", vp8x(4, 4).slice(0, 9))]);
  assert.equal(refused(inspectCreativeImageHeader(badExtended)).reason, "invalid");

  // A WEBP container with no image chunk at all.
  const empty = webp([riffChunk("XMP ", [1, 2, 3, 4])]);
  assert.equal(refused(inspectCreativeImageHeader(empty)).reason, "invalid");
});

test("PNG eXIf and WebP EXIF orientations are read before decode", () => {
  // Bare little-endian TIFF with one orientation-6 tag, the eXIf form.
  const tiff = [
    ...u16le(0x4949),
    ...u16le(42),
    ...u32le(8),
    ...u16le(1),
    0x12,
    0x01,
    3,
    0,
    ...u32le(1),
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  const orientedPng = png(3, 2, [...pngChunk("eXIf", tiff), ...pngChunk("IDAT", [0x78, 1, 2])]);
  const pngHeader = inspected(inspectCreativeImageHeader(orientedPng));
  assert.equal(pngHeader.orientation, 6);
  assert.deepEqual([pngHeader.width, pngHeader.height], [3, 2]);
  assert.deepEqual(orientedImageDimensions(pngHeader), { width: 2, height: 3 });

  const orientedWebp = webp([
    riffChunk("VP8X", vp8x(32, 20, 0x08)),
    riffChunk("VP8 ", vp8(32, 20)),
    riffChunk("EXIF", tiff),
  ]);
  const webpHeader = inspected(inspectCreativeImageHeader(orientedWebp));
  assert.equal(webpHeader.orientation, 6);
  assert.deepEqual([webpHeader.width, webpHeader.height], [32, 20]);
  assert.deepEqual(orientedImageDimensions(webpHeader), { width: 20, height: 32 });
});

test("the decode copy drops orientation metadata and nothing else", () => {
  const tiff = [
    ...u16le(0x4949),
    ...u16le(42),
    ...u32le(8),
    ...u16le(1),
    0x12,
    0x01,
    3,
    0,
    ...u32le(1),
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];

  // JPEG: the Exif APP1 is removed whole; an XMP APP1 and an APP2 survive.
  const jpeg = Uint8Array.of(
    0xff,
    0xd8,
    ...jpegSegment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...jpegSegment(0xe1, [...ascii("Exif"), 0, 0, ...tiff]),
    ...jpegSegment(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/"), 0, 1, 2]),
    ...jpegSegment(0xe2, [9, 9, 9]),
    ...sof(32, 20),
    0xff,
    0xd9,
  );
  const neutralJpeg = decodeCopyWithoutOrientation(jpeg, "jpeg");
  const neutralJpegHeader = inspected(inspectCreativeImageHeader(neutralJpeg));
  assert.equal(neutralJpegHeader.orientation, 1);
  assert.deepEqual([neutralJpegHeader.width, neutralJpegHeader.height], [32, 20]);
  // The JFIF, XMP, APP2, SOF and EOI bytes all survive verbatim.
  const still = Uint8Array.of(
    0xff,
    0xd8,
    ...jpegSegment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...jpegSegment(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/"), 0, 1, 2]),
    ...jpegSegment(0xe2, [9, 9, 9]),
    ...sof(32, 20),
    0xff,
    0xd9,
  );
  assert.deepEqual([...neutralJpeg], [...still]);

  // PNG: the eXIf chunk leaves, other chunks (with their CRCs) are verbatim.
  const withExif = png(3, 2, [
    ...pngChunk("eXIf", tiff),
    ...pngChunk("tEXt", ascii("note")),
    ...pngChunk("IDAT", [0x78, 1, 2]),
  ]);
  const neutralPng = decodeCopyWithoutOrientation(withExif, "png");
  assert.deepEqual(
    [...neutralPng],
    [...png(3, 2, [...pngChunk("tEXt", ascii("note")), ...pngChunk("IDAT", [0x78, 1, 2])])],
  );
  assert.equal(inspected(inspectCreativeImageHeader(neutralPng)).orientation, 1);

  // WebP: the EXIF chunk leaves, the RIFF size shrinks by its padded extent
  // and the VP8X EXIF flag clears; the bitstream bytes stay identical.
  const extended = webp([
    riffChunk("VP8X", vp8x(32, 20, 0x08 | 0x20)),
    riffChunk("VP8 ", vp8(32, 20)),
    riffChunk("EXIF", tiff),
  ]);
  const neutralWebp = decodeCopyWithoutOrientation(extended, "webp");
  const expectedWebp = webp([
    riffChunk("VP8X", vp8x(32, 20, 0x20)),
    riffChunk("VP8 ", vp8(32, 20)),
  ]);
  assert.deepEqual([...neutralWebp], [...expectedWebp]);
  const neutralWebpHeader = inspected(inspectCreativeImageHeader(neutralWebp));
  assert.equal(neutralWebpHeader.orientation, 1);
  assert.deepEqual([neutralWebpHeader.width, neutralWebpHeader.height], [32, 20]);

  // Files without orientation metadata pass through unchanged.
  assert.deepEqual([...decodeCopyWithoutOrientation(png(4, 4), "png")], [...png(4, 4)]);
  const plainJpeg = Uint8Array.of(0xff, 0xd8, ...sof(8, 8), 0xff, 0xd9);
  assert.deepEqual([...decodeCopyWithoutOrientation(plainJpeg, "jpeg")], [...plainJpeg]);
});

test("WebP bounds hold at the declared limits", () => {
  const side = CREATIVE_LIMITS.maxDecodedSide;
  assert.equal(
    refused(inspectCreativeImageHeader(webp([riffChunk("VP8 ", vp8(side + 1, 1))]))).reason,
    "dimensions",
  );
  assert.equal(
    refused(inspectCreativeImageHeader(webp([riffChunk("VP8X", vp8x(4097, 4096))]))).reason,
    "dimensions",
  );
});
