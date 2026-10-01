/**
 * Reference art by handle: content-derived ids, the per-turn manifest with its
 * contact strip, read_reference_image's sizes, regions and grid, its refusals, and
 * the under-fetch check. Every dimension below is hand-computed from the
 * documented edges: thumb 64, small 256, region 512 (256 small, 64 thumb),
 * full = the working size, and strip tiles of 64 with a 4-pixel gutter.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";
import { sha256Hex } from "../src/crypto.ts";
import { createAgentSessionState } from "../src/agent/agentState.ts";
import {
  AGENT_TOOLS,
  ASK_TOOLS,
  executeAgentToolAsync,
  withReferences,
} from "../src/agent/tools.ts";
import { REFERENCE_WORKING_EDGE, splitToolResult } from "../src/agent/toolTransport.ts";
import {
  fitWithin,
  referenceArtId,
  referenceManifest,
  referenceUnderFetch,
  workingBitmap,
  type ReferenceArt,
  type ReferenceBitmap,
  type ReferenceSource,
} from "../src/agent/referenceTools.ts";
import { assertNoImageData } from "./modelText.ts";

function pngPixels(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  let offset = 8;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = header.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (type === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const scanlines = new Uint8Array(inflateSync(Buffer.concat(idat)));
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    rgb.set(scanlines.subarray(y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1)), y * width * 3);
  return { width, height, rgb };
}

/** Left half pure blue (EGA 1), right half yellow (EGA 14), opaque. */
function halves(width: number, height: number): ReferenceBitmap {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      rgba.set(x < width / 2 ? [0, 0, 0xaa, 255] : [0xff, 0xff, 0x55, 255], (y * width + x) * 4);
  return { width, height, rgba };
}

function art(id: string, bitmap: ReferenceBitmap, extra: Partial<ReferenceArt> = {}): ReferenceArt {
  return {
    id,
    label: "Room plate",
    target: { kind: "room", num: 3 },
    note: "",
    attached: false,
    pixels: () => bitmap,
    ...extra,
  };
}

const ID_A = "art-aaaaaaaaaa";
const ID_B = "art-bbbbbbbbbb";
const ID_C = "art-cccccccccc";

function source(): ReferenceSource {
  return {
    art: [
      art(ID_A, halves(1024, 512), { note: "a harbour at dawn", attached: true }),
      art(ID_B, halves(200, 100), {
        label: "Character sheet, right-facing row",
        target: { kind: "view", num: 0 },
      }),
      art(ID_C, halves(64, 64), { target: { kind: "general" } }),
    ],
  };
}

async function view(args: Record<string, unknown>, references: ReferenceSource | null = source()) {
  return executeAgentToolAsync(
    createAgentSessionState(),
    "read_reference_image",
    { region: null, grid: null, ...args },
    { allowedTools: ["read_reference_image"], ...(references ? { references } : {}) },
  );
}

describe("reference ids", () => {
  it("are the first ten hex digits of the stored bytes' SHA-256", () => {
    const abc = new TextEncoder().encode("abc");
    // FIPS 180-4 test vector: SHA-256("abc") = ba7816bf8f01cfea...
    assert.equal(referenceArtId(abc), "art-ba7816bf8f");
    assert.equal(referenceArtId(abc), `art-${sha256Hex(abc).slice(0, 10)}`);
    assert.equal(referenceArtId(Uint8Array.from(abc)), referenceArtId(abc), "stable per content");
    assert.notEqual(referenceArtId(new TextEncoder().encode("abd")), referenceArtId(abc));
  });
});

describe("working size", () => {
  it("fits the longest edge and never upscales", () => {
    assert.equal(REFERENCE_WORKING_EDGE, 1024);
    assert.deepEqual(fitWithin(2400, 300, 1024), { width: 1024, height: 128 });
    assert.deepEqual(fitWithin(640, 480, 1024), { width: 640, height: 480 });
    assert.deepEqual(fitWithin(1000, 3, 64), { width: 64, height: 1 });
    const stored = workingBitmap(halves(2048, 1024));
    assert.deepEqual([stored.width, stored.height], [1024, 512]);
    assert.equal(stored.rgba.length, 1024 * 512 * 4);
  });
});

