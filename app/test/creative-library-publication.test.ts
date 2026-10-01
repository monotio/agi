import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { CREATIVE_SOURCE_FORMAT, type CreativeSource } from "../../src/creative/catalog.ts";
import type { CreativeProjectAssets } from "../../src/creative/project.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import {
  clearCachedGame,
  commitProject,
  listCachedGames,
  loadAuthoredGame,
  publishNewProject,
} from "../src/project/gameStorage.ts";
import {
  holdCreativeBlobs,
  releaseCreativeHold,
  stageCreativeBlobs,
} from "../src/project/creativeStore.ts";
import { captureCreativeProject } from "../src/project/creativeProjectSnapshot.ts";
import { publishProjectWithCreative } from "../src/project/creativeProjectPublication.ts";
import {
  buildProjectZip,
  buildPublicGameZip,
  measureStoredArchive,
} from "../src/archive/projectArchive.ts";
import { readGameZip, type OpenedGame } from "../src/archive/gameZip.ts";
import { addLibraryGame, copyLibraryGame } from "../src/library/gameLibrary.ts";

const records = installIndexedDbFixture();
const cache = new Map<string, string>();
// The index view enumerates localStorage's own keys, so entries live as
// enumerable own properties like the library suite's stub.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem(key: string) {
      return cache.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      cache.set(key, value);
      Object.defineProperty(this, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
    },
    removeItem(key: string) {
      cache.delete(key);
      Reflect.deleteProperty(this, key);
    },
  },
});

const opening = {
  preview: "data:image/png;base64,iVBORw0KGgo=",
  status: "ready" as const,
  message: "Checked synthetic opening.",
  profile: "2.936",
};

function starterFiles() {
  const starter = createStarterProject("boilerplate");
  return {
    title: "Synthetic art project",
    provider: "stub",
    model: "stub",
    files: Object.fromEntries(starter.files()),
    words: [...starter.sources.words],
  };
}

function redPixelSource(): {
  source: CreativeSource;
  encoded: Uint8Array;
  raster: Uint8Array;
} {
  const encoded = encodePngRgb(1, 1, Uint8Array.of(255, 0, 0));
  const raster = Uint8Array.of(255, 0, 0, 255);
  return {
    encoded,
    raster,
    source: {
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
    },
  };
}

