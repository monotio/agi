import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/crypto.ts";
import {
  CREATIVE_RECIPE_FORMAT,
  CREATIVE_SOURCE_FORMAT,
  CreativeCatalogError,
  type BlobHash,
  type CreativeBoardEntry,
  type CreativeDerivative,
  type CreativeRecipe,
  type CreativeSource,
} from "../src/creative/catalog.ts";
import {
  CREATIVE_PROJECT_FORMAT,
  creativeProjectBlobHashes,
  deriveCreativeProjectManifest,
  readCreativeProjectManifest,
  writeCreativeProjectManifest,
  type CreativeKeptSet,
} from "../src/creative/project.ts";

function blobBytes(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (seed + i) & 0xff;
  return bytes;
}

function blobRef(bytes: Uint8Array, mime: string) {
  return { hash: sha256Hex(bytes), byteLength: bytes.length, mime };
}

function source(id: string, encoded: Uint8Array): CreativeSource {
  return {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: { id, incarnation: "inc", revision: 0 },
    encoded: blobRef(encoded, "image/png"),
    availability: "original",
    normalized: {
      blob: blobRef(blobBytes(200, 16), "application/x-rgba8"),
      format: "rgba8-srgb-unpremultiplied-v1",
      width: 2,
      height: 2,
    },
    origin: { kind: "import", title: `Source ${id}`, originUrl: "file:///private/origin.png" },
  };
}

function derivative(id: string, of: CreativeSource): CreativeDerivative {
  return {
    identity: { id, incarnation: "inc", revision: 0 },
    source: of.identity,
    blob: blobRef(blobBytes(90, 8), "image/png"),
    purpose: "thumbnail",
    generatorVersion: "thumb-1",
  };
}

function boardEntry(id: string, of: CreativeSource, on?: CreativeDerivative): CreativeBoardEntry {
  return {
    identity: { id, incarnation: "inc", revision: 0 },
    source: of.identity,
    ...(on === undefined ? {} : { derivative: on.identity }),
    roles: ["exact-source", "style"],
    approval: "approved",
    notes: "the kept look",
  };
}

