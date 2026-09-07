import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  SHEET_GAP,
  drawFrameInto,
  frameToPng,
  framesToContactSheet,
  sheetGrid,
  textRows,
  type AgentFrame,
  type FrameSource,
} from "../src/agent/frames.ts";
import { createAgentSessionState, executeAgentToolAsync } from "../src/agent/tools.ts";
import { FrameRing, SURFACE_BYTES, TEXT_BYTES } from "../app/src/frameRing.ts";

/**
 * A deterministic fake frame source: frame `cycle` paints its whole visual
 * surface with colour `cycle % 16` and its priority surface with 4, so every
 * assertion below is a hand-computed pixel value rather than a snapshot.
 */
function fakeFrame(cycle: number, picRow = 1): AgentFrame {
  return {
    cycle,
    visual: new Uint8Array(SURFACE_BYTES).fill(cycle % 16),
    priority: new Uint8Array(SURFACE_BYTES).fill(4),
    picRow,
    text: undefined,
  };
}

function fakeSource(cycles: readonly number[]): FrameSource {
  return {
    read({ count, stride }) {
      const out: AgentFrame[] = [];
      for (let i = cycles.length - 1; i >= 0 && out.length < count; i -= stride) {
        out.push(fakeFrame(cycles[i]!));
      }
      return out.reverse();
    },
  };
}

/** Width and height out of a PNG's IHDR (bytes 16..23 of the file). */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("contact sheet geometry", () => {
  it("lays frames out in a near-square grid capped at three columns", () => {
    // cols = min(3, ceil(sqrt(n))); rows = ceil(n / cols).
    assert.deepEqual(sheetGrid(1), { cols: 1, rows: 1, width: 320, height: 200 });
    // 2 frames: cols = min(3, ceil(1.414)) = 2, rows = 1.
    assert.deepEqual(sheetGrid(2), { cols: 2, rows: 1, width: 2 * 320 + 4, height: 200 });
    // 4 frames: cols = 2, rows = 2 -> 644 x 404.
    assert.deepEqual(sheetGrid(4), { cols: 2, rows: 2, width: 644, height: 404 });
    // 6 frames: ceil(sqrt(6)) = 3 -> 3 x 2 -> 968 x 404.
    assert.deepEqual(sheetGrid(6), { cols: 3, rows: 2, width: 968, height: 404 });
    // 9 frames: 3 x 3 -> 968 x 608.
    assert.deepEqual(sheetGrid(9), { cols: 3, rows: 3, width: 968, height: 608 });
    // The column cap holds: 12 frames stay 3 wide and grow downward.
    assert.deepEqual(sheetGrid(12), { cols: 3, rows: 4, width: 968, height: 4 * 200 + 3 * 4 });
  });

  it("encodes a single frame at the screen's exact geometry", () => {
    assert.deepEqual(pngSize(frameToPng(fakeFrame(3), "visual")), { width: 320, height: 200 });
  });

  it("encodes a contact sheet at the grid's exact geometry", () => {
    const frames = [1, 2, 3, 4, 5].map((c) => fakeFrame(c));
    const { png, grid } = framesToContactSheet(frames, "visual");
    // 5 frames -> ceil(sqrt(5)) = 3 columns, 2 rows.
    assert.deepEqual(grid, { cols: 3, rows: 2, width: 968, height: 404 });
    assert.deepEqual(pngSize(png), { width: 968, height: 404 });
  });
});

