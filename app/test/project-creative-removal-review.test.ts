import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CREATIVE_RECIPE_FORMAT,
  CREATIVE_SOURCE_FORMAT,
  type CreativeRecipe,
  type CreativeSource,
} from "../../src/creative/catalog.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { openContainer } from "../../src/container/container.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject } from "../src/project/editableProject.ts";
import { commitProject, loadAuthoredGame } from "../src/project/gameStorage.ts";
import { loadCreativeCatalog, stageCreativeBlobs } from "../src/project/creativeStore.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem(key: string) {
      return cache.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      cache.set(key, value);
    },
    removeItem(key: string) {
      cache.delete(key);
    },
  },
});

test("reviewed picture removal cannot strand its kept preparation recipe", async () => {
  const seed = prepareLocalProject({ title: "Recipe destination removal", kind: "blank" });
  await seed.save();
  const workspace = await openEditableProject(seed.projectId);
  const base = workspace.draft.capture();
  workspace.draft.edit("logic:1", "return;", base.version("logic:1"));
  workspace.draft.edit("picture:42", Uint8Array.of(0xff), base.version("picture:42"));
  await workspace.keepCandidate(workspace.buildSelected(["logic:1", "picture:42"]));
  const encoded = encodePngRgb(1, 1, Uint8Array.of(255, 0, 0));
  const raster = Uint8Array.of(255, 0, 0, 255);
  const source: CreativeSource = {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: { id: "source", incarnation: "original", revision: 0 },
    encoded: { hash: sha256Hex(encoded), byteLength: encoded.length, mime: "image/png" },
    availability: "original",
    normalized: {
      format: "rgba8-srgb-unpremultiplied-v1",
      width: 1,
      height: 1,
      blob: { hash: sha256Hex(raster), byteLength: raster.length, mime: "application/x-rgba8" },
    },
    origin: { kind: "import", title: "Red reference" },
  };
  const recipe: CreativeRecipe = {
    format: CREATIVE_RECIPE_FORMAT,
    version: 1,
    identity: { id: "room-reference", incarnation: "recipe", revision: 0 },
    sources: [source.identity],
    algorithm: "manual-picture-underlay-v1",
    preparation: {
      kind: "picture-underlay",
      source: source.identity,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      destination: { x: 0, y: 0, width: 160, height: 168 },
      fit: "contain",
      intendedAspect: "native",
      sample: "nearest-centre-v1",
      opacity: 0.5,
      palette: "ega-weighted-243-v1",
      alpha: { threshold: 128, matte: 0 },
      scope: "art",
    },
    destination: { kind: "picture", resourceId: 42 },
  };
  const staged = await stageCreativeBlobs({
    projectId: workspace.projectId,
    expectedHead: 0,
    lease: { id: "reference", owner: "editor", workspace: workspace.workspaceId },
    staged: { sources: [source], recipes: [recipe] },
    blobs: [
      { hash: source.encoded.hash, mime: source.encoded.mime, bytes: encoded },
      { hash: source.normalized.blob.hash, mime: source.normalized.blob.mime, bytes: raster },
    ],
  });
  const data = await loadAuthoredGame(workspace.projectId);
  assert.ok(data);
  await commitProject({
    projectId: workspace.projectId,
    commitId: "keep-reference",
    workspaceId: workspace.workspaceId,
    buildId: "a".repeat(64),
    expected: workspace.savedIdentity(),
    documents: [],
    data,
    creative: {
      expectedHead: staged.head,
      asOf: Date.now(),
      lease: { id: "reference", owner: "editor", workspace: workspace.workspaceId },
      keep: { sources: [source.identity], derivatives: [], recipes: [recipe.identity], board: [] },
    },
  });
  const reopened = await openEditableProject(workspace.projectId);
  const generation = reopened.savedIdentity().generation;
  reopened.draft.edit("picture:42", null, reopened.draft.capture().version("picture:42"));
  const removal = reopened.buildSelected(["picture:42"]);
  assert.equal(removal.diagnostics.filter((entry) => entry.severity === "error").length, 0);
  assert.deepEqual(removal.removedResources, ["picture:42"]);
  await assert.rejects(
    reopened.keepCandidate(removal, { reviewedRemovals: ["picture:42"] }),
    /recipe|preparation|creative|destination/i,
  );
  const after = await loadAuthoredGame(workspace.projectId);
  assert.ok(after);
  assert.equal(after.generation, generation);
  assert.ok(openContainer(new Map(Object.entries(after.files))).getResource("picture", 42));
  assert.equal(
    (await loadCreativeCatalog(workspace.projectId)).catalog?.recipes[0]?.destination.resourceId,
    42,
  );
});
