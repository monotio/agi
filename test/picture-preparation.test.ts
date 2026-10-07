import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RASTER_FORMAT,
  type CreativeRecipe,
  type PicturePreparation,
  type RasterRef,
  type Rect,
} from "../src/creative/catalog.ts";
import { sha256Hex } from "../src/crypto.ts";
import {
  derivePicturePlacement,
  PICTURE_UNDERLAY_ALGORITHM,
  preparePictureUnderlay,
  type PictureAspect,
  type PictureFit,
  type PicturePlacementRequest,
  type PreparedPictureUnderlay,
} from "../src/picture/preparation.ts";
import type { SourceIdentity, SourceRaster } from "../src/view/preparation.ts";

/**
 * Hand-labelled RGBA cells. The underlay keeps canonical pixels verbatim —
 * colour and alpha — so expectations are the source tuples themselves.
 */
const WHITE = [0xff, 0xff, 0xff, 0xff] as const;
const RED = [0xff, 0x00, 0x00, 0xff] as const;
const BLACK = [0x00, 0x00, 0x00, 0xff] as const;
const BLUE = [0x00, 0x00, 0xff, 0xff] as const;
const MAGENTA = [0xff, 0x00, 0xff, 0xff] as const;
const GREEN = [0x00, 0xff, 0x00, 0xff] as const;
/** Fully transparent but tinted: alpha is carried, never overwritten. */
const CLEAR = [0x12, 0x34, 0x56, 0x00] as const;
/** Alpha 127: below the default threshold yet still carried verbatim. */
const FAINT = [0x20, 0x40, 0x60, 0x7f] as const;

const SRC_A: SourceIdentity = { id: "photo-a", incarnation: "inc-1", revision: 3 };
const RECIPE_A = { id: "recipe-1", incarnation: "inc-1", revision: 0 };

function makeSource(
  width: number,
  height: number,
  paint: (x: number, y: number) => readonly [number, number, number, number],
  identity: SourceIdentity = SRC_A,
): SourceRaster {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rgba.set(paint(x, y), (y * width + x) * 4);
  return { identity, width, height, rgba };
}

/** The four bytes of one logical cell of a prepared underlay. */
function cellAt(underlay: PreparedPictureUnderlay, x: number, y: number): number[] {
  return Array.from(
    underlay.rgba.slice((y * underlay.width + x) * 4, (y * underlay.width + x) * 4 + 4),
  );
}

/** Every cell outside `rect` is transparent. */
function assertClearOutside(underlay: PreparedPictureUnderlay, rect: Rect): void {
  for (let y = 0; y < underlay.height; y++)
    for (let x = 0; x < underlay.width; x++) {
      const inside =
        x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
      if (!inside) assert.deepEqual(cellAt(underlay, x, y), [0, 0, 0, 0]);
    }
}

function preparation(partial: Partial<PicturePreparation> = {}): PicturePreparation {
  return {
    kind: "picture-underlay",
    source: SRC_A,
    crop: { x: 0, y: 0, width: 2, height: 2 },
    destination: { x: 0, y: 0, width: 2, height: 2 },
    fit: "stretch",
    intendedAspect: "native",
    sample: "nearest-centre-v1",
    opacity: 1,
    palette: "ega-weighted-243-v1",
    alpha: { threshold: 128, matte: 0 },
    scope: "art",
    ...partial,
  };
}

function recipe(prep: PicturePreparation = preparation()): CreativeRecipe {
  return {
    format: "agi.preparation",
    version: 1,
    identity: RECIPE_A,
    sources: [prep.source],
    algorithm: PICTURE_UNDERLAY_ALGORITHM,
    preparation: prep,
    destination: { kind: "picture", resourceId: 7 },
  };
}

/** 2x2 source: white/clear on top, red/black below. */
const SRC_2X2 = () => makeSource(2, 2, (x, y) => [WHITE, CLEAR, RED, BLACK][y * 2 + x]!);