describe("manifest", () => {
  it("carries one line per reference and one contact strip of thumbnails", async () => {
    const manifest = await referenceManifest(source());
    const lines = manifest.text.split("\n").filter((line) => line.startsWith("art-"));
    assert.deepEqual(lines, [
      'art-aaaaaaaaaa · Room plate · room 3 · 1024x512 · blue 50%, yellow 50% · attached to this request · note: "a harbour at dawn"',
      "art-bbbbbbbbbb · Character sheet, right-facing row · view 0 · 200x100 · blue 50%, yellow 50%",
      "art-cccccccccc · Room plate · general · 64x64 · blue 50%, yellow 50%",
    ]);
    assertNoImageData(manifest.text);
    // Three 64-pixel tiles with a 4-pixel gutter around and between them.
    const strip = pngPixels(manifest.image.png);
    assert.deepEqual([strip.width, strip.height], [3 * 64 + 4 * 4, 64 + 2 * 4]);
    assert.match(manifest.image.caption, /art-aaaaaaaaaa, art-bbbbbbbbbb, art-cccccccccc/);
  });
});

describe("read_reference_image", () => {
  it("returns the size asked for, longest edge 64, 256 or the working size", async () => {
    for (const [size, width, height] of [
      ["thumb", 64, 32],
      ["small", 256, 128],
      ["full", 1024, 512],
    ] as const) {
      const result = await view({ id: ID_A, size });
      assert.equal(result.success, true, result.error ?? "");
      assert.equal(result.images?.length, 1);
      const png = pngPixels(result.images![0]!.png);
      assert.deepEqual([png.width, png.height], [width, height], size);
      assert.deepEqual(result.details?.["output"], { width, height });
      assert.match(result.images![0]!.caption, /^Reference art-[0-9a-f]{10} viewed at /);
      assertNoImageData(splitToolResult(result).text);
    }
  });

  it("shows the working size when size is left out", async () => {
    const result = await view({ id: ID_A, size: null });
    assert.equal(result.success, true, result.error ?? "");
    assert.deepEqual(result.details?.["output"], { width: 1024, height: 512 });
    assert.equal(result.details?.["size"], "full");
  });

  it("names the views that would show more", async () => {
    const small = await view({ id: ID_A, size: "small" });
    assert.match(
      small.message ?? "",
      / For shapes, poses and outlines, view it at size full \(1024x512\) or a region of it\.$/,
    );
    const full = await view({ id: ID_A, size: "full" });
    assert.match(
      full.message ?? "",
      / For fine detail, view a region: it is enlarged by a whole factor up to 512 px\. grid: true labels source coordinates for an exact next region\.$/,
    );
    const region = { x: 100, y: 50, w: 40, h: 30 };
    const thumbRegion = await view({ id: ID_A, size: "thumb", region });
    assert.match(
      thumbRegion.message ?? "",
      / size full shows this region enlarged up to 512 px\.$/,
    );
    const gridded = await view({ id: ID_A, size: "full", region, grid: true });
    assert.match(
      gridded.message ?? "",
      /Colours here: [^.]*\.$/,
      "a gridded region at full is the closest look",
    );
  });

  it("enlarges a region by a whole factor up to 512 and crops in source pixels", async () => {
    // 40x30 at full: floor(512 / 40) = 12, so 480x360; at small floor(256 / 40) = 6.
    const full = await view({ id: ID_A, size: "full", region: { x: 100, y: 50, w: 40, h: 30 } });
    assert.deepEqual(full.details?.["output"], { width: 480, height: 360 });
    assert.equal(full.details?.["scale"], 12);
    const small = await view({ id: ID_A, size: "small", region: { x: 100, y: 50, w: 40, h: 30 } });
    assert.deepEqual(small.details?.["output"], { width: 240, height: 180 });
    // The whole image as a region shrinks to fit 512: 512x256.
    const whole = await view({ id: ID_A, size: "full", region: { x: 0, y: 0, w: 1024, h: 512 } });
    assert.deepEqual(whole.details?.["output"], { width: 512, height: 256 });
    // Across the seam at x 512: two blue columns then two yellow, each 128 wide.
    const seam = await view({ id: ID_A, size: "full", region: { x: 510, y: 0, w: 4, h: 1 } });
    const png = pngPixels(seam.images![0]!.png);
    assert.deepEqual([png.width, png.height], [512, 128]);
    assert.deepEqual([...png.rgb.subarray(0, 3)], [0, 0, 0xaa]);
    assert.deepEqual([...png.rgb.subarray(255 * 3, 256 * 3)], [0, 0, 0xaa]);
    assert.deepEqual([...png.rgb.subarray(256 * 3, 257 * 3)], [0xff, 0xff, 0x55]);
    assert.match(seam.images![0]!.caption, /region x 510, y 0, 4x1, shown at 128x \(512x128\)/);
  });

  it("overlays a grid labelled in source coordinates", async () => {
    const plain = await view({ id: ID_A, size: "small" });
    const gridded = await view({ id: ID_A, size: "small", grid: true });
    // 1024 wide: the step is the smallest of 1, 2, 5, 10, 20, 25, 50, 100, ...
    // that gives at most ten divisions, 200; at 256/1024 the x 200 line sits at x 50.
    assert.equal(gridded.details?.["grid"], 200);
    assert.equal(plain.details?.["grid"], null);
    const a = pngPixels(plain.images![0]!.png);
    const b = pngPixels(gridded.images![0]!.png);
    assert.deepEqual([b.width, b.height], [a.width, a.height]);
    const pixel = (image: typeof a, x: number, y: number) => [
      ...image.rgb.subarray((y * image.width + x) * 3, (y * image.width + x) * 3 + 3),
    ];
    // Row 25 lies between the y 0 and y 200 lines, below the top labels.
    assert.notDeepEqual(pixel(b, 50, 25), pixel(a, 50, 25), "a grid line at x 50");
    assert.deepEqual(pixel(b, 30, 25), pixel(a, 30, 25), "nothing between the lines");
    assert.notDeepEqual(pixel(b, 30, 50), pixel(a, 30, 50), "the y 200 line at y 50");
    assert.match(gridded.images![0]!.caption, /grid every 200 source pixels/);
  });

  it("refuses an unknown id, a region past the edge and a call without references", async () => {
    const unknown = await view({ id: "art-0000000000", size: "small" });
    assert.equal(unknown.success, false);
    assert.equal(
      unknown.error,
      "No reference art has the id art-0000000000. This request has art-aaaaaaaaaa, art-bbbbbbbbbb, art-cccccccccc.",
    );
    const outside = await view({ id: ID_B, size: "full", region: { x: 180, y: 0, w: 40, h: 10 } });
    assert.equal(outside.success, false);
    assert.equal(
      outside.error,
      "That region ends at x 220, past the right edge of art-bbbbbbbbbb (200x100). Keep x + w within 200 and y + h within 100.",
    );
    const below = await view({ id: ID_B, size: "full", region: { x: 0, y: 90, w: 10, h: 20 } });
    assert.match(below.error ?? "", /ends at y 110, past the bottom edge/);
    const none = await view({ id: ID_A, size: "small" }, null);
    assert.equal(none.success, false);
    assert.equal(none.error, "No reference art is attached to this task.");
  });

  it("validates its arguments strictly", async () => {
    for (const args of [
      { id: "ref-1", size: "small" },
      { id: ID_A, size: "huge" },
      { id: ID_A, size: "small", region: { x: 0, y: 0, w: 0, h: 5 } },
      { id: ID_A, size: "small", region: { x: 0, y: 0, w: 5 } },
      { id: ID_A, size: "small", extra: true },
    ]) {
      const result = await view(args);
      assert.equal(result.success, false, JSON.stringify(args));
      assert.match(result.error ?? "", /^Invalid arguments for read_reference_image/);
    }
    const tool = AGENT_TOOLS.find((candidate) => candidate.name === "read_reference_image");
    assert.deepEqual(tool?.parameters.required, ["id", "size", "region", "grid"]);
  });
});

