import { expect, test } from "./test.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { crc32 } from "../src/archive/zip.ts";

// Independently authored little-endian TIFF: one orientation-6 SHORT in IFD0.
const TIFF = Uint8Array.of(
  73,
  73,
  42,
  0,
  8,
  0,
  0,
  0,
  1,
  0,
  18,
  1,
  3,
  0,
  1,
  0,
  0,
  0,
  6,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
);

function orientedPng(orientation = 6): Uint8Array {
  const png = encodePngRgb(
    3,
    2,
    Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0),
  );
  const chunk = new Uint8Array(12 + TIFF.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, TIFF.length);
  chunk.set([101, 88, 73, 102], 4); // eXIf
  chunk.set(TIFF, 8);
  chunk[8 + 18] = orientation;
  view.setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
  const result = new Uint8Array(png.length + chunk.length);
  result.set(png.subarray(0, 33));
  result.set(chunk, 33);
  result.set(png.subarray(33), 33 + chunk.length);
  return result;
}

function orientedWebp(): Uint8Array {
  // Project-owned 32x20 solid-blue WebP also used in reference-art.spec.ts.
  const base = Buffer.from(
    "UklGRkIAAABXRUJQVlA4IDYAAAAQAwCdASogABQAPm0ylkekIyIhKAgAgA2JZQB2AACQ7IgA/u4KZ//cGZ9XY4f/4tz9uuXwAAA=",
    "base64",
  );
  const extended = new Uint8Array(18);
  extended.set([86, 80, 56, 88]); // VP8X
  new DataView(extended.buffer).setUint32(4, 10, true);
  extended[8] = 8; // EXIF present
  extended[12] = 31;
  extended[15] = 19;
  const exif = new Uint8Array(8 + TIFF.length);
  exif.set([69, 88, 73, 70]);
  new DataView(exif.buffer).setUint32(4, TIFF.length, true);
  exif.set(TIFF, 8);
  const result = new Uint8Array(base.length + extended.length + exif.length);
  result.set(base.subarray(0, 12));
  result.set(extended, 12);
  result.set(base.subarray(12), 12 + extended.length);
  result.set(exif, base.length + extended.length);
  new DataView(result.buffer).setUint32(4, result.length - 8, true);
  return result;
}

for (const format of ["png", "webp"] as const) {
  test(`EXIF-oriented ${format} remains importable with exact original bytes @webkit-desktop`, async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto("/");
    const bytes = format === "png" ? orientedPng() : orientedWebp();
    const result = await page.evaluate(
      async ({ encoded, format }) => {
        const { decodeCreativeImage } = await import("/src/references/creativeImageDecode.ts");
        const raw = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
        const file = new File([raw], `drawing.${format}`, { type: `image/${format}` });
        const witness = await createImageBitmap(file, { premultiplyAlpha: "none" });
        const observed = [witness.width, witness.height];
        witness.close();
        try {
          const intake = await decodeCreativeImage(file);
          return {
            ok: true,
            observed,
            dimensions: [intake.normalized.width, intake.normalized.height],
            orientation: intake.orientation,
            exact:
              intake.encodedBytes.length === raw.length &&
              intake.encodedBytes.every((b, i) => b === raw[i]),
            pixels: Array.from(intake.pixels.slice(0, 24)),
          };
        } catch (error) {
          return { ok: false, observed, reason: String(error) };
        }
      },
      { encoded: Buffer.from(bytes).toString("base64"), format },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.exact).toBe(true);
    expect(result.orientation).toBe(6);
    expect(result.dimensions).toEqual(format === "png" ? [2, 3] : [20, 32]);
    if (format === "png")
      expect(result.pixels).toEqual([
        0, 255, 255, 255, 255, 0, 0, 255, 255, 0, 255, 255, 0, 255, 0, 255, 255, 255, 0, 255, 0, 0,
        255, 255,
      ]);
    expect(pageErrors).toEqual([]);
  });
}

// Six independently named source pixels: A B C / D E F.
const COLORS = [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [0, 255, 255, 255],
  [255, 0, 255, 255],
  [255, 255, 0, 255],
];
const PLACEMENTS = [
  [1, 3, 2, [0, 1, 2, 3, 4, 5]],
  [2, 3, 2, [2, 1, 0, 5, 4, 3]],
  [3, 3, 2, [5, 4, 3, 2, 1, 0]],
  [4, 3, 2, [3, 4, 5, 0, 1, 2]],
  [5, 2, 3, [0, 3, 1, 4, 2, 5]],
  [6, 2, 3, [3, 0, 4, 1, 5, 2]],
  [7, 2, 3, [5, 2, 4, 1, 3, 0]],
  [8, 2, 3, [2, 5, 1, 4, 0, 3]],
] as const;

for (const [orientation, width, height, placement] of PLACEMENTS) {
  test(`orientation placement ${orientation} preserves exact six-pixel geometry @webkit-desktop`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto("/");
    const bytes = orientedPng(orientation);
    const result = await page.evaluate(async (encoded) => {
      const { decodeCreativeImage } = await import("/src/references/creativeImageDecode.ts");
      const raw = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      const intake = await decodeCreativeImage(
        new File([raw], "drawing.png", { type: "image/png" }),
      );
      return {
        dimensions: [intake.normalized.width, intake.normalized.height],
        orientation: intake.orientation,
        pixels: Array.from(intake.pixels),
        exact:
          intake.encodedBytes.length === raw.length &&
          intake.encodedBytes.every((value, i) => value === raw[i]),
      };
    }, Buffer.from(bytes).toString("base64"));
    expect(result.dimensions).toEqual([width, height]);
    expect(result.orientation).toBe(orientation);
    expect(result.pixels).toEqual(placement.flatMap((index) => COLORS[index]!));
    expect(result.exact).toBe(true);
    expect(errors).toEqual([]);
  });
}
