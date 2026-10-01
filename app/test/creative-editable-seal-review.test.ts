import assert from "node:assert/strict";
import { test } from "node:test";
import { CREATIVE_SOURCE_FORMAT, type CreativeSource } from "../../src/creative/catalog.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { resolveWorkspaceCreativeKeep } from "../src/project/creativeWorkspaceKeep.ts";
import { openEditableProject } from "../src/project/editableProject.ts";
import { loadCreativeCatalog, stageCreativeBlobs } from "../src/project/creativeStore.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => {
      cache.set(key, value);
    },
    removeItem: (key: string) => cache.delete(key),
  },
});

test("reading a resolved creative request cannot rewrite the candidate's sealed Keep intent", async () => {
  const prepared = prepareLocalProject({ title: "Sealed inspiration", kind: "blank" });
  await prepared.save();
  const workspace = await openEditableProject(prepared.projectId);
  const encoded = encodePngRgb(1, 1, Uint8Array.of(255, 0, 0));
  const raster = Uint8Array.of(255, 0, 0, 255);
  const source: CreativeSource = {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: { id: "reference", incarnation: "original", revision: 0 },
    encoded: { hash: sha256Hex(encoded), byteLength: encoded.length, mime: "image/png" },
    availability: "original",
    normalized: {
      format: "rgba8-srgb-unpremultiplied-v1",
      width: 1,
      height: 1,
      blob: { hash: sha256Hex(raster), byteLength: raster.length, mime: "application/x-rgba8" },
    },
    origin: { kind: "import", title: "Red drawing" },
  };
  await stageCreativeBlobs({
    projectId: workspace.projectId,
    expectedHead: 0,
    lease: { id: "art", owner: "editor", workspace: workspace.workspaceId },
    staged: { sources: [source] },
    blobs: [
      { hash: sha256Hex(encoded), mime: "image/png", bytes: encoded },
      { hash: sha256Hex(raster), mime: "application/x-rgba8", bytes: raster },
    ],
  });
  const candidate = workspace.buildSelected([]);
  const keep = await workspace.prepareCreativeKeep(candidate, {
    lease: { id: "art", owner: "editor" },
    keep: { sources: [source.identity] },
  });
  const exposed = resolveWorkspaceCreativeKeep(candidate, keep);
  try {
    (exposed.lease as { owner: string }).owner = "changed-after-review";
  } catch (error) {
    assert.ok(error instanceof TypeError, "immutable resolved requests may refuse mutation");
  }
  await workspace.keepCandidate(candidate, { creative: keep });
  const kept = (await loadCreativeCatalog(workspace.projectId)).catalog;
  assert.ok(kept);
  assert.equal(kept.sources[0]?.identity.id, "reference");
  assert.equal(kept.leases.length, 0, "the exact sealed lease was consumed once");
});
