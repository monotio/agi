import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CREATIVE_SOURCE_FORMAT,
  RASTER_FORMAT,
  creativeCatalogKey,
  type CreativeSource,
} from "../../src/creative/catalog.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject } from "../src/project/editableProject.ts";
import { loadCreativeCatalog } from "../src/project/creativeStore.ts";
import { openCreativeWorkspace } from "../src/studio/creative/creativeWorkspace.ts";

const records = installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key),
  },
});

test("cancellation after durable material admission reports the admitted visible result", async () => {
  const prepared = prepareLocalProject({ title: "Material cancellation", kind: "blank" });
  await prepared.save();
  const project = await openEditableProject(prepared.projectId);
  const workspace = openCreativeWorkspace(project, { autosaveRecovery: false });
  await workspace.ready;
  const controller = new AbortController();
  const pixels = new Uint8Array([19, 43, 87, 255]);
  const encoded = encodePngRgba(1, 1, pixels);
  const source: CreativeSource = {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: { id: "source-cancellation", incarnation: "material-cancellation", revision: 0 },
    encoded: { hash: sha256Hex(encoded), byteLength: encoded.length, mime: "image/png" },
    availability: "original",
    normalized: {
      format: RASTER_FORMAT,
      width: 1,
      height: 1,
      blob: { hash: sha256Hex(pixels), byteLength: pixels.length, mime: "application/x-rgba8" },
    },
    origin: { kind: "generated", title: "Reviewed image" },
  };
  const set = records.set.bind(records);
  let stageCommitted = false;
  records.set = (key, value) => {
    const result = set(key, value);
    if (key === creativeCatalogKey(project.projectId) && !stageCommitted) {
      stageCommitted = true;
      // The fixture publishes the entire transaction synchronously, then
      // resolves oncomplete. Deliver cancel after publication but before the
      // awaiting controller resumes, as independent queued UI work can do.
      queueMicrotask(() => controller.abort());
    }
    return result;
  };
  try {
    const result = await workspace.stageMaterialUse(workspace.issueMaterialCapture({ keys: [] }), {
      sources: [{ record: source, pixels, encoded }],
      signal: controller.signal,
    });
    const { catalog } = await loadCreativeCatalog(project.projectId);
    assert.equal(stageCommitted, true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(catalog?.leases[0]?.staged.sources.length, 1, "the stage committed durably");
    assert.ok(!("refusal" in result), "a committed write must return its admitted result");
    assert.deepEqual(
      workspace.sources.map((entry) => entry.record.identity),
      [source.identity],
    );
  } finally {
    records.set = set;
    await workspace.dispose();
  }
});
