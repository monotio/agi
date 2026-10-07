import { crc32 } from "node:zlib";
import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { CREATIVE_LIMITS } from "../../src/creative/catalog.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { CREATIVE_RASTER_MIME } from "../src/references/creativeImageDecode.ts";

/**
 * Creative image intake through the real Vite app: the adapter module is
 * loaded by a plain dynamic import inside the page (no production hook), the
 * same way Studio reaches lazy modules. Every byte fixture here is synthetic
 * and project-owned: PNGs come from the project's own encoder, the JPEG is
 * canvas-encoded in the page with a spliced EXIF APP1, and the WebP is the
 * checked-in 32x20 solid-blue fixture also used by reference-art.spec.ts.
 */

const WEBP_BLUE_32x20 =
  "UklGRkIAAABXRUJQVlA4IDYAAAAQAwCdASogABQAPm0ylkekIyIhKAgAgA2JZQB2AACQ7IgA/u4KZ//cGZ9XY4f/4tz9uuXwAAA=";

interface IntakeOutcome {
  ok: boolean;
  reason?: string;
  message?: string;
  header?: {
    width: number;
    height: number;
    animated: boolean;
    frames?: number | undefined;
  };
  format?: string;
  mime?: string;
  byteLength?: number;
  encodedHash?: string;
  encodedExact?: boolean;
  normalizedMime?: string;
  normalizedHash?: string;
  normalizedLength?: number;
  width?: number;
  height?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  orientation?: number;
  pixelsLength?: number;
  samples?: number[][];
  firstOk?: boolean;
}

interface OfferArgs {
  b64: string;
  name: string;
  mime: string;
  samples: number[];
  abortBefore: boolean;
  behindB64?: string;
}

/**
 * Offer `bytes` to the adapter inside the page. `samples` lists pixel indices
 * whose RGBA quads come back for assertions; `abortBefore` delivers an
 * already-aborted signal; `behindB64` occupies the queue with a slow decode
 * so the offer can be cancelled while it waits.
 */
async function offer(
  page: Page,
  bytes: Uint8Array,
  opts: {
    name?: string;
    mime?: string;
    samples?: number[];
    abortBefore?: boolean;
    behindB64?: string;
  } = {},
): Promise<IntakeOutcome> {
  const args: OfferArgs = {
    b64: Buffer.from(bytes).toString("base64"),
    name: opts.name ?? "drawing.png",
    mime: opts.mime ?? "image/png",
    samples: opts.samples ?? [],
    abortBefore: opts.abortBefore ?? false,
    ...(opts.behindB64 !== undefined ? { behindB64: opts.behindB64 } : {}),
  };
  return page.evaluate(async (args: OfferArgs) => {
    const { decodeCreativeImage, CreativeImageError } =
      await import("/src/references/creativeImageDecode.ts");
    const raw = Uint8Array.from(atob(args.b64), (c) => c.charCodeAt(0));
    const controller = new AbortController();
    const file = new File([raw], args.name, { type: args.mime });
    const summarize = (r: {
      format: string;
      sourceWidth: number;
      sourceHeight: number;
      orientation: number;
      encoded: { hash: string; byteLength: number; mime: string };
      encodedBytes: Uint8Array;
      normalized: {
        blob: { hash: string; byteLength: number; mime: string };
        width: number;
        height: number;
      };
      pixels: Uint8Array;
    }) => ({
      ok: true,
      format: r.format,
      mime: r.encoded.mime,
      byteLength: r.encoded.byteLength,
      encodedHash: r.encoded.hash,
      encodedExact:
        r.encodedBytes.length === raw.length && r.encodedBytes.every((b, i) => b === raw[i]),
      normalizedMime: r.normalized.blob.mime,
      normalizedHash: r.normalized.blob.hash,
      normalizedLength: r.normalized.blob.byteLength,
      width: r.normalized.width,
      height: r.normalized.height,
      sourceWidth: r.sourceWidth,
      sourceHeight: r.sourceHeight,
      orientation: r.orientation,
      pixelsLength: r.pixels.length,
      samples: args.samples.map((i) => [...r.pixels.slice(i * 4, i * 4 + 4)]),
    });
    const refuse = (error: unknown) => ({
      ok: false,
      reason: error instanceof CreativeImageError ? error.reason : "foreign",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof CreativeImageError && error.header ? { header: error.header } : {}),
    });
    if (args.abortBefore) {
      controller.abort();
      try {
        return summarize(await decodeCreativeImage(file, controller.signal));
      } catch (error) {
        return refuse(error);
      }
    }
    if (args.behindB64 !== undefined) {
      // Occupy the queue with a slow decode, then cancel while queued.
      const behind = Uint8Array.from(atob(args.behindB64), (c) => c.charCodeAt(0));
      const first = decodeCreativeImage(new File([behind], "first.png"));
      const second = decodeCreativeImage(file, controller.signal);
      controller.abort();
      const firstOk = await first.then(
        () => true,
        () => false,
      );
      try {
        return { ...summarize(await second), firstOk };
      } catch (error) {
        return { ...refuse(error), firstOk };
      }
    }
    try {
      return summarize(await decodeCreativeImage(file, controller.signal));
    } catch (error) {
      return refuse(error);
    }
  }, args);
}

