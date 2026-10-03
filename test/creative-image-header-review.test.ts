import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectCreativeImageHeader } from "../src/creative/imageHeader.ts";

function extendedWebp(canvas: number, width: number, height: number): Uint8Array {
  // RIFF payload: WEBP, VP8X (10 bytes), VP8L (5 bytes + required padding).
  const bytes = new Uint8Array(44);
  bytes.set([82, 73, 70, 70], 0);
  bytes.set([87, 69, 66, 80, 86, 80, 56, 88], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 36, true);
  view.setUint32(16, 10, true);
  const side = canvas - 1;
  bytes[24] = side & 255;
  bytes[25] = (side >>> 8) & 255;
  bytes[26] = (side >>> 16) & 255;
  bytes[27] = side & 255;
  bytes[28] = (side >>> 8) & 255;
  bytes[29] = (side >>> 16) & 255;
  bytes.set([86, 80, 56, 76], 30);
  view.setUint32(34, 5, true);
  bytes[38] = 47;
  view.setUint32(39, (width - 1) | ((height - 1) << 14), true);
  return bytes;
}

test("PNG inspection refuses an IHDR with a truncated checksum", () => {
  // Signature, thirteen-byte IHDR data, then only three of its four CRC bytes.
  const bytes = Uint8Array.of(
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    0,
    0,
    0,
    13,
    73,
    72,
    68,
    82,
    0,
    0,
    0,
    2,
    0,
    0,
    0,
    2,
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  const result = inspectCreativeImageHeader(bytes);
  assert.equal(result.ok, false, "known incomplete first chunk must refuse before browser decode");
});

test("a small WebP canvas cannot hide an over-budget bitstream", () => {
  const result = inspectCreativeImageHeader(extendedWebp(2, 8192, 8192));
  assert.equal(result.ok, false, "every declared decoded extent needs preallocation validation");
});

test("static WebP canvas and bitstream dimensions must agree", () => {
  const result = inspectCreativeImageHeader(extendedWebp(2, 3, 3));
  assert.equal(result.ok, false, "conflicting still dimensions cannot be offered to a decoder");
});

test("WebP chunk inspection refuses a missing required odd-size padding byte", () => {
  const bytes = extendedWebp(2, 2, 2).slice(0, 43);
  new DataView(bytes.buffer).setUint32(4, 35, true);
  const result = inspectCreativeImageHeader(bytes);
  assert.equal(result.ok, false, "a chunk padding byte cannot fall beyond the declared container");
});
