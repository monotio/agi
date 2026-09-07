import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";
import {
  actorLayoutFeedback,
  colourGrid,
  editReport,
  formatPriorityDiagnostics,
  formatLayoutDiff,
  layoutDiff,
  parseLayout,
  pictureComparisonPng,
} from "../src/agent/pictureFeedback.ts";
import { EGA_RGB } from "../src/picture/png.ts";

/** Tiny hand-drawable surface: rows of colour indices -> flat buffer. */
function surface(rows: readonly (readonly number[])[]): Uint8Array {
  const width = rows[0]!.length;
  const buf = new Uint8Array(width * rows.length);
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < width; x++) buf[y * width + x] = rows[y]![x]!;
  }
  return buf;
}

/** width x height of 15 (the initial white) with the given rectangles painted. */
function painted(
  width: number,
  height: number,
  rects: readonly { x0: number; y0: number; x1: number; y1: number; colour: number }[],
): Uint8Array {
  const buf = new Uint8Array(width * height).fill(15);
  for (const r of rects) {
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) buf[y * width + x] = r.colour;
    }
  }
  return buf;
}

function pngPixels(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  let offset = 8;
  let idat: Uint8Array | null = null;
  while (offset < png.length) {
    const length = header.getUint32(offset);
    const type = String.fromCharCode(
      png[offset + 4]!,
      png[offset + 5]!,
      png[offset + 6]!,
      png[offset + 7]!,
    );
    if (type === "IDAT") idat = png.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
  }
  assert.ok(idat);
  const scanlines = new Uint8Array(inflateSync(Buffer.from(idat)));
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    assert.equal(scanlines[y * (width * 3 + 1)], 0);
    rgb.set(scanlines.subarray(y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1)), y * width * 3);
  }
  return { width, height, rgb };
}

describe("picture feedback: colour grid", () => {
  it("reports the dominant colour of each cell over a hand-computed 4x4 surface", () => {
    const visual = surface([
      [1, 1, 2, 2],
      [1, 1, 2, 2],
      [3, 3, 3, 4],
      [3, 3, 4, 4],
    ]);
    // 2x2 grid: top-left all 1, top-right all 2, bottom-left all 3,
    // bottom-right {3,4,4,4} -> 4.
    assert.equal(
      colourGrid(visual, 2, 2, { width: 4, height: 4 }),
      "y  0-  1:  1  2\ny  2-  3:  3  4",
    );
  });

  it("covers every row when the cell count does not divide the surface evenly", () => {
    // 6 rows in 4 bands: 0..0, 1..2, 3..3, 4..5 — the last band must reach y5.
    const visual = surface([
      [1, 1],
      [2, 2],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ]);
    assert.equal(
      colourGrid(visual, 1, 4, { width: 2, height: 6 }),
      ["y  0-  0:  1", "y  1-  2:  2", "y  3-  3:  3", "y  4-  5:  4"].join("\n"),
    );
  });

  it("defaults to an 8x7 grid of 56 cells on the real 160x168 surface", () => {
    const visual = new Uint8Array(160 * 168).fill(9);
    const lines = colourGrid(visual).split("\n");
    assert.equal(lines.length, 7);
    assert.equal(lines[0], "y  0- 23:  9  9  9  9  9  9  9  9");
    assert.equal(lines[6], "y144-167:  9  9  9  9  9  9  9  9");
  });
});

