import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import {
  CREATIVE_SOURCE_FORMAT,
  creativeBlobKey,
  creativeCatalogKey,
  readCreativeCatalogRecord,
  type CreativeSource,
} from "../../src/creative/catalog.ts";
import { creativeProjectBlobHashes } from "../../src/creative/project.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import * as storage from "../src/project/gameStorage.ts";
import type { ProjectCommitReceipt } from "../src/project/gameStorage.ts";
import {
  collectCreativeGarbage,
  holdCreativeBlobs,
  loadCreativeCatalog,
  stageCreativeBlobs,
} from "../src/project/creativeStore.ts";
import {
  CreativeSnapshotError,
  captureCreativeProject,
} from "../src/project/creativeProjectSnapshot.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";

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

function bytes(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (seed + i) & 0xff;
  return out;
}

function ref(data: Uint8Array, mime: string) {
  return { hash: sha256Hex(data), byteLength: data.length, mime };
}

const RASTER = bytes(200, 16); // a 2x2 tightly packed RGBA8 raster

function source(id: string, encoded: Uint8Array): CreativeSource {
  return {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: { id, incarnation: "inc", revision: 0 },
    encoded: ref(encoded, "image/png"),
    availability: "original",
    normalized: {
      blob: ref(RASTER, "application/x-rgba8"),
      format: "rgba8-srgb-unpremultiplied-v1",
      width: 2,
      height: 2,
    },
    origin: { kind: "import", title: `Source ${id}` },
  };
}

function request(name: string) {
  return {
    projectId: testProjectId(name),
    commitId: "first",
    workspaceId: "workspace-one",
    buildId: "a".repeat(64),
    expected: null,
    documents: [{ key: "logic:1", version: 1 }],
    data: {
      title: "Adventure",
      provider: "",
      model: "",
      files: { "VOL.0": Uint8Array.of(1) },
      words: [] as [string, number][],
    },
  };
}

async function boot(name: string) {
  const input = request(name);
  const first = await storage.commitProject(input);
  return { input, first };
}