async function keptProject(name: string) {
  const projectId = testProjectId(name);
  const data = starterFiles();
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
  const { source, encoded, raster } = redPixelSource();
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
  await commitProject({
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
  return { projectId, snapshot };
}

function storedKeys(): Set<IDBValidKey> {
  return new Set(records.keys());
}

test("import, cold capture and re-export preserve identical creative payloads", async () => {
  const { snapshot } = await keptProject("art-roundtrip");
  const opened = await readGameZip(
    await buildProjectZip(snapshot.data, undefined, undefined, undefined, undefined, snapshot),
  );
  const importedId = await addLibraryGame(opened, "Imported art", "zip", opening);
  // A second import never folds into or overwrites the first: independent
  // private projects stay independent.
  const reimportedId = await addLibraryGame(
    await readGameZip(
      await buildProjectZip(snapshot.data, undefined, undefined, undefined, undefined, snapshot),
    ),
    "Imported art",
    "zip",
    opening,
  );
  assert.notEqual(reimportedId, importedId);
  const first = (await captureCreativeProject(importedId))!;
  const second = (await captureCreativeProject(reimportedId))!;
  assert.deepEqual(second.manifest, snapshot.manifest);
  assert.deepEqual(first.blobs, snapshot.blobs);
  // The exported archive round-trips the manifest and exact bytes.
  const exported = await readGameZip(
    await buildProjectZip(first.data, undefined, undefined, undefined, undefined, first),
  );
  assert.deepEqual(exported.project?.creative?.manifest, snapshot.manifest);
  assert.deepEqual(exported.project?.creative?.blobs, snapshot.blobs);
});

test("a copied project survives deleting its source and vice versa", async () => {
  const { projectId, snapshot } = await keptProject("art-independent");
  const copyId = await copyLibraryGame(projectId);
  await clearCachedGame(projectId);
  const copied = await captureCreativeProject(copyId);
  assert.deepEqual(copied?.manifest, snapshot.manifest);
  assert.deepEqual(copied?.blobs, snapshot.blobs);
  const copiedAgain = await copyLibraryGame(copyId);
  await clearCachedGame(copyId);
  assert.ok(await captureCreativeProject(copiedAgain));
});

test("projects without creative markers keep legacy import and copy behavior", async () => {
  // Distinct bytes, so the import deduplicates onto no earlier project.
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic('display(5, 2, "Plain"); return;', { dictionary: new Map() }).payload,
  );
  const files = { ...Object.fromEntries(container.files), "WORDS.TOK": buildWordsTok([]) };
  const importedId = await addLibraryGame({ files, words: [] }, "Plain project", "zip", opening);
  assert.equal(await captureCreativeProject(importedId), null);
  const copyId = await copyLibraryGame(importedId);
  assert.equal(await captureCreativeProject(copyId), null);
  // A public Game ZIP never carries creative context, even when built from
  // a project body whose stored twin has kept art. The declared interpreter
  // makes the import land under a fresh identity rather than deduplicating
  // onto that stored twin.
  const { snapshot } = await keptProject("art-public");
  const publicZip = await readGameZip(buildPublicGameZip(snapshot.data));
  assert.equal(publicZip.project, undefined);
  const publicId = await addLibraryGame(
    { ...publicZip, profile: "3.002.086" },
    "Public art",
    "zip",
    opening,
  );
  assert.equal(await captureCreativeProject(publicId), null);
});

test("corrupt, mismatched and future-version creative imports refuse with no writes", async () => {
  const { snapshot } = await keptProject("art-corrupt-source");
  const valid: CreativeProjectAssets = {
    manifest: snapshot.manifest!,
    blobs: snapshot.blobs,
  };
  const cases: { name: string; assets: CreativeProjectAssets }[] = [
    {
      name: "a manifest that is not a manifest",
      assets: { manifest: { garbage: true } as never, blobs: valid.blobs },
    },
    {
      name: "a blob missing from the offer",
      assets: { manifest: valid.manifest, blobs: {} },
    },
    {
      name: "blob bytes that do not match their hash",
      assets: {
        manifest: valid.manifest,
        blobs: Object.fromEntries(
          Object.entries(valid.blobs).map(([hash, bytes]) => [
            hash,
            Uint8Array.of(...bytes.slice(0, -1), bytes[bytes.length - 1]! ^ 0xff),
          ]),
        ),
      },
    },
    {
      name: "a nested record carrying a future version",
      assets: {
        manifest: {
          ...structuredClone(valid.manifest),
          sources: structuredClone(valid.manifest).sources.map((source) => ({
            ...source,
            version: 99 as never,
          })),
        },
        blobs: valid.blobs,
      },
    },
  ];
  for (const { name, assets } of cases) {
    const before = storedKeys();
    const indexBefore = new Set(cache.keys());
    const game: OpenedGame = {
      files: starterFiles().files,
      words: [],
      project: { provider: "stub", model: "stub", transcript: [], creative: assets },
    };
    await assert.rejects(addLibraryGame(game, "Bad art", "zip", opening), name);
    // No target body, catalog, blob records or index entry may survive.
    assert.deepEqual(storedKeys(), before, name);
    assert.deepEqual(new Set(cache.keys()), indexBefore, name);
  }
});

test("a transaction abort leaves no orphan body, catalog, blobs or index", async () => {
  const { snapshot } = await keptProject("art-abort-source");
  const projectId = testProjectId("art-abort-target");
  const before = storedKeys();
  const indexBefore = new Set(cache.keys());
  const originalSet = records.set.bind(records);
  // Fault-inject the commit-time apply: the first durable write fails as a
  // quota-class put error would, aborting the whole transaction.
  let armed = true;
  records.set = ((key: IDBValidKey, value: unknown) => {
    if (armed) {
      armed = false;
      throw new Error("QuotaExceededError: injected");
    }
    return originalSet(key, value);
  }) as typeof records.set;
  try {
    await assert.rejects(
      publishProjectWithCreative({
        projectId,
        data: starterFiles(),
        creative: { manifest: snapshot.manifest!, blobs: snapshot.blobs },
      }),
      /Quota/,
    );
  } finally {
    records.set = originalSet;
  }
  assert.deepEqual(storedKeys(), before);
  assert.deepEqual(new Set(cache.keys()), indexBefore);
  assert.equal(await loadAuthoredGame(projectId), null);
});

test("an identity collision cannot overwrite another project or its art", async () => {
  const { projectId, snapshot } = await keptProject("art-collision");
  const before = await captureCreativeProject(projectId);
  await assert.rejects(
    publishProjectWithCreative({
      projectId,
      data: { ...starterFiles(), title: "Usurper" },
      creative: { manifest: snapshot.manifest!, blobs: snapshot.blobs },
    }),
    /already exists/,
  );
  await assert.rejects(
    publishNewProject({ projectId, data: { ...starterFiles(), title: "Usurper" } }),
    /already exists/,
  );
  const after = await captureCreativeProject(projectId);
  assert.deepEqual(after?.manifest, before?.manifest);
  assert.equal((await loadAuthoredGame(projectId))?.title, "Synthetic art project");
});

test("a lost acknowledgment retries the exact candidate once; index repair is explicit", async () => {
  const { snapshot } = await keptProject("art-receipt-source");
  const projectId = testProjectId("art-receipt");
  const input = {
    projectId,
    data: starterFiles(),
    creative: { manifest: snapshot.manifest!, blobs: snapshot.blobs },
  };
  const first = await publishProjectWithCreative(structuredClone(input));
  // The same candidate retries to the same receipt without republishing.
  const retry = await publishProjectWithCreative(structuredClone(input));
  assert.deepEqual(retry.receipt, first.receipt);
  assert.equal((await loadAuthoredGame(projectId))?.generation, 1);
  // A different candidate under the same identity refuses rather than
  // quietly reusing the publication.
  await assert.rejects(
    publishProjectWithCreative({
      projectId,
      data: { ...input.data, title: "Different project" },
      creative: input.creative,
    }),
    /different candidate/,
  );
  // A failed index write warns; the durable publication already exists and
  // the retry repairs the view with the same receipt.
  const secondId = testProjectId("art-repair");
  const originalCacheSet = cache.set.bind(cache);
  cache.set = (() => {
    throw new Error("localStorage full");
  }) as typeof cache.set;
  try {
    const warned = await publishProjectWithCreative({
      projectId: secondId,
      data: starterFiles(),
      creative: { manifest: snapshot.manifest!, blobs: snapshot.blobs },
    });
    assert.deepEqual(warned.warnings, ["indexRepairPending"]);
    cache.set = originalCacheSet;
    assert.ok(await captureCreativeProject(secondId));
    assert.equal(
      listCachedGames().some((entry) => entry.projectId === secondId),
      false,
      "the index stays repairable metadata, not authority",
    );
    const repaired = await publishProjectWithCreative({
      projectId: secondId,
      data: starterFiles(),
      creative: { manifest: snapshot.manifest!, blobs: snapshot.blobs },
    });
    assert.deepEqual(repaired.receipt, warned.receipt);
    assert.ok(listCachedGames().some((entry) => entry.projectId === secondId));
  } finally {
    cache.set = originalCacheSet;
  }
});

test("caller mutation after the call cannot mix into the publication", async () => {
  const { snapshot } = await keptProject("art-mutation-source");
  const projectId = testProjectId("art-mutation");
  const data = starterFiles();
  const assets = { manifest: snapshot.manifest!, blobs: snapshot.blobs };
  const expectedBlobs = Object.fromEntries(
    Object.entries(assets.blobs).map(([hash, bytes]) => [hash, new Uint8Array(bytes)]),
  );
  const originalName = Object.keys(data.files)[0]!;
  const originalBytes = data.files[originalName]!;
  const published = publishProjectWithCreative({ projectId, data, creative: assets });
  // Mutate everything the caller still owns while the coordinator works.
  data.title = "Mutated title";
  data.files[originalName] = Uint8Array.of(9, 9, 9);
  data.files["BOGUS.0"] = Uint8Array.of(1);
  for (const bytes of Object.values(assets.blobs)) bytes[0] = bytes[0]! ^ 0xff;
  const { receipt } = await published;
  assert.ok(receipt.candidateHash);
  const stored = (await loadAuthoredGame(projectId))!;
  assert.equal(stored.title, "Synthetic art project");
  assert.deepEqual(stored.files[originalName], originalBytes);
  assert.equal(stored.files["BOGUS.0"], undefined);
  const captured = (await captureCreativeProject(projectId))!;
  assert.deepEqual(captured.blobs, expectedBlobs);
});

test("deleting the source mid-copy still yields a coherent copy or a named refusal", async () => {
  const { projectId, snapshot } = await keptProject("art-race");
  // The copy's coherent capture is queued first under the per-project
  // writer serialization; the delete commits after it.
  const copied = copyLibraryGame(projectId);
  const removed = clearCachedGame(projectId);
  const copyId = await copied;
  await removed;
  assert.equal(await loadAuthoredGame(projectId), null);
  const captured = await captureCreativeProject(copyId);
  assert.deepEqual(captured?.manifest, snapshot.manifest);
  assert.deepEqual(captured?.blobs, snapshot.blobs);
  // After the delete a fresh copy refuses by name — the capture's lifetime
  // guard sees the removed game before any body read.
  await assert.rejects(copyLibraryGame(projectId), /missing|removed/i);
});

test("a recovery hold no indexed row claims refuses the copy by name", async () => {
  const { projectId, snapshot } = await keptProject("art-hold");
  const hash = Object.keys(snapshot.manifest!.blobs)[0]!;
  // A durable hold pins real bytes but no workspace row owns it — the
  // capture cannot carry orphaned recovery data truthfully, so the copy
  // refuses by name rather than silently dropping the held art.
  await holdCreativeBlobs({
    projectId,
    hold: { id: "recovery-1", kind: "recovery", hashes: [hash] },
  });
  await assert.rejects(copyLibraryGame(projectId), /no indexed workspace row/i);
  await assert.rejects(captureCreativeProject(projectId), /no indexed workspace row/i);
  await releaseCreativeHold({ projectId, holdId: "recovery-1" });
  const restored = await captureCreativeProject(projectId);
  assert.deepEqual(restored?.manifest, snapshot.manifest);
});

test("publication refuses an authoring set the archive could never write", async () => {
  // Exact boundary arithmetic on the shared measure: one byte past the
  // per-entry bound, and one entry past the entry-count bound, refuse with
  // the writer's own errors — hand-computed, no giant packing.
  const blobName = `CREATIVE/${"a".repeat(64)}.BIN`;
  measureStoredArchive([{ name: blobName, data: new Uint8Array(64 * 1024 * 1024) }]);
  assert.throws(
    () => measureStoredArchive([{ name: blobName, data: new Uint8Array(64 * 1024 * 1024 + 1) }]),
    /exceeds the supported archive size/,
  );
  assert.throws(
    () =>
      measureStoredArchive(
        Array.from({ length: 1025 }, (_, i) => ({ name: `E${i}`, data: new Uint8Array(0) })),
      ),
    /more than 1024 archive entries/,
  );
  // End to end: a candidate whose measured archive overflows refuses before
  // anything durable exists — no body, catalog, blob records, index or
  // fake-complete receipt. A playable file just past the per-entry bound is
  // the smallest such authoring set.
  const { snapshot } = await keptProject("art-budget-source");
  const projectId = testProjectId("art-overbudget");
  const before = storedKeys();
  const indexBefore = new Set(cache.keys());
  await assert.rejects(
    publishProjectWithCreative({
      projectId,
      data: {
        ...starterFiles(),
        files: {
          ...starterFiles().files,
          "VOL.0": new Uint8Array(64 * 1024 * 1024 + 1),
        },
      },
      creative: { manifest: snapshot.manifest!, blobs: snapshot.blobs },
    }),
    /exceeds the supported archive size/,
  );
  assert.deepEqual(storedKeys(), before);
  assert.deepEqual(new Set(cache.keys()), indexBefore);
});