describe("picture feedback: authentic scene geometry", () => {
  it("aligns clean visual, raw priority, and exact semantic overlay panels", () => {
    const visual = new Uint8Array([4, 2, 7, 7, 7, 7]);
    const priority = new Uint8Array([4, 6, 0, 1, 2, 3]);
    const { width, height, rgb } = pngPixels(
      pictureComparisonPng(visual, priority, { width: 6, height: 1 }),
    );
    assert.deepEqual([width, height], [36, 1]);
    const pixel = (x: number): number[] => [...rgb.subarray(x * 3, x * 3 + 3)];

    // Left stays clean and every logical pixel is exactly two display columns.
    assert.deepEqual(pixel(0), EGA_RGB[4]);
    assert.deepEqual(pixel(1), EGA_RGB[4]);
    assert.deepEqual(pixel(2), EGA_RGB[2]);
    // Middle is the unmodified EGA rendering of raw priority values.
    assert.deepEqual(pixel(12), EGA_RGB[4]);
    assert.deepEqual(pixel(14), EGA_RGB[6]);
    assert.deepEqual(pixel(16), EGA_RGB[0]);
    // Right: priority 4 is untouched; 6 is a 50% integer blend; controls are vivid.
    assert.deepEqual(pixel(24), EGA_RGB[4]);
    assert.deepEqual(pixel(26), [85, 127, 0]);
    assert.deepEqual(pixel(28), [255, 85, 85]);
    assert.deepEqual(pixel(30), [255, 255, 255]);
    assert.deepEqual(pixel(32), [255, 85, 255]);
    assert.deepEqual(pixel(34), [85, 255, 255]);
  });

  it("summarises exact control and depth extents without losing thin barriers", () => {
    const priority = surface([
      [4, 4, 4, 4],
      [5, 5, 5, 5],
      [0, 0, 8, 8],
      [3, 3, 8, 8],
    ]);
    const text = formatPriorityDiagnostics(priority, { width: 4, height: 4 });
    assert.match(text, /0 barrier: 2 cells in 1 component, x0-1 y2-2/);
    assert.match(text, /3 water: 2 cells in 1 component, x0-1 y3-3/);
    assert.match(text, /depth bands: 4 x0-3 y0-0 \(4\); 5 x0-3 y1-1 \(4\); 8 x2-3 y2-3 \(4\)/);
  });

  it("checks a declared actor's displayed proportions, baseline controls, and occlusion", () => {
    const priority = surface([
      [4, 4, 4, 4],
      [4, 4, 9, 4],
      [4, 4, 9, 4],
      [4, 0, 7, 4],
    ]);
    const text = actorLayoutFeedback("# actor: ego x1 y3 width2 height3 priority7", priority, {
      width: 4,
      height: 4,
    });
    assert.equal(
      text,
      "- ego: logical x1-2 y1-3 (2x3), display x2-5 y1-3 (4x3); priority 7; baseline values [0, 7], controls [0@x1]; higher-priority scenery 2/6 cells",
    );
  });
});

describe("picture feedback: layout diff", () => {
  it("parses `# layout:` lines and ignores everything else", () => {
    const masses = parseLayout(
      ["# layout: castle x0-70 y30-120 colour 7", "vis 4", "# just a comment", "end"].join("\n"),
    );
    assert.deepEqual(masses, [{ name: "castle", x0: 0, x1: 70, y0: 30, y1: 120, colour: 7 }]);
  });

  it("calls a fully painted, correctly placed mass OK", () => {
    const visual = painted(8, 8, [{ x0: 1, y0: 1, x1: 4, y1: 4, colour: 6 }]);
    const [d] = layoutDiff("# layout: hill x1-4 y1-4 colour 6", visual, { width: 8, height: 8 });
    assert.ok(d);
    assert.equal(d.dominant, 6);
    assert.equal(d.coverage, 1);
    assert.deepEqual(d.rendered, { x0: 1, y0: 1, x1: 4, y1: 4, cells: 16 });
    assert.equal(d.verdict, "OK");
  });

  it("calls a mass covering under 40% of its box UNDERFILLED", () => {
    // 4 cells of colour 2 inside a 16-cell declared box: 25%.
    const visual = painted(8, 8, [{ x0: 0, y0: 0, x1: 1, y1: 1, colour: 2 }]);
    const [d] = layoutDiff("# layout: tree x0-3 y0-3 colour 2", visual, { width: 8, height: 8 });
    assert.ok(d);
    assert.equal(d.dominant, 15);
    assert.equal(d.coverage, 0.25);
    assert.deepEqual(d.rendered, { x0: 0, y0: 0, x1: 1, y1: 1, cells: 4 });
    assert.equal(d.verdict, "UNDERFILLED");
  });

  it("calls a mass whose drawn centre fell outside the declared box SHIFTED", () => {
    // Declared 2x2 at the corner; what got drawn is 6x6 centred on (2.5, 2.5).
    const visual = painted(8, 8, [{ x0: 0, y0: 0, x1: 5, y1: 5, colour: 5 }]);
    const [d] = layoutDiff("# layout: rock x0-1 y0-1 colour 5", visual, { width: 8, height: 8 });
    assert.ok(d);
    assert.equal(d.coverage, 1);
    assert.deepEqual(d.rendered, { x0: 0, y0: 0, x1: 5, y1: 5, cells: 36 });
    assert.equal(d.verdict, "SHIFTED");
  });

  it("calls a declared colour that never landed MISSING", () => {
    const visual = painted(8, 8, []);
    const [d] = layoutDiff("# layout: sky x0-7 y0-7 colour 9", visual, { width: 8, height: 8 });
    assert.ok(d);
    assert.equal(d.dominant, 15);
    assert.equal(d.coverage, 0);
    assert.equal(d.rendered, null);
    assert.equal(d.verdict, "MISSING");
  });

  it("reports the largest overlapping region, not the first one found", () => {
    const visual = painted(8, 8, [
      { x0: 0, y0: 0, x1: 0, y1: 0, colour: 3 },
      { x0: 3, y0: 0, x1: 6, y1: 2, colour: 3 },
    ]);
    const [d] = layoutDiff("# layout: wall x0-6 y0-2 colour 3", visual, { width: 8, height: 8 });
    assert.ok(d);
    assert.deepEqual(d.rendered, { x0: 3, y0: 0, x1: 6, y1: 2, cells: 12 });
    assert.equal(d.verdict, "OK");
  });

  it("returns nothing to say when the source declares no layout", () => {
    assert.deepEqual(layoutDiff("vis 4\nend", painted(8, 8, []), { width: 8, height: 8 }), []);
  });

  it("formats one compact line per mass", () => {
    const visual = painted(8, 8, [{ x0: 1, y0: 1, x1: 4, y1: 4, colour: 6 }]);
    const text = formatLayoutDiff(
      layoutDiff("# layout: hill x1-4 y1-4 colour 6", visual, { width: 8, height: 8 }),
    );
    assert.equal(
      text,
      "- hill x1-4 y1-4 colour 6: dominant 6, coverage 100%, largest region x1-4 y1-4 -> OK",
    );
  });
});

