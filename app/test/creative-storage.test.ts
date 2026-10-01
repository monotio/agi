import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import {
  CREATIVE_SOURCE_FORMAT,
  creativeBlobKey,
  creativeCatalogKey,
  readCreativeCatalogRecord,
  retainedCreativeUsage,
  type CreativeSource,
} from "../../src/creative/catalog.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import * as storage from "../src/project/gameStorage.ts";
import type { ProjectCommitReceipt } from "../src/project/gameStorage.ts";
import {
  collectCreativeGarbage,
  holdCreativeBlobs,
  loadCreativeCatalog,
  readCreativeBlob,
  releaseCreativeHold,
  releaseCreativeLease,
  renewCreativeLease,
  stageCreativeBlobs,
} from "../src/project/creativeStore.ts";

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

/** Stage a lease carrying `staged` sources and their blob bytes. */
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

function keepPublication(staged: { head: number }, sources: CreativeSource[], leaseId = "lease-1") {
  return {
    expectedHead: staged.head,
    asOf: Date.now(),
    lease: { id: leaseId, owner: "editor", workspace: "workspace-one" },
    keep: {
      sources: sources.map((s) => s.identity),
      derivatives: [],
      recipes: [],
      board: [],
    },
  };
}

async function publish(
  input: ReturnType<typeof request>,
  saved: ProjectCommitReceipt["saved"],
  staged: { head: number },
  sources: CreativeSource[],
  commitId = "keep",
  leaseId = "lease-1",
) {
  return storage.commitProject({
    ...input,
    commitId,
    expected: saved,
    creative: keepPublication(staged, sources, leaseId),
  });
}

test("staged blob records round-trip exact encoded and canonical bytes", async () => {
  const { input } = await boot("creative-roundtrip");
  const encoded = bytes(3, 96);
  const src = source("s1", encoded);
  await stage(input.projectId, 0, [src], [{ encoded, raster: RASTER }]);
  const encodedBack = await readCreativeBlob(input.projectId, sha256Hex(encoded));
  assert.deepEqual([...encodedBack.bytes], [...encoded]);
  assert.equal(encodedBack.mime, "image/png");
  const rasterBack = await readCreativeBlob(input.projectId, sha256Hex(RASTER));
  assert.deepEqual([...rasterBack.bytes], [...RASTER]);
});

test("the same bytes under two source identities register once, kept distinctly", async () => {
  const { input } = await boot("creative-shared-bytes");
  const shared = bytes(5, 32);
  const first = source("first", shared);
  const second = source("second", shared);
  await stage(input.projectId, 0, [first, second], [{ encoded: shared, raster: RASTER }]);
  const { catalog } = await loadCreativeCatalog(input.projectId);
  assert.notEqual(catalog, null);
  const lease = catalog!.leases[0]!;
  assert.equal(lease.staged.sources.length, 2); // identities stay distinct
  // One blob record exists for the shared bytes.
  assert.ok(records.has(creativeBlobKey(input.projectId, sha256Hex(shared))));
  const usage = retainedCreativeUsage(catalog!, Date.now());
  assert.equal(usage.sources, 2);
  assert.equal(usage.originals, shared.length); // unique hash counted once
});

test("an expired lease's orphan staged bytes are collected; a live lease protects them", async () => {
  const { input } = await boot("creative-gc");
  const encoded = bytes(11, 32);
  await stage(input.projectId, 0, [source("s1", encoded)], [{ encoded, raster: RASTER }], {
    now: () => 1000,
  });
  // While the lease is live the staged bytes are reachable.
  const live = await collectCreativeGarbage({ projectId: input.projectId, now: () => 2000 });
  assert.equal(live.removed, 0);
  assert.ok(records.has(creativeBlobKey(input.projectId, sha256Hex(encoded))));
  // After expiry the lease drops and its unreferenced bytes are removed.
  const collected = await collectCreativeGarbage({
    projectId: input.projectId,
    now: () => 601_000,
  });
  assert.equal(collected.removed, 2);
  assert.ok(!records.has(creativeBlobKey(input.projectId, sha256Hex(encoded))));
  assert.ok(!records.has(creativeBlobKey(input.projectId, sha256Hex(RASTER))));
  assert.ok(
    !readCreativeCatalogRecord(records.get(creativeCatalogKey(input.projectId)), input.projectId)!
      .leases.length,
  );
});

