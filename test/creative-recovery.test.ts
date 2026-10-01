import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/crypto.ts";
import {
  CREATIVE_SOURCE_FORMAT,
  CreativeCatalogError,
  type CreativeDerivative,
  type CreativeRecipe,
  type CreativeSource,
} from "../src/creative/catalog.ts";
import {
  CREATIVE_RECOVERY_FORMAT,
  creativeRecoveryBlobHashes,
  readCreativeRecovery,
  writeCreativeRecovery,
  type CreativeRecoveryBase,
  type CreativeRecipeDraft,
} from "../src/creative/recovery.ts";
import { requireResourceRevision } from "../src/gameIdentity.ts";
import { writeProjectRecovery } from "../src/authoring/projectRecovery.ts";

function blobBytes(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (seed + i) & 0xff;
  return bytes;
}

function blobRef(bytes: Uint8Array, mime: string) {
  return { hash: sha256Hex(bytes), byteLength: bytes.length, mime };
}

const RASTER = blobBytes(9, 16); // a 2x2 tightly packed RGBA8 raster

function source(id: string, encoded: Uint8Array): CreativeSource {
  return {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: { id, incarnation: "inc", revision: 0 },
    encoded: blobRef(encoded, "image/png"),
    availability: "original",
    normalized: {
      blob: blobRef(RASTER, "application/x-rgba8"),
      format: "rgba8-srgb-unpremultiplied-v1",
      width: 2,
      height: 2,
    },
    origin: { kind: "import", title: `Source ${id}` },
  };
}

function derivative(id: string, src: CreativeSource, bytes: Uint8Array): CreativeDerivative {
  return {
    identity: { id, incarnation: "inc", revision: 0 },
    source: src.identity,
    blob: blobRef(bytes, "image/png"),
    purpose: "thumbnail",
    generatorVersion: "thumb-v1",
  };
}

function recipe(id: string, src: CreativeSource): CreativeRecipe {
  return {
    format: "agi.preparation",
    version: 1,
    identity: { id, incarnation: "inc", revision: 0 },
    sources: [src.identity],
    algorithm: "picture-underlay-v1",
    preparation: {
      kind: "picture-underlay",
      source: src.identity,
      crop: { x: 0, y: 0, width: 2, height: 2 },
      destination: { x: 0, y: 0, width: 2, height: 2 },
      fit: "contain",
      intendedAspect: "native",
      sample: "nearest-centre-v1",
      opacity: 1,
      palette: "ega-weighted-243-v1",
      alpha: { threshold: 128, matte: 0 },
      scope: "art",
    },
    destination: { kind: "picture", resourceId: 1 },
  };
}

function base(over: Partial<CreativeRecoveryBase> = {}): CreativeRecoveryBase {
  return {
    revision: requireResourceRevision("a".repeat(64)),
    authoring: "b".repeat(64),
    profileId: "2.936",
    kept: 0,
    pins: [],
    ...over,
  };
}

function frame(id: string, src: CreativeSource) {
  return {
    id,
    source: src.identity,
    region: { x: 0, y: 0, width: 2, height: 2 },
    outputWidth: 2,
    outputHeight: 2,
    sourceAnchor: { x: 0, baselineEdgeY: 2 },
    outputAnchorX: 0,
    sample: "nearest-centre-v1",
    allowCropBelowBaseline: false,
    allowCropOutsideCanvas: false,
  };
}

function viewDraft(id: string, src: CreativeSource): CreativeRecipeDraft {
  return {
    identity: { id, incarnation: "inc", revision: 0 },
    sources: [src.identity],
    preparation: {
      kind: "view",
      frames: [frame("f1", src)],
      loops: [{ id: "l1", frameIds: ["f1", "queued-for-split"] }],
    },
  };
}