describe("frame compositing", () => {
  it("doubles each logical pixel horizontally and offsets the band by picRow", () => {
    // picRow 1 puts picture row 0 at frame row 8; colour 2 is EGA green (0,170,0).
    const rgb = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 3);
    drawFrameInto(fakeFrame(2, 1), "visual", rgb, FRAME_WIDTH, 0, 0);
    const at = (x: number, y: number): number[] => {
      const o = (y * FRAME_WIDTH + x) * 3;
      return [rgb[o]!, rgb[o + 1]!, rgb[o + 2]!];
    };
    assert.deepEqual(at(0, 7), [0, 0, 0], "row 7 is above the picture band");
    assert.deepEqual(at(0, 8), [0, 0xaa, 0], "picture row 0 lands on frame row 8");
    assert.deepEqual(at(1, 8), [0, 0xaa, 0], "one logical pixel covers two screen pixels");
    assert.deepEqual(at(319, 175), [0, 0xaa, 0], "last band row is 8 + 167 = 175");
    assert.deepEqual(at(0, 176), [0, 0, 0], "row 176 is below the picture band");
  });

  it("renders the priority plane when asked", () => {
    const rgb = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 3);
    drawFrameInto(fakeFrame(2, 1), "priority", rgb, FRAME_WIDTH, 0, 0);
    const o = (8 * FRAME_WIDTH + 0) * 3;
    // Priority 4 is EGA red (0xaa, 0, 0), not the visual plane's green.
    assert.deepEqual([rgb[o], rgb[o + 1], rgb[o + 2]], [0xaa, 0x00, 0x00]);
  });

  it("places sheet tiles row-major with the gutter between them", () => {
    // Two frames of different colours: tile 1 starts at x = 320 + SHEET_GAP.
    const { grid } = framesToContactSheet([fakeFrame(2), fakeFrame(4)], "visual");
    const rgb = new Uint8Array(grid.width * grid.height * 3);
    drawFrameInto(fakeFrame(2), "visual", rgb, grid.width, 0, 0);
    drawFrameInto(fakeFrame(4), "visual", rgb, grid.width, FRAME_WIDTH + SHEET_GAP, 0);
    const at = (x: number, y: number): number[] => {
      const o = (y * grid.width + x) * 3;
      return [rgb[o]!, rgb[o + 1]!, rgb[o + 2]!];
    };
    assert.deepEqual(at(0, 8), [0, 0xaa, 0], "tile 0 is colour 2, green");
    assert.deepEqual(at(321, 8), [0, 0, 0], "the 4px gutter stays black");
    assert.deepEqual(at(324, 8), [0xaa, 0, 0], "tile 1 starts at 320 + 4 and is colour 4, red");
  });

  it("transcribes the text surface, trimming trailing blanks", () => {
    const text = new Uint8Array(TEXT_BYTES);
    for (const [i, ch] of [..."HI"].entries()) text[i * 2] = ch.charCodeAt(0);
    assert.deepEqual(textRows({ ...fakeFrame(1), text }), ["HI"]);
    assert.deepEqual(textRows(fakeFrame(1)), []);
  });
});

