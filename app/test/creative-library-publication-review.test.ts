import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { CREATIVE_SOURCE_FORMAT, type CreativeSource } from "../../src/creative/catalog.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import { commitProject, loadAuthoredGame } from "../src/project/gameStorage.ts";
import { stageCreativeBlobs } from "../src/project/creativeStore.ts";
import { captureCreativeProject } from "../src/project/creativeProjectSnapshot.ts";
import { buildProjectZip } from "../src/archive/projectArchive.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { addLibraryGame, copyLibraryGame } from "../src/library/gameLibrary.ts";

installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() {
      return cache.size;
    },
    key(index: number) {
      return [...cache.keys()][index] ?? null;
    },
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

async function keptProject(name: string) {
  const projectId = testProjectId(name);
  const starter = createStarterProject("boilerplate");
  const data = {
    title: "Synthetic art project",
    provider: "stub",
    model: "stub",
    files: Object.fromEntries(starter.files()),
    words: [...starter.sources.words],
  };
  const request = {
    projectId,
    commitId: "initial",
    workspaceId: "workspace",
    buildId: "a".repeat(64),
    expected: null,
    documents: [{ key: "logic:0", version: 1 }],
    data,
  };
  const first = await commitProject(request);
  const encoded = encodePngRgb(1, 1, Uint8Array.of(255, 0, 0));
  const raster = Uint8Array.of(255, 0, 0, 255);
  const source: CreativeSource = {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: { id: "red-source", incarnation: "original", revision: 0 },
    encoded: { hash: sha256Hex(encoded), byteLength: encoded.length, mime: "image/png" },
    availability: "original",
    normalized: {
      blob: { hash: sha256Hex(raster), byteLength: raster.length, mime: "application/x-rgba8" },
      format: "rgba8-srgb-unpremultiplied-v1",
      width: 1,
      height: 1,
    },
    origin: { kind: "import", title: "Synthetic red pixel" },
  };
  const staged = await stageCreativeBlobs({
    projectId,
    expectedHead: 0,
    lease: { id: "art", owner: "editor", workspace: "workspace" },
    staged: { sources: [source] },
    blobs: [
      { hash: source.encoded.hash, mime: source.encoded.mime, bytes: encoded },
      { hash: source.normalized.blob.hash, mime: source.normalized.blob.mime, bytes: raster },
    ],
  });
  const kept = await commitProject({
    ...request,
    commitId: "keep-art",
    expected: first.receipt.saved,
    creative: {
      expectedHead: staged.head,
      asOf: Date.now(),
      lease: { id: "art", owner: "editor", workspace: "workspace" },
      keep: { sources: [source.identity], derivatives: [], recipes: [], board: [] },
    },
  });
  const snapshot = await captureCreativeProject(projectId);
  assert.ok(snapshot);
  return { projectId, snapshot, request, receipt: kept.receipt };
}

test("Copy preserves a readable independent creative catalog and exact originals", async () => {
  const { projectId, snapshot } = await keptProject("art-copy-root");
  const copyId = await copyLibraryGame(projectId);
  assert.notEqual(copyId, projectId);
  const copied = await captureCreativeProject(copyId);
  assert.ok(copied);
  assert.deepEqual(copied.manifest, snapshot.manifest);
  assert.deepEqual(copied.blobs, snapshot.blobs);
  const original = await captureCreativeProject(projectId);
  assert.deepEqual(original?.blobs, snapshot.blobs);
});

test("private project ZIP import durably publishes its declared creative assets", async () => {
  const { snapshot } = await keptProject("art-import-root");
  const zip = await buildProjectZip(
    snapshot.data,
    undefined,
    undefined,
    undefined,
    undefined,
    snapshot,
  );
  const opened = await readGameZip(zip);
  assert.ok(opened.project?.creative, "reader admits the actual creative archive");
  const image = encodePngRgb(1, 1, Uint8Array.of(255, 0, 0));
  const importedId = await addLibraryGame(opened, "Imported art", "zip", {
    preview: `data:image/png;base64,${Buffer.from(image).toString("base64")}`,
    status: "ready",
    message: "Checked synthetic opening",
    profile: "2.936",
  });
  assert.ok(await loadAuthoredGame(importedId));
  const imported = await captureCreativeProject(importedId);
  assert.ok(imported, "declared creative assets cannot be silently omitted at library import");
  assert.deepEqual(imported.manifest, snapshot.manifest);
  assert.deepEqual(imported.blobs, snapshot.blobs);
});

