import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseView } from "../src/view/view.ts";
import {
  buildViewFromSheet,
  cutGrid,
  nearestEgaIndex,
  quantizeToEga,
  type EgaSheet,
  type SheetFrame,
} from "../src/view/spritesheet.ts";

/** Build an RGBA buffer from a grid of `[r,g,b,a]` tuples in reading order. */
function rgbaFrom(pixels: readonly (readonly [number, number, number, number])[]): Uint8Array {
  const out = new Uint8Array(pixels.length * 4);
  for (let i = 0; i < pixels.length; i++) {
    out.set(pixels[i]!, i * 4);
  }
  return out;
}

const MAGENTA: readonly [number, number, number, number] = [0xff, 0x00, 0xff, 0xff];
const WHITE: readonly [number, number, number, number] = [0xff, 0xff, 0xff, 0xff];
const RED: readonly [number, number, number, number] = [0xff, 0x00, 0x00, 0xff];
const BLACK: readonly [number, number, number, number] = [0x00, 0x00, 0x00, 0xff];
const CLEAR: readonly [number, number, number, number] = [0x12, 0x34, 0x56, 0x00];

/**
 * Hand-drawn 4x4 sheet: a pure-magenta key background with a 2x2 figure of
 * white, white / red, black at (1,1)..(2,2).
 *
 * Hand-computed nearest EGA indices with the weighted metric 2dR^2+4dG^2+3dB^2:
 *   #ff00ff -> magenta(aa,00,aa) costs 5*85^2 = 36125,
 *              light magenta(ff,55,ff) costs 4*85^2 = 28900  => 13.
 *   #ff0000 -> red(aa,00,00) costs 2*85^2 = 14450,
 *              light red(ff,55,55) costs 7*85^2 = 50575      => 4.
 *   #ffffff -> 15 (exact).  #000000 -> 0 (exact).
 */
const FIGURE_SHEET: readonly (readonly [number, number, number, number])[] = [
  MAGENTA,
  MAGENTA,
  MAGENTA,
  MAGENTA,
  MAGENTA,
  WHITE,
  WHITE,
  MAGENTA,
  MAGENTA,
  RED,
  BLACK,
  MAGENTA,
  MAGENTA,
  MAGENTA,
  MAGENTA,
  MAGENTA,
];

