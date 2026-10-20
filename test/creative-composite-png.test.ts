import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/crypto.ts";
import {
  CREATIVE_LIMITS,
  CREATIVE_SOURCE_FORMAT,
  readCreativeSource,
  type CreativeSource,
} from "../src/creative/catalog.ts";
import {
  checkCompositeSourceBytes,
  compositeSelection,
  encodePngRgba,
  encodedPngRgbaSize,
} from "../src/creative/composite.ts";

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

/** Independent chunk walk: checks signature, CRCs, and returns typed chunks. */
function parsePng(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assert.deepEqual([...bytes.subarray(0, 8)], signature, "PNG signature");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: { type: string; data: Uint8Array }[] = [];
  let pos = 8;
  while (pos + 12 <= bytes.length) {
    const length = view.getUint32(pos, false);
    assert.ok(pos + 12 + length <= bytes.length, `chunk at ${pos} overruns the file`);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    const expectedCrc = view.getUint32(pos + 8 + length, false);
    // Independent CRC-32 over type+data.
    let crc = 0xffffffff;
    for (const b of bytes.subarray(pos + 4, pos + 8 + length)) {
      crc ^= b;
      for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    assert.equal(expectedCrc, (crc ^ 0xffffffff) >>> 0, `${type} chunk CRC`);
    chunks.push({ type, data });
    pos += 12 + length;
  }
  assert.equal(pos, bytes.length, "trailing bytes after IEND");
  return chunks;
}

/** Independent zlib-stored-block unwrap with Adler-32 verification. */
function unzlibStored(zlib: Uint8Array): Uint8Array {
  assert.equal(zlib[0], 0x78, "zlib CMF");
  assert.equal(
    (zlib[0]! << 8) + zlib[1]!,
    (zlib[0]! << 8) + zlib[1]! - (((zlib[0]! << 8) + zlib[1]!) % 31),
    "FCHECK",
  );
  const view = new DataView(zlib.buffer, zlib.byteOffset, zlib.byteLength);
  const out: number[] = [];
  let pos = 2;
  let final = false;
  while (!final) {
    assert.ok(pos + 5 <= zlib.length - 4, "stored block header truncated");
    const header = zlib[pos]!;
    assert.equal(header >> 1, 0, "only stored (BTYPE 00) blocks are emitted");
    final = (header & 1) === 1;
    const length = view.getUint16(pos + 1, true);
    const nlen = view.getUint16(pos + 3, true);
    assert.equal(length, ~nlen & 0xffff, "LEN/NLEN pair");
    out.push(...zlib.subarray(pos + 5, pos + 5 + length));
    pos += 5 + length;
  }
  assert.equal(pos, zlib.length - 4, "Adler-32 trailer position");
  const raw = new Uint8Array(out);
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  assert.equal(view.getUint32(pos, false), ((b << 16) | a) >>> 0, "Adler-32 checksum");
  return raw;
}

test("encodePngRgba emits a deterministic sRGB RGBA PNG that decodes byte-exact", () => {
  const { pixels } = raster(3, 2, (x, y) => [x * 10, y * 20, 5, (x + y) % 2 ? 255 : 17]);
  const png = encodePngRgba(3, 2, pixels);
  assert.equal(png.length, encodedPngRgbaSize(3, 2), "precomputed size is exact");
  const second = encodePngRgba(3, 2, pixels);
  assert.deepEqual([...png], [...second], "encoder is deterministic");

  const chunks = parsePng(png);
  const types = chunks.map((chunk) => chunk.type);
  assert.deepEqual(types, ["IHDR", "sRGB", "IDAT", "IEND"]);
  const ihdr = chunks[0]!.data;
  const ihdrView = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  assert.equal(ihdrView.getUint32(0), 3);
  assert.equal(ihdrView.getUint32(4), 2);
  assert.equal(ihdr[8], 8, "8-bit depth");
  assert.equal(ihdr[9], 6, "RGBA colour type");
  assert.equal(chunks[1]!.data[0], 0, "sRGB perceptual rendering intent");

  const raw = unzlibStored(chunks[2]!.data);
  const expected = new Uint8Array((3 * 4 + 1) * 2);
  for (let y = 0; y < 2; y++) {
    expected[y * 13] = 0;
    expected.set(pixels.subarray(y * 12, y * 12 + 12), y * 13 + 1);
  }
  assert.deepEqual([...raw], [...expected], "filter-0 scanlines carry the exact pixels");
});

test("encodePngRgba covers a stored-block boundary and odd sizes", () => {
  // (w*4+1)*h must exceed 65535 so two stored blocks are emitted.
  const width = 8192;
  const height = 3;
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7 + 3) & 0xff;
  const png = encodePngRgba(width, height, pixels);
  const chunks = parsePng(png);
  const idat = chunks.find((chunk) => chunk.type === "IDAT")!;
  const raw = unzlibStored(idat.data);
  assert.equal(raw.length, (width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width * 4 + 1)], 0);
    assert.deepEqual(
      [...raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1))],
      [...pixels.subarray(y * width * 4, (y + 1) * width * 4)],
    );
  }
});