describe("availability", () => {
  it("offers read_reference_image only to a task that has references", () => {
    const withArt = withReferences(ASK_TOOLS, source());
    assert.ok(withArt.includes("read_reference_image"));
    assert.ok(!withReferences(ASK_TOOLS, undefined).includes("read_reference_image"));
    assert.ok(!withReferences(ASK_TOOLS, { art: [] }).includes("read_reference_image"));
    // Everything else in the list is unchanged either way.
    assert.deepEqual(
      withReferences(ASK_TOOLS, undefined),
      ASK_TOOLS.filter((name) => name !== "read_reference_image"),
    );
  });
});

describe("under-fetch", () => {
  it("names attached references a turn matched or wrote from without viewing", () => {
    const attached = [ID_A, ID_B];
    assert.deepEqual(
      referenceUnderFetch({
        attached,
        calls: [{ tool: "write_picture", args: { room: 3 }, success: true }],
        text: "Room 3 is drawn.",
      }),
      [ID_A, ID_B],
    );
    assert.deepEqual(
      referenceUnderFetch({
        attached,
        calls: [
          { tool: "read_reference_image", args: { id: ID_A, size: "full" }, success: true },
          { tool: "write_picture", args: { room: 3 }, success: true },
        ],
        text: "Room 3 now matches the harbour reference.",
      }),
      [ID_B],
    );
    // A claim alone counts; a failed view does not count as viewing.
    assert.deepEqual(
      referenceUnderFetch({
        attached: [ID_A],
        calls: [{ tool: "read_reference_image", args: { id: ID_A, size: "full" }, success: false }],
        text: "The room follows your sketch.",
      }),
      [ID_A],
    );
    assert.deepEqual(
      referenceUnderFetch({ attached: [ID_A], calls: [], text: "Which room should I change?" }),
      [],
    );
  });
});