test("recovery and retained-undo holds protect bytes past their source's kept life", async () => {
  const { input, first } = await boot("creative-holds");
  const encoded = bytes(21, 32);
  const src = source("s1", encoded);
  const staged = await stage(input.projectId, 0, [src], [{ encoded, raster: RASTER }]);
  const published = await publish(input, first.receipt.saved, staged, [src]);
  assert.equal(published.receipt.creative?.kept, 1);

  // Pin the source's bytes for retained undo, then keep a set without it.
  const held = await holdCreativeBlobs({
    projectId: input.projectId,
    hold: { id: "undo-1", kind: "retained-undo", hashes: [sha256Hex(encoded), sha256Hex(RASTER)] },
  });
  const restage = await stage(input.projectId, held.head, [], [], { leaseId: "lease-2" });
  const emptied = await publish(
    input,
    published.receipt.saved,
    restage,
    [],
    "empty-keep",
    "lease-2",
  );
  assert.equal(emptied.receipt.creative?.kept, 2);

  const collected = await collectCreativeGarbage({ projectId: input.projectId });
  assert.equal(collected.removed, 0); // the hold keeps every byte
  assert.deepEqual(
    [...(await readCreativeBlob(input.projectId, sha256Hex(encoded))).bytes],
    [...encoded],
  );
  // Retained bytes still count in their original buckets after the source
  // record left the kept set.
  const { catalog } = await loadCreativeCatalog(input.projectId);
  const usage = retainedCreativeUsage(catalog!, Date.now());
  assert.equal(usage.sources, 0);
  assert.equal(usage.originals, encoded.length);
  assert.equal(usage.canonical, RASTER.length);
  const entry = catalog!.blobs[sha256Hex(encoded)]!;
  assert.deepEqual(entry.buckets, ["original"]);

  await releaseCreativeHold({ projectId: input.projectId, holdId: "undo-1" });
  const swept = await collectCreativeGarbage({ projectId: input.projectId });
  assert.equal(swept.removed, 2);
  assert.ok(!records.has(creativeBlobKey(input.projectId, sha256Hex(encoded))));
});

test("an expired lease cannot be renewed, and a dead lifetime cannot restage or publish", async () => {
  const { input, first } = await boot("creative-lease-expiry");
  await stage(input.projectId, 0, [], [], { now: () => 1000 });
  await assert.rejects(
    renewCreativeLease({
      projectId: input.projectId,
      lease: { id: "lease-1", owner: "editor" },
      now: () => 700_000,
    }),
    /expired/i,
  );
  await assert.rejects(
    releaseCreativeLease({
      projectId: input.projectId,
      lease: { id: "lease-1", owner: "other" },
    }),
    /owner/i,
  );

  // Deletion ends the lifetime; a reimport under the same id gets a fresh
  // catalog, and neither the old lease nor its head survives.
  const oldLifetime = first.receipt.saved.lifetime;
  await storage.clearCachedGame(input.projectId);
  const recreated = await storage.commitProject({
    ...request(input.projectId),
    commitId: "recreate",
  });
  await assert.rejects(
    stageCreativeBlobs({
      projectId: input.projectId,
      expectedHead: 0,
      lease: { id: "lease-1", owner: "editor", workspace: "workspace-one" },
      expectedLifetime: oldLifetime,
    }),
    /removed|deleted|replaced/i,
  );
  const fresh = await stage(input.projectId, 0, [], []);
  assert.equal(fresh.head, 1);
  await assert.rejects(
    storage.commitProject({
      ...input,
      commitId: "revived",
      expected: recreated.receipt.saved,
      creative: {
        expectedHead: 0,
        asOf: Date.now(),
        lease: { id: "lease-1", owner: "editor", workspace: "workspace-one" },
        keep: { sources: [], derivatives: [], recipes: [], board: [] },
      },
    }),
    /head/i,
  );
});

test("publication over an expired lease refuses and leaves body, catalog and receipt untouched", async () => {
  const { input, first } = await boot("creative-expired-keep");
  const src = source("s1", bytes(31, 32));
  const staged = await stage(
    input.projectId,
    0,
    [src],
    [{ encoded: bytes(31, 32), raster: RASTER }],
    { now: () => 1000 },
  );
  const before = structuredClone([...records]);
  await assert.rejects(
    storage.commitProject({
      ...input,
      commitId: "late",
      expected: first.receipt.saved,
      creative: {
        ...keepPublication(staged, [src]),
        asOf: 1, // the caller's stale timestamp cannot revive the lease
      },
    }),
    /expired/i,
  );
  assert.deepEqual([...records], before);
});

