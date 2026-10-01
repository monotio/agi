import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyCreativeCatalog,
  readCreativePreparation,
  writeCreativeBlobRecord,
  writeCreativeCatalogRecord,
} from "../src/creative/catalog.ts";
import { sha256Hex } from "../src/crypto.ts";

test("catalog writer detaches lease and hold records from caller ownership", () => {
  const hash = sha256Hex(Uint8Array.of(1, 2, 3, 4));
  const catalog = {
    ...emptyCreativeCatalog("ownership"),
    blobs: { [hash]: { hash, byteLength: 4, mime: "image/png", buckets: ["original" as const] } },
    leases: [
      {
        id: "lease",
        owner: "editor",
        workspace: "work",
        expiresAt: 100,
        staged: { sources: [], derivatives: [], recipes: [], blobs: [] },
      },
    ],
    holds: [{ id: "hold", kind: "recovery" as const, hashes: [hash] }],
  };
  const written = writeCreativeCatalogRecord(catalog);
  const before = structuredClone(written);
  catalog.leases[0]!.owner = "changed";
  catalog.holds[0]!.hashes.push("b".repeat(64));
  assert.deepEqual(written, before);
});

test("blob writer captures bytes before its result can be persisted asynchronously", () => {
  const bytes = Uint8Array.of(1, 2, 3, 4);
  const written = writeCreativeBlobRecord(
    "ownership",
    {
      hash: sha256Hex(bytes),
      byteLength: 4,
      mime: "image/png",
    },
    bytes,
  );
  bytes[0] = 99;
  assert.deepEqual(written["bytes"], Uint8Array.of(1, 2, 3, 4));
});

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
