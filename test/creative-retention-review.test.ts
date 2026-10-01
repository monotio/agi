import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyCreativeCatalog,
  retainedCreativeUsage,
  type CreativeSource,
} from "../src/creative/catalog.ts";

function source(id: string, revision: number): CreativeSource {
  return {
    format: "agi.creative-source",
    version: 1,
    identity: { id, incarnation: "original", revision },
    encoded: { hash: "a".repeat(64), byteLength: 1, mime: "image/png" },
    availability: "original",
    normalized: {
      blob: { hash: "b".repeat(64), byteLength: 4, mime: "application/x-rgba8" },
      format: "rgba8-srgb-unpremultiplied-v1",
      width: 1,
      height: 1,
    },
    origin: { kind: "import", title: id },
  };
}

test("revising one of sixteen sources retains sixteen logical assets", () => {
  const catalog = {
    ...emptyCreativeCatalog("retention"),
    sources: Array.from({ length: 16 }, (_, i) => source(`source-${i}`, 0)),
    leases: [
      {
        id: "revision",
        owner: "editor",
        workspace: "work",
        expiresAt: 100,
        staged: { sources: [source("source-0", 1)], derivatives: [], recipes: [], blobs: [] },
      },
    ],
  };
  const usage = retainedCreativeUsage(catalog, 1);
  assert.equal(usage.sources, 16);
  assert.equal(usage.originals, 1);
  assert.equal(usage.canonical, 4);
});

test("a canonical raster held for undo keeps its own byte budget after its source was removed", () => {
  const hash = "c".repeat(64);
  const catalog = {
    ...emptyCreativeCatalog("retention"),
    blobs: {
      [hash]: {
        hash,
        byteLength: 64 * 1024 * 1024,
        mime: "application/octet-stream",
        buckets: ["canonical" as const],
      },
    },
    holds: [{ id: "undo", kind: "retained-undo" as const, hashes: [hash] }],
  };
  assert.deepEqual(retainedCreativeUsage(catalog, 1), {
    sources: 0,
    originals: 0,
    canonical: 64 * 1024 * 1024,
    disposable: 0,
  });
});
