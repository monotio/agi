import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { openContainer } from "../src/container/container.ts";
import { createPictureSurface, SCREEN_WIDTH, type PictureSurface } from "../src/types.ts";
import { buildView, drawCel, parseView, type ViewCel } from "../src/view/view.ts";
import { fixtureSkip, KQ1_DIR } from "./fixtures.ts";

function makeCel(
  width: number,
  height: number,
  transparentColor: number,
  pixels: readonly number[],
): ViewCel {
  return { width, height, transparentColor, mirrored: false, pixels: new Uint8Array(pixels) };
}

function cell(surface: PictureSurface, x: number, y: number) {
  const i = y * SCREEN_WIDTH + x;
  return { visual: surface.visual[i], priority: surface.priority[i] };
}

// Hand-computed payload: 1 loop, 2 cels, no display string (offset 0).
//   loop 0 @ 7: cel count 2, cel offsets +5 (abs 12) and +14 (abs 21),
//   relative to the loop start.
//   cel 0 @ 12: 4x2, control 0x05 (transparent 5, no mirror).
//     row 0: run(1,2) run(5,1) run(2,1) end -> [1, 1, 5, 2] (5 = transparent)
//     row 1: run(3,4) end                   -> [3, 3, 3, 3]
//   cel 1 @ 21: 2x3, control 0x00 (transparent 0).
//     row 0: run(6,1) end -> [6, 0]
//     row 1: run(7,3) end -> [7, 7] (run wider than the row: 1 pixel dropped)
//     row 2: end          -> [0, 0]
const TWO_CEL_PAYLOAD = new Uint8Array([
  0x00, 0x00, 0x01, 0x00, 0x00, 0x07, 0x00, 0x02, 0x05, 0x00, 0x0e, 0x00, 0x04, 0x02, 0x05, 0x12,
  0x51, 0x21, 0x00, 0x34, 0x00, 0x02, 0x03, 0x00, 0x61, 0x00, 0x73, 0x00, 0x00,
]);

describe("parseView", () => {
  it("decodes loops, cels, RLE rows, and transparency", () => {
    const view = parseView(TWO_CEL_PAYLOAD);
    assert.equal(view.loops.length, 1);
    assert.equal(view.loops[0]!.cels.length, 2);

    const cel0 = view.loops[0]!.cels[0]!;
    assert.equal(cel0.width, 4);
    assert.equal(cel0.height, 2);
    assert.equal(cel0.transparentColor, 5);
    assert.equal(cel0.mirrored, false);
    assert.deepEqual([...cel0.pixels], [1, 1, 5, 2, 3, 3, 3, 3]);

    const cel1 = view.loops[0]!.cels[1]!;
    assert.equal(cel1.width, 2);
    assert.equal(cel1.height, 3);
    assert.equal(cel1.transparentColor, 0);
    assert.equal(cel1.mirrored, false);
    assert.deepEqual([...cel1.pixels], [6, 0, 7, 7, 0, 0]);
  });

  it("mirrors a loop whose cel orientation differs from the loop number", () => {
    // 2 loops; both loop offsets point at the same loop data @ 9 (the classic
    // mirrored-loop encoding). Cel: 3x1, control 0x80 = mirrorable, stored
    // orientation loop 0, transparent 0. Stored row: [1, 2, 0].
    // Selecting loop 0 keeps orientation; selecting loop 1 mirrors the rows.
    const payload = new Uint8Array([
      0x00, 0x00, 0x02, 0x00, 0x00, 0x09, 0x00, 0x09, 0x00, 0x01, 0x03, 0x00, 0x03, 0x01, 0x80,
      0x11, 0x21, 0x00,
    ]);
    const view = parseView(payload);
    assert.equal(view.loops.length, 2);

    const plain = view.loops[0]!.cels[0]!;
    assert.equal(plain.mirrored, false);
    assert.deepEqual([...plain.pixels], [1, 2, 0]);

    const flipped = view.loops[1]!.cels[0]!;
    assert.equal(flipped.mirrored, true);
    assert.deepEqual([...flipped.pixels], [0, 2, 1]);
  });

  it("rejects truncated payloads and unterminated rows", () => {
    assert.throws(() => parseView(new Uint8Array([0x00, 0x00, 0x01])), RangeError);
    // loop offset past the payload
    assert.throws(
      () => parseView(new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x00, 0x40, 0x00])),
      RangeError,
    );
    // cel row without zero terminator before the payload end
    assert.throws(
      () =>
        parseView(
          new Uint8Array([
            0x00, 0x00, 0x01, 0x00, 0x00, 0x07, 0x00, 0x01, 0x03, 0x00, 0x01, 0x01, 0x00, 0x12,
          ]),
        ),
      RangeError,
    );
  });
});