function recipe(id: string, of: CreativeSource, outputPayloadHash?: string): CreativeRecipe {
  return {
    format: CREATIVE_RECIPE_FORMAT,
    version: 1,
    identity: { id, incarnation: "inc", revision: 0 },
    sources: [of.identity],
    algorithm: "picture-preparation-v1",
    preparation: {
      kind: "picture-conversion",
      source: of.identity,
      crop: { x: 0, y: 0, width: 2, height: 2 },
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
    ...(outputPayloadHash === undefined ? {} : { outputPayloadHash }),
  };
}

function keptSet(): { kept: CreativeKeptSet; encoded: Uint8Array } {
  const encoded = blobBytes(1, 64);
  const src = source("s1", encoded);
  const deriv = derivative("d1", src);
  return {
    encoded,
    kept: {
      sources: [src],
      derivatives: [deriv],
      board: [boardEntry("b1", src, deriv)],
      recipes: [recipe("r1", src, sha256Hex(blobBytes(7, 32)))],
    },
  };
}

test("a kept set round-trips records and blob descriptors exactly", () => {
  const { kept } = keptSet();
  const written = writeCreativeProjectManifest(kept);
  assert.equal(written["format"], CREATIVE_PROJECT_FORMAT);
  assert.equal(written["version"], 1);
  // Blob bodies never embed in the manifest: only descriptors travel in JSON.
  assert.equal(JSON.stringify(written).includes(JSON.stringify([...blobBytes(1, 64)])), false);
  const manifest = readCreativeProjectManifest(structuredClone(written));
  assert.deepEqual(manifest.sources, kept.sources);
  assert.deepEqual(manifest.derivatives, kept.derivatives);
  assert.deepEqual(manifest.board, kept.board);
  assert.deepEqual(manifest.recipes, kept.recipes);
  // The registry is exactly the kept claims: original + raster + thumbnail.
  const expected = new Set<BlobHash>([
    kept.sources[0]!.encoded.hash,
    kept.sources[0]!.normalized.blob.hash,
    kept.derivatives[0]!.blob.hash,
  ]);
  assert.deepEqual(new Set(creativeProjectBlobHashes(manifest)), expected);
  assert.deepEqual(manifest.blobs[kept.sources[0]!.encoded.hash]?.buckets, ["original"]);
  assert.deepEqual(manifest.blobs[kept.sources[0]!.normalized.blob.hash]?.buckets, ["canonical"]);
  assert.deepEqual(manifest.blobs[kept.derivatives[0]!.blob.hash]?.buckets, ["disposable"]);
});

test("a stale outputPayloadHash is evidence, not a kept-blob claim", () => {
  const { kept } = keptSet();
  // The recipe records the native payload it last produced; a later native
  // edit makes that evidence stale but never makes the source backup corrupt.
  assert.notEqual(
    creativeProjectBlobHashes(readCreativeProjectManifest(writeCreativeProjectManifest(kept)))
      .length,
    0,
  );
  const manifest = readCreativeProjectManifest(writeCreativeProjectManifest(kept));
  const claimed = new Set(creativeProjectBlobHashes(manifest));
  const payloadHash = kept.recipes[0]!.outputPayloadHash!;
  assert.equal(claimed.has(payloadHash), false); // evidence is not a registered blob
  assert.equal(manifest.recipes[0]!.outputPayloadHash, payloadHash); // but it survives
});

test("manifest format, version and unknown fields refuse without rewriting", () => {
  const { kept } = keptSet();
  const written = writeCreativeProjectManifest(kept);
  const before = structuredClone(written);

  const badFormat = { ...structuredClone(written), format: "monotio.other" };
  let error: unknown;
  try {
    readCreativeProjectManifest(badFormat);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof CreativeCatalogError);
  assert.equal(error.code, "unsupported");

  const future = structuredClone(written) as { version: number };
  future.version = 2;
  const futureBefore = structuredClone(future);
  try {
    readCreativeProjectManifest(future);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof CreativeCatalogError);
  assert.equal(error.code, "unsupported");
  assert.deepEqual(future, futureBefore); // refusal never rewrote the input

  const extra = { ...structuredClone(written), staged: [] };
  assert.throws(() => readCreativeProjectManifest(extra), /unknown field/i);
  assert.deepEqual(written, before);
});

test("an unknown nested record version refuses through the manifest", () => {
  const { kept } = keptSet();
  const written = writeCreativeProjectManifest(kept) as { sources: { version: number }[] };
  written.sources[0]!.version = 2;
  let error: unknown;
  try {
    readCreativeProjectManifest(written);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof CreativeCatalogError);
  assert.equal(error.code, "unsupported");
});

test("duplicate identities and non-canonical stored order refuse", () => {
  const encoded = blobBytes(1, 64);
  const a = source("a", encoded);
  const b = source("b", encoded);
  const kept: CreativeKeptSet = {
    sources: [a, b],
    derivatives: [],
    board: [],
    recipes: [],
  };
  const written = writeCreativeProjectManifest(kept) as { sources: unknown[] };

  const duplicated = structuredClone(written);
  duplicated.sources = [duplicated.sources[0], duplicated.sources[0]];
  assert.throws(() => readCreativeProjectManifest(duplicated), /order|twice/i);

  const swapped = structuredClone(written);
  swapped.sources = [...swapped.sources].reverse();
  assert.throws(() => readCreativeProjectManifest(swapped), /order/i);
});

test("a dangling board or recipe reference refuses", () => {
  const encoded = blobBytes(1, 64);
  const src = source("s1", encoded);
  const kept: CreativeKeptSet = {
    sources: [src],
    derivatives: [],
    board: [boardEntry("b1", src)],
    recipes: [],
  };
  const written = writeCreativeProjectManifest(kept) as {
    board: { source: unknown }[];
  };
  written.board[0]!.source = { id: "ghost", incarnation: "inc", revision: 0 };
  assert.throws(() => readCreativeProjectManifest(written), /outside the kept set/i);
});

test("the blob registry must equal the kept claims — no missing, extra or drifted entries", () => {
  const { kept } = keptSet();
  const written = writeCreativeProjectManifest(kept) as {
    blobs: Record<string, Record<string, unknown>>;
  };

  const missing = structuredClone(written);
  const rasterHash = kept.sources[0]!.normalized.blob.hash;
  delete missing.blobs[rasterHash];
  assert.throws(() => readCreativeProjectManifest(missing), /blob/i);

  const orphan = structuredClone(written);
  const extraHash = sha256Hex(blobBytes(42, 8));
  orphan.blobs[extraHash] = {
    hash: extraHash,
    byteLength: 8,
    mime: "image/png",
    buckets: ["original"],
  };
  assert.throws(() => readCreativeProjectManifest(orphan), /blob/i);

  const drifted = structuredClone(written);
  drifted.blobs[rasterHash]!["byteLength"] = 1;
  assert.throws(() => readCreativeProjectManifest(drifted), /descriptor|match/i);

  const wrongHash = structuredClone(written);
  wrongHash.blobs[rasterHash]!["hash"] = sha256Hex(blobBytes(8, 8));
  assert.throws(() => readCreativeProjectManifest(wrongHash), /hash/i);
});

test("reads and writes return owned nested data", () => {
  const { kept } = keptSet();
  const written = writeCreativeProjectManifest(kept);
  // Mutating the caller's records after writing cannot reach the record.
  (kept.sources[0]!.origin as { title: string }).title = "rewritten";
  (kept.board[0]!.roles as string[]).push("composition");
  const manifest = readCreativeProjectManifest(structuredClone(written));
  assert.equal(manifest.sources[0]!.origin.title, "Source s1");
  assert.deepEqual(manifest.board[0]!.roles, ["exact-source", "style"]);
  // And mutating a read result cannot reach the stored shape.
  (manifest.board[0]!.roles as string[]).length = 0;
  const reread = readCreativeProjectManifest(structuredClone(written));
  assert.deepEqual(reread.board[0]!.roles, ["exact-source", "style"]);
});

test("deriveCreativeProjectManifest agrees with the written record", () => {
  const { kept } = keptSet();
  const derived = deriveCreativeProjectManifest(kept);
  const read = readCreativeProjectManifest(writeCreativeProjectManifest(kept));
  assert.deepEqual(derived, read);
});

test("an unsorted offer is refused, not silently resorted", () => {
  const encoded = blobBytes(1, 64);
  const kept: CreativeKeptSet = {
    sources: [source("b", encoded), source("a", encoded)],
    derivatives: [],
    board: [],
    recipes: [],
  };
  assert.throws(() => writeCreativeProjectManifest(kept), /order/i);
});