describe("picture feedback: edit report", () => {
  const before = "# heading\nvis 1\nline 0,0 3,0\nend\n";
  const after = "vis 1\nline 0,0 3,0\nfill 2,2\nend\n";

  it("counts original command lines preserved in order, ignoring comments", () => {
    const flat = new Uint8Array(16).fill(15);
    const r = editReport(before, after, flat, flat, { width: 4, height: 4 });
    // Three commands (the comment does not count); a pure insertion keeps all.
    assert.deepEqual(r.preserved, { kept: 3, total: 3 });
  });

  it("uses a longest common subsequence, so reordering does not count as preserved", () => {
    const flat = new Uint8Array(16).fill(15);
    const r = editReport("a\nb\nc\n", "c\nb\na\n", flat, flat, { width: 4, height: 4 });
    assert.deepEqual(r.preserved, { kept: 1, total: 3 });
  });

  it("boxes the largest changed region and counts the stray cells outside it", () => {
    const previousVisual = new Uint8Array(16).fill(15);
    const newVisual = surface([
      [15, 15, 15, 15],
      [15, 7, 7, 15],
      [15, 15, 15, 15],
      [15, 15, 15, 7],
    ]);
    const r = editReport(before, after, previousVisual, newVisual, { width: 4, height: 4 });
    assert.equal(r.changedCells, 3);
    assert.deepEqual(r.changedBox, { x0: 1, y0: 1, x1: 2, y1: 1 });
    assert.equal(r.strayCells, 1);
    assert.equal(r.changedComponents, 2);
  });

  it("reports no box and no strays when the render did not move at all", () => {
    const flat = new Uint8Array(16).fill(15);
    const r = editReport(before, before, flat, flat, { width: 4, height: 4 });
    assert.equal(r.changedCells, 0);
    assert.equal(r.changedBox, null);
    assert.equal(r.strayCells, 0);
    assert.equal(r.changedComponents, 0);
  });

  it("treats a diagonal-only change as two separate 4-connected regions", () => {
    const previousVisual = new Uint8Array(16).fill(15);
    const newVisual = surface([
      [4, 15, 15, 15],
      [15, 4, 15, 15],
      [15, 15, 15, 15],
      [15, 15, 15, 15],
    ]);
    const r = editReport(before, after, previousVisual, newVisual, { width: 4, height: 4 });
    assert.equal(r.changedComponents, 2);
    assert.equal(r.changedCells, 2);
    // Two components of one cell each: the first found wins the box.
    assert.deepEqual(r.changedBox, { x0: 0, y0: 0, x1: 0, y1: 0 });
    assert.equal(r.strayCells, 1);
  });
});