describe("preparePictureUnderlay", () => {
  it("prepares a crop 1:1 into the detached 160x168 canvas", () => {
    const prepared = preparePictureUnderlay(
      SRC_2X2(),
      recipe(
        preparation({
          crop: { x: 0, y: 0, width: 2, height: 2 },
          destination: { x: 5, y: 7, width: 2, height: 2 },
        }),
      ),
    );
    assert.equal(prepared.width, 160);
    assert.equal(prepared.height, 168);
    assert.equal(prepared.rgba.length, 160 * 168 * 4);
    assert.equal(prepared.algorithm, PICTURE_UNDERLAY_ALGORITHM);
    assert.deepEqual(cellAt(prepared, 5, 7), [...WHITE]);
    // The transparent source pixel arrives verbatim, tinted rgb included.
    assert.deepEqual(cellAt(prepared, 6, 7), [...CLEAR]);
    assert.deepEqual(cellAt(prepared, 5, 8), [...RED]);
    assert.deepEqual(cellAt(prepared, 6, 8), [...BLACK]);
    assertClearOutside(prepared, { x: 5, y: 7, width: 2, height: 2 });
    assert.deepEqual(prepared.diagnostics, {
      limits: {
        maxDecodedSide: 8192,
        maxDecodedPixels: 16 * 1024 * 1024,
        pictureWidth: 160,
        pictureHeight: 168,
      },
      source: { width: 2, height: 2 },
      alpha: { threshold: 128, matte: 0 },
      cropPixels: 4,
      destinationPixels: 4,
      canvasPixels: 160 * 168,
      belowThreshold: 1,
    });
    assert.deepEqual(prepared.crop, { x: 0, y: 0, width: 2, height: 2 });
    assert.deepEqual(prepared.destination, { x: 5, y: 7, width: 2, height: 2 });
    assert.deepEqual(prepared.source, SRC_A);
    assert.deepEqual(prepared.recipe, RECIPE_A);
  });

  it("honours a crop offset into a larger source", () => {
    const rows = [
      [WHITE, RED, BLACK],
      [BLUE, MAGENTA, GREEN],
    ];
    const src = makeSource(3, 2, (x, y) => rows[y]![x]!);
    const prepared = preparePictureUnderlay(
      src,
      recipe(
        preparation({
          crop: { x: 1, y: 0, width: 2, height: 2 },
          destination: { x: 0, y: 0, width: 2, height: 2 },
        }),
      ),
    );
    assert.deepEqual(cellAt(prepared, 0, 0), [...RED]);
    assert.deepEqual(cellAt(prepared, 1, 0), [...BLACK]);
    assert.deepEqual(cellAt(prepared, 0, 1), [...MAGENTA]);
    assert.deepEqual(cellAt(prepared, 1, 1), [...GREEN]);
    assertClearOutside(prepared, { x: 0, y: 0, width: 2, height: 2 });
  });

  it("upsamples nearest-centre: a 2x2 crop on a 4x2 destination doubles columns", () => {
    const prepared = preparePictureUnderlay(
      SRC_2X2(),
      recipe(preparation({ destination: { x: 0, y: 0, width: 4, height: 2 } })),
    );
    // u -> floor((u + 0.5) * 2 / 4): 0,0,1,1; v -> floor((v + 0.5) * 2 / 2): 0,1.
    for (const [x, want] of [
      [0, WHITE],
      [1, WHITE],
      [2, CLEAR],
      [3, CLEAR],
    ] as const)
      assert.deepEqual(cellAt(prepared, x, 0), [...want]);
    for (const [x, want] of [
      [0, RED],
      [1, RED],
      [2, BLACK],
      [3, BLACK],
    ] as const)
      assert.deepEqual(cellAt(prepared, x, 1), [...want]);
  });

  it("downsamples nearest-centre: 3x1 -> 2x1 picks source columns 0 and 2", () => {
    const src = makeSource(3, 1, (x) => [WHITE, RED, BLACK][x]!);
    const prepared = preparePictureUnderlay(
      src,
      recipe(
        preparation({
          crop: { x: 0, y: 0, width: 3, height: 1 },
          destination: { x: 0, y: 0, width: 2, height: 1 },
        }),
      ),
    );
    // u 0 -> floor(0.5 * 3 / 2) = 0; u 1 -> floor(1.5 * 3 / 2) = 2.
    assert.deepEqual(cellAt(prepared, 0, 0), [...WHITE]);
    assert.deepEqual(cellAt(prepared, 1, 0), [...BLACK]);
  });

  it("downsamples nearest-centre: 4x2 -> 2x1 picks (1,3) of row 1", () => {
    const rows = [
      [WHITE, RED, BLACK, WHITE],
      [BLUE, MAGENTA, RED, GREEN],
    ];
    const src = makeSource(4, 2, (x, y) => rows[y]![x]!);
    const prepared = preparePictureUnderlay(
      src,
      recipe(
        preparation({
          crop: { x: 0, y: 0, width: 4, height: 2 },
          destination: { x: 0, y: 0, width: 2, height: 1 },
        }),
      ),
    );
    // v 0 -> floor(0.5 * 2 / 1) = 1; u -> 1, 3.
    assert.deepEqual(cellAt(prepared, 0, 0), [...MAGENTA]);
    assert.deepEqual(cellAt(prepared, 1, 0), [...GREEN]);
  });

  it("carries alpha verbatim and reports opacity without baking it", () => {
    const src = makeSource(2, 1, (x) => [FAINT, CLEAR][x]!);
    const prep = preparation({
      crop: { x: 0, y: 0, width: 2, height: 1 },
      destination: { x: 0, y: 0, width: 2, height: 1 },
      opacity: 0.35,
    });
    const prepared = preparePictureUnderlay(src, recipe(prep));
    assert.deepEqual(cellAt(prepared, 0, 0), [...FAINT]);
    assert.deepEqual(cellAt(prepared, 1, 0), [...CLEAR]);
    assert.equal(prepared.opacity, 0.35);
    assert.equal(prepared.diagnostics.belowThreshold, 2);

    // Opacity is a display hint only: a different value renders identical bytes.
    const opaqueRun = preparePictureUnderlay(src, recipe({ ...prep, opacity: 1 }));
    assert.deepEqual(Array.from(opaqueRun.rgba), Array.from(prepared.rgba));
    assert.equal(opaqueRun.opacity, 1);
  });

  it("renders identical bytes whatever fit/intendedAspect the recipe records", () => {
    const src = SRC_2X2();
    const dest = { x: 4, y: 4, width: 8, height: 4 };
    const base = preparePictureUnderlay(
      src,
      recipe(preparation({ crop: { x: 0, y: 0, width: 2, height: 2 }, destination: dest })),
    );
    // A later presentation change edits the recipe's recorded provenance, not
    // its geometry: the frozen rectangles still render exactly the same.
    const restated = preparePictureUnderlay(
      src,
      recipe(
        preparation({
          crop: { x: 0, y: 0, width: 2, height: 2 },
          destination: dest,
          fit: "contain",
          intendedAspect: "original-4:3",
          opacity: 0.5,
        }),
      ),
    );
    assert.deepEqual(Array.from(restated.rgba), Array.from(base.rgba));
    assert.equal(restated.fit, "contain");
    assert.equal(restated.intendedAspect, "original-4:3");
  });

  it("refuses a stale or mismatched source identity", () => {
    const src = SRC_2X2();
    assert.throws(
      () => preparePictureUnderlay(src, recipe(preparation({ source: { ...SRC_A, revision: 4 } }))),
      /stale|does not match/,
    );
    assert.throws(
      () =>
        preparePictureUnderlay({ ...src, identity: { ...SRC_A, incarnation: "other" } }, recipe()),
      /does not match|stale/,
    );
    // Declared in recipe.sources but never matching the supplied raster.
    const missing = { id: "missing", incarnation: "inc-1", revision: 0 };
    assert.throws(
      () =>
        preparePictureUnderlay(src, {
          ...recipe(preparation({ source: missing })),
          sources: [missing],
        }),
      /does not match|stale/,
    );
  });

  it("refuses unsupported formats, versions, algorithms and kinds", () => {
    const src = SRC_2X2();
    const r = recipe();
    assert.throws(
      () => preparePictureUnderlay(src, { ...r, format: "agi.other" as never }),
      /format/,
    );
    assert.throws(() => preparePictureUnderlay(src, { ...r, version: 2 as never }), /version/);
    assert.throws(
      () => preparePictureUnderlay(src, { ...r, algorithm: "auto-vectorize-v9" }),
      /algorithm/,
    );
    assert.throws(
      () =>
        preparePictureUnderlay(
          src,
          recipe({ ...preparation(), kind: "picture-v3" as PicturePreparation["kind"] }),
        ),
      /kind/,
    );
    // The conversion kind is real but belongs to the deferred experiment.
    assert.throws(
      () => preparePictureUnderlay(src, recipe(preparation({ kind: "picture-conversion" }))),
      /picture-underlay|conversion/,
    );
    // A valid view recipe is still not a picture underlay.
    const viewRecipe: CreativeRecipe = {
      ...r,
      preparation: {
        format: "agi.preparation",
        version: 1,
        kind: "view",
        algorithm: "manual-view-preparation-v1",
        sources: [SRC_A],
        palette: "ega-weighted-243-v1",
        mask: { alphaThreshold: 128, key: null },
        frames: [
          {
            id: "f1",
            source: SRC_A,
            region: { x: 0, y: 0, width: 1, height: 1 },
            outputWidth: 1,
            outputHeight: 1,
            sourceAnchor: { x: 0, baselineEdgeY: 1 },
            outputAnchorX: 0,
            sample: "nearest-centre-v1",
            allowCropBelowBaseline: false,
            allowCropOutsideCanvas: false,
          },
        ],
        loops: [{ id: "only", frameIds: ["f1"] }],
      },
      destination: { kind: "view", resourceId: 1 },
    };
    assert.throws(() => preparePictureUnderlay(src, viewRecipe), /picture-underlay/);
  });

  it("rejects malformed geometry and nonfinite values before allocation", () => {
    const src = SRC_2X2();
    const p = (partial: Partial<PicturePreparation>) => () =>
      preparePictureUnderlay(src, recipe(preparation(partial)));

    assert.throws(p({ crop: { x: 1, y: 0, width: 2, height: 2 } }), /extends past source/);
    assert.throws(p({ crop: { x: 0, y: 0, width: 0, height: 2 } }), /crop.*width/);
    assert.throws(p({ crop: { x: 0.5, y: 0, width: 2, height: 2 } }), /crop.*x/);
    assert.throws(p({ crop: { x: -1, y: 0, width: 2, height: 2 } }), /crop/);
    assert.throws(p({ destination: { x: 159, y: 0, width: 2, height: 1 } }), /destination/);
    assert.throws(p({ destination: { x: 0, y: 167, width: 1, height: 2 } }), /destination/);
    assert.throws(p({ destination: { x: 0, y: 0, width: 1.5, height: 1 } }), /destination/);
    assert.throws(p({ opacity: Number.NaN }), /opacity/);
    assert.throws(p({ opacity: -0.1 }), /opacity/);
    assert.throws(p({ opacity: 1.01 }), /opacity/);
    assert.throws(p({ opacity: Number.POSITIVE_INFINITY }), /opacity/);
    // The underlay never quantizes, but the contract fields still validate.
    assert.throws(p({ alpha: { threshold: 256, matte: 0 } }), /threshold/);
    assert.throws(p({ alpha: { threshold: 1.5, matte: 0 } }), /threshold/);
    assert.throws(p({ alpha: { threshold: 128, matte: 16 } }), /matte/);
    assert.throws(p({ alpha: { threshold: 128, matte: -1 } }), /matte/);
    assert.throws(p({ sample: "bilinear" as never }), /sample/);
    assert.throws(p({ palette: "rgb-332" as never }), /palette/);
    assert.throws(p({ scope: "art+walk" as never }), /scope/);
    assert.throws(p({ fit: "squish" as never }), /fit/);
    assert.throws(p({ intendedAspect: "screen-4:3" as never }), /intendedAspect/);
  });

  it("rejects malformed, oversized or wrongly-sized rasters", () => {
    const r = recipe();
    assert.throws(() => preparePictureUnderlay(null as unknown as SourceRaster, r), /raster/);
    assert.throws(
      () =>
        preparePictureUnderlay(
          { identity: SRC_A, width: 2, height: 2, rgba: new Uint8Array(4) },
          r,
        ),
      /rgba length/,
    );
    assert.throws(
      () =>
        preparePictureUnderlay(
          {
            identity: SRC_A,
            width: 2,
            height: 2,
            rgba: [1, 2, 3] as unknown as Uint8Array,
          },
          r,
        ),
      /rgba/,
    );
    assert.throws(
      () =>
        preparePictureUnderlay(
          { identity: SRC_A, width: 8193, height: 1, rgba: new Uint8Array(4) },
          r,
        ),
      /width/,
    );
    // 4096 x 4097 exceeds the 16 MiP decoded cap before the byte length check.
    assert.throws(
      () =>
        preparePictureUnderlay(
          { identity: SRC_A, width: 4096, height: 4097, rgba: new Uint8Array(4) },
          r,
        ),
      /pixels/,
    );
  });

  it("verifies supplied raster descriptors, including hash and byte length", () => {
    const src = SRC_2X2();
    const descriptor: RasterRef = {
      format: RASTER_FORMAT,
      width: 2,
      height: 2,
      blob: {
        hash: sha256Hex(src.rgba as Uint8Array),
        byteLength: 16,
        mime: "application/x-rgba8",
      },
    };
    const prepared = preparePictureUnderlay(src, recipe(), descriptor);
    assert.equal(prepared.diagnostics.cropPixels, 4);

    assert.throws(
      () =>
        preparePictureUnderlay(src, recipe(), {
          ...descriptor,
          blob: { ...descriptor.blob, hash: "0".repeat(64) },
        }),
      /hash/,
    );
    assert.throws(
      () =>
        preparePictureUnderlay(src, recipe(), {
          ...descriptor,
          blob: { ...descriptor.blob, byteLength: 15 },
        }),
      /byteLength/,
    );
    assert.throws(
      () => preparePictureUnderlay(src, recipe(), { ...descriptor, width: 3 }),
      /does not match raster/,
    );
    assert.throws(
      () =>
        preparePictureUnderlay(src, recipe(), {
          ...descriptor,
          format: "rgba8-premultiplied",
        } as unknown as RasterRef),
      /format/,
    );

    // A clamped-array raster is canonical too, and hashes the same bytes.
    const clamped = new Uint8Array(src.rgba);
    const clampedRaster: SourceRaster = { ...src, rgba: new Uint8ClampedArray(clamped) };
    const fromClamped = preparePictureUnderlay(clampedRaster, recipe(), {
      format: RASTER_FORMAT,
      width: 2,
      height: 2,
      blob: {
        hash: sha256Hex(clamped),
        byteLength: 16,
        mime: "application/x-rgba8",
      },
    });
    assert.deepEqual(Array.from(fromClamped.rgba), Array.from(prepared.rgba));
    assert.deepEqual(cellAt(fromClamped, 1, 0), [...CLEAR]);
  });

  it("does not mutate inputs and returns detached, deterministic output", () => {
    const src = SRC_2X2();
    const pixels = src.rgba.slice();
    const r = recipe();
    const before = JSON.stringify(r);
    const first = preparePictureUnderlay(src, r);
    const bytes = first.rgba.slice();
    first.rgba.fill(7);
    (first.crop as { x: number }).x = 99;
    const second = preparePictureUnderlay(src, r);
    assert.deepEqual(Array.from(second.rgba), Array.from(bytes));
    assert.deepEqual(src.rgba, pixels);
    assert.equal(JSON.stringify(r), before);
    assert.notEqual(second.rgba, src.rgba);
  });

  it("fills the whole 160x168 canvas when the destination does", () => {
    const src = makeSource(160, 168, (x, y) => (x === y ? RED : CLEAR));
    const prepared = preparePictureUnderlay(
      src,
      recipe(
        preparation({
          crop: { x: 0, y: 0, width: 160, height: 168 },
          destination: { x: 0, y: 0, width: 160, height: 168 },
        }),
      ),
    );
    // 1:1 mapping keeps the diagonal exactly.
    assert.deepEqual(cellAt(prepared, 42, 42), [...RED]);
    assert.deepEqual(cellAt(prepared, 42, 43), [...CLEAR]);
    assert.equal(prepared.diagnostics.belowThreshold, 160 * 168 - 160);
  });
});