describe("buildView", () => {
  it("builds exact hand-computed bytes for minimal 1x1 cel (matching EGO_VIEW)", () => {
    const payload = buildView({
      loops: [
        {
          cels: [
            {
              width: 1,
              height: 1,
              transparentColor: 0,
              pixels: [5],
            },
          ],
        },
      ],
    });
    const expected = new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 1, 1, 0, 0x51, 0]);
    assert.deepEqual(payload, expected);
  });

  it("encodes RLE rows with runs, transparent skipping, and zero row terminators", () => {
    const payload = buildView({
      loops: [
        {
          cels: [
            {
              width: 4,
              height: 2,
              transparentColor: 5,
              pixels: [1, 1, 5, 2, 3, 3, 3, 3],
            },
          ],
        },
      ],
    });
    // Header (7 bytes): 0, 0, 1 loop, desc 0, offset 7
    // Loop 0 (3 bytes): 1 cel, offset 3
    // Cel 0: 4x2, control 5, row 0 (0x12, 0x51, 0x21, 0), row 1 (0x34, 0)
    const expected = new Uint8Array([
      0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 4, 2, 5, 0x12, 0x51, 0x21, 0, 0x34, 0,
    ]);
    assert.deepEqual(payload, expected);

    const parsed = parseView(payload);
    assert.equal(parsed.loops.length, 1);
    assert.equal(parsed.loops[0]!.cels.length, 1);
    const cel = parsed.loops[0]!.cels[0]!;
    assert.equal(cel.width, 4);
    assert.equal(cel.height, 2);
    assert.equal(cel.transparentColor, 5);
    assert.deepEqual([...cel.pixels], [1, 1, 5, 2, 3, 3, 3, 3]);
  });

  it("builds mirrored loops sharing loop offset and setting cel control bit 0x80", () => {
    const payload = buildView({
      loops: [
        {
          cels: [
            {
              width: 3,
              height: 1,
              transparentColor: 0,
              pixels: [1, 2, 0],
            },
          ],
        },
        { mirrorLoop: 0 },
      ],
    });
    // Header (9 bytes): 0, 0, 2 loops, desc 0, loop 0 @ 9, loop 1 @ 9
    // Loop 0 @ 9 (3 bytes): 1 cel, offset 3
    // Cel 0 @ 12: 3x1, control 0x80 (mirrorable, orient 0, trans 0), row 0 (0x11, 0x21, 0)
    const expected = new Uint8Array([
      0x00, 0x00, 0x02, 0x00, 0x00, 0x09, 0x00, 0x09, 0x00, 0x01, 0x03, 0x00, 0x03, 0x01, 0x80,
      0x11, 0x21, 0x00,
    ]);
    assert.deepEqual(payload, expected);

    const parsed = parseView(payload);
    assert.equal(parsed.loops.length, 2);
    assert.equal(parsed.loops[0]!.cels[0]!.mirrored, false);
    assert.deepEqual([...parsed.loops[0]!.cels[0]!.pixels], [1, 2, 0]);
    assert.equal(parsed.loops[1]!.cels[0]!.mirrored, true);
    assert.deepEqual([...parsed.loops[1]!.cels[0]!.pixels], [0, 2, 1]);
  });

  it("chunks runs longer than 15 pixels", () => {
    const pixels = new Uint8Array(20).fill(4);
    const payload = buildView({
      loops: [
        {
          cels: [
            {
              width: 20,
              height: 1,
              transparentColor: 0,
              pixels,
            },
          ],
        },
      ],
    });
    // Row should encode as run(4, 15) -> 0x4f, run(4, 5) -> 0x45, end -> 0x00
    const expectedRow = [0x4f, 0x45, 0x00];
    const celStart = 10; // header 7 + loop 3
    const rowBytes = [...payload.subarray(celStart + 3)];
    assert.deepEqual(rowBytes, expectedRow);

    const parsed = parseView(payload);
    assert.deepEqual([...parsed.loops[0]!.cels[0]!.pixels], [...pixels]);
  });

  it("roundtrips multi-loop views through buildView -> parseView", () => {
    const viewInput = {
      loops: [
        {
          cels: [
            { width: 3, height: 2, transparentColor: 0, pixels: [1, 2, 3, 0, 4, 0] },
            { width: 3, height: 2, transparentColor: 0, pixels: [4, 5, 6, 0, 0, 7] },
          ],
        },
        { mirrorLoop: 0 },
        {
          cels: [{ width: 2, height: 2, transparentColor: 1, pixels: [1, 2, 3, 1] }],
        },
      ],
    };
    const payload = buildView(viewInput);
    const parsed = parseView(payload);
    assert.equal(parsed.loops.length, 3);
    assert.equal(parsed.loops[0]!.cels.length, 2);
    assert.equal(parsed.loops[1]!.cels.length, 2);
    assert.equal(parsed.loops[2]!.cels.length, 1);

    // Loop 0 vs Loop 1 mirroring
    assert.deepEqual([...parsed.loops[0]!.cels[0]!.pixels], [1, 2, 3, 0, 4, 0]);
    assert.deepEqual([...parsed.loops[1]!.cels[0]!.pixels], [3, 2, 1, 0, 4, 0]);
    assert.equal(parsed.loops[1]!.cels[0]!.mirrored, true);

    // Loop 2 independent cel
    assert.deepEqual([...parsed.loops[2]!.cels[0]!.pixels], [1, 2, 3, 1]);
  });

  it("encodes optional description text and points header offset to it", () => {
    const payload = buildView({
      loops: [
        {
          cels: [{ width: 1, height: 1, transparentColor: 0, pixels: [9] }],
        },
      ],
      description: "Magic Sword",
    });
    // Header description offset is at bytes 3..4
    const descOffset = payload[3]! | (payload[4]! << 8);
    assert.ok(descOffset > 0 && descOffset < payload.length);
    const textBytes = payload.subarray(descOffset, payload.length - 1);
    assert.equal(new TextDecoder().decode(textBytes), "Magic Sword");
    assert.equal(payload[payload.length - 1], 0); // null terminator
  });

  it("validates input dimensions, loop count, and pixel lengths", () => {
    assert.throws(() => buildView({ loops: [] }), RangeError);
    assert.throws(
      () =>
        buildView({
          loops: [{ cels: [{ width: 0, height: 1, pixels: [] }] }],
        }),
      RangeError,
    );
    assert.throws(
      () =>
        buildView({
          loops: [{ cels: [{ width: 2, height: 2, pixels: [1, 2, 3] }] }],
        }),
      RangeError,
    );
    assert.throws(
      () =>
        buildView({
          loops: [{ mirrorLoop: 0 }],
        }),
      RangeError,
    );
    assert.throws(
      () =>
        buildView({
          loops: [{ cels: [] }],
        }),
      RangeError,
    );
  });
});