describe("quantizeToEga", () => {
  it("maps RGB to the nearest EGA index without dithering", () => {
    assert.equal(nearestEgaIndex(0x00, 0x00, 0x00), 0);
    assert.equal(nearestEgaIndex(0xff, 0xff, 0xff), 15);
    assert.equal(nearestEgaIndex(0xff, 0x00, 0x00), 4);
    assert.equal(nearestEgaIndex(0xff, 0x00, 0xff), 13);
    // Halfway between black and dark gray (0x55): 0x2a is nearer black.
    assert.equal(nearestEgaIndex(0x2a, 0x2a, 0x2a), 0);
    assert.equal(nearestEgaIndex(0x2c, 0x2c, 0x2c), 8);
    // The weighting is part of the contract. #003c3c is nearer black by plain
    // squared RGB distance (3600+3600 = 7200 vs 7225+625+625 = 8475) but
    // nearer dark gray once G and B are weighted 4 and 3 against R's 2
    // (4*3600+3*3600 = 25200 vs 2*7225+4*625+3*625 = 18825).
    assert.equal(nearestEgaIndex(0x00, 0x3c, 0x3c), 8);
    // Exact tie (#000055 sits 0x55 from both black and blue): lower index wins.
    assert.equal(nearestEgaIndex(0x00, 0x00, 0x55), 0);
  });

  it("keys transparency off the most common border colour", () => {
    const sheet = quantizeToEga(rgbaFrom(FIGURE_SHEET), 4, 4);
    assert.equal(sheet.keyIndex, 13);
    // Transparent cells hold the key index; mask is the authority.
    assert.deepEqual(
      Array.from(sheet.pixels),
      [13, 13, 13, 13, 13, 15, 15, 13, 13, 4, 0, 13, 13, 13, 13, 13],
    );
    assert.deepEqual(Array.from(sheet.mask), [0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
  });

  it("treats low alpha as transparent and honours an explicit key", () => {
    const withHole = FIGURE_SHEET.slice();
    withHole[6] = CLEAR; // the second white pixel
    const sheet = quantizeToEga(rgbaFrom(withHole), 4, 4);
    assert.equal(sheet.mask[6], 0);
    assert.equal(sheet.pixels[6], 13);

    // An explicit key of pure red keys the figure's red pixel instead, and the
    // magenta background stays opaque.
    const keyed = quantizeToEga(rgbaFrom(FIGURE_SHEET), 4, 4, { keyColor: [0xff, 0x00, 0x00] });
    assert.equal(keyed.keyIndex, 4);
    assert.equal(keyed.mask[9], 0);
    assert.equal(keyed.mask[0], 1);
    assert.equal(keyed.pixels[0], 13);

    // keyColor null disables colour keying entirely: alpha only.
    const noKey = quantizeToEga(rgbaFrom(FIGURE_SHEET), 4, 4, { keyColor: null });
    assert.equal(noKey.keyIndex, null);
    assert.ok(Array.from(noKey.mask).every((m) => m === 1));
  });

  it("breaks a border-colour tie toward the lower index", () => {
    // 3x3: border of four red and four white pixels (the centre is not border
    // and does not vote). Red is index 4, white 15, so red keys.
    const px = [RED, WHITE, RED, WHITE, BLACK, WHITE, RED, WHITE, RED];
    assert.equal(quantizeToEga(rgbaFrom(px), 3, 3).keyIndex, 4);
    const swapped = [WHITE, RED, WHITE, RED, BLACK, RED, WHITE, RED, WHITE];
    assert.equal(quantizeToEga(rgbaFrom(swapped), 3, 3).keyIndex, 4);
  });

  it("votes on the border ring only, not the whole sheet", () => {
    // 7x7: a white border ring (24 pixels) around a black 5x5 interior (25
    // pixels). The interior is the larger area but casts no vote, so white
    // keys and the black figure stays opaque.
    const px = Array.from({ length: 49 }, (_, i) => {
      const x = i % 7;
      const y = Math.floor(i / 7);
      return x === 0 || y === 0 || x === 6 || y === 6 ? WHITE : BLACK;
    });
    const sheet = quantizeToEga(rgbaFrom(px), 7, 7);
    assert.equal(sheet.keyIndex, 15);
    assert.equal(sheet.mask[0], 0);
    assert.equal(sheet.mask[8], 1);
  });

  it("rejects a buffer whose length does not match the dimensions", () => {
    assert.throws(() => quantizeToEga(new Uint8Array(4 * 4 * 4 - 4), 4, 4), /does not match 4x4x4/);
  });
});

/**
 * Two hand-drawn 4x4 frames side by side (an 8x4 sheet), magenta key.
 * Frame 0 has opaque pixels at local (1,1) and (1,2); frame 1 at (2,2) only.
 * The union bounding box is therefore x 1..2, y 1..2 for both frames, so the
 * bottom row of each trimmed frame is source row 2 — the shared baseline.
 */
function twoFrameSheet(): EgaSheet {
  const px: (readonly [number, number, number, number])[] = new Array(8 * 4).fill(MAGENTA);
  px[1 * 8 + 1] = WHITE; // frame 0, local (1,1)
  px[2 * 8 + 1] = RED; // frame 0, local (1,2)
  px[2 * 8 + 6] = BLACK; // frame 1, local (2,2)
  return quantizeToEga(rgbaFrom(px), 8, 4);
}

describe("cutGrid", () => {
  it("cuts frames in reading order and trims to a shared bounding box", () => {
    const frames = cutGrid(twoFrameSheet(), 2, 1);
    assert.equal(frames.length, 2);
    for (const frame of frames) {
      assert.equal(frame.width, 2);
      assert.equal(frame.height, 2);
    }
    assert.deepEqual(Array.from(frames[0]!.mask), [1, 0, 1, 0]);
    assert.deepEqual(Array.from(frames[0]!.pixels), [15, 13, 4, 13]);
    assert.deepEqual(Array.from(frames[1]!.mask), [0, 0, 0, 1]);
    assert.deepEqual(Array.from(frames[1]!.pixels), [13, 13, 13, 0]);
  });

  it("keeps the baseline aligned: every frame's opaque content shares a bottom row", () => {
    const frames = cutGrid(twoFrameSheet(), 2, 1);
    const bottomRowOpaque = (f: SheetFrame): number[] =>
      Array.from(f.mask.subarray((f.height - 1) * f.width));
    // Both frames carry their source row 2 as their last row; frame 0's white
    // pixel at source row 1 stays one row above it rather than being pushed
    // down by an independent per-frame trim.
    assert.deepEqual(bottomRowOpaque(frames[0]!), [1, 0]);
    assert.deepEqual(bottomRowOpaque(frames[1]!), [0, 1]);
    assert.equal(frames[0]!.mask[0], 1);
  });

  it("cuts a multi-row grid in reading order (left to right, then down)", () => {
    // 4x4 sheet of four solid 2x2 cells: white, red / black, yellow.
    const YELLOW: readonly [number, number, number, number] = [0xff, 0xff, 0x55, 0xff];
    const px = [
      WHITE,
      WHITE,
      RED,
      RED,
      WHITE,
      WHITE,
      RED,
      RED,
      BLACK,
      BLACK,
      YELLOW,
      YELLOW,
      BLACK,
      BLACK,
      YELLOW,
      YELLOW,
    ];
    const sheet = quantizeToEga(rgbaFrom(px), 4, 4, { keyColor: null });
    const frames = cutGrid(sheet, 2, 2);
    assert.deepEqual(
      frames.map((f) => Array.from(f.pixels)),
      [
        [15, 15, 15, 15],
        [4, 4, 4, 4],
        [0, 0, 0, 0],
        [14, 14, 14, 14],
      ],
    );
  });

  it("trim:false keeps the full cell", () => {
    const frames = cutGrid(twoFrameSheet(), 2, 1, { trim: false });
    assert.equal(frames[0]!.width, 4);
    assert.equal(frames[0]!.height, 4);
    assert.deepEqual(Array.from(frames[0]!.mask), [0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  });

  it("downsamples nearest-neighbour with the 2:1 logical pixel aspect", () => {
    // 8x8 fully opaque sheet, pixel colour = (x + y) & 15, no colour keying.
    const px: (readonly [number, number, number, number])[] = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const [r, g, b] = [
          [0x00, 0x00, 0x00],
          [0x00, 0x00, 0xaa],
          [0x00, 0xaa, 0x00],
          [0x00, 0xaa, 0xaa],
          [0xaa, 0x00, 0x00],
          [0xaa, 0x00, 0xaa],
          [0xaa, 0x55, 0x00],
          [0xaa, 0xaa, 0xaa],
          [0x55, 0x55, 0x55],
          [0x55, 0x55, 0xff],
          [0x55, 0xff, 0x55],
          [0x55, 0xff, 0xff],
          [0xff, 0x55, 0x55],
          [0xff, 0x55, 0xff],
          [0xff, 0xff, 0x55],
          [0xff, 0xff, 0xff],
        ][(x + y) & 15]!;
        px.push([r!, g!, b!, 0xff]);
      }
    }
    const sheet = quantizeToEga(rgbaFrom(px), 8, 8, { keyColor: null });
    const [frame] = cutGrid(sheet, 1, 1, { targetHeight: 4 });
    // width = round(8 * (4/8) / 2) = 2, so a square-pixel 8x8 frame becomes a
    // 2x4 cel that redisplays as 4x4 raster pixels: proportions preserved.
    assert.equal(frame!.width, 2);
    assert.equal(frame!.height, 4);
    // Nearest neighbour samples the source under each destination centre:
    //   sy = floor((y+0.5)*8/4) = 1,3,5,7 ; sx = floor((x+0.5)*8/2) = 2,6.
    assert.deepEqual(Array.from(frame!.pixels), [3, 7, 5, 9, 7, 11, 9, 13]);
    assert.ok(Array.from(frame!.mask).every((m) => m === 1));
  });

  it("rejects a grid that does not divide the sheet evenly", () => {
    assert.throws(() => cutGrid(twoFrameSheet(), 3, 1), /does not divide evenly/);
  });
});

describe("buildViewFromSheet", () => {
  const frame = (width: number, height: number, colors: number[], mask: number[]): SheetFrame => ({
    width,
    height,
    pixels: new Uint8Array(colors),
    mask: new Uint8Array(mask),
  });

  it("picks the lowest free transparent colour and round-trips through parseView", () => {
    // 2x2 cel using colours 15 and 4: colour 0 is free, so it is transparent.
    const frames = [frame(2, 2, [15, 4, 4, 4], [1, 1, 1, 1])];
    const view = parseView(buildViewFromSheet(frames, { loops: [{ frames: [0] }] }));
    assert.equal(view.loops.length, 1);
    const cel = view.loops[0]!.cels[0]!;
    assert.equal(cel.width, 2);
    assert.equal(cel.height, 2);
    assert.equal(cel.transparentColor, 0);
    assert.deepEqual(Array.from(cel.pixels), [15, 4, 4, 4]);
  });

  it("avoids a transparent colour the art uses", () => {
    // Opaque black and white leave colour 1 as the lowest free index.
    const frames = [frame(2, 2, [0, 0, 15, 15], [1, 1, 1, 1])];
    const cel = parseView(buildViewFromSheet(frames, { loops: [{ frames: [0] }] })).loops[0]!
      .cels[0]!;
    assert.equal(cel.transparentColor, 1);
    assert.deepEqual(Array.from(cel.pixels), [0, 0, 15, 15]);
    // preferTransparent is honoured when free, ignored when the art uses it.
    const preferred = parseView(
      buildViewFromSheet(frames, { loops: [{ frames: [0] }], preferTransparent: 9 }),
    ).loops[0]!.cels[0]!;
    assert.equal(preferred.transparentColor, 9);
    const clashing = parseView(
      buildViewFromSheet(frames, { loops: [{ frames: [0] }], preferTransparent: 15 }),
    ).loops[0]!.cels[0]!;
    assert.equal(clashing.transparentColor, 1);
  });

  it("writes masked-out pixels as the transparent colour", () => {
    const frames = [frame(2, 2, [15, 13, 4, 4], [1, 0, 1, 1])];
    const cel = parseView(buildViewFromSheet(frames, { loops: [{ frames: [0] }] })).loops[0]!
      .cels[0]!;
    assert.equal(cel.transparentColor, 0);
    assert.deepEqual(Array.from(cel.pixels), [15, 0, 4, 4]);
  });

  it("mirrors a loop by reusing the preceding loop's cel data", () => {
    const frames = [frame(2, 2, [15, 4, 4, 4], [1, 1, 1, 1])];
    const view = parseView(
      buildViewFromSheet(frames, {
        loops: [{ frames: [0] }, { mirrorOf: 0 }],
        description: "ego",
      }),
    );
    assert.equal(view.loops.length, 2);
    assert.equal(view.description, "ego");
    assert.equal(view.loops[0]!.cels[0]!.mirrored, false);
    assert.deepEqual(Array.from(view.loops[0]!.cels[0]!.pixels), [15, 4, 4, 4]);
    assert.equal(view.loops[1]!.cels[0]!.mirrored, true);
    assert.deepEqual(Array.from(view.loops[1]!.cels[0]!.pixels), [4, 15, 4, 4]);
  });

  it("rejects an empty loop and an out-of-range frame index", () => {
    assert.throws(() => buildViewFromSheet([], { loops: [{}] }), /neither frames nor mirrorOf/);
    assert.throws(
      () => buildViewFromSheet([], { loops: [{ frames: [0] }] }),
      /references frame 0, but only 0 were cut/,
    );
  });

  it("rejects a cel that leaves no colour for transparency", () => {
    const colors = Array.from({ length: 16 }, (_, i) => i);
    const frames = [frame(16, 1, colors, new Array<number>(16).fill(1))];
    assert.throws(
      () => buildViewFromSheet(frames, { loops: [{ frames: [0] }] }),
      /all 16 EGA colours/,
    );
  });
});

describe("sheet to view pipeline", () => {
  it("carries hand-drawn sheet pixels through to decoded cels", () => {
    const frames = cutGrid(twoFrameSheet(), 2, 1);
    const view = parseView(
      buildViewFromSheet(frames, {
        loops: [{ frames: [0, 1] }, { mirrorOf: 0 }],
      }),
    );
    // Loop 0, cel 0: white at (0,0), red at (0,1); transparent elsewhere.
    // Free colours after {15,4} start at 0, so transparent is 0.
    const [celA, celB] = view.loops[0]!.cels;
    assert.equal(celA!.transparentColor, 0);
    assert.deepEqual(Array.from(celA!.pixels), [15, 0, 4, 0]);
    // Loop 0, cel 1: only black at (1,1). Black is opaque, so transparent
    // falls to the lowest free index, 1.
    assert.equal(celB!.transparentColor, 1);
    assert.deepEqual(Array.from(celB!.pixels), [1, 1, 1, 0]);
    // Loop 1 mirrors both cels of loop 0 row by row.
    assert.deepEqual(Array.from(view.loops[1]!.cels[0]!.pixels), [0, 15, 0, 4]);
    assert.deepEqual(Array.from(view.loops[1]!.cels[1]!.pixels), [1, 1, 0, 1]);
  });
});