/** A plain Blob offer for the over-size refusal (no bytes cross the wire). */
async function offerEmptyBlob(page: Page, size: number): Promise<IntakeOutcome> {
  return page.evaluate(async (size) => {
    const { decodeCreativeImage, CreativeImageError } =
      await import("/src/references/creativeImageDecode.ts");
    try {
      await decodeCreativeImage(new Blob([new Uint8Array(size)]));
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof CreativeImageError ? error.reason : "foreign",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }, size);
}

const be32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const le32 = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
];
const le24 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** Splice an EXIF APP1 segment (TIFF + one orientation tag) after JPEG SOI. */
function withExifOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = [
    ...ascii("MM"),
    0,
    0x2a,
    ...be32(8),
    ...be16(1),
    0x01,
    0x12,
    0,
    3,
    ...be32(1),
    0,
    orientation,
    0,
    0,
    ...be32(0),
  ];
  const app1 = [0xff, 0xe1, ...be16(2 + 6 + tiff.length), ...ascii("Exif"), 0, 0, ...tiff];
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.slice(0, 2), 0);
  out.set(app1, 2);
  out.set(jpeg.slice(2), 2 + app1.length);
  return out;
}

/** A PNG chunk with its real CRC so no decoder can skip past it. */
function pngChunkChecked(type: string, data: Uint8Array): number[] {
  const body = Uint8Array.of(...ascii(type), ...data);
  return [...be32(data.length), ...body, ...be32(crc32(body) >>> 0)];
}

/**
 * Header-clean but undecodable: a structurally perfect PNG that carries no
 * image data at all. WebKit tolerates damaged IDAT payloads (it decodes
 * short or garbage streams to a partial frame), so only an absent raster is
 * a failure every engine agrees on. CRCs are real.
 */
function pngWithoutImageData(): Uint8Array {
  const ihdr = Uint8Array.of(...be32(8), ...be32(8), 8, 2, 0, 0, 0);
  return Uint8Array.of(
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...pngChunkChecked("IHDR", ihdr),
    ...pngChunkChecked("IEND", new Uint8Array(0)),
  );
}

/** An APNG marker block inserted between IHDR and IDAT of a still PNG. */
function pngWithActl(png: Uint8Array, frames: number): Uint8Array {
  const actl = [...be32(8), ...ascii("acTL"), ...be32(frames), ...be32(0), 0, 0, 0, 0];
  const ihdrEnd = 8 + 25; // signature + IHDR chunk (length 13 + 12 framing)
  const out = new Uint8Array(png.length + actl.length);
  out.set(png.slice(0, ihdrEnd), 0);
  out.set(actl, ihdrEnd);
  out.set(png.slice(ihdrEnd), ihdrEnd + actl.length);
  return out;
}

function animatedWebp(): Uint8Array {
  const vp8x = [...ascii("VP8X"), ...le32(10), 0x02, 0, 0, 0, ...le24(319), ...le24(239)];
  const anim = [...ascii("ANIM"), ...le32(6), ...le32(0), ...le16(0)];
  const anmf = [
    ...ascii("ANMF"),
    ...le32(16),
    ...le24(0),
    ...le24(0),
    ...le24(319),
    ...le24(239),
    ...le24(90),
    0,
  ];
  const body = [...ascii("WEBP"), ...vp8x, ...anim, ...anmf, ...anmf];
  return Uint8Array.of(...ascii("RIFF"), ...le32(body.length), ...body);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("heading", { name: "Your games" }).waitFor();
});

