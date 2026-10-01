import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/crypto.ts";
import {
  CREATIVE_CATALOG_FORMAT,
  CREATIVE_LIMITS,
  CREATIVE_RECIPE_FORMAT,
  CREATIVE_SOURCE_FORMAT,
  CreativeCatalogError,
  applyCreativeKeep,
  checkCreativeBudgets,
  creativeBlobKey,
  creativeBlobPrefix,
  creativeCatalogKey,
  creativeUsage,
  emptyCreativeCatalog,
  planCreativeKeep,
  readCreativeCatalog,
  readCreativeCatalogRecord,
  readCreativeKeepRequest,
  readCreativeRecipe,
  readCreativeSource,
  verifyCreativeBlob,
  writeCreativeBlobRecord,
  writeCreativeCatalogRecord,
  type CreativeCatalog,
  type CreativeKeepRequest,
  type CreativeSource,
} from "../src/creative/catalog.ts";

function blobBytes(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (seed + i) & 0xff;
  return bytes;
}

function blobRef(bytes: Uint8Array, mime: string) {
  return { hash: sha256Hex(bytes), byteLength: bytes.length, mime };
}

function source(
  id: string,
  encoded: Uint8Array,
  raster: { bytes: Uint8Array; width: number; height: number },
): CreativeSource {
  return {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: { id, incarnation: "inc", revision: 0 },
    encoded: blobRef(encoded, "image/png"),
    availability: "original",
    normalized: {
      blob: blobRef(raster.bytes, "application/x-rgba8"),
      format: "rgba8-srgb-unpremultiplied-v1",
      width: raster.width,
      height: raster.height,
    },
    origin: { kind: "import", title: `Source ${id}` },
  };
}

function keepRequest(over: Partial<CreativeKeepRequest> = {}): CreativeKeepRequest {
  return {
    expectedHead: 0,
    asOf: 100,
    lease: { id: "lease-1", owner: "owner", workspace: "ws-1" },
    keep: { sources: [], derivatives: [], recipes: [], board: [] },
    ...over,
  };
}

test("catalog keys live under the creative sidecar prefix", () => {
  assert.equal(creativeCatalogKey("p1"), "creative/p1");
  const hash = "a".repeat(64);
  assert.equal(creativeBlobKey("p1", hash), `creative/p1/blob/${hash}`);
  assert.equal(creativeBlobPrefix("p1"), "creative/p1/blob/");
  assert.ok(creativeBlobKey("p1", hash).startsWith(creativeBlobPrefix("p1")));
});

test("a catalog record round-trips through its write/read codecs", () => {
  const encoded = blobBytes(1, 64);
  const raster = blobBytes(9, 16);
  const catalog: CreativeCatalog = {
    ...emptyCreativeCatalog("p1"),
    head: 3,
    kept: 1,
    sources: [source("s1", encoded, { bytes: raster, width: 2, height: 2 })],
    holds: [{ id: "h1", kind: "recovery", hashes: [sha256Hex(encoded)] }],
  };
  const written = writeCreativeCatalogRecord(catalog);
  assert.equal(written["format"], CREATIVE_CATALOG_FORMAT);
  assert.equal(written["projectId"], "creative/p1");
  const read = readCreativeCatalogRecord(structuredClone(written), "p1");
  assert.deepEqual(read, catalog);
});

test("blob records verify exact stored bytes against the claimed hash", () => {
  const projectId = "p1";
  const bytes = blobBytes(7, 32);
  const ref = blobRef(bytes, "image/png");
  const record = writeCreativeBlobRecord(projectId, ref, bytes);
  const verified = verifyCreativeBlob(structuredClone(record), projectId, ref.hash);
  assert.deepEqual([...verified], [...bytes]);
  verified[0] = 255;
  assert.equal(bytes[0], 7); // returned bytes are a detached copy

  assert.throws(() => verifyCreativeBlob(undefined, projectId, ref.hash), CreativeCatalogError);
  assert.throws(
    () => verifyCreativeBlob({ ...record, bytes: blobBytes(8, 32) }, projectId, ref.hash),
    CreativeCatalogError,
  );
  assert.throws(
    () => verifyCreativeBlob({ ...record, version: 2 }, projectId, ref.hash),
    /version/i,
  );
});