test("composite rasters refuse inputs the wrong length or rect outside the base", () => {
  const base = raster(3, 3, () => [1, 2, 3, 4]);
  const provider = raster(2, 2, () => [9, 9, 9, 9]);
  assert.throws(
    () =>
      compositeSelection({ width: 3, height: 3, pixels: new Uint8Array(4) }, provider, {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      }),
    /pixel|raster/i,
  );
  assert.throws(
    () => compositeSelection(base, provider, { x: 2, y: 0, width: 2, height: 1 }),
    /bounds|inside/i,
  );
});

test("partial-alpha and zero-alpha base bytes outside the selection are preserved verbatim", () => {
  // Hand-computed: base rows carry partial alpha (128) and fully transparent
  // pixels whose RGB bytes differ — every byte outside the rect must survive.
  const base = raster(4, 3, (x, y) => [x * 17, 200 - y * 50, 90, (x * 64 + y) % 256]);
  const provider = raster(4, 3, () => [10, 20, 30, 128]);
  const out = compositeSelection(base, provider, { x: 1, y: 1, width: 2, height: 2 });
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 4; x++) {
      const inside = x >= 1 && x < 3 && y >= 1 && y < 3;
      const at = (y * 4 + x) * 4;
      if (inside) assert.deepEqual([...out.pixels.subarray(at, at + 4)], [10, 20, 30, 128]);
      else {
        const bp = (y * 4 + x) * 4;
        assert.deepEqual(
          [...out.pixels.subarray(at, at + 4)],
          [...base.pixels.subarray(bp, bp + 4)],
          `pixel ${x},${y} outside selection`,
        );
      }
    }
  // Neither input mutated.
  assert.deepEqual(
    [...base.pixels],
    [...raster(4, 3, (x, y) => [x * 17, 200 - y * 50, 90, (x * 64 + y) % 256]).pixels],
  );
});