describe("read_frames tool", () => {
  const session = createAgentSessionState();

  it("returns one image per frame by default", async () => {
    const res = await executeAgentToolAsync(
      session,
      "read_frames",
      { count: 3, stride: 1, sheet: null, plane: null },
      { frames: fakeSource([10, 11, 12]) },
    );
    assert.equal(res.success, true);
    assert.equal(res.images?.length, 3);
    assert.deepEqual(res.details?.["cycles"], [10, 11, 12]);
    assert.match(res.images![0]!.caption, /^Cycle 10, visual plane, 320x200\./);
    assert.match(res.images![0]!.caption, /Text rows are not drawn into the image/);
  });

  it("packs frames into one contact sheet on request, labelled by cycle", async () => {
    const res = await executeAgentToolAsync(
      session,
      "read_frames",
      { count: 5, stride: 1, sheet: true, plane: "visual" },
      { frames: fakeSource([1, 2, 3, 4, 5]) },
    );
    assert.equal(res.images?.length, 1);
    const caption = res.images![0]!.caption;
    assert.match(caption, /3 columns x 2 rows/);
    assert.match(caption, /sheet 968x404/);
    assert.match(caption, /Cycles in order: 1, 2, 3, 4, 5/);
    assert.deepEqual(pngSize(res.images![0]!.png), { width: 968, height: 404 });
  });

  it("returns every frame up to the documented maximum", async () => {
    const res = await executeAgentToolAsync(
      session,
      "read_frames",
      { count: 9, stride: 1, sheet: null, plane: null },
      { frames: fakeSource([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) },
    );
    assert.equal(res.images?.length, 9);
  });

  it("rejects a count above the documented maximum before dispatch", async () => {
    // The schema bound is the contract, as for playtest_room.ticks; nothing is clamped silently.
    const res = await executeAgentToolAsync(
      session,
      "read_frames",
      { count: 99, stride: 1, sheet: null, plane: null },
      { frames: fakeSource([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) },
    );
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /count must be <= 9, got 99/);
    assert.equal(res.images, undefined);
  });

  it("reports an empty ring rather than an empty image", async () => {
    const res = await executeAgentToolAsync(
      session,
      "read_frames",
      { count: 1, stride: 1, sheet: null, plane: null },
      { frames: { read: () => [] } },
    );
    assert.equal(res.success, false);
    assert.match(res.error!, /frame ring is empty/);
  });

  it("stays declared but fails clearly when no game is attached", async () => {
    const res = await executeAgentToolAsync(session, "read_frames", {
      count: 1,
      stride: 1,
      sheet: null,
      plane: null,
    });
    assert.equal(res.success, false);
    assert.match(res.error!, /No live game is attached/);
  });

  it("rejects an unknown plane", async () => {
    const res = await executeAgentToolAsync(
      session,
      "read_frames",
      { count: 1, stride: 1, sheet: null, plane: "depth" },
      { frames: fakeSource([1]) },
    );
    assert.equal(res.success, false);
    assert.match(res.error!, /plane must be/);
  });
});

describe("read_objects / read_state tools", () => {
  const session = createAgentSessionState();
  const engine = {
    objects: () => [{ num: 0, view: 1, x: 40, y: 120 }],
    state: () => ({
      profile: "2.936",
      room: 3,
      previousRoom: 1,
      egoX: 40,
      egoY: 120,
      egoDirection: 3,
      horizon: 36,
      modalKind: null,
      lastInputLine: "look",
    }),
  };

  it("reports the active object table", async () => {
    const res = await executeAgentToolAsync(session, "read_objects", {}, { engine });
    assert.equal(res.success, true);
    assert.equal(res.message, "1 active screen object(s). Object 0 is ego.");
    assert.deepEqual(res.details?.["objects"], [{ num: 0, view: 1, x: 40, y: 120 }]);
  });

  it("summarises live interpreter state in one line and returns it whole", async () => {
    const res = await executeAgentToolAsync(session, "read_state", {}, { engine });
    assert.equal(res.success, true);
    assert.equal(
      res.message,
      'Room 3 (previous 1), profile 2.936, ego at (40, 120) facing 3, horizon 36, modal none, last input "look".',
    );
    assert.equal(res.details?.["room"], 3);
  });

  it("fails clearly with no interpreter attached", async () => {
    for (const name of ["read_objects", "read_state"]) {
      const res = await executeAgentToolAsync(session, name, {});
      assert.equal(res.success, false, name);
      assert.match(res.error!, /No live game is attached/);
    }
  });
});

describe("worker frame ring", () => {
  const visual = (v: number): Uint8Array => new Uint8Array(SURFACE_BYTES).fill(v);
  const text = new Uint8Array(TEXT_BYTES);

  it("keeps the newest `capacity` frames and returns them oldest first", () => {
    const ring = new FrameRing(4);
    for (let cycle = 1; cycle <= 6; cycle++) ring.push(cycle, visual(cycle), visual(0), text, 1);
    assert.equal(ring.size, 4);
    assert.deepEqual(
      ring.take(10, 1, null).map((f) => f.cycle),
      [3, 4, 5, 6],
    );
  });

  it("honours stride and the `since` watermark", () => {
    const ring = new FrameRing(8);
    for (let cycle = 1; cycle <= 8; cycle++) ring.push(cycle, visual(cycle), visual(0), text, 1);
    // Newest-first walk with stride 2 -> cycles 8, 6, 4; reversed for reading.
    assert.deepEqual(
      ring.take(3, 2, null).map((f) => f.cycle),
      [4, 6, 8],
    );
    // since = 6 stops the backward walk once it reaches cycle 6.
    assert.deepEqual(
      ring.take(5, 1, 6).map((f) => f.cycle),
      [7, 8],
    );
  });

  it("hands out detached copies of the stored surfaces", () => {
    const ring = new FrameRing(2);
    ring.push(9, visual(7), visual(4), text, 3);
    const [frame] = ring.take(1, 1, null);
    assert.equal(frame!.picRow, 3);
    assert.equal(frame!.visual.length, SURFACE_BYTES);
    assert.equal(frame!.visual[0], 7);
    assert.equal(frame!.priority[SURFACE_BYTES - 1], 4);
    frame!.visual[0] = 15;
    assert.equal(ring.take(1, 1, null)[0]!.visual[0], 7, "the ring is not aliased");
  });

  it("resets to empty on a fresh boot", () => {
    const ring = new FrameRing(2);
    ring.push(1, visual(1), visual(0), text, 1);
    ring.reset();
    assert.equal(ring.size, 0);
    assert.deepEqual(ring.take(1, 1, null), []);
  });
});