test("non-canonical and malformed hashes are refused", () => {
  const catalog = emptyCreativeCatalog("p1");
  const bad = (hash: string) => ({
    ...writeCreativeCatalogRecord(catalog),
    blobs: { [hash]: { hash, byteLength: 1, mime: "image/png", buckets: ["original"] } },
  });
  assert.throws(() => readCreativeCatalog(bad("A".repeat(64))), /sha-256|digest/i);
  assert.throws(() => readCreativeCatalog(bad("not-a-hash")), /sha-256|digest/i);
});

test("an unknown nested record version refuses without rewriting", () => {
  const encoded = blobBytes(1, 64);
  const raster = blobBytes(9, 16);
  const kept = {
    ...emptyCreativeCatalog("p1"),
    sources: [source("s1", encoded, { bytes: raster, width: 2, height: 2 })],
  };
  const written = writeCreativeCatalogRecord(kept);
  const future = structuredClone(written) as { sources: { version: number }[] };
  future.sources[0]!.version = 2;
  const before = structuredClone(future);
  let error: unknown;
  try {
    readCreativeCatalogRecord(future, "p1");
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof CreativeCatalogError);
  assert.equal(error.code, "unsupported");
  assert.deepEqual(future, before); // the stored record is untouched

  const renamed = structuredClone(written) as Record<string, unknown>;
  renamed["brandNewField"] = true;
  assert.throws(() => readCreativeCatalogRecord(renamed, "p1"), /unknown field/i);
});

test("a catalog stored out of canonical identity order is corruption", () => {
  const encoded = blobBytes(1, 64);
  const raster = blobBytes(9, 16);
  const written = writeCreativeCatalogRecord({
    ...emptyCreativeCatalog("p1"),
    sources: [
      source("a", encoded, { bytes: raster, width: 2, height: 2 }),
      source("b", encoded, { bytes: raster, width: 2, height: 2 }),
    ],
  });
  const swapped = structuredClone(written) as { sources: unknown[] };
  swapped.sources = [...swapped.sources].reverse();
  assert.throws(() => readCreativeCatalogRecord(swapped, "p1"), /order/i);
});

test("duplicate content counts once while source identities stay distinct", () => {
  const encoded = blobBytes(1, 64);
  const raster = blobBytes(9, 16);
  const usage = creativeUsage({
    sources: [
      source("first", encoded, { bytes: raster, width: 2, height: 2 }),
      source("second", encoded, { bytes: raster, width: 2, height: 2 }),
    ],
    derivatives: [],
  });
  assert.equal(usage.sources, 2);
  assert.equal(usage.originals, encoded.length); // one hash, counted once
  assert.equal(usage.canonical, raster.length);
  assert.equal(usage.disposable, 0);
});

test("kept-set budgets refuse over-limit sources", () => {
  const encoded = blobBytes(1, 64);
  const raster = blobBytes(9, 16);
  const sources = Array.from({ length: CREATIVE_LIMITS.maxSources + 1 }, (_, i) =>
    source(`s${i}`, encoded, { bytes: raster, width: 2, height: 2 }),
  );
  assert.throws(() => checkCreativeBudgets({ sources, derivatives: [] }), /limit/i);

  const big = new Uint8Array(CREATIVE_LIMITS.maxFileBytes + 1);
  assert.throws(
    () =>
      readCreativeSource(
        JSON.parse(JSON.stringify(source("huge", big, { bytes: raster, width: 2, height: 2 }))),
      ),
    /per-file|byte limit/i,
  );
});