function stage(
  projectId: ReturnType<typeof testProjectId>,
  expectedHead: number,
  sources: CreativeSource[],
  blobs: { encoded: Uint8Array; raster: Uint8Array }[],
  options: { leaseId?: string; now?: () => number } = {},
) {
  return stageCreativeBlobs({
    projectId,
    expectedHead,
    lease: { id: options.leaseId ?? "lease-1", owner: "editor", workspace: "workspace-one" },
    staged: { sources },
    blobs: blobs.flatMap(({ encoded, raster }) => [
      { hash: sha256Hex(encoded), mime: "image/png", bytes: encoded },
      { hash: sha256Hex(raster), mime: "application/x-rgba8", bytes: raster },
    ]),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

async function publish(
  input: ReturnType<typeof request>,
  saved: ProjectCommitReceipt["saved"],
  staged: { head: number },
  sources: CreativeSource[],
  leaseId = "lease-1",
) {
  return storage.commitProject({
    ...input,
    commitId: `keep-${staged.head}`,
    expected: saved,
    creative: {
      expectedHead: staged.head,
      asOf: Date.now(),
      lease: { id: leaseId, owner: "editor", workspace: "workspace-one" },
      keep: {
        sources: sources.map((s) => s.identity),
        derivatives: [],
        recipes: [],
        board: [],
      },
    },
  });
}

test("a kept project captures body marker, manifest and exact blob bytes coherently", async () => {
  const { input, first } = await boot("snap-happy");
  const encoded = bytes(1, 96);
  const src = source("s1", encoded);
  const staged = await stage(input.projectId, 0, [src], [{ encoded, raster: RASTER }]);
  const published = await publish(input, first.receipt.saved, staged, [src]);

  const snapshot = await captureCreativeProject(input.projectId);
  assert.ok(snapshot);
  const body = (await storage.loadAuthoredGame(input.projectId))!;
  assert.equal(snapshot.projectId, input.projectId);
  assert.equal(snapshot.generation, body.generation);
  assert.equal(snapshot.data.projectId, input.projectId);
  assert.deepEqual(snapshot.data.files, body.files);
  assert.equal(snapshot.kept, 1);
  assert.equal(snapshot.head, published.receipt.creative?.head);
  assert.equal(snapshot.revision, await gameRevision(body.files));
  assert.deepEqual(snapshot.manifest!.sources, [src]);
  const hashes = creativeProjectBlobHashes(snapshot.manifest!);
  assert.deepEqual(hashes, [encoded, RASTER].map((b) => sha256Hex(b)).sort());
  assert.deepEqual([...snapshot.blobs[sha256Hex(encoded)]!], [...encoded]);
  assert.deepEqual([...snapshot.blobs[sha256Hex(RASTER)]!], [...RASTER]);
});

test("a project without creative data captures null; staging alone stays unpublished", async () => {
  const { input } = await boot("snap-none");
  assert.equal(await captureCreativeProject(input.projectId), null);
  // A staged lease is not a kept publication.
  await stage(
    input.projectId,
    0,
    [source("s1", bytes(3, 32))],
    [{ encoded: bytes(3, 32), raster: RASTER }],
  );
  assert.equal(await captureCreativeProject(input.projectId), null);
  // Nothing staged was reported as kept, and a GC that sweeps the lease does
  // not change the answer.
  await collectCreativeGarbage({ projectId: input.projectId, now: () => 601_000 });
  assert.equal(await captureCreativeProject(input.projectId), null);
});

test("capture refuses a missing body, lost marker or moved catalog; held bytes carry", async () => {
  const { input, first } = await boot("snap-refusals");
  const encoded = bytes(5, 32);
  const src = source("s1", encoded);
  const staged = await stage(input.projectId, 0, [src], [{ encoded, raster: RASTER }]);
  await publish(input, first.receipt.saved, staged, [src]);
  const catalogKey = creativeCatalogKey(input.projectId);

  // Missing body: capture refuses rather than reporting an empty project.
  const body = records.get(input.projectId);
  records.delete(input.projectId);
  await assert.rejects(captureCreativeProject(input.projectId), (error: unknown) => {
    assert.ok(error instanceof CreativeSnapshotError);
    assert.equal(error.reason, "missing");
    return true;
  });
  records.set(input.projectId, body);

  // A body that pins a kept catalog refuses when the catalog is gone.
  const catalog = records.get(catalogKey);
  records.delete(catalogKey);
  await assert.rejects(captureCreativeProject(input.projectId), (error: unknown) => {
    assert.ok(error instanceof CreativeSnapshotError);
    assert.equal(error.reason, "missing");
    return true;
  });
  records.set(catalogKey, catalog);

  // Marker lost while the catalog stays kept: corruption, not an empty set.
  const unmarked = structuredClone(body) as { creative?: unknown };
  delete unmarked.creative;
  records.set(input.projectId, unmarked);
  await assert.rejects(captureCreativeProject(input.projectId), (error: unknown) => {
    assert.ok(error instanceof CreativeSnapshotError);
    assert.equal(error.reason, "conflict");
    return true;
  });
  records.set(input.projectId, body);

  // A marker that pins a different kept revision than the catalog.
  const moved = structuredClone(body) as { creative: { kept: number } };
  moved.creative = { kept: 9 };
  records.set(input.projectId, moved);
  await assert.rejects(captureCreativeProject(input.projectId), (error: unknown) => {
    assert.ok(error instanceof CreativeSnapshotError);
    assert.equal(error.reason, "conflict");
    return true;
  });
  records.set(input.projectId, body);

  // A retained-undo hold is durable work: it captures into the portable
  // envelope with its exact inventory rather than refusing.
  await holdCreativeBlobs({
    projectId: input.projectId,
    hold: { id: "undo-1", kind: "retained-undo", hashes: [sha256Hex(encoded)] },
  });
  const held = (await captureCreativeProject(input.projectId))!;
  assert.equal(held.work?.retained.length, 1);
  assert.deepEqual([...held.work!.retained[0]!], [sha256Hex(encoded)]);
  assert.deepEqual([...held.workBlobs[sha256Hex(encoded)]!], [...encoded]);
});

test("capture writes nothing: head, generation and the stored records are untouched", async () => {
  const { input, first } = await boot("snap-pure");
  const encoded = bytes(7, 32);
  const src = source("s1", encoded);
  const staged = await stage(input.projectId, 0, [src], [{ encoded, raster: RASTER }]);
  await publish(input, first.receipt.saved, staged, [src]);

  const before = structuredClone([...records]);
  const indexBefore = new Map(cache);
  const snapshot = await captureCreativeProject(input.projectId);
  assert.ok(snapshot);
  assert.deepEqual([...records], before);
  assert.deepEqual(new Map(cache), indexBefore);
  const { catalog } = await loadCreativeCatalog(input.projectId);
  assert.equal(catalog!.head, staged.head + 1);
  assert.equal(catalog!.kept, 1);
});

test("a missing or tampered kept blob record refuses in the same transaction", async () => {
  const { input, first } = await boot("snap-blobs");
  const encoded = bytes(9, 32);
  const src = source("s1", encoded);
  const staged = await stage(input.projectId, 0, [src], [{ encoded, raster: RASTER }]);
  await publish(input, first.receipt.saved, staged, [src]);
  const encodedKey = creativeBlobKey(input.projectId, sha256Hex(encoded));
  const stored = records.get(encodedKey);

  // A record that disappears between the catalog read and the blob read —
  // what a concurrent GC or delete looks like mid-capture — refuses.
  const nativeGet = records.get;
  records.get = ((key: IDBValidKey) => {
    const value = nativeGet.call(records, key);
    if (key === creativeCatalogKey(input.projectId)) records.delete(encodedKey);
    return value;
  }) as typeof records.get;
  await assert.rejects(captureCreativeProject(input.projectId), (error: unknown) => {
    assert.ok(error instanceof CreativeSnapshotError);
    assert.equal(error.reason, "missing");
    return true;
  });
  records.get = nativeGet;
  records.set(encodedKey, stored);

  // Tampered stored bytes refuse on exact-hash verification.
  records.set(encodedKey, { ...(stored as object), bytes: bytes(99, 32) });
  await assert.rejects(captureCreativeProject(input.projectId), (error: unknown) => {
    assert.ok(error instanceof CreativeSnapshotError);
    assert.equal(error.reason, "integrity");
    return true;
  });
  records.set(encodedKey, stored);
  assert.ok(await captureCreativeProject(input.projectId));
});

test("captured bytes are owned: mutating the snapshot cannot touch stored records", async () => {
  const { input, first } = await boot("snap-owned");
  const encoded = bytes(11, 32);
  const src = source("s1", encoded);
  const staged = await stage(input.projectId, 0, [src], [{ encoded, raster: RASTER }]);
  await publish(input, first.receipt.saved, staged, [src]);

  const snapshot = (await captureCreativeProject(input.projectId))!;
  snapshot.blobs[sha256Hex(encoded)]![0] = 255;
  (snapshot.manifest!.sources[0]!.origin as { title: string }).title = "mutated";
  const stored = readCreativeCatalogRecord(
    records.get(creativeCatalogKey(input.projectId)),
    input.projectId,
  )!;
  assert.equal(stored.sources[0]!.origin.title, "Source s1");
  const reread = (await captureCreativeProject(input.projectId))!;
  assert.deepEqual([...reread.blobs[sha256Hex(encoded)]!], [...encoded]);
});

test("a concurrent Keep before capture resolves to one coherent kept set or no kept set", async () => {
  const { input, first } = await boot("snap-concurrent");
  const encoded = bytes(13, 32);
  const src = source("s1", encoded);
  const staged = await stage(input.projectId, 0, [src], [{ encoded, raster: RASTER }]);

  // Capture queued first: it must resolve to the pre-Keep state (null), and
  // the Keep that lands afterwards produces a complete kept set — never a
  // snapshot that mixes the two catalog revisions.
  const early = await captureCreativeProject(input.projectId);
  assert.equal(early, null);
  const racing = Promise.all([
    captureCreativeProject(input.projectId),
    publish(input, first.receipt.saved, staged, [src]),
  ]);
  const [snapshot, published] = await racing;
  void published;
  // Whichever transaction ran first, the result is internally consistent.
  if (snapshot === null) {
    const { catalog } = await loadCreativeCatalog(input.projectId);
    assert.equal(catalog!.kept, 1); // the Keep landed after the capture
  } else {
    assert.equal(snapshot.kept, 1);
    assert.equal(snapshot.head, staged.head + 1);
    for (const hash of creativeProjectBlobHashes(snapshot.manifest!))
      assert.ok(snapshot.blobs[hash]);
  }
  const after = (await captureCreativeProject(input.projectId))!;
  assert.equal(after.kept, 1);
});

test("capture honors expectedLifetime against the same snapshot", async () => {
  const { input, first } = await boot("snap-lifetime");
  const encoded = bytes(15, 32);
  const src = source("s1", encoded);
  const staged = await stage(input.projectId, 0, [src], [{ encoded, raster: RASTER }]);
  await publish(input, first.receipt.saved, staged, [src]);

  const lifetime = first.receipt.saved.lifetime;
  assert.ok(await captureCreativeProject(input.projectId, lifetime));
  await assert.rejects(
    captureCreativeProject(input.projectId, "not-the-lifetime"),
    /removed|deleted/i,
  );
});

test("an unsupported stored body version refuses the capture", async () => {
  const id = testProjectId("snap-v99");
  records.set(id, {
    format: "monotio.agi.stored-project",
    version: 99,
    projectId: id,
    title: "Future",
    authoredAt: "2026-01-01",
    files: {},
    words: [],
  });
  await assert.rejects(captureCreativeProject(id), (error: unknown) => {
    assert.ok(error instanceof CreativeSnapshotError);
    assert.equal(error.reason, "integrity");
    return true;
  });
});
