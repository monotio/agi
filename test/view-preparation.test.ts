import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROFILES } from "../src/runtime/profile.ts";
import {
  prepareView,
  PREPARATION_LIMITS,
  VIEW_PREPARATION_ALGORITHM,
  type SourceIdentity,
  type SourceRaster,
  type ViewPreparationRecipe,
  type ViewRecipeFrame,
  type ViewRecipeLoop,
} from "../src/view/preparation.ts";
import { parseView } from "../src/view/view.ts";

/**
 * Hand-labelled tiny RGBA grids. EGA indices are hand-computed with the
 * weighted metric 2dR^2+4dG^2+3dB^2 (see test/spritesheet.test.ts):
 *   #ffffff -> 15, #ff0000 -> 4, #000000 -> 0, #ff00ff -> 13, #0000ff -> 1.
 */

const PROFILE = PROFILES["2.936"];
const PACKED = PROFILES["2.230"];

const WHITE: readonly [number, number, number, number] = [0xff, 0xff, 0xff, 0xff];
const RED: readonly [number, number, number, number] = [0xff, 0x00, 0x00, 0xff];
const BLACK: readonly [number, number, number, number] = [0x00, 0x00, 0x00, 0xff];
const MAGENTA: readonly [number, number, number, number] = [0xff, 0x00, 0xff, 0xff];
const BLUE: readonly [number, number, number, number] = [0x00, 0x00, 0xff, 0xff];
const CLEAR: readonly [number, number, number, number] = [0x12, 0x34, 0x56, 0x00];

function makeSource(
  width: number,
  height: number,
  paint: (x: number, y: number) => readonly [number, number, number, number],
  identity: SourceIdentity = SRC_A,
): SourceRaster {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rgba.set(paint(x, y), (y * width + x) * 4);
    }
  }
  return { identity, width, height, rgba };
}

const SRC_A: SourceIdentity = { id: "drawing-a", incarnation: "inc-1", revision: 2 };
const SRC_B: SourceIdentity = { id: "drawing-b", incarnation: "inc-1", revision: 1 };

function frame(partial: Partial<ViewRecipeFrame> & { id: string }): ViewRecipeFrame {
  return {
    source: SRC_A,
    region: { x: 0, y: 0, width: 2, height: 2 },
    outputWidth: 2,
    outputHeight: 2,
    sourceAnchor: { x: 1, baselineEdgeY: 2 },
    outputAnchorX: 1,
    sample: "nearest-centre-v1",
    allowCropBelowBaseline: false,
    allowCropOutsideCanvas: false,
    ...partial,
  };
}

function cels(id: string, frameIds: readonly string[]): ViewRecipeLoop {
  return { id, frameIds };
}

function mirror(id: string, mirrorOf: string): ViewRecipeLoop {
  return { id, mirrorOf, explicitlyApproved: true };
}

function recipe(
  frames: readonly ViewRecipeFrame[],
  loops: readonly ViewRecipeLoop[],
  extra?: Partial<ViewPreparationRecipe>,
): ViewPreparationRecipe {
  return {
    format: "agi.preparation",
    version: 1,
    kind: "view",
    algorithm: VIEW_PREPARATION_ALGORITHM,
    sources: [SRC_A],
    palette: "ega-weighted-243-v1",
    mask: { alphaThreshold: 128, key: null },
    frames,
    loops,
    ...extra,
  };
}

/** 2x2 source: white / transparent on top, red / black on the ground row. */
const SRC_2X2 = () => makeSource(2, 2, (x, y) => [WHITE, CLEAR, RED, BLACK][y * 2 + x]!);

