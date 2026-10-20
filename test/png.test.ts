import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";
import { EGA_RGB, encodePngRgb, surfaceToPng } from "../src/picture/png.ts";

/** Independent bitwise CRC-32 (no lookup table) so the encoder's table is checked, not trusted. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(type: string, data: number[]): number[] {
  const typed = [...type].map((c) => c.charCodeAt(0));
  const crc = crc32(new Uint8Array([...typed, ...data]));
  return [...be32(data.length), ...typed, ...data, ...be32(crc)];
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("png encoder (zero dependency, stored deflate)", () => {
  it("encodes a 1x1 RGB pixel to exact hand-computed bytes", () => {
    // Raw PNG scanline data: one filter byte (0 = none) + one RGB triple.
    const raw = [0x00, 0xaa, 0x00, 0x00];

    // zlib stream: CMF 0x78, FLG 0x01 (0x7801 % 31 === 0); one final stored
    // block (BFINAL=1, BTYPE=00) with LEN=4 / NLEN=~4; then Adler-32.
    // Adler by hand over [00 aa 00 00]: a = 1+0+170+0+0 = 171 (0x00ab);
    // b accumulates a at each step: 1, 172, 343, 514 (0x0202). Adler = 0x020200ab.
    const zlib = [0x78, 0x01, 0x01, 0x04, 0x00, 0xfb, 0xff, ...raw, 0x02, 0x02, 0x00, 0xab];

    const ihdr = [
      ...be32(1), // width
      ...be32(1), // height
      8, // bit depth
      2, // colour type: truecolour RGB
      0, // compression: deflate
      0, // filter method: adaptive
      0, // interlace: none
    ];

    const expected = new Uint8Array([
      ...SIGNATURE,
      ...chunk("IHDR", ihdr),
      ...chunk("IDAT", zlib),
      ...chunk("IEND", []),
    ]);

    const png = encodePngRgb(1, 1, new Uint8Array([0xaa, 0x00, 0x00]));
    assert.deepEqual([...png], [...expected]);
    assert.equal(png.length, 8 + (12 + 13) + (12 + 15) + 12);
  });

  it("produces an IDAT stream a real inflater accepts, across multiple stored blocks", () => {
    // 40000 RGB pixels => 120040 raw bytes => three 65535-byte stored blocks.
    const width = 200;
    const height = 200;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 7) & 0xff;
    const png = encodePngRgb(width, height, rgb);

    // Walk the chunks and pull IDAT out.
    let p = 8;
    const chunks = new Map<string, Uint8Array>();
    while (p < png.length) {
      const len = (png[p]! << 24) | (png[p + 1]! << 16) | (png[p + 2]! << 8) | png[p + 3]!;
      const type = String.fromCharCode(png[p + 4]!, png[p + 5]!, png[p + 6]!, png[p + 7]!);
      const data = png.subarray(p + 8, p + 8 + len);
      const crc =
        (png[p + 8 + len]! << 24) |
        (png[p + 9 + len]! << 16) |
        (png[p + 10 + len]! << 8) |
        png[p + 11 + len]!;
      assert.equal(crc >>> 0, crc32(png.subarray(p + 4, p + 8 + len)), `${type} chunk CRC`);
      chunks.set(type, data);
      p += 12 + len;
    }
    assert.deepEqual([...chunks.keys()], ["IHDR", "IDAT", "IEND"]);

    const inflated = new Uint8Array(inflateSync(Buffer.from(chunks.get("IDAT")!)));
    assert.equal(inflated.length, (width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
      assert.equal(inflated[y * (width * 3 + 1)], 0, `row ${y} filter byte`);
      assert.deepEqual(
        [...inflated.subarray(y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1))],
        [...rgb.subarray(y * width * 3, (y + 1) * width * 3)],
        `row ${y} pixels`,
      );
    }
  });

  it("upscales a nibble surface nearest-neighbour through the EGA palette", () => {
    // 2x2 surface: colours 0 (black), 4 (dark red), 15 (white), 2 (green).
    const surface = new Uint8Array([0, 4, 15, 2]);
    const png = surfaceToPng(surface, 2, 2, { scale: 2 });

    let p = 8;
    let idat: Uint8Array | null = null;
    let dims: [number, number] = [0, 0];
    while (p < png.length) {
      const len = (png[p]! << 24) | (png[p + 1]! << 16) | (png[p + 2]! << 8) | png[p + 3]!;
      const type = String.fromCharCode(png[p + 4]!, png[p + 5]!, png[p + 6]!, png[p + 7]!);
      const data = png.subarray(p + 8, p + 8 + len);
      if (type === "IHDR") {
        dims = [
          (data[0]! << 24) | (data[1]! << 16) | (data[2]! << 8) | data[3]!,
          (data[4]! << 24) | (data[5]! << 16) | (data[6]! << 8) | data[7]!,
        ];
      }
      if (type === "IDAT") idat = data;
      p += 12 + len;
    }
    assert.deepEqual(dims, [4, 4]);

    const px = new Uint8Array(inflateSync(Buffer.from(idat!)));
    const row = (y: number): number[] => [...px.subarray(y * 13 + 1, y * 13 + 13)];
    const c = (n: number): number[] => [...EGA_RGB[n]!];

    // Rows 0 and 1 are the top surface row doubled: 0 0 4 4.
    const top = [...c(0), ...c(0), ...c(4), ...c(4)];
    const bottom = [...c(15), ...c(15), ...c(2), ...c(2)];
    assert.deepEqual(row(0), top);
    assert.deepEqual(row(1), top);
    assert.deepEqual(row(2), bottom);
    assert.deepEqual(row(3), bottom);
  });

  it("rejects a pixel buffer that does not match the declared dimensions", () => {
    assert.throws(() => encodePngRgb(2, 2, new Uint8Array(11)), /expected 12 RGB bytes, got 11/);
    assert.throws(() => encodePngRgb(0, 1, new Uint8Array(0)), /bad dimensions/);
  });
});