test("ordinary Keep of a project with kept art refuses an unexportable candidate atomically", async () => {
  const { projectId, snapshot, request, receipt } = await keptProject("art-keep-budget-root");
  const offered = {
    ...request,
    commitId: "unexportable-native-change",
    expected: receipt.saved,
    data: {
      ...request.data,
      files: { ...request.data.files, "VOL.0": new Uint8Array(64 * 1024 * 1024 + 1) },
    },
  };
  await assert.rejects(commitProject(offered), /archive.*size|archive.*limit|archive.*budget/i);
  const stored = await loadAuthoredGame(projectId);
  assert.equal(stored?.generation, snapshot.data.generation);
  assert.deepEqual(stored?.files, snapshot.data.files);
  const after = await captureCreativeProject(projectId);
  assert.deepEqual(after?.manifest, snapshot.manifest);
  assert.deepEqual(after?.blobs, snapshot.blobs);
});

test("invalid optional assistant metadata cannot bypass creative Keep archive limits", async () => {
  const { projectId, snapshot, request, receipt } = await keptProject(
    "art-keep-metadata-budget-root",
  );
  await assert.rejects(
    commitProject({
      ...request,
      commitId: "metadata-masked-native-budget",
      expected: receipt.saved,
      data: {
        ...request.data,
        provider: "",
        model: "",
        files: { ...request.data.files, "VOL.0": new Uint8Array(64 * 1024 * 1024 + 1) },
      },
    }),
    /archive|metadata|model/i,
  );
  const stored = await loadAuthoredGame(projectId);
  assert.equal(stored?.generation, snapshot.data.generation);
  assert.deepEqual(stored?.files, snapshot.data.files);
  const after = await captureCreativeProject(projectId);
  assert.deepEqual(after?.manifest, snapshot.manifest);
  assert.deepEqual(after?.blobs, snapshot.blobs);
});

test("kept creative project metadata must stay exportable without silent assistant omission", async () => {
  const { projectId, snapshot, request, receipt } = await keptProject("art-keep-metadata-root");
  await assert.rejects(
    commitProject({
      ...request,
      commitId: "unsupported-assistant-claim",
      expected: receipt.saved,
      data: { ...request.data, provider: "unsupported-provider", model: "opaque-model" },
    }),
    /metadata|model|provider/i,
  );
  const after = await captureCreativeProject(projectId);
  assert.equal(after?.data.generation, snapshot.data.generation);
  assert.deepEqual(after?.data, snapshot.data);
  assert.deepEqual(after?.manifest, snapshot.manifest);
});

test("empty legacy provider fields with no assistant data remain a complete no-key backup", async () => {
  const { projectId, request, receipt } = await keptProject("art-keep-no-key-sentinel-root");
  await commitProject({
    ...request,
    commitId: "no-assistant-sentinel",
    expected: receipt.saved,
    data: { ...request.data, provider: "", model: "" },
  });
  const snapshot = await captureCreativeProject(projectId);
  assert.ok(snapshot);
  const zip = await buildProjectZip(
    snapshot.data,
    undefined,
    undefined,
    undefined,
    undefined,
    snapshot,
  );
  const opened = await readGameZip(zip);
  assert.ok(opened.project?.creative);
  assert.equal(opened.project?.provider, undefined);
  assert.equal(opened.project?.model, undefined);
  assert.deepEqual(opened.project.creative.manifest, snapshot.manifest);
});

test("an empty provider sentinel cannot hide a meaningful assistant transcript", async () => {
  const { projectId, snapshot, request, receipt } = await keptProject(
    "art-keep-orphan-transcript-root",
  );
  await assert.rejects(
    commitProject({
      ...request,
      commitId: "orphan-transcript",
      expected: receipt.saved,
      data: {
        ...request.data,
        provider: "",
        model: "",
        transcript: [{ role: "user", content: "Retain this request." }],
      },
    }),
    /metadata|model|provider/i,
  );
  const after = await captureCreativeProject(projectId);
  assert.deepEqual(after?.data, snapshot.data);
});