describe("prepareView", () => {
  it("prepares one drawing into a 1:1 single-cel view with exact bytes", () => {
    const prepared = prepareView(
      [SRC_2X2()],
      recipe([frame({ id: "f1" })], [cels("only", ["f1"])]),
      PROFILE,
    );
    const prepared_frame = prepared.frames[0]!;
    // 1:1 crop: the transparent source pixel stays transparent.
    assert.deepEqual(Array.from(prepared_frame.mask), [1, 0, 1, 1]);
    // Transparent cells hold the reserved transparent index; mask is the authority.
    assert.deepEqual(Array.from(prepared_frame.pixels), [15, 1, 4, 0]);
    assert.equal(prepared_frame.transparentIndex, 1); // lowest index free of 15/4/0
    assert.equal(prepared_frame.baseline, 1);
    assert.equal(prepared_frame.diagnostics.opaque, 3);
    assert.equal(prepared_frame.diagnostics.alphaErased, 1);

    // Hand-computed payload: 5-byte header + 2-byte loop table, one loop at
    // offset 7 with a 1-cel table, cel at 7+3=10:
    //   control = 0x00 | (loop 0 << 4) | trans 1 = 0x01
    //   row 0: [15, trans] -> run F1, 00;  row 1: [4, 0] -> 41, 01, 00.
    assert.deepEqual(
      Array.from(prepared.payload),
      [0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 2, 2, 1, 0xf1, 0x00, 0x41, 0x01, 0x00],
    );
    const decoded = parseView(prepared.payload, PROFILE);
    assert.deepEqual(Array.from(decoded.loops[0]!.cels[0]!.pixels), [15, 1, 4, 0]);
    assert.equal(decoded.loops[0]!.cels[0]!.transparentColor, 1);
  });

  it("resolves the alpha edge: 127 transparent, 128 opaque at threshold 128", () => {
    const src = makeSource(2, 1, (x) => (x === 0 ? [9, 9, 9, 127] : [9, 9, 9, 128]));
    const prepared = prepareView(
      [src],
      recipe(
        [
          frame({
            id: "f1",
            region: { x: 0, y: 0, width: 2, height: 1 },
            outputWidth: 2,
            outputHeight: 1,
            sourceAnchor: { x: 1, baselineEdgeY: 1 },
          }),
        ],
        [cels("only", ["f1"])],
      ),
      PROFILE,
    );
    assert.deepEqual(Array.from(prepared.frames[0]!.mask), [0, 1]);

    const strict = prepareView(
      [src],
      recipe(
        [
          frame({
            id: "f1",
            region: { x: 0, y: 0, width: 2, height: 1 },
            outputWidth: 2,
            outputHeight: 1,
            sourceAnchor: { x: 1, baselineEdgeY: 1 },
          }),
        ],
        [cels("only", ["f1"])],
        { mask: { alphaThreshold: 200, key: null } },
      ),
      PROFILE,
    );
    assert.deepEqual(Array.from(strict.frames[0]!.mask), [0, 0]);
  });

  it("keeps an opaque border colour: no border-key detection on new imports", () => {
    // A fully opaque all-magenta sheet: the legacy quantizer's border-ring
    // vote would erase every pixel. The preparation path passes an explicit
    // null key, so alpha is the only transparency source and the art stays.
    const src = makeSource(3, 3, () => MAGENTA);
    const prepared = prepareView(
      [src],
      recipe(
        [
          frame({
            id: "f1",
            region: { x: 0, y: 0, width: 3, height: 3 },
            outputWidth: 3,
            outputHeight: 3,
            sourceAnchor: { x: 1, baselineEdgeY: 3 },
            outputAnchorX: 1,
          }),
        ],
        [cels("only", ["f1"])],
      ),
      PROFILE,
    );
    assert.ok(prepared.frames[0]!.mask.every((m) => m === 1));
    assert.equal(prepared.frames[0]!.diagnostics.keyIndex, null);
    assert.equal(prepared.frames[0]!.diagnostics.keyErased, 0);
    assert.equal(prepared.frames[0]!.transparentIndex, 0);
  });

  it("erases the explicit key colour and reports every erased pixel", () => {
    // #f70df3 quantizes to index 13 like pure #ff00ff (distances 21296 vs
    // 28521 to the two magentas), so both vanish under the key.
    const NEAR_MAGENTA: readonly [number, number, number, number] = [0xf7, 0x0d, 0xf3, 0xff];
    const src = makeSource(4, 1, (x) => [MAGENTA, WHITE, NEAR_MAGENTA, CLEAR][x]!);
    const prepared = prepareView(
      [src],
      recipe(
        [
          frame({
            id: "f1",
            region: { x: 0, y: 0, width: 4, height: 1 },
            outputWidth: 4,
            outputHeight: 1,
            sourceAnchor: { x: 2, baselineEdgeY: 1 },
            outputAnchorX: 2,
          }),
        ],
        [cels("only", ["f1"])],
        { mask: { alphaThreshold: 128, key: { mode: "ega-index-v1", rgb: [0xff, 0x00, 0xff] } } },
      ),
      PROFILE,
    );
    const diagnostics = prepared.frames[0]!.diagnostics;
    assert.deepEqual(Array.from(prepared.frames[0]!.mask), [0, 1, 0, 0]);
    assert.equal(diagnostics.keyIndex, 13);
    assert.equal(diagnostics.keyErased, 2);
    assert.equal(diagnostics.alphaErased, 1);
    // The key index is always free for transparency under key mode.
    assert.equal(prepared.frames[0]!.transparentIndex, 13);
  });

  it("breaks nearest-colour ties toward the lower EGA index", () => {
    // #000055 is exactly 21675 from black(0) and blue(1): lower index wins.
    const src = makeSource(1, 1, () => [0x00, 0x00, 0x55, 0xff]);
    const prepared = prepareView(
      [src],
      recipe(
        [
          frame({
            id: "f1",
            region: { x: 0, y: 0, width: 1, height: 1 },
            outputWidth: 1,
            outputHeight: 1,
            sourceAnchor: { x: 0, baselineEdgeY: 1 },
            outputAnchorX: 0,
          }),
        ],
        [cels("only", ["f1"])],
      ),
      PROFILE,
    );
    assert.deepEqual(Array.from(prepared.frames[0]!.pixels), [0]);
    assert.deepEqual(Array.from(prepared.frames[0]!.mask), [1]);
  });

  it("samples nearest-centre on downscale: 4x2 -> 2x1 picks columns 1 and 3 of row 1", () => {
    const rows = [
      [WHITE, RED, BLACK, WHITE],
      [BLACK, WHITE, RED, BLACK],
    ];
    const src = makeSource(4, 2, (x, y) => rows[y]![x]!);
    const prepared = prepareView(
      [src],
      recipe(
        [
          frame({
            id: "f1",
            region: { x: 0, y: 0, width: 4, height: 2 },
            outputWidth: 2,
            outputHeight: 1,
            // baseline at the region's bottom edge; anchor at its centre edge
            // so the sampled window is the region itself at scale 2.
            sourceAnchor: { x: 2, baselineEdgeY: 2 },
            outputAnchorX: 1,
          }),
        ],
        [cels("only", ["f1"])],
      ),
      PROFILE,
    );
    // oy 0 -> sy = floor(1*2/2) = 1; ox 0 -> floor(0.5*4/2) = 1; ox 1 -> 3.
    assert.deepEqual(Array.from(prepared.frames[0]!.pixels), [15, 0]);
    assert.deepEqual(Array.from(prepared.frames[0]!.mask), [1, 1]);
  });

  it("honours arbitrary frame order, reuse and a seven-cel loop", () => {
    const src = makeSource(4, 1, (x) => [WHITE, RED, BLACK, BLUE][x]!);
    const frames = ["w", "r", "k", "b"].map((id, x) =>
      frame({
        id,
        region: { x, y: 0, width: 1, height: 1 },
        outputWidth: 1,
        outputHeight: 1,
        sourceAnchor: { x, baselineEdgeY: 1 },
        outputAnchorX: 0,
      }),
    );
    const prepared = prepareView(
      [src],
      recipe(frames, [
        cels("main", ["b", "w", "b"]), // 3 cels, reuse of "b"
        cels("long", ["k", "r", "w", "b", "k", "w", "r"]), // 7 cels
      ]),
      PROFILE,
    );
    const decoded = parseView(prepared.payload, PROFILE);
    assert.deepEqual(
      decoded.loops[0]!.cels.map((c) => Array.from(c.pixels)),
      [[1], [15], [1]],
    );
    assert.deepEqual(
      decoded.loops[1]!.cels.map((c) => Array.from(c.pixels)),
      [[0], [4], [15], [1], [0], [15], [4]],
    );
  });

  it("refuses a frame whose source identity or revision is stale", () => {
    const src = SRC_2X2();
    const stale = frame({ id: "f1", source: { ...SRC_A, revision: 99 } });
    assert.throws(
      () => prepareView([src], recipe([stale], [cels("only", ["f1"])]), PROFILE),
      /stale|does not match|not declared/,
    );
    // Declared but not supplied.
    const refOnly = frame({ id: "f1", source: SRC_B });
    assert.throws(
      () =>
        prepareView(
          [src],
          recipe([refOnly], [cels("only", ["f1"])], { sources: [SRC_A, SRC_B] }),
          PROFILE,
        ),
      /stale|missing/,
    );
    // Used but undeclared in recipe.sources.
    const undeclared = frame({ id: "f1", source: { ...SRC_A, incarnation: "other" } });
    assert.throws(
      () => prepareView([src], recipe([undeclared], [cels("only", ["f1"])]), PROFILE),
      /not declared in recipe\.sources/,
    );
  });

  it("aligns differing regions on a common anchor and baseline, preserving padding", () => {
    // One 8x8 source; a 6-wide red block sits on the ground rows 5..7,
    // cols 1..6.
    const src = makeSource(8, 8, (x, y) => (y >= 5 && x >= 1 && x <= 6 ? RED : CLEAR));
    const prepared = prepareView(
      [src],
      recipe(
        [
          // Tight region: baseline 8 is its bottom edge; anchor edge 2.
          frame({
            id: "a",
            region: { x: 0, y: 2, width: 4, height: 6 },
            outputWidth: 4,
            outputHeight: 6,
            sourceAnchor: { x: 2, baselineEdgeY: 8 },
            outputAnchorX: 2,
          }),
          // Wider region, same baseline edge and same anchor: the sampled
          // window shifts left by one source pixel, so figure columns land
          // one further right; surrounding source stays transparent padding.
          frame({
            id: "b",
            region: { x: 1, y: 0, width: 6, height: 8 },
            outputWidth: 6,
            outputHeight: 8,
            sourceAnchor: { x: 2, baselineEdgeY: 8 },
            outputAnchorX: 3,
            allowCropOutsideCanvas: true,
          }),
        ],
        [cels("poses", ["a", "b"])],
      ),
      PROFILE,
    );
    const [a, b] = prepared.frames;
    // Frame a: 1:1 — source rows 2..7 -> canvas rows 0..5. The region covers
    // source cols 0..3, so opaque cols 1..3 land at canvas cols 1..3 and the
    // padding rows above stay transparent.
    assert.deepEqual(Array.from(a!.mask), [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      1,
      1, // canvas row 3 <- source row 5
      0,
      1,
      1,
      1,
      0,
      1,
      1,
      1,
    ]);
    // Frame b: W_left = 2 - 3*(6/6) = -1 -> canvas col ox samples source
    // ox-1. Region covers source cols 1..6, so cols 0..1 are padding and
    // opaque source cols 5..6 are clipped off the right edge: 2 columns x
    // 3 rows = 6 opaque pixels of crop loss needing explicit approval.
    assert.deepEqual(prepared.frames[1]!.diagnostics.cropLoss.outsideCanvas, {
      opaque: 6,
      transparent: 10,
    });
    // The kept pixels land with two transparent padding columns on the left.
    assert.deepEqual(Array.from(b!.mask), [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      1,
      1,
      1, // canvas row 5 <- source row 5, cols 1..4
      0,
      0,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      1,
      1,
    ]);
  });

  it("rejects opaque content below the baseline unless explicitly approved", () => {
    // 3x4 region; baseline edge sits one row above the region bottom, so the
    // bottom source row is below the baseline. One red pixel sits there.
    const src = makeSource(3, 4, (x, y) => (y === 3 && x === 1 ? RED : CLEAR));
    const mk = (allow: boolean) =>
      recipe(
        [
          frame({
            id: "f1",
            region: { x: 0, y: 0, width: 3, height: 4 },
            outputWidth: 3,
            outputHeight: 4,
            sourceAnchor: { x: 1, baselineEdgeY: 3 },
            outputAnchorX: 1,
            allowCropBelowBaseline: allow,
          }),
        ],
        [cels("only", ["f1"])],
      );
    assert.throws(() => prepareView([src], mk(false), PROFILE), /"f1".*below baselineEdgeY/);
    const prepared = prepareView([src], mk(true), PROFILE);
    assert.deepEqual(prepared.frames[0]!.diagnostics.cropLoss.belowBaseline, {
      opaque: 1,
      transparent: 2,
    });
    // Window = rows -1..2 sampled onto 4 rows: canvas row 0 is padding, the
    // rest are the region's rows 0..2.
    assert.deepEqual(Array.from(prepared.frames[0]!.mask), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("rejects opaque content clipped outside the canvas unless approved", () => {
    // 1:1 scale: anchor edge 0 maps to canvas edge 2, pushing the window left
    // so the region's right two columns fall outside. Opaque there -> refuse.
    const src = makeSource(4, 1, (x) => (x >= 2 ? RED : CLEAR));
    const mk = (allow: boolean) =>
      recipe(
        [
          frame({
            id: "f1",
            region: { x: 0, y: 0, width: 4, height: 1 },
            outputWidth: 4,
            outputHeight: 1,
            sourceAnchor: { x: 0, baselineEdgeY: 1 },
            outputAnchorX: 2,
            allowCropOutsideCanvas: allow,
          }),
        ],
        [cels("only", ["f1"])],
      );
    assert.throws(() => prepareView([src], mk(false), PROFILE), /"f1".*outside.*canvas/i);
    const prepared = prepareView([src], mk(true), PROFILE);
    assert.equal(prepared.frames[0]!.diagnostics.cropLoss.outsideCanvas.opaque, 2);
    // Window covers source cols -2..1: only source col 1 lands on canvas
    // (col 3), and it is transparent.
    assert.deepEqual(Array.from(prepared.frames[0]!.mask), [0, 0, 0, 0]);
  });

  it("rejects a cel using all 16 EGA colours — palette remap required", () => {
    // The sixteen EGA colours exactly.
    const colours: readonly (readonly [number, number, number, number])[] = [
      [0x00, 0x00, 0x00, 0xff],
      [0x00, 0x00, 0xaa, 0xff],
      [0x00, 0xaa, 0x00, 0xff],
      [0x00, 0xaa, 0xaa, 0xff],
      [0xaa, 0x00, 0x00, 0xff],
      [0xaa, 0x00, 0xaa, 0xff],
      [0xaa, 0x55, 0x00, 0xff],
      [0xaa, 0xaa, 0xaa, 0xff],
      [0x55, 0x55, 0x55, 0xff],
      [0x55, 0x55, 0xff, 0xff],
      [0x55, 0xff, 0x55, 0xff],
      [0x55, 0xff, 0xff, 0xff],
      [0xff, 0x55, 0x55, 0xff],
      [0xff, 0x55, 0xff, 0xff],
      [0xff, 0xff, 0x55, 0xff],
      [0xff, 0xff, 0xff, 0xff],
    ];
    const src = makeSource(16, 1, (x) => colours[x]!);
    assert.throws(
      () =>
        prepareView(
          [src],
          recipe(
            [
              frame({
                id: "f1",
                region: { x: 0, y: 0, width: 16, height: 1 },
                outputWidth: 16,
                outputHeight: 1,
                sourceAnchor: { x: 8, baselineEdgeY: 1 },
                outputAnchorX: 8,
              }),
            ],
            [cels("only", ["f1"])],
          ),
          PROFILE,
        ),
      /palette remap is required/,
    );
  });

  it("encodes an approved mirror loop natively and decodes it flipped", () => {
    const prepared = prepareView(
      [SRC_2X2()],
      recipe([frame({ id: "f1" })], [cels("right", ["f1"]), mirror("left", "right")]),
      PROFILE,
    );
    // Shared data block: both loop offsets point at the same bytes.
    assert.equal(prepared.payload[5], prepared.payload[7]);
    assert.equal(prepared.payload[6], prepared.payload[8]);
    const decoded = parseView(prepared.payload, PROFILE);
    assert.deepEqual(Array.from(decoded.loops[1]!.cels[0]!.pixels), [1, 15, 0, 4]);
    assert.equal(decoded.loops[1]!.cels[0]!.mirrored, true);
  });

  it("refuses unapproved, dangling or self-referencing mirror loops", () => {
    const base = [SRC_2X2()];
    const f = frame({ id: "f1" });
    assert.throws(
      () =>
        prepareView(
          base,
          recipe(
            [f],
            [cels("right", ["f1"]), { id: "left", mirrorOf: "right", explicitlyApproved: false }],
          ),
          PROFILE,
        ),
      /explicitlyApproved/,
    );
    assert.throws(
      () =>
        prepareView(base, recipe([f], [cels("right", ["f1"]), mirror("left", "nowhere")]), PROFILE),
      /earlier loop/,
    );
    assert.throws(
      () =>
        prepareView(base, recipe([f], [mirror("left", "right"), cels("right", ["f1"])]), PROFILE),
      /earlier loop/,
    );
    // A self-mirror is a recipe refusal (RangeError), never an internal crash.
    assert.throws(
      () =>
        prepareView(
          base,
          recipe([f], [cels("right", ["f1"]), mirror("selfish", "selfish")]),
          PROFILE,
        ),
      (e: unknown) => e instanceof RangeError && /earlier loop/.test(e.message),
    );
    // Mirror-of-mirror chains are not encodable.
    assert.throws(
      () =>
        prepareView(
          base,
          recipe([f], [cels("a", ["f1"]), mirror("b", "a"), mirror("c", "b")]),
          PROFILE,
        ),
      /itself a mirror|pixel-flipped/,
    );
  });

  it("refuses a mirror the selected profile cannot represent", () => {
    const f = frame({ id: "f1" });
    // Packed profile (2.230): a mirrored loop at index 4 is unencodable.
    const packedLoops: ViewRecipeLoop[] = [
      cels("l0", ["f1"]),
      cels("l1", ["f1"]),
      cels("l2", ["f1"]),
      cels("l3", ["f1"]),
      mirror("l4", "l0"),
    ];
    assert.throws(
      () => prepareView([SRC_2X2()], recipe([f], packedLoops), PACKED),
      /pixel-flipped independent copy/,
    );
    // Same recipe under the ordinary profile is legal and decodes mirrored.
    const ok = prepareView([SRC_2X2()], recipe([f], packedLoops), PROFILE);
    const decoded = parseView(ok.payload, PROFILE);
    assert.equal(decoded.loops[4]!.cels[0]!.mirrored, true);
    // Ordinary profile parity trap: loop 8 mirrors loop 0 -> equal mod 8.
    const parity: ViewRecipeLoop[] = Array.from({ length: 8 }, (_, i) => cels(`l${i}`, ["f1"]));
    parity.push(mirror("l8", "l0"));
    assert.throws(
      () => prepareView([SRC_2X2()], recipe([f], parity), PROFILE),
      /pixel-flipped independent copy/,
    );
    // Packed profile caps a loop at 15 cels.
    const sixteen = Array.from({ length: 16 }, () => "f1");
    assert.throws(
      () => prepareView([SRC_2X2()], recipe([f], [cels("big", sixteen)]), PACKED),
      /at most 15/,
    );
  });

  it("fails oversized payloads before any raster work", () => {
    // 2 loops x 200 cels of height 168: minimum encoding per cel is
    // 3 + 168 bytes -> 400*171 = 68400 > 65535, caught statically.
    const many = Array.from({ length: 200 }, () => "f1");
    const src = makeSource(160, 168, () => CLEAR);
    const tall = frame({
      id: "f1",
      region: { x: 0, y: 0, width: 160, height: 168 },
      outputWidth: 160,
      outputHeight: 168,
      sourceAnchor: { x: 0, baselineEdgeY: 168 },
      outputAnchorX: 0,
    });
    assert.throws(
      () => prepareView([src], recipe([tall], [cels("a", many), cels("b", many)]), PROFILE),
      /65535|cannot fit|exceeds/,
    );
  });

  it("fails payloads that only the real encoding reveals as oversized", () => {
    // One 160x168 cel of alternating columns: every row needs 161 bytes.
    const src = makeSource(160, 168, (x) => (x % 2 === 0 ? WHITE : BLACK));
    const big = frame({
      id: "f1",
      region: { x: 0, y: 0, width: 160, height: 168 },
      outputWidth: 160,
      outputHeight: 168,
      sourceAnchor: { x: 0, baselineEdgeY: 168 },
      outputAnchorX: 0,
    });
    // Three such cels: 3*(3 + 168*161) ~= 81153 > 65535 at encode time.
    assert.throws(
      () => prepareView([src], recipe([big], [cels("a", ["f1", "f1", "f1"])]), PROFILE),
      /65535/,
    );
  });

  it("rejects malformed dimensions and counts before allocating", () => {
    const src = SRC_2X2();
    const f = () => frame({ id: "f1" });
    const r = (frames = [f()], loops: ViewRecipeLoop[] = [cels("only", ["f1"])], extra = {}) =>
      prepareView([src], recipe(frames, loops, extra), PROFILE);

    assert.throws(
      () => r([frame({ id: "f1", region: { x: 0, y: 0, width: 0, height: 2 } })]),
      /region\.width/,
    );
    assert.throws(
      () => r([frame({ id: "f1", region: { x: 1, y: 0, width: 2, height: 2 } })]),
      /extends past source/,
    );
    assert.throws(() => r([frame({ id: "f1", outputWidth: 0 })]), /outputWidth/);
    assert.throws(() => r([frame({ id: "f1", outputWidth: 161 })]), /outputWidth/);
    assert.throws(() => r([frame({ id: "f1", outputHeight: 169 })]), /outputHeight/);
    assert.throws(() => r([frame({ id: "f1", outputAnchorX: 3 })]), /outputAnchorX/);
    assert.throws(
      () => r([frame({ id: "f1", sourceAnchor: { x: 1.5, baselineEdgeY: 2 } })]),
      /sourceAnchor\.x/,
    );
    assert.throws(() => r([frame({ id: "f1", sample: "bilinear" })]), /sample/);
    assert.throws(() => r([f(), f()]), /duplicate frame id/);
    assert.throws(() => r([f()], []), /loops/);
    assert.throws(() => r([f()], [cels("only", [])]), /frameIds/);
    assert.throws(() => r([f()], [cels("only", ["ghost"])]), /unknown frame id/);
    assert.throws(
      () => r([f()], [{ id: "x", frameIds: ["f1"], mirrorOf: "x" } as never]),
      /exactly one of/,
    );
    assert.throws(() => r([f()], [cels("only", ["f1"])], { algorithm: "v2-hopeful" }), /algorithm/);
    assert.throws(() => r([f()], [cels("only", ["f1"])], { version: 2 }), /version/);
    assert.throws(() => r([f()], [cels("only", ["f1"])], { palette: "rgb-332" }), /palette/);
    assert.throws(
      () => r([f()], [cels("only", ["f1"])], { mask: { alphaThreshold: 1.5, key: null } }),
      /alphaThreshold/,
    );
    assert.throws(
      () => r([f()], [cels("only", ["f1"])], { mask: { alphaThreshold: -1, key: null } }),
      /alphaThreshold/,
    );
    assert.throws(
      () =>
        r([f()], [cels("only", ["f1"])], {
          mask: { alphaThreshold: 128, key: { mode: "rgb-exact", rgb: [0, 0, 0] } },
        }),
      /key\.mode/,
    );
    assert.throws(
      () =>
        r([f()], [cels("only", ["f1"])], {
          mask: { alphaThreshold: 128, key: { mode: "ega-index-v1", rgb: [0, 0, 256] } },
        }),
      /rgb/,
    );

    // Raster registry: wrong rgba length, oversized sources, count cap.
    const badLen: SourceRaster = { identity: SRC_A, width: 2, height: 2, rgba: new Uint8Array(4) };
    assert.throws(
      () => prepareView([badLen], recipe([f()], [cels("only", ["f1"])]), PROFILE),
      /rgba length/,
    );
    const tooBig: SourceRaster = {
      identity: SRC_A,
      width: 5000,
      height: 4000,
      rgba: new Uint8Array(4),
    };
    assert.throws(
      () => prepareView([tooBig], recipe([f()], [cels("only", ["f1"])]), PROFILE),
      /pixels/,
    );
    const seventeen = Array.from({ length: PREPARATION_LIMITS.maxSources + 1 }, (_, i) => ({
      identity: { id: `s${i}`, incarnation: "i", revision: 0 },
      width: 1,
      height: 1,
      rgba: new Uint8Array(4),
    }));
    assert.throws(
      () => prepareView(seventeen, recipe([f()], [cels("only", ["f1"])]), PROFILE),
      /at most 16/,
    );

    // Aggregate prepared-pixel bound: 1000 frames x 160x168 = 26.9M > 16MiP.
    const frames = Array.from({ length: 1000 }, (_, i) =>
      frame({
        id: `f${i}`,
        outputWidth: 160,
        outputHeight: 168,
        sourceAnchor: { x: 0, baselineEdgeY: 2 },
        outputAnchorX: 0,
      }),
    );
    assert.throws(() => r(frames), /canvas pixels|limit/);
  });

  it("does not mutate inputs and produces byte-identical results on repeat", () => {
    const src = SRC_2X2();
    const snapshot = src.rgba.slice();
    const build = () =>
      prepareView([src], recipe([frame({ id: "f1" })], [cels("only", ["f1"])]), PROFILE);
    const first = build();
    const bytes = first.payload.slice();
    // Mutating returned buffers must not corrupt any retained state.
    first.frames[0]!.pixels.fill(9);
    first.frames[0]!.mask.fill(0);
    first.payload.fill(0);
    const second = build();
    assert.deepEqual(Array.from(second.payload), Array.from(bytes));
    assert.deepEqual(src.rgba, snapshot);
  });

  it("separates mask loss from requested crop loss in diagnostics", () => {
    // Row 0: key-erased magenta + alpha-erased + opaque white; row 1 is below
    // the baseline edge: one opaque and one transparent pixel cropped away.
    const src = makeSource(3, 2, (x, y) =>
      y === 0 ? [MAGENTA, CLEAR, WHITE][x]! : [RED, CLEAR, CLEAR][x]!,
    );
    const prepared = prepareView(
      [src],
      recipe(
        [
          frame({
            id: "f1",
            region: { x: 0, y: 0, width: 3, height: 2 },
            outputWidth: 3,
            outputHeight: 2,
            sourceAnchor: { x: 1, baselineEdgeY: 1 },
            outputAnchorX: 1,
            allowCropBelowBaseline: true,
          }),
        ],
        [cels("only", ["f1"])],
        { mask: { alphaThreshold: 128, key: { mode: "ega-index-v1", rgb: [0xff, 0x00, 0xff] } } },
      ),
      PROFILE,
    );
    const d = prepared.frames[0]!.diagnostics;
    assert.equal(d.keyErased, 1);
    assert.equal(d.alphaErased, 1);
    assert.equal(d.opaque, 1);
    // The below-baseline row is crop loss, not mask loss.
    assert.deepEqual(d.cropLoss.belowBaseline, { opaque: 1, transparent: 2 });
    assert.equal(d.cropLoss.outsideCanvas.opaque, 0);
  });
});