test("checkCompositeSourceBytes verifies record, canonical and encoded bytes against the transform", () => {
  const basePixels = raster(4, 4, (x, y) => [x * 40, y * 40, 5, 255]).pixels;
  const providerPixels = raster(8, 8, (x, y) => [x, y, 7, 200]).pixels;
  const selection = { x: 1, y: 1, width: 2, height: 2 };
  const composite = compositeSelection(
    { width: 4, height: 4, pixels: basePixels },
    { width: 8, height: 8, pixels: providerPixels },
    selection,
  );
  const png = encodePngRgba(4, 4, composite.pixels);
  const providerEncoded = new Uint8Array([1, 2, 3, 4]);

  const ref = (id: string) => ({ id, incarnation: `inc-${id}`, revision: 0 });
  const rasterRef = (pixels: Uint8Array, width: number, height: number) => ({
    blob: { hash: sha256Hex(pixels), byteLength: pixels.length, mime: "application/x-rgba8" },
    format: "rgba8-srgb-unpremultiplied-v1" as const,
    width,
    height,
  });
  const baseRecord: CreativeSource = {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: ref("base"),
    encoded: { hash: sha256Hex(new Uint8Array([9])), byteLength: 1, mime: "image/png" },
    availability: "original",
    normalized: rasterRef(basePixels, 4, 4),
    origin: { kind: "import", title: "Base" },
  };
  const providerRecord: CreativeSource = {
    ...baseRecord,
    identity: ref("provider"),
    encoded: {
      hash: sha256Hex(providerEncoded),
      byteLength: providerEncoded.length,
      mime: "image/png",
    },
    normalized: rasterRef(providerPixels, 8, 8),
    origin: { kind: "generated", title: "Provider" },
  };
  const compositeRecord: CreativeSource = {
    ...baseRecord,
    identity: ref("composite"),
    encoded: { hash: sha256Hex(png), byteLength: png.length, mime: "image/png" },
    normalized: rasterRef(composite.pixels, 4, 4),
    origin: { kind: "composite", title: "Composite" },
    derivation: {
      kind: "selection-composite",
      version: 1,
      base: baseRecord.identity,
      provider: providerRecord.identity,
      selection,
      algorithm: "agi.edit-selection-composite-v1",
    },
  };
  readCreativeSource(structuredClone({ ...compositeRecord }));
  const blobs: Record<string, Uint8Array> = {
    [baseRecord.normalized.blob.hash]: basePixels,
    [providerRecord.normalized.blob.hash]: providerPixels,
    [providerRecord.encoded.hash]: providerEncoded,
    [compositeRecord.normalized.blob.hash]: composite.pixels,
    [compositeRecord.encoded.hash]: png,
  };
  const sources = [baseRecord, providerRecord, compositeRecord];
  assert.doesNotThrow(() => checkCompositeSourceBytes(sources, (hash) => blobs[hash]));

  // Tampered canonical composite — hash-correct bytes that were not produced
  // by the transform — must still refuse.
  const tamperedPixels = new Uint8Array(composite.pixels);
  tamperedPixels[0] = (tamperedPixels[0]! + 1) & 0xff;
  const tampered: CreativeSource = {
    ...compositeRecord,
    normalized: rasterRef(tamperedPixels, 4, 4),
  };
  assert.throws(
    () =>
      checkCompositeSourceBytes([baseRecord, providerRecord, tampered], (hash) =>
        hash === tampered.normalized.blob.hash ? tamperedPixels : blobs[hash],
      ),
    /composite|canonical|recompute/i,
  );

  // Tampered encoded PNG — hash-correct but not the deterministic encoder's
  // output — refuses as well. Flip a byte inside the IDAT payload.
  const tamperedPng = new Uint8Array(png);
  tamperedPng[png.length - 20] = (tamperedPng[png.length - 20]! + 1) & 0xff;
  const forged: CreativeSource = {
    ...compositeRecord,
    encoded: { hash: sha256Hex(tamperedPng), byteLength: tamperedPng.length, mime: "image/png" },
  };
  assert.throws(
    () =>
      checkCompositeSourceBytes([baseRecord, providerRecord, forged], (hash) =>
        hash === forged.encoded.hash ? tamperedPng : blobs[hash],
      ),
    /encoded|png|original/i,
  );

  // Missing parent bytes refuse rather than skip.
  assert.throws(() => checkCompositeSourceBytes(sources, () => undefined), /byte|blob|missing/i);
});

test("encodedPngRgbaSize refuses rasters whose encoded original exceeds the file bound", () => {
  const w = CREATIVE_LIMITS.maxDecodedSide;
  const h = CREATIVE_LIMITS.maxDecodedSide;
  // The max raster (8192x8192) encodes far over maxFileBytes — the caller
  // preflights before allocating.
  assert.ok(encodedPngRgbaSize(w, h) > CREATIVE_LIMITS.maxFileBytes);
});