describe("drawCel", () => {
  it("draws nontransparent pixels at baseline placement, skipping transparent", () => {
    const surface = createPictureSurface();
    // row 0: [1, transparent]   row 1: [2, 3]
    const cel = makeCel(2, 2, 0, [1, 0, 2, 3]);
    drawCel(surface, cel, 10, 20, { priority: 7 });
    // top = 20 - 2 + 1 = 19
    assert.deepEqual(cell(surface, 10, 19), { visual: 1, priority: 7 });
    assert.deepEqual(cell(surface, 11, 19), { visual: 15, priority: 4 });
    assert.deepEqual(cell(surface, 10, 20), { visual: 2, priority: 7 });
    assert.deepEqual(cell(surface, 11, 20), { visual: 3, priority: 7 });
  });

  it("hides pixels whose destination priority exceeds the drawing priority", () => {
    const surface = createPictureSurface();
    // Barrier at priority 8 across the cel's target row.
    surface.priority[10 * SCREEN_WIDTH + 5] = 8;
    surface.priority[10 * SCREEN_WIDTH + 6] = 8;
    const cel = makeCel(2, 1, 0, [9, 9]);
    drawCel(surface, cel, 5, 10, { priority: 7 });
    assert.deepEqual(cell(surface, 5, 10), { visual: 15, priority: 8 });
    assert.deepEqual(cell(surface, 6, 10), { visual: 15, priority: 8 });
    // Equal priority draws and replaces the destination priority with p.
    drawCel(surface, cel, 5, 10, { priority: 8 });
    assert.deepEqual(cell(surface, 5, 10), { visual: 9, priority: 8 });
    assert.deepEqual(cell(surface, 6, 10), { visual: 9, priority: 8 });
  });

  it("scans downward past control values 0..2 for the comparison priority", () => {
    const surface = createPictureSurface();
    // Control line 0 in column 8, rows 10..12; ordinary priority 4 below.
    for (let y = 10; y <= 12; y++) surface.priority[y * SCREEN_WIDTH + 8] = 0;
    const cel = makeCel(1, 1, 0, [6]);
    // Comparison value is the 4 found at row 13: p=3 is hidden, p=4 draws.
    drawCel(surface, cel, 8, 10, { priority: 3 });
    assert.deepEqual(cell(surface, 8, 10), { visual: 15, priority: 0 });
    drawCel(surface, cel, 8, 10, { priority: 4 });
    assert.deepEqual(cell(surface, 8, 10), { visual: 6, priority: 4 });

    // Column 9 below row 20 is all control value 1: the scan reaches the
    // bottom, comparison 0, so even priority 0 draws.
    for (let y = 20; y < 168; y++) surface.priority[y * SCREEN_WIDTH + 9] = 1;
    drawCel(surface, cel, 9, 20, { priority: 0 });
    assert.deepEqual(cell(surface, 9, 20), { visual: 6, priority: 0 });
  });

  it("shifts left to fit the right edge and clips rows below the bottom", () => {
    const surface = createPictureSurface();
    const cel = makeCel(4, 1, 0, [1, 2, 3, 4]);
    // 158 + 4 > 160 -> left becomes 156, all four pixels land at 156..159.
    drawCel(surface, cel, 158, 5, { priority: 7 });
    assert.deepEqual(cell(surface, 155, 5), { visual: 15, priority: 4 });
    assert.deepEqual(cell(surface, 156, 5), { visual: 1, priority: 7 });
    assert.deepEqual(cell(surface, 157, 5), { visual: 2, priority: 7 });
    assert.deepEqual(cell(surface, 158, 5), { visual: 3, priority: 7 });
    assert.deepEqual(cell(surface, 159, 5), { visual: 4, priority: 7 });

    // Baseline 169 with height 3: top = 167; rows at 168 and 169 clip away.
    const tall = makeCel(1, 3, 0, [5, 6, 7]);
    drawCel(surface, tall, 3, 169, { priority: 7 });
    assert.deepEqual(cell(surface, 3, 167), { visual: 5, priority: 7 });
  });

  it("treats a negative top as a position adjustment, not clipping", () => {
    const surface = createPictureSurface();
    const cel = makeCel(1, 3, 0, [5, 6, 7]);
    // top = 1 - 3 + 1 = -1 -> left 20 - 1 = 19, baseline 1 + 1 = 2, top = 0;
    // all three rows still draw, one pixel further left than requested.
    drawCel(surface, cel, 20, 1, { priority: 7 });
    assert.deepEqual(cell(surface, 19, 0), { visual: 5, priority: 7 });
    assert.deepEqual(cell(surface, 19, 1), { visual: 6, priority: 7 });
    assert.deepEqual(cell(surface, 19, 2), { visual: 7, priority: 7 });
    assert.deepEqual(cell(surface, 20, 0), { visual: 15, priority: 4 });
  });
});