test("a picture recipe envelope validates strictly, refusing unknown versions", () => {
  const src = { id: "s1", incarnation: "inc", revision: 0 };
  const envelope = {
    format: CREATIVE_RECIPE_FORMAT,
    version: 1,
    identity: { id: "r1", incarnation: "inc", revision: 0 },
    sources: [src],
    algorithm: "picture-preparation-v1",
    preparation: {
      kind: "picture-conversion",
      source: src,
      crop: { x: 0, y: 0, width: 16, height: 16 },
      destination: { x: 0, y: 0, width: 160, height: 168 },
      fit: "cover",
      intendedAspect: "original-4:3",
      sample: "nearest-centre-v1",
      opacity: 1,
      palette: "ega-weighted-243-v1",
      alpha: { threshold: 128, matte: 0 },
      scope: "art",
    },
    destination: { kind: "picture", resourceId: 1 },
  };
  const read = readCreativeRecipe(structuredClone(envelope));
  assert.equal(read.identity.id, "r1");
  const future = structuredClone(envelope) as {
    preparation: Record<string, unknown> & { kind: string };
  };
  future.preparation = { ...future.preparation, kind: "picture-v3" };
  assert.throws(() => readCreativeRecipe(future), /kind|unknown/i);
});

test("keep publication validates head, lease, expiry and identities", () => {
  const encoded = blobBytes(1, 64);
  const raster = blobBytes(9, 16);
  const staged = source("s1", encoded, { bytes: raster, width: 2, height: 2 });
  const catalog: CreativeCatalog = {
    ...emptyCreativeCatalog("p1"),
    head: 1,
    leases: [
      {
        id: "lease-1",
        owner: "owner",
        workspace: "ws-1",
        expiresAt: 1000,
        staged: {
          sources: [staged],
          derivatives: [],
          recipes: [],
          blobs: [staged.encoded, staged.normalized.blob],
        },
      },
    ],
    blobs: {
      [staged.encoded.hash]: { ...staged.encoded, buckets: ["original" as const] },
      [staged.normalized.blob.hash]: { ...staged.normalized.blob, buckets: ["canonical" as const] },
    },
  };
  const request = keepRequest({
    expectedHead: 1,
    keep: { sources: [staged.identity], derivatives: [], recipes: [], board: [] },
  });
  const plan = planCreativeKeep(request, catalog, 500);
  assert.deepEqual(plan.referenced.map((ref) => ref.hash).sort(), [
    staged.encoded.hash,
    staged.normalized.blob.hash,
  ]);
  const next = applyCreativeKeep(catalog, request, plan);
  assert.equal(next.kept, 1);
  assert.equal(next.head, 2);
  assert.equal(next.leases.length, 0);
  assert.deepEqual(next.sources, [staged]);

  assert.throws(() => planCreativeKeep({ ...request, expectedHead: 9 }, catalog, 500), /head/i);
  assert.throws(
    () =>
      planCreativeKeep(
        { ...request, lease: { id: "lease-1", owner: "other", workspace: "ws-1" } },
        catalog,
        500,
      ),
    /owner|workspace/i,
  );
  assert.throws(() => planCreativeKeep(request, catalog, 1001), /expired/i);
  assert.throws(
    () =>
      planCreativeKeep(
        {
          ...request,
          keep: {
            sources: [{ id: "ghost", incarnation: "inc", revision: 0 }],
            derivatives: [],
            recipes: [],
            board: [],
          },
        },
        catalog,
        500,
      ),
    /neither kept nor staged/i,
  );
});

test("the publication request codec refuses malformed or duplicate keep sets", () => {
  const base = {
    expectedHead: 0,
    asOf: 1,
    lease: { id: "l1", owner: "o", workspace: "w" },
    keep: { sources: [], derivatives: [], recipes: [], board: [] },
  };
  assert.equal(readCreativeKeepRequest(structuredClone(base)).lease.id, "l1");
  const dup = structuredClone(base) as {
    keep: { sources: unknown[] };
  };
  dup.keep.sources = [
    { id: "s", incarnation: "i", revision: 0 },
    { id: "s", incarnation: "i", revision: 0 },
  ];
  assert.throws(() => readCreativeKeepRequest(dup), /twice/i);
  assert.throws(() => readCreativeKeepRequest({ ...base, extra: 1 }), /unknown field/i);
});
