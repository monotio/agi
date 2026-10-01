import assert from "node:assert/strict";
import { test } from "node:test";
import { readCreativePreparation } from "../src/creative/catalog.ts";

test("a captured View preparation owns its loop frame selection", () => {
  const identity = { id: "drawing", incarnation: "original", revision: 0 };
  const offered = {
    format: "agi.preparation",
    version: 1,
    kind: "view",
    algorithm: "manual-view-preparation-v1",
    sources: [identity],
    palette: "ega-weighted-243-v1",
    mask: { alphaThreshold: 128, key: null },
    frames: [
      {
        id: "one",
        source: identity,
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
    loops: [{ id: "front", frameIds: ["one"] }],
  };
  const captured = readCreativePreparation(offered);
  offered.loops[0]!.frameIds[0] = "missing";
  assert.equal(captured.kind, "view");
  if (captured.kind !== "view") throw new Error("Expected a View preparation.");
  const loop = captured.loops[0]!;
  if (!("frameIds" in loop)) throw new Error("Expected a direct loop.");
  assert.deepEqual(loop.frameIds, ["one"]);
});
