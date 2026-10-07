import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSelectionMaskPng,
  compositeSelection,
  CreativeSelectionError,
  EDIT_COMPOSITE_ALGORITHM,
  mapSelection,
  normalizeSelection,
} from "../src/studio/creative/creativeSelectionComposite.ts";
import { inspectCreativeImageHeader } from "../../src/creative/imageHeader.ts";

function raster(
  width: number,
  height: number,
  paint: (x: number, y: number) => readonly [number, number, number, number],
) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const [r, g, b, a] = paint(x, y);
      pixels[p] = r;
      pixels[p + 1] = g;
      pixels[p + 2] = b;
      pixels[p + 3] = a;
    }
  }
  return { width, height, pixels };
}

test("normalizeSelection accepts interior rects and refuses outside or fractional ones", () => {
  assert.deepEqual(normalizeSelection({ x: 1, y: 2, width: 3, height: 4 }, 8, 8), {
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  });
  for (const rect of [
    { x: -1, y: 0, width: 2, height: 2 },
    { x: 0, y: 0, width: 9, height: 2 },
    { x: 6, y: 0, width: 3, height: 2 },
    { x: 0, y: 7, width: 2, height: 2 },
    { x: 0, y: 0, width: 0, height: 2 },
    { x: 0, y: 0, width: 2, height: 0 },
    { x: 0.5, y: 0, width: 2, height: 2 },
    { x: 0, y: 0, width: 2, height: 2.5 },
  ]) {
    assert.throws(
      () => normalizeSelection(rect, 8, 8),
      (error: unknown) => error instanceof CreativeSelectionError && error.reason === "bounds",
    );
  }
});

test("same-size composite writes only the authorized rect and preserves every protected pixel", () => {
  const base = raster(4, 4, (x, y) => [x * 40, y * 40, 5, 255]);
  const edited = raster(4, 4, (x, y) => [200, x * 30, y * 30, 17]);
  const out = compositeSelection(base, edited, { x: 1, y: 1, width: 2, height: 2 });

  assert.equal(out.algorithm, EDIT_COMPOSITE_ALGORITHM);
  assert.deepEqual(out.region, { x: 1, y: 1, width: 2, height: 2 });
  // Hand-computed expectation: every pixel outside (1,1)..(2,2) is the base
  // byte for byte; inside it is the provider pixel, alpha included.
  const expected = raster(4, 4, (x, y) =>
    x >= 1 && x < 3 && y >= 1 && y < 3 ? [200, x * 30, y * 30, 17] : [x * 40, y * 40, 5, 255],
  );
  assert.deepEqual([...out.pixels], [...expected.pixels]);
  // The base input is untouched and the output is an owned copy.
  assert.notEqual(out.pixels, base.pixels);
  const check = raster(4, 4, (x, y) => [x * 40, y * 40, 5, 255]);
  assert.deepEqual([...base.pixels], [...check.pixels]);
});

test("a full-image selection resamples the whole provider image nearest-neighbour", () => {
  const base = raster(2, 2, () => [0, 0, 0, 255]);
  const edited = raster(4, 4, (x, y) => [x * 10, y * 10, 3, 255]);
  const out = compositeSelection(base, edited, { x: 0, y: 0, width: 2, height: 2 });
  assert.deepEqual(out.region, { x: 0, y: 0, width: 4, height: 4 });
  // dest (0,0)<-src(0,0); (1,0)<-src(2,0); (0,1)<-src(0,2); (1,1)<-src(2,2)
  const expected = [0, 0, 3, 255, 20, 0, 3, 255, 0, 20, 3, 255, 20, 20, 3, 255];
  assert.deepEqual([...out.pixels], expected);
});

test("a larger provider output maps the selection proportionally before sampling", () => {
  const base = raster(4, 4, () => [9, 9, 9, 255]);
  const edited = raster(8, 8, (x, y) => [x, y, 7, 255]);
  // Selection right half of base rows 0..3 maps to x 4..7 of the 8x8 output.
  const out = compositeSelection(base, edited, { x: 2, y: 0, width: 2, height: 4 });
  assert.deepEqual(out.region, { x: 4, y: 0, width: 4, height: 8 });
  // dest(2,0) <- src(4,0); dest(3,0) <- src(6,0); dest(2,2) <- src(4,4)
  const at = (x: number, y: number) => [
    ...out.pixels.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4),
  ];
  assert.deepEqual(at(2, 0), [4, 0, 7, 255]);
  assert.deepEqual(at(3, 0), [6, 0, 7, 255]);
  assert.deepEqual(at(2, 2), [4, 4, 7, 255]);
  assert.deepEqual(at(3, 3), [6, 6, 7, 255]);
  // Column 0..1 stays the protected base.
  assert.deepEqual(at(0, 0), [9, 9, 9, 255]);
  assert.deepEqual(at(1, 3), [9, 9, 9, 255]);
});

