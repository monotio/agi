import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";
import { encodePngPaletteRgb } from "../src/picture/png.ts";

interface ParsedPng {
  chunks: Map<string, Uint8Array>;
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parsePng(png: Uint8Array): ParsedPng {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  const chunks = new Map<string, Uint8Array>();
  let offset = 8;
  while (offset < png.length) {
    const view = new DataView(png.buffer, png.byteOffset + offset);
    const length = view.getUint32(0);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(
      view.getUint32(8 + length),
      crc32(png.subarray(offset + 4, offset + 8 + length)),
      `${type} CRC`,
    );
    chunks.set(type, data);
    offset += 12 + length;
  }
  const header = new DataView(chunks.get("IHDR")!.buffer, chunks.get("IHDR")!.byteOffset);
  return {
    chunks,
    width: header.getUint32(0),
    height: header.getUint32(4),
    bitDepth: header.getUint8(8),
    colorType: header.getUint8(9),
  };
}

function reconstruct(parsed: ParsedPng): Uint8Array {
  const palette = parsed.chunks.get("PLTE")!;
  const raw = new Uint8Array(inflateSync(parsed.chunks.get("IDAT")!));
  const rgb = new Uint8Array(parsed.width * parsed.height * 3);
  for (let y = 0; y < parsed.height; y++) {
    const row = y * (parsed.width + 1);
    assert.equal(raw[row], 0, `row ${y} filter`);
    for (let x = 0; x < parsed.width; x++) {
      const index = raw[row + x + 1]!;
      rgb.set(palette.subarray(index * 3, index * 3 + 3), (y * parsed.width + x) * 3);
    }
  }
  return rgb;
}

describe("indexed palette PNG encoder", () => {
  it("stores first-seen palette colors and exact 8-bit pixel indexes", () => {
    const rgb = Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0);
    const parsed = parsePng(encodePngPaletteRgb(2, 2, rgb));
    assert.deepEqual([...parsed.chunks.keys()], ["IHDR", "PLTE", "IDAT", "IEND"]);
    assert.deepEqual(
      [parsed.width, parsed.height, parsed.bitDepth, parsed.colorType],
      [2, 2, 8, 3],
    );
    assert.deepEqual([...parsed.chunks.get("PLTE")!], [255, 0, 0, 0, 255, 0, 0, 0, 255]);
    assert.deepEqual(
      [...new Uint8Array(inflateSync(parsed.chunks.get("IDAT")!))],
      [0, 0, 1, 0, 2, 0],
    );
    assert.deepEqual(reconstruct(parsed), rgb);
  });

  it("rejects invalid dimensions, lengths and images with more than 256 colors", () => {
    assert.throws(() => encodePngPaletteRgb(0, 1, new Uint8Array()), /bad dimensions/);
    assert.throws(
      () => encodePngPaletteRgb(2, 2, new Uint8Array(11)),
      /expected 12 RGB bytes, got 11/,
    );
    const tooMany = new Uint8Array(257 * 3);
    for (let color = 0; color < 257; color++) {
      tooMany[color * 3] = color & 255;
      tooMany[color * 3 + 1] = color >> 8;
    }
    assert.throws(() => encodePngPaletteRgb(257, 1, tooMany), /more than 256 colors/i);
  });

  it("keeps an 800x400 graph below transport limits with exact pixel reconstruction", () => {
    const width = 800;
    const height = 400;
    const colors = [
      [15, 20, 30],
      [30, 120, 220],
      [240, 245, 250],
      [255, 180, 20],
      [220, 60, 70],
      [80, 190, 120],
      [125, 90, 200],
      [90, 100, 115],
      [255, 255, 255],
    ] as const;
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const color = colors[(Math.floor(x / 80) + Math.floor(y / 40)) % colors.length]!;
        rgb.set(color, (y * width + x) * 3);
      }
    }
    const png = encodePngPaletteRgb(width, height, rgb);
    assert.ok(png.length < 500_000, `${png.length} byte indexed graph exceeds transport cap`);
    assert.deepEqual(reconstruct(parsePng(png)), rgb);
  });
});