const KQ1_NAMES = ["VIEWDIR", "VOL.0", "VOL.1", "VOL.2"];

describe("authentic KQ1 view fixtures", { skip: fixtureSkip("kq1", KQ1_NAMES) }, () => {
  const files = new Map<string, Uint8Array>();
  for (const name of KQ1_NAMES) files.set(name, new Uint8Array(readFileSync(KQ1_DIR + name)));
  const container = openContainer(files);

  it("view 0 parses into in-bounds loops and cels", () => {
    const payload = container.getResource("view", 0);
    assert.ok(payload, "view 0 present in KQ1");
    const view = parseView(payload);
    assert.ok(view.loops.length >= 1);
    for (const loop of view.loops) {
      for (const cel of loop.cels) {
        assert.equal(cel.pixels.length, cel.width * cel.height);
        assert.ok(cel.width <= SCREEN_WIDTH && cel.height <= 168);
      }
    }
    console.log(
      `KQ1 view 0: ${view.loops.length} loops, cels per loop: [${view.loops
        .map((loop) => loop.cels.length)
        .join(", ")}]`,
    );
  });

  it("every view resource in VIEWDIR parses without throwing", () => {
    let count = 0;
    for (let num = 0; num < 256; num++) {
      const payload = container.getResource("view", num);
      if (!payload) continue;
      count++;
      const view = parseView(payload);
      for (const loop of view.loops) {
        for (const cel of loop.cels) {
          assert.equal(cel.pixels.length, cel.width * cel.height);
        }
      }
    }
    assert.ok(count > 0);
    console.log(`KQ1: ${count} view resources parsed`);
  });
});