test("a drawn PNG keeps its exact bytes and full canonical size @webkit-desktop", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  // Past the legacy 1024px working edge: intake must keep full dimensions.
  const width = 1500;
  const height = 300;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      rgb.set(
        [(x * 7 + y * 3) & 0xff, (x * 5 + y * 11) & 0xff, (x + y * 13) & 0xff],
        (y * width + x) * 3,
      );
  const png = encodePngRgb(width, height, rgb);
  const expectedRgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    expectedRgba.set([rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!, 255], i * 4);
  }

  const result = await offer(page, png, { samples: [0, 1499, width * 299 + 1499] });
  expect(result.ok).toBe(true);
  expect(result.format).toBe("png");
  expect(result.mime).toBe("image/png");
  expect(result.byteLength).toBe(png.length);
  expect(result.encodedHash).toBe(sha256Hex(png));
  expect(result.encodedExact).toBe(true);
  // Full admitted source size survives: no working-edge downscale.
  expect([result.width, result.height]).toEqual([1500, 300]);
  expect([result.sourceWidth, result.sourceHeight]).toEqual([1500, 300]);
  expect(result.orientation).toBe(1);
  expect(result.normalizedMime).toBe(CREATIVE_RASTER_MIME);
  expect(result.normalizedLength).toBe(width * height * 4);
  // The canonical raster is byte-identical to the hand-computed RGBA frame.
  expect(result.normalizedHash).toBe(sha256Hex(expectedRgba));
  expect(result.samples).toEqual([
    [rgb[0], rgb[1], rgb[2], 255],
    [rgb[1499 * 3], rgb[1499 * 3 + 1], rgb[1499 * 3 + 2], 255],
    [
      rgb[(width * 299 + 1499) * 3],
      rgb[(width * 299 + 1499) * 3 + 1],
      rgb[(width * 299 + 1499) * 3 + 2],
      255,
    ],
  ]);
  expect(pageErrors).toEqual([]);
});

test("a JPEG with EXIF orientation 6 lands rotated exactly once @webkit-desktop", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  const jpegB64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 48;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#d42a1e";
    context.fillRect(0, 0, 48, 48);
    context.fillStyle = "#1e4bd4";
    context.fillRect(48, 0, 48, 48);
    context.fillStyle = "#ffffff";
    context.fillRect(4, 4, 12, 12);
    return canvas.toDataURL("image/jpeg").split(",")[1]!;
  });
  const jpeg = Buffer.from(jpegB64, "base64");
  expect(jpeg[0]).toBe(0xff);
  expect(jpeg[1]).toBe(0xd8);
  const oriented = withExifOrientation(jpeg, 6);

  // Samples land on oriented coordinates: 48x96 after one 90-degree rotation.
  const result = await offer(page, oriented, {
    name: "photo.jpg",
    mime: "image/jpeg",
    samples: [24 + 10 * 48, 24 + 85 * 48, 37 + 10 * 48],
  });
  expect(result.ok).toBe(true);
  expect(result.format).toBe("jpeg");
  expect(result.mime).toBe("image/jpeg");
  expect(result.encodedHash).toBe(sha256Hex(oriented));
  expect(result.encodedExact).toBe(true);
  expect(result.orientation).toBe(6);
  expect([result.sourceWidth, result.sourceHeight]).toEqual([96, 48]);
  // Rotated once: 48x96, stored left half (red) becomes the oriented top half.
  expect([result.width, result.height]).toEqual([48, 96]);
  const [top, bottom, marker] = result.samples!;
  expect(top![0]).toBeGreaterThan(150); // red channel up top
  expect(top![2]).toBeLessThan(120);
  expect(bottom![2]).toBeGreaterThan(150); // blue channel below
  expect(bottom![0]).toBeLessThan(120);
  expect(marker![0]).toBeGreaterThan(200); // the white square moved with the image
  expect(marker![1]).toBeGreaterThan(200);
  expect(marker![2]).toBeGreaterThan(200);
  expect(pageErrors).toEqual([]);
});

test("a WebP still decodes and a canvas PNG keeps straight alpha @webkit-desktop", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  const webp = Buffer.from(WEBP_BLUE_32x20, "base64");
  const still = await offer(page, webp, {
    name: "swatch.webp",
    mime: "image/webp",
    samples: [16 * 32 + 16],
  });
  expect(still.ok).toBe(true);
  expect(still.format).toBe("webp");
  expect([still.width, still.height]).toEqual([32, 20]);
  expect(still.encodedHash).toBe(sha256Hex(webp));
  expect(still.encodedExact).toBe(true);
  const centre = still.samples![0]!;
  expect(centre[2]!).toBeGreaterThan(centre[0]!); // the blue swatch reads blue
  expect(centre[3]).toBe(255);

  // Exact RGBA through a real browser PNG encode; the half-transparent red
  // survives premultiply/unpremultiply exactly (255*128/255).
  const alphaB64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const data = context.createImageData(4, 1);
    data.data.set([255, 0, 0, 128, 0, 255, 0, 255, 10, 20, 30, 0, 40, 50, 60, 255]);
    context.putImageData(data, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  const alpha = await offer(page, Buffer.from(alphaB64, "base64"), { samples: [0, 1, 2, 3] });
  expect(alpha.ok).toBe(true);
  expect(alpha.samples![0]).toEqual([255, 0, 0, 128]); // unpremultiplied, alpha intact
  expect(alpha.samples![1]).toEqual([0, 255, 0, 255]);
  expect(alpha.samples![2]![3]).toBe(0);
  expect(alpha.samples![3]).toEqual([40, 50, 60, 255]);
  expect(pageErrors).toEqual([]);
});