test("stale head, generation and lifetime refuse a creative commit without mutation", async () => {
  const { input, first } = await boot("creative-cas");
  const src = source("s1", bytes(41, 32));
  const staged = await stage(
    input.projectId,
    0,
    [src],
    [{ encoded: bytes(41, 32), raster: RASTER }],
  );

  // A stale catalog head.
  await assert.rejects(
    storage.commitProject({
      ...input,
      commitId: "stale-head",
      expected: first.receipt.saved,
      creative: { ...keepPublication(staged, [src]), expectedHead: staged.head + 5 },
    }),
    /head/i,
  );
  // A stale storage generation.
  await assert.rejects(
    storage.commitProject({
      ...input,
      commitId: "stale-gen",
      expected: { ...first.receipt.saved, generation: first.receipt.saved.generation + 9 },
      creative: keepPublication(staged, [src]),
    }),
    /modified/i,
  );
  // Nothing was admitted.
  const { catalog } = await loadCreativeCatalog(input.projectId);
  assert.equal(catalog!.kept, 0);
  assert.equal(catalog!.head, staged.head);
});

test("a staged blob that no staged record claims is refused", async () => {
  const { input } = await boot("creative-orphan-blob");
  const stray = bytes(77, 16);
  await assert.rejects(
    stageCreativeBlobs({
      projectId: input.projectId,
      expectedHead: 0,
      lease: { id: "lease-1", owner: "editor", workspace: "workspace-one" },
      blobs: [{ hash: sha256Hex(stray), mime: "image/png", bytes: stray }],
    }),
    /not referenced/i,
  );
  assert.ok(!records.has(creativeBlobKey(input.projectId, sha256Hex(stray))));
});

test("publication verifies blob bytes, key and descriptor before writing", async () => {
  const { input, first } = await boot("creative-blob-verify");
  const encoded = bytes(51, 32);
  const src = source("s1", encoded);
  const staged = await stage(input.projectId, 0, [src], [{ encoded, raster: RASTER }]);
  const encodedKey = creativeBlobKey(input.projectId, sha256Hex(encoded));

  // Missing blob: remove the record a staged source claims.
  const stored = records.get(encodedKey);
  records.delete(encodedKey);
  await assert.rejects(
    storage.commitProject({
      ...input,
      commitId: "missing",
      expected: first.receipt.saved,
      creative: keepPublication(staged, [src]),
    }),
    /missing/i,
  );
  assert.ok(!records.has(`commit/${input.projectId}/missing`));
  assert.equal((await loadCreativeCatalog(input.projectId)).catalog!.kept, 0);

  // Tampered bytes: self-consistent fields but the payload no longer hashes.
  const tampered = structuredClone(stored) as { bytes: Uint8Array };
  tampered.bytes = bytes(99, 32);
  records.set(encodedKey, tampered);
  await assert.rejects(
    storage.commitProject({
      ...input,
      commitId: "tampered",
      expected: first.receipt.saved,
      creative: keepPublication(staged, [src]),
    }),
    /hash|match/i,
  );
  assert.ok(!records.has(`commit/${input.projectId}/tampered`));

  // Tampered descriptor: record rewritten self-consistently but its declared
  // mime no longer matches the registered descriptor.
  records.set(encodedKey, { ...(stored as object), mime: "image/jpeg" });
  await assert.rejects(
    storage.commitProject({
      ...input,
      commitId: "descriptor",
      expected: first.receipt.saved,
      creative: keepPublication(staged, [src]),
    }),
    /descriptor|match/i,
  );
  assert.ok(!records.has(`commit/${input.projectId}/descriptor`));

  records.set(encodedKey, stored);
  const published = await publish(input, first.receipt.saved, staged, [src]);
  assert.equal(published.receipt.creative?.kept, 1);
});

test("a failed write rolls back body, catalog and receipt together", async () => {
  const { input, first } = await boot("creative-rollback");
  const src = source("s1", bytes(61, 32));
  const staged = await stage(
    input.projectId,
    0,
    [src],
    [{ encoded: bytes(61, 32), raster: RASTER }],
  );
  const bodyBefore = structuredClone(records.get(input.projectId));
  const catalogBefore = structuredClone(records.get(creativeCatalogKey(input.projectId)));
  const failing = () => {
    throw new Error("simulated storage failure");
  };
  const original = records.set;
  records.set = failing as typeof records.set;
  try {
    await assert.rejects(
      storage.commitProject({
        ...input,
        commitId: "doomed",
        expected: first.receipt.saved,
        creative: keepPublication(staged, [src]),
      }),
      /simulated storage failure/,
    );
  } finally {
    records.set = original;
  }
  assert.deepEqual(records.get(input.projectId), bodyBefore);
  assert.deepEqual(records.get(creativeCatalogKey(input.projectId)), catalogBefore);
  assert.ok(!records.has(`commit/${input.projectId}/doomed`));
  assert.equal((await storage.loadAuthoredGame(input.projectId))!.generation, 1);
});