test("provider pixel alpha is copied verbatim inside the selection", () => {
  const base = raster(2, 1, () => [50, 60, 70, 255]);
  const edited = raster(2, 1, () => [1, 2, 3, 0]);
  const out = compositeSelection(base, edited, { x: 1, y: 0, width: 1, height: 1 });
  assert.deepEqual([...out.pixels], [50, 60, 70, 255, 1, 2, 3, 0]);
});

test("composite refuses mismatched raster lengths and out-of-bounds selections", () => {
  const base = raster(2, 2, () => [0, 0, 0, 255]);
  const edited = raster(2, 2, () => [1, 1, 1, 255]);
  assert.throws(
    () =>
      compositeSelection({ width: 2, height: 2, pixels: new Uint8Array(4) }, edited, {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      }),
    (error: unknown) => error instanceof CreativeSelectionError && error.reason === "pixels",
  );
  assert.throws(
    () => compositeSelection(base, edited, { x: 1, y: 0, width: 2, height: 2 }),
    (error: unknown) => error instanceof CreativeSelectionError && error.reason === "bounds",
  );
});

/** Minimal PNG chunk walk + stored-zlib unwrap for exact byte assertions. */
function parsePng(bytes: Uint8Array): { type: string; data: Uint8Array }[] {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: { type: string; data: Uint8Array }[] = [];
  let pos = 8;
  while (pos + 12 <= bytes.length) {
    const length = view.getUint32(pos, false);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    chunks.push({ type, data: bytes.subarray(pos + 8, pos + 8 + length) });
    pos += 12 + length;
  }
  assert.equal(pos, bytes.length);
  return chunks;
}

function unzlibStored(zlib: Uint8Array): Uint8Array {
  assert.equal(zlib[0], 0x78);
  const out: number[] = [];
  const view = new DataView(zlib.buffer, zlib.byteOffset, zlib.byteLength);
  let pos = 2;
  for (;;) {
    const header = zlib[pos]!;
    const length = view.getUint16(pos + 1, true);
    const nlen = view.getUint16(pos + 3, true);
    assert.equal(length & 0xffff, ~nlen & 0xffff);
    out.push(...zlib.subarray(pos + 5, pos + 5 + length));
    pos += 5 + length;
    if (header & 1) break;
  }
  return new Uint8Array(out);
}

test("the provider mask is a same-size RGBA PNG with alpha 0 only inside the selection", () => {
  const png = buildSelectionMaskPng(2, 2, { x: 0, y: 0, width: 1, height: 1 });
  const verdict = inspectCreativeImageHeader(png);
  assert.ok(verdict.ok, `the built mask parses: ${verdict.ok ? "" : verdict.message}`);
  assert.equal(verdict.header.format, "png");
  assert.equal(verdict.header.width, 2);
  assert.equal(verdict.header.height, 2);

  const chunks = parsePng(png);
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR")!;
  assert.equal(ihdr.data[8], 8, "8-bit depth");
  assert.equal(ihdr.data[9], 6, "RGBA colour type");
  const idat = chunks.find((chunk) => chunk.type === "IDAT")!;
  const raw = unzlibStored(idat.data);
  // 2 rows of filter byte + 2 RGBA pixels: selection pixel alpha 0, rest 255.
  const expected = [
    0, 255, 255, 255, 0, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255,
  ];
  assert.deepEqual([...raw], expected);
});

test("mapSelection is the identity on equal dimensions and floors the origin", () => {
  assert.deepEqual(mapSelection({ x: 1, y: 1, width: 2, height: 2 }, 4, 4, 4, 4), {
    x: 1,
    y: 1,
    width: 2,
    height: 2,
  });
  assert.deepEqual(mapSelection({ x: 0, y: 0, width: 1, height: 1 }, 3, 3, 8, 8), {
    x: 0,
    y: 0,
    width: 3,
    height: 3,
  });
  // Origin floors, far edge ceils: 1..2 of 3 maps to 2..6 of 8.
  assert.deepEqual(mapSelection({ x: 1, y: 1, width: 1, height: 1 }, 3, 3, 8, 8), {
    x: 2,
    y: 2,
    width: 4,
    height: 4,
  });
});
