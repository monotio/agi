import assert from "node:assert/strict";
import { test } from "node:test";
import { PROFILES } from "../src/runtime/profile.ts";
import { parseView } from "../src/view/view.ts";
import {
  prepareView,
  PREPARATION_LIMITS,
  VIEW_PREPARATION_ALGORITHM,
  type ViewPreparationRecipe,
} from "../src/view/preparation.ts";

function prepare(alphaThreshold: number, loops?: ViewPreparationRecipe["loops"]) {
  const identity = { id: "drawing", incarnation: "source-one", revision: 1 };
  const recipe: ViewPreparationRecipe = {
    format: "agi.preparation",
    version: 1,
    kind: "view",
    algorithm: VIEW_PREPARATION_ALGORITHM,
    sources: [identity],
    palette: "ega-weighted-243-v1",
    mask: { alphaThreshold, key: null },
    frames: [
      {
        id: "one",
        source: identity,
        region: { x: 0, y: 0, width: 1, height: 1 },
        outputWidth: 2,
        outputHeight: 1,
        sourceAnchor: { x: 0, baselineEdgeY: 1 },
        outputAnchorX: 1,
        sample: "nearest-centre-v1",
        allowCropBelowBaseline: false,
        allowCropOutsideCanvas: false,
      },
    ],
    loops: loops ?? [{ id: "front", frameIds: ["one"] }],
  };
  return prepareView(
    [{ identity, width: 1, height: 1, rgba: Uint8Array.of(170, 0, 0, 255) }],
    recipe,
    PROFILES["2.936"],
  );
}

test("anchor padding stays transparent even when all source alpha values are admitted", () => {
  // A half-source-pixel left padding maps to the first output pixel. It is
  // outside the source, so alpha threshold zero cannot turn it into black art.
  const prepared = prepare(0);
  assert.deepEqual([...prepared.frames[0]!.mask], [0, 1]);
  assert.equal(prepared.frames[0]!.pixels[1], 4);
  const cel = parseView(prepared.payload, PROFILES["2.936"]).loops[0]!.cels[0]!;
  assert.deepEqual([...cel.pixels], [cel.transparentColor, 4]);
});

test("editing displayed preparation limits cannot change future admission policy", () => {
  const prepared = prepare(128);
  const before = PREPARATION_LIMITS.maxSources;
  try {
    Reflect.set(prepared.diagnostics.limits, "maxSources", before + 100);
    assert.equal(PREPARATION_LIMITS.maxSources, before);
  } finally {
    Reflect.set(PREPARATION_LIMITS, "maxSources", before);
  }
});

test("a self-mirror is refused as an invalid recipe, not an internal crash", () => {
  assert.throws(
    () =>
      prepare(128, [
        { id: "front", frameIds: ["one"] },
        { id: "self", mirrorOf: "self", explicitlyApproved: true },
      ]),
    /must name an earlier loop/,
  );
});

test("exported preparation limits cannot be edited to bypass admission policy", () => {
  const before = PREPARATION_LIMITS.maxSources;
  try {
    Reflect.set(PREPARATION_LIMITS, "maxSources", before + 100);
    assert.equal(PREPARATION_LIMITS.maxSources, before);
  } finally {
    Reflect.set(PREPARATION_LIMITS, "maxSources", before);
  }
});