function envelope(): Record<string, unknown> {
  const encoded = blobBytes(1, 64);
  const src = source("s1", encoded);
  const deriv = derivative("d1", src, blobBytes(7, 32));
  const keptRecipe = recipe("r1", src);
  return {
    format: CREATIVE_RECOVERY_FORMAT,
    version: 1,
    base: { ...base(), kept: 1, pins: [keptRecipe.identity] },
    sources: [src],
    derivatives: [deriv],
    board: [
      {
        identity: { id: "b1", incarnation: "inc", revision: 0 },
        source: src.identity,
        derivative: deriv.identity,
        roles: ["style"],
        approval: "unapproved",
        notes: "the import under preparation",
      },
    ],
    recipes: [keptRecipe],
    drafts: [
      viewDraft("r2", src),
      {
        identity: { id: "r3", incarnation: "inc", revision: 0 },
        sources: [src.identity],
        notes: "crop chosen, destination not yet",
      },
    ],
    blobs: {
      [src.encoded.hash]: { ...src.encoded, buckets: ["original"] },
      [src.normalized.blob.hash]: { ...src.normalized.blob, buckets: ["canonical"] },
      [deriv.blob.hash]: { ...deriv.blob, buckets: ["disposable"] },
    },
  };
}

test("a recovery envelope round-trips records, drafts and the derived blob registry", () => {
  const stored = envelope();
  const recovery = readCreativeRecovery(structuredClone(stored));
  assert.equal(recovery.format, CREATIVE_RECOVERY_FORMAT);
  assert.equal(recovery.version, 1);
  assert.equal(recovery.sources.length, 1);
  assert.equal(recovery.drafts.length, 2);
  // The registry covers every claimed blob: original, raster, thumbnail.
  assert.deepEqual(
    creativeRecoveryBlobHashes(recovery),
    [
      recovery.sources[0]!.encoded.hash,
      recovery.sources[0]!.normalized.blob.hash,
      recovery.derivatives[0]!.blob.hash,
    ].sort(),
  );
  assert.deepEqual(recovery.blobs[recovery.derivatives[0]!.blob.hash]?.buckets, ["disposable"]);
  // Drafts keep unfinished state without fabrication: the second draft has no
  // destination or preparation, and the first has a loop naming a frame that
  // does not exist yet.
  assert.equal(recovery.drafts[0]!.preparation?.kind, "view");
  assert.equal(recovery.drafts[1]!.destination, undefined);
  assert.equal(recovery.drafts[1]!.preparation, undefined);
  assert.equal(recovery.drafts[1]!.notes, "crop chosen, destination not yet");
  const written = writeCreativeRecovery({
    base: recovery.base,
    sources: recovery.sources,
    derivatives: recovery.derivatives,
    board: recovery.board,
    recipes: recovery.recipes,
    drafts: recovery.drafts,
  });
  assert.deepEqual(readCreativeRecovery(written), recovery);
});

test("the writer canonicalizes input order and derives the blob registry", () => {
  const stored = envelope() as {
    sources: { identity: { id: string } }[];
    blobs: Record<string, unknown>;
  };
  const recovery = readCreativeRecovery(structuredClone(stored));
  const written = writeCreativeRecovery(recovery);
  // blobs is always derived: a stale caller-declared registry is refused.
  assert.deepEqual(
    Object.keys(written["blobs"] as Record<string, unknown>).sort(),
    creativeRecoveryBlobHashes(recovery).sort(),
  );
  const declaredWrong = structuredClone(stored);
  declaredWrong["blobs"] = {};
  assert.throws(
    () =>
      writeCreativeRecovery(
        declaredWrong as unknown as Parameters<typeof writeCreativeRecovery>[0],
      ),
    /does not match|referenced/i,
  );
  // Feeding a decoded envelope back with its derived registry agrees.
  assert.deepEqual(readCreativeRecovery(writeCreativeRecovery(recovery)), recovery);
});

test("unknown formats, versions and fields refuse without rewriting", () => {
  const stored = envelope();
  const badFormat = { ...structuredClone(stored), format: "agi.other" };
  let error: unknown;
  try {
    readCreativeRecovery(badFormat);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof CreativeCatalogError);
  assert.equal(error.code, "unsupported");

  const future = structuredClone(stored) as { version: number };
  future.version = 2;
  const before = structuredClone(future);
  try {
    readCreativeRecovery(future);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof CreativeCatalogError);
  assert.equal(error.code, "unsupported");
  assert.deepEqual(future, before);

  const nested = structuredClone(stored) as { sources: { version: number }[] };
  nested.sources[0]!.version = 2;
  try {
    readCreativeRecovery(nested);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof CreativeCatalogError);
  assert.equal(error.code, "unsupported");
});