test("a same-id retry returns the original creative receipt exactly once", async () => {
  const { input, first } = await boot("creative-retry");
  const src = source("s1", bytes(71, 32));
  const staged = await stage(
    input.projectId,
    0,
    [src],
    [{ encoded: bytes(71, 32), raster: RASTER }],
  );
  const commit = {
    ...input,
    commitId: "keep",
    expected: first.receipt.saved,
    creative: keepPublication(staged, [src]),
  };
  const published = await storage.commitProject(commit);
  assert.deepEqual(published.receipt.creative, { kept: 1, head: staged.head + 1 });
  const retry = await storage.commitProject(commit);
  assert.deepEqual(retry.receipt, published.receipt);
  // The kept set did not advance a second time.
  const { catalog, marker } = await loadCreativeCatalog(input.projectId);
  assert.equal(catalog!.kept, 1);
  assert.deepEqual(marker, { kept: 1 });
  // A same-id request carrying a different creative candidate is refused.
  await assert.rejects(
    storage.commitProject({ ...commit, creative: { ...commit.creative, expectedHead: 0 } }),
    /reused|different/i,
  );
});

test("GC never removes staged bytes under a live lease or kept blobs after publish", async () => {
  const { input, first } = await boot("creative-gc-kept");
  const encoded = bytes(81, 32);
  const src = source("s1", encoded);
  const staged = await stage(input.projectId, 0, [src], [{ encoded, raster: RASTER }]);
  const before = await collectCreativeGarbage({ projectId: input.projectId });
  assert.equal(before.removed, 0); // lease live: the kept candidate survives
  await publish(input, first.receipt.saved, staged, [src]);
  const after = await collectCreativeGarbage({ projectId: input.projectId });
  assert.equal(after.removed, 0); // kept bytes are never collectible
  assert.equal((await loadCreativeCatalog(input.projectId)).catalog!.kept, 1);
  assert.deepEqual(
    [...(await readCreativeBlob(input.projectId, sha256Hex(encoded))).bytes],
    [...encoded],
  );
});

test("staging past the retained source budget aborts with no partial writes", async () => {
  const { input, first } = await boot("creative-quota");
  const sixteen = Array.from({ length: 16 }, (_, i) => source(`s${i}`, bytes(i, 8)));
  const staged = await stage(
    input.projectId,
    0,
    sixteen,
    sixteen.map((s, i) => ({ encoded: bytes(i, 8), raster: RASTER })),
  );
  const published = await publish(input, first.receipt.saved, staged, sixteen);
  assert.equal(published.receipt.creative?.kept, 1);
  const before = structuredClone([...records]);
  // Kept already holds 16 logical sources; a seventeenth staged source must
  // fail budgets and leave no blob records or manifest entry behind.
  const extra = source("extra", bytes(200, 8));
  const extraHash = sha256Hex(bytes(200, 8));
  await assert.rejects(
    stage(input.projectId, staged.head + 1, [extra], [{ encoded: bytes(200, 8), raster: RASTER }], {
      leaseId: "lease-2",
    }),
    /source|budget|limit/i,
  );
  assert.ok(!records.has(creativeBlobKey(input.projectId, extraHash)));
  assert.deepEqual([...records], before);
});

test("unknown nested catalog versions refuse without rewriting stored bytes", async () => {
  const { input, first } = await boot("creative-future");
  const src = source("s1", bytes(91, 32));
  await stage(input.projectId, 0, [src], [{ encoded: bytes(91, 32), raster: RASTER }]);
  const key = creativeCatalogKey(input.projectId);
  const stored = structuredClone(records.get(key)) as {
    leases: { staged: { sources: Record<string, unknown>[] } }[];
  };
  const future = structuredClone(stored);
  future.leases[0]!.staged.sources[0] = {
    ...future.leases[0]!.staged.sources[0]!,
    version: 2,
  };
  records.set(key, future);
  await assert.rejects(loadCreativeCatalog(input.projectId), /version|unsupported/i);
  // The stored record is untouched and the project body still loads.
  assert.deepEqual(records.get(key), future);
  assert.equal((await storage.loadAuthoredGame(input.projectId))!.generation, 1);
  // And publication over the unreadable catalog refuses too.
  await assert.rejects(
    publish(input, first.receipt.saved, { head: 1 }, [src]),
    /version|unsupported/i,
  );
});