describe("derivePicturePlacement", () => {
  const full = { x: 0, y: 0, width: 160, height: 168 };

  it("stores stretch rectangles verbatim", () => {
    const placement = derivePicturePlacement({
      sourceWidth: 6,
      sourceHeight: 4,
      crop: { x: 1, y: 1, width: 3, height: 2 },
      bounds: { x: 10, y: 20, width: 40, height: 30 },
      fit: "stretch",
      intendedAspect: "native",
    });
    assert.deepEqual(placement, {
      crop: { x: 1, y: 1, width: 3, height: 2 },
      destination: { x: 10, y: 20, width: 40, height: 30 },
    });
  });

  it("contains a 2:1 crop in the full band under native aspect", () => {
    // Crop 4x2 (aspect 2): cell aspect target is 1; width limits at 160, so
    // dh = 160 and the 8 spare rows pad 4 above and 4 below.
    const placement = derivePicturePlacement({
      sourceWidth: 4,
      sourceHeight: 2,
      crop: { x: 0, y: 0, width: 4, height: 2 },
      bounds: full,
      fit: "contain",
      intendedAspect: "native",
    });
    assert.deepEqual(placement, {
      crop: { x: 0, y: 0, width: 4, height: 2 },
      destination: { x: 0, y: 4, width: 160, height: 160 },
    });
  });

  it("places the same square crop differently under each captured aspect", () => {
    const request = (intendedAspect: PictureAspect) =>
      derivePicturePlacement({
        sourceWidth: 4,
        sourceHeight: 4,
        crop: { x: 0, y: 0, width: 4, height: 4 },
        bounds: full,
        fit: "contain",
        intendedAspect,
      });
    // Native cell 2:1 -> target cell aspect 1/2 -> dw = round(168 * 1/2) = 84.
    assert.deepEqual(request("native").destination, { x: 38, y: 0, width: 84, height: 168 });
    // Original cell 5:3 -> target 3/5 -> dw = round(168 * 3/5) = 101 (100.8).
    assert.deepEqual(request("original-4:3").destination, {
      x: 29,
      y: 0,
      width: 101,
      height: 168,
    });
  });

  it("centres a contained placement inside offset bounds", () => {
    // Square crop, native: dw = round(40 * 1/2) = 20, centred in 40 wide.
    const placement = derivePicturePlacement({
      sourceWidth: 4,
      sourceHeight: 4,
      crop: { x: 0, y: 0, width: 4, height: 4 },
      bounds: { x: 10, y: 20, width: 40, height: 40 },
      fit: "contain",
      intendedAspect: "native",
    });
    assert.deepEqual(placement.destination, { x: 20, y: 20, width: 20, height: 40 });
  });

  it("covers by centring a trimmed crop, native and original-4:3", () => {
    // 8x2 crop (aspect 4) over 320x168 display (40/21): keeps height, trims
    // width to round(2 * 40/21) = round(3.81) = 4 -> source cols 2..5.
    const native = derivePicturePlacement({
      sourceWidth: 8,
      sourceHeight: 2,
      crop: { x: 0, y: 0, width: 8, height: 2 },
      bounds: full,
      fit: "cover",
      intendedAspect: "native",
    });
    assert.deepEqual(native, {
      crop: { x: 2, y: 0, width: 4, height: 2 },
      destination: full,
    });
    // 6x2 crop under 5:3 cells: target source aspect 100/63, trims width to
    // round(2 * 100/63) = round(3.17) = 3 -> source cols 1..3 (odd cell left).
    const original = derivePicturePlacement({
      sourceWidth: 6,
      sourceHeight: 2,
      crop: { x: 0, y: 0, width: 6, height: 2 },
      bounds: full,
      fit: "cover",
      intendedAspect: "original-4:3",
    });
    assert.deepEqual(original, {
      crop: { x: 1, y: 0, width: 3, height: 2 },
      destination: full,
    });
    // 2x8 crop (aspect 0.25) under native: keeps width, trims height to
    // round(2 * 21/40) = round(1.05) = 1 -> source rows 3..3.
    const tall = derivePicturePlacement({
      sourceWidth: 2,
      sourceHeight: 8,
      crop: { x: 0, y: 0, width: 2, height: 8 },
      bounds: full,
      fit: "cover",
      intendedAspect: "native",
    });
    assert.deepEqual(tall, {
      crop: { x: 0, y: 3, width: 2, height: 1 },
      destination: full,
    });
  });

  it("rounds the fitted dimension to the nearest cell, halves toward +1", () => {
    // 3x8 crop native: cell aspect 3/16; height limits -> round(168*3/16)
    // = round(31.5) = 32, centred with 64 padding each side.
    const placement = derivePicturePlacement({
      sourceWidth: 3,
      sourceHeight: 8,
      crop: { x: 0, y: 0, width: 3, height: 8 },
      bounds: full,
      fit: "contain",
      intendedAspect: "native",
    });
    assert.deepEqual(placement.destination, { x: 64, y: 0, width: 32, height: 168 });
  });

  it("never lets a rounded dimension collapse below one cell", () => {
    // 1x8000 crop native: cell aspect 1/16000 -> round(168/16000) = 0 -> 1.
    const placement = derivePicturePlacement({
      sourceWidth: 1,
      sourceHeight: 8000,
      crop: { x: 0, y: 0, width: 1, height: 8000 },
      bounds: full,
      fit: "contain",
      intendedAspect: "native",
    });
    assert.deepEqual(placement.destination, { x: 79, y: 0, width: 1, height: 168 });
  });

  it("rejects malformed placement requests before returning geometry", () => {
    const base: PicturePlacementRequest = {
      sourceWidth: 4,
      sourceHeight: 4,
      crop: { x: 0, y: 0, width: 2, height: 2 },
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      fit: "contain" satisfies PictureFit,
      intendedAspect: "native",
    };
    assert.throws(() => derivePicturePlacement({ ...base, sourceWidth: 0 }), /sourceWidth/);
    assert.throws(() => derivePicturePlacement({ ...base, sourceWidth: 4.5 }), /sourceWidth/);
    assert.throws(
      () => derivePicturePlacement({ ...base, crop: { x: 3, y: 0, width: 2, height: 2 } }),
      /extends past source/,
    );
    assert.throws(
      () => derivePicturePlacement({ ...base, crop: { x: 0, y: 0, width: 0, height: 2 } }),
      /width/,
    );
    assert.throws(
      () =>
        derivePicturePlacement({
          ...base,
          bounds: { x: 0, y: 0, width: 161, height: 10 },
        }),
      /bounds/,
    );
    assert.throws(() => derivePicturePlacement({ ...base, fit: "squish" as never }), /fit/);
    assert.throws(
      () => derivePicturePlacement({ ...base, intendedAspect: "screen-4:3" as never }),
      /intendedAspect/,
    );
  });

  it("produces geometry the preparation renders verbatim", () => {
    // The derived rectangles are what the recipe stores; rendering them uses
    // nearest-centre exactly, so the source appears centred in the band.
    const src = makeSource(4, 4, () => RED);
    const placement = derivePicturePlacement({
      sourceWidth: 4,
      sourceHeight: 4,
      crop: { x: 0, y: 0, width: 4, height: 4 },
      bounds: full,
      fit: "contain",
      intendedAspect: "native",
    });
    const prepared = preparePictureUnderlay(
      src,
      recipe(
        preparation({
          crop: placement.crop,
          destination: placement.destination,
          fit: "contain",
          intendedAspect: "native",
        }),
      ),
    );
    assert.deepEqual(cellAt(prepared, 84, 0), [...RED]);
    assert.deepEqual(cellAt(prepared, 121, 167), [...RED]);
    assertClearOutside(prepared, placement.destination);
  });
});