test("no storage-local authority is admitted to the portable envelope", () => {
  for (const field of [
    "projectId",
    "lifetime",
    "generation",
    "head",
    "lease",
    "expiresAt",
    "receipt",
    "credentials",
  ]) {
    const stored = { ...structuredClone(envelope()), [field]: "authority" };
    assert.throws(() => readCreativeRecovery(stored), /unknown field/i, field);
  }
});

test("dangling references and pins naming absent records refuse", () => {
  // Records share the same identity object in memory; structuredClone keeps
  // that graph, so dangling references are produced by replacing the ref.
  const ghost = { id: "ghost", incarnation: "inc", revision: 0 };
  const noDerivativeSource = structuredClone(envelope()) as {
    derivatives: { source: unknown }[];
  };
  noDerivativeSource.derivatives[0]!.source = ghost;
  assert.throws(() => readCreativeRecovery(noDerivativeSource), /absent source/i);

  const noRecipeSource = structuredClone(envelope()) as {
    recipes: { sources: unknown[] }[];
  };
  noRecipeSource.recipes[0]!.sources = [ghost];
  assert.throws(() => readCreativeRecovery(noRecipeSource), /absent source|does not cover/i);

  const noDraftSource = structuredClone(envelope()) as {
    drafts: { sources: unknown[] }[];
  };
  noDraftSource.drafts[0]!.sources = [ghost];
  assert.throws(() => readCreativeRecovery(noDraftSource), /absent source/i);

  const badBoard = structuredClone(envelope()) as {
    board: { derivative: unknown }[];
  };
  badBoard.board[0]!.derivative = ghost;
  assert.throws(() => readCreativeRecovery(badBoard), /absent derivative/i);

  const absentPin = structuredClone(envelope()) as { base: { pins: unknown[] } };
  absentPin.base.pins = [ghost];
  assert.throws(() => readCreativeRecovery(absentPin), /no carried record/i);
});

test("a declared blob registry must equal the records' claims exactly", () => {
  const missing = structuredClone(envelope()) as { blobs: Record<string, unknown> };
  const first = Object.keys(missing.blobs)[0]!;
  delete missing.blobs[first];
  assert.throws(() => readCreativeRecovery(missing), /does not match|referenced/i);

  const extra = structuredClone(envelope()) as { blobs: Record<string, unknown> };
  extra.blobs["c".repeat(64)] = {
    hash: "c".repeat(64),
    byteLength: 1,
    mime: "image/png",
    buckets: ["disposable"],
  };
  assert.throws(() => readCreativeRecovery(extra), /not referenced/i);

  const wrongLength = structuredClone(envelope()) as {
    blobs: Record<string, { byteLength: number }>;
    sources: { encoded: { hash: string } }[];
  };
  wrongLength.blobs[wrongLength.sources[0]!.encoded.hash]!.byteLength += 1;
  assert.throws(() => readCreativeRecovery(wrongLength), /does not match/i);
});

test("duplicate identities and non-canonical stored order refuse", () => {
  const stored = structuredClone(envelope()) as {
    drafts: CreativeRecipeDraft[];
    sources: CreativeSource[];
  };
  stored.drafts.push(structuredClone(stored.drafts[0]!));
  assert.throws(() => readCreativeRecovery(stored), /canonical|duplicat/i);

  const unordered = structuredClone(envelope()) as { sources: CreativeSource[] };
  unordered.sources = [source("s9", blobBytes(2, 32)), source("s1", blobBytes(1, 64))];
  assert.throws(() => readCreativeRecovery(unordered), /canonical/i);
});