test("an ordinary commit carries the stored marker forward but refuses a forged or moved one", async () => {
  const { input, first } = await boot("creative-marker");
  const src = source("s1", bytes(101, 32));
  const staged = await stage(
    input.projectId,
    0,
    [src],
    [{ encoded: bytes(101, 32), raster: RASTER }],
  );
  const published = await publish(input, first.receipt.saved, staged, [src]);

  // Caller omits the marker: the stored body's authoritative marker survives.
  const plain = await storage.commitProject({
    ...input,
    commitId: "ordinary",
    expected: published.receipt.saved,
    data: { ...input.data, title: "Edited" },
  });
  assert.deepEqual((await storage.loadAuthoredGame(input.projectId))!.creative, { kept: 1 });

  // Caller carries the correct marker explicitly: accepted.
  const explicit = await storage.commitProject({
    ...input,
    commitId: "explicit",
    expected: plain.receipt.saved,
    data: { ...input.data, creative: { kept: 1 } },
  });
  assert.equal(explicit.receipt.saved.generation, plain.receipt.saved.generation + 1);

  // A mismatched marker is forged metadata: refused before any write.
  const before = structuredClone([...records]);
  await assert.rejects(
    storage.commitProject({
      ...input,
      commitId: "forged",
      expected: explicit.receipt.saved,
      data: { ...input.data, creative: { kept: 42 } },
    }),
    /creative|marker|catalog/i,
  );
  assert.deepEqual([...records], before);
});

test("a marker whose catalog moved or vanished refuses the commit", async () => {
  const { input, first } = await boot("creative-marker-mismatch");
  const src = source("s1", bytes(111, 32));
  const staged = await stage(
    input.projectId,
    0,
    [src],
    [{ encoded: bytes(111, 32), raster: RASTER }],
  );
  const published = await publish(input, first.receipt.saved, staged, [src]);
  // The stored body now pins kept:1. If the catalog record moves ahead —
  // or disappears — metadata alone must not relink the body.
  const body = structuredClone(records.get(input.projectId)) as {
    creative: { kept: number };
  };
  const catalogKey = creativeCatalogKey(input.projectId);
  const catalog = records.get(catalogKey);

  body.creative = { kept: 9 };
  records.set(input.projectId, body);
  await assert.rejects(
    storage.commitProject({
      ...input,
      commitId: "moved",
      expected: published.receipt.saved,
      data: { ...input.data, creative: { kept: 9 } },
    }),
    /creative|catalog|marker/i,
  );
  assert.equal((await storage.loadAuthoredGame(input.projectId))!.generation, 2);

  records.delete(catalogKey);
  body.creative = { kept: 1 };
  records.set(input.projectId, body);
  await assert.rejects(
    storage.commitProject({
      ...input,
      commitId: "orphan-marker",
      expected: published.receipt.saved,
      data: { ...input.data, creative: { kept: 1 } },
    }),
    /creative|catalog|marker/i,
  );
  records.set(catalogKey, catalog);
});

test("a v1 body carrying a creative marker is refused, not dropped", async () => {
  const id = testProjectId("creative-v1");
  records.set(id, {
    format: "monotio.agi.stored-project",
    version: 1,
    projectId: id,
    title: "Old",
    authoredAt: "2025-01-01T00:00:00.000Z",
    provider: "stub",
    model: "stub",
    files: {},
    words: [],
    creative: { kept: 0 },
  });
  await assert.rejects(storage.loadAuthoredGame(id), /creative.*version|version.*creative/i);
});

test("loadCreativeCatalog refuses a missing catalog behind a marker and a marker behind none", async () => {
  const { input, first } = await boot("creative-marker-integrity");
  const src = source("s1", bytes(121, 32));
  const staged = await stage(
    input.projectId,
    0,
    [src],
    [{ encoded: bytes(121, 32), raster: RASTER }],
  );
  await publish(input, first.receipt.saved, staged, [src]);
  const catalogKey = creativeCatalogKey(input.projectId);
  const catalog = records.get(catalogKey);
  records.delete(catalogKey);
  await assert.rejects(loadCreativeCatalog(input.projectId), /missing|catalog/i);
  records.set(catalogKey, catalog);
  assert.equal((await loadCreativeCatalog(input.projectId)).marker?.kept, 1);
});