test("oversized, corrupt and animated offers refuse by name @webkit-desktop", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  const oversized = await offerEmptyBlob(page, CREATIVE_LIMITS.maxFileBytes + 1);
  expect(oversized.ok).toBe(false);
  expect(oversized.reason).toBe("oversize");

  const text = await offer(page, new TextEncoder().encode("not an image at all"));
  expect(text.reason).toBe("signature");

  // A tiny file whose IHDR declares a frame past the decoded-pixel budget:
  // refused on the header, never reaching createImageBitmap.
  const fatHeader = encodePngRgb(4, 4, new Uint8Array(4 * 4 * 3));
  fatHeader[16] = 0;
  fatHeader[17] = 0;
  fatHeader[18] = 0x23; // width 0x00002321 = 9009
  fatHeader[19] = 0x21;
  const tooBig = await offer(page, fatHeader);
  expect(tooBig.reason).toBe("dimensions");

  const cut = await offer(page, encodePngRgb(8, 8, new Uint8Array(8 * 8 * 3)).subarray(0, 20));
  expect(cut.reason).toBe("truncated");

  // Header-valid but undecodable: a well-formed PNG with no image data fails
  // decode in every engine.
  const broken = await offer(page, pngWithoutImageData());
  expect(broken.reason).toBe("decode");

  // Animated containers refuse with the named frame-selection condition and
  // carry enough header truth for a later picker.
  const apng = await offer(page, pngWithActl(encodePngRgb(8, 8, new Uint8Array(8 * 8 * 3)), 12));
  expect(apng.reason).toBe("frame-selection");
  expect(apng.header).toMatchObject({ width: 8, height: 8, animated: true, frames: 12 });

  const webpAnimated = await offer(page, animatedWebp(), { mime: "image/webp" });
  expect(webpAnimated.reason).toBe("frame-selection");
  expect(webpAnimated.header).toMatchObject({ animated: true, frames: 2 });

  expect(pageErrors).toEqual([]);
});

test("an already-aborted or queued offer refuses without touching decode @webkit-desktop", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  const still = encodePngRgb(64, 32, new Uint8Array(64 * 32 * 3).fill(120));
  const aborted = await offer(page, still, { abortBefore: true });
  expect(aborted.ok).toBe(false);
  expect(aborted.reason).toBe("cancelled");

  // Queue a second offer behind a slow decode and cancel it while it waits:
  // it refuses cancelled, and the image ahead of it still completes.
  const slow = encodePngRgb(1500, 1500, new Uint8Array(1500 * 1500 * 3).fill(200));
  const queued = await offer(page, still, { behindB64: Buffer.from(slow).toString("base64") });
  expect(queued.ok).toBe(false);
  expect(queued.reason).toBe("cancelled");
  expect(queued.firstOk).toBe(true);
  expect(pageErrors).toEqual([]);
});

test("results own their bytes across sequential decodes @webkit-desktop", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  const png = encodePngRgb(24, 24, new Uint8Array(24 * 24 * 3).fill(77));
  const b64 = Buffer.from(png).toString("base64");
  const outcome = await page.evaluate(async (b64) => {
    const { decodeCreativeImage } = await import("/src/references/creativeImageDecode.ts");
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([raw], "tile.png");
    const first = await decodeCreativeImage(file);
    const second = await decodeCreativeImage(file);
    first.encodedBytes[0] = 0;
    first.pixels[0] = 0;
    return {
      sameEncodedHash: first.encoded.hash === second.encoded.hash,
      sameRasterHash: first.normalized.blob.hash === second.normalized.blob.hash,
      distinctEncoded: first.encodedBytes !== second.encodedBytes,
      distinctPixels: first.pixels !== second.pixels,
      encodedStillValid: second.encodedBytes.every((b, i) => b === raw[i]),
      pixelIntact: second.pixels[0],
    };
  }, b64);
  expect(outcome.sameEncodedHash).toBe(true);
  expect(outcome.sameRasterHash).toBe(true);
  expect(outcome.distinctEncoded).toBe(true);
  expect(outcome.distinctPixels).toBe(true);
  expect(outcome.encodedStillValid).toBe(true);
  expect(outcome.pixelIntact).toBe(77);
  expect(pageErrors).toEqual([]);
});