test("unfinished drafts keep an explicit bounded contract", () => {
  const stored = envelope() as {
    drafts: {
      destination?: unknown;
      preparation?: unknown;
      sources: unknown[];
      notes?: unknown;
    }[];
  };
  // A mirror loop without explicit approval is still refused.
  const badMirror = structuredClone(stored);
  (badMirror.drafts[0]!.preparation as { loops: object[] }).loops.push({
    id: "l2",
    mirrorOf: "l1",
    explicitlyApproved: false,
  });
  assert.throws(() => readCreativeRecovery(badMirror), /explicitlyApproved/i);

  // A loop naming frames that do not exist yet is an unfinished state, kept.
  const withDanglingCel = structuredClone(stored);
  assert.doesNotThrow(() => readCreativeRecovery(withDanglingCel));

  // Present fields keep exact validation: malformed crop and opacity refuse.
  const badCrop = structuredClone(stored);
  badCrop.drafts[1]!.preparation = {
    kind: "picture-conversion",
    crop: { x: 0, y: 0, width: -1, height: 2 },
  };
  assert.throws(() => readCreativeRecovery(badCrop), /width/i);

  const badOpacity = structuredClone(stored);
  badOpacity.drafts[1]!.preparation = { kind: "picture-conversion", opacity: 1.5 };
  assert.throws(() => readCreativeRecovery(badOpacity), /opacity/i);

  const badFit = structuredClone(stored);
  badFit.drafts[1]!.preparation = { kind: "picture-conversion", fit: "scale2x" };
  assert.throws(() => readCreativeRecovery(badFit), /fit/i);

  // A destination kind disagreeing with the preparation kind is refused.
  const disagreeing = structuredClone(stored);
  disagreeing.drafts[1]!.destination = { kind: "view", resourceId: 3 };
  disagreeing.drafts[1]!.preparation = { kind: "picture-underlay" };
  assert.throws(() => readCreativeRecovery(disagreeing), /destination/i);

  // A draft colliding with a carried recipe identity is refused.
  const colliding = structuredClone(stored) as unknown as {
    drafts: { identity: { id: string } }[];
  };
  colliding.drafts[0]!.identity.id = "r1";
  assert.throws(() => readCreativeRecovery(colliding), /collides|canonical|duplicat/i);
});

test("a coordinated ProjectDraft must share the recovery base", () => {
  const stored = envelope();
  const draft = writeProjectRecovery(
    {
      revision: requireResourceRevision("a".repeat(64)),
      authoring: "b".repeat(64),
      profileId: "2.936",
    },
    {
      changes: [{ key: "logic:1", version: 2, content: 'print("unfinished' }],
      groups: [],
    },
  );
  (stored as { projectDraft?: unknown }).projectDraft = structuredClone(draft);
  const recovery = readCreativeRecovery(structuredClone(stored));
  assert.equal(recovery.projectDraft?.documents[0]?.key, "logic:1");

  const mismatched = structuredClone(stored) as {
    projectDraft: { base: { authoring: string } };
  };
  mismatched.projectDraft.base.authoring = "c".repeat(64);
  assert.throws(() => readCreativeRecovery(mismatched), /base/i);
});

test("stored and decoded envelopes share no mutable state with their inputs", () => {
  const input = envelope();
  const written = writeCreativeRecovery(
    JSON.parse(JSON.stringify(input)) as Parameters<typeof writeCreativeRecovery>[0],
  );
  (input["sources"] as { identity: { id: string } }[])[0]!.identity.id = "mutated";
  (input["blobs"] as Record<string, { mime: string }>)[
    Object.keys(input["blobs"] as object)[0]!
  ]!.mime = "image/tampered";
  const recovered = readCreativeRecovery(written);
  assert.equal(recovered.sources[0]!.identity.id, "s1");
  assert.equal(recovered.blobs[recovered.sources[0]!.encoded.hash]!.mime, "image/png");

  const stored = envelope();
  const decoded = readCreativeRecovery(stored);
  (stored["base"] as { kept: number }).kept = 99;
  (stored["drafts"] as { notes: string }[])[1]!.notes = "mutated after read";
  assert.equal(decoded.base.kept, 1);
  assert.equal(decoded.drafts[1]!.notes, "crop chosen, destination not yet");
});
