import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import {
  CREATIVE_RECIPE_FORMAT,
  CREATIVE_SOURCE_FORMAT,
  type CreativeBoardEntry,
  type CreativeDerivative,
  type CreativeRecipe,
  type CreativeSource,
} from "../../src/creative/catalog.ts";
import {
  creativeProjectBlobHashes,
  writeCreativeProjectManifest,
} from "../../src/creative/project.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import * as storage from "../src/project/gameStorage.ts";
import { stageCreativeBlobs } from "../src/project/creativeStore.ts";
import { captureCreativeProject } from "../src/project/creativeProjectSnapshot.ts";
import {
  buildProjectZip,
  buildPublicGameZip,
  readProjectContext,
} from "../src/archive/projectArchive.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { buildZip } from "../src/archive/zip.ts";

installIndexedDbFixture();
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
const THUMB = bytes(90, 8);

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
    origin: {
      kind: "import",
      title: `Source ${id}`,
      originUrl: "https://private.example/origin.png",
    },
  };
}

function derivative(id: string, of: CreativeSource, ofRecipe: CreativeRecipe): CreativeDerivative {
  return {
    identity: { id, incarnation: "inc", revision: 0 },
    source: of.identity,
    blob: ref(THUMB, "image/png"),
    purpose: "thumbnail",
    generatorVersion: "thumb-1",
    recipe: ofRecipe.identity,
  };
}

function boardEntry(id: string, of: CreativeSource, on: CreativeDerivative): CreativeBoardEntry {
  return {
    identity: { id, incarnation: "inc", revision: 0 },
    source: of.identity,
    derivative: on.identity,
    roles: ["exact-source", "style"],
    approval: "approved",
    notes: "a private board note",
  };
}

function recipe(id: string, of: CreativeSource): CreativeRecipe {
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
    outputPayloadHash: sha256Hex(bytes(7, 32)),
  };
}

function gameFiles() {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  return { ...Object.fromEntries(container.files), "WORDS.TOK": new Uint8Array(52) };
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
      provider: "stub",
      model: "stub",
      files: gameFiles(),
      words: [] as [string, number][],
    },
  };
}

function stagedBlobSet(...blobs: { bytes: Uint8Array; mime: string }[]) {
  return blobs.map(({ bytes: data, mime }) => ({
    hash: sha256Hex(data),
    mime,
    bytes: data,
  }));
}

/** Boot a project, stage and publish a full kept set, return its coherent snapshot. */
async function keptProject(name: string) {
  const input = request(name);
  const first = await storage.commitProject(input);
  const encoded = bytes(1, 96);
  const src = source("s1", encoded);
  const rec = recipe("r1", src);
  const deriv = derivative("d1", src, rec);
  const board = boardEntry("b1", src, deriv);
  const staged = await stageCreativeBlobs({
    projectId: input.projectId,
    expectedHead: 0,
    lease: { id: "lease-1", owner: "editor", workspace: "workspace-one" },
    staged: { sources: [src], derivatives: [deriv], recipes: [rec] },
    blobs: stagedBlobSet(
      { bytes: encoded, mime: "image/png" },
      { bytes: RASTER, mime: "application/x-rgba8" },
      { bytes: THUMB, mime: "image/png" },
    ),
  });
  const published = await storage.commitProject({
    ...input,
    commitId: "keep",
    expected: first.receipt.saved,
    creative: {
      expectedHead: staged.head,
      asOf: Date.now(),
      lease: { id: "lease-1", owner: "editor", workspace: "workspace-one" },
      keep: {
        sources: [src.identity],
        derivatives: [deriv.identity],
        recipes: [rec.identity],
        board: [board],
      },
    },
  });
  const data = (await storage.loadAuthoredGame(input.projectId))!;
  const snapshot = (await captureCreativeProject(input.projectId))!;
  return { input, first, published, data, snapshot, src, deriv, board, rec, encoded };
}

test("kept source bytes, raster, derivatives, board and recipes round-trip through the project archive", async () => {
  const { data, snapshot, src, deriv, board, rec, encoded } = await keptProject("arch-roundtrip");
  const zip = await buildProjectZip(data, undefined, undefined, undefined, undefined, snapshot);
  const opened = await readGameZip(zip);
  const creative = opened.project?.creative;
  assert.ok(creative);
  assert.deepEqual(creative.manifest, snapshot.manifest);
  assert.deepEqual(creative.manifest.sources, [src]);
  assert.deepEqual(creative.manifest.derivatives, [deriv]);
  assert.deepEqual(creative.manifest.board, [board]);
  assert.deepEqual(creative.manifest.recipes, [rec]);
  assert.equal(creative.manifest.recipes[0]!.outputPayloadHash, rec.outputPayloadHash);
  assert.deepEqual([...creative.blobs[src.encoded.hash]!], [...encoded]);
  assert.deepEqual([...creative.blobs[src.normalized.blob.hash]!], [...RASTER]);
  assert.deepEqual([...creative.blobs[deriv.blob.hash]!], [...THUMB]);
  // One stored entry per unique hash, named by its lowercase digest.
  const text = new TextDecoder("latin1").decode(zip);
  for (const hash of creativeProjectBlobHashes(creative.manifest))
    assert.ok(text.includes(`CREATIVE/${hash}.BIN`), `missing entry for ${hash}`);
});

test("the public game export carries no creative data or private creative metadata", async () => {
  const { data, snapshot } = await keptProject("arch-public");
  const publicZip = buildPublicGameZip(data);
  const text = new TextDecoder("latin1").decode(publicZip);
  assert.equal(text.includes("CREATIVE/"), false);
  assert.equal(text.includes("private.example"), false); // source origin URL stays private
  assert.equal(text.includes("a private board note"), false);
  const publicGame = await readGameZip(publicZip);
  assert.equal(publicGame.project, undefined);
  // And the project archive refuses to be built without its creative capture.
  await assert.rejects(buildProjectZip(data), /captured/i);
  void snapshot;
});

test("a project without creative data archives exactly as before", async () => {
  const input = request("arch-plain");
  await storage.commitProject(input);
  const data = (await storage.loadAuthoredGame(input.projectId))!;
  assert.equal(data.creative, undefined);
  const zip = await buildProjectZip(data);
  const opened = await readGameZip(zip);
  assert.equal(opened.project?.creative, undefined);
});

test("version-1 project envelopes refuse a creative claim outright", () => {
  const v1 = new TextEncoder().encode(
    JSON.stringify({
      format: "monotio.agi.project",
      version: 1,
      provider: "stub",
      model: "stub",
      conversation: { formatVersion: 1, messages: [] },
      authoringState: {},
      creative: { format: "monotio.agi.creative-project", version: 1 },
    }),
  );
  assert.throws(() => readProjectContext(v1, new Map(), ""), /creative/i);
});

test("the archive reader refuses missing, corrupt or mismatching creative data", async () => {
  const { snapshot, src, encoded } = await keptProject("arch-reader");
  const manifestJson = JSON.stringify({
    format: "monotio.agi.project",
    version: 2,
    authoringState: {},
    creative: writeCreativeProjectManifest(snapshot.manifest!),
  });
  const encodedEntry = `CREATIVE/${src.encoded.hash}.BIN`.toUpperCase();

  // Declared blob missing from the archive refuses.
  const missing = new TextEncoder().encode(manifestJson);
  assert.throws(() => readProjectContext(missing, new Map(), ""), /creative|missing/i);

  // Blob bytes that fail the hash check refuse.
  const tampered = new Map([[encodedEntry, bytes(9, encoded.length)]]);
  assert.throws(() => readProjectContext(missing, tampered, ""), /creative|match/i);

  // A manifest with an unknown nested version refuses.
  const futureManifest = JSON.parse(manifestJson) as {
    creative: { sources: { version: number }[] };
  };
  futureManifest.creative.sources[0]!.version = 2;
  assert.throws(
    () =>
      readProjectContext(new TextEncoder().encode(JSON.stringify(futureManifest)), tampered, ""),
    /version|unsupported/i,
  );

  // Undeclared CREATIVE entries carry no authority: declared reads alone decide.
  const full = new Map<string, Uint8Array>();
  for (const hash of creativeProjectBlobHashes(snapshot.manifest!))
    full.set(`CREATIVE/${hash}.BIN`.toUpperCase(), snapshot.blobs[hash]!);
  const stray = bytes(42, 8);
  full.set(`CREATIVE/${sha256Hex(stray)}.BIN`.toUpperCase(), stray);
  const context = readProjectContext(new TextEncoder().encode(manifestJson), full, "");
  assert.deepEqual(
    Object.keys(context.creative!.blobs).sort(),
    creativeProjectBlobHashes(snapshot.manifest!),
  );
});

test("the writer refuses a snapshot bound to another project or revision", async () => {
  const { data, snapshot } = await keptProject("arch-binding");
  const other = request("arch-binding-other");
  await storage.commitProject(other);
  const otherData = (await storage.loadAuthoredGame(other.projectId))!;

  // A snapshot offered beside another project's body refuses.
  await assert.rejects(
    buildProjectZip(
      { ...otherData, creative: { kept: 1 } },
      undefined,
      undefined,
      undefined,
      undefined,
      snapshot,
    ),
    /match this saved project|snapshot/i,
  );

  // A snapshot at a stale generation refuses.
  await assert.rejects(
    buildProjectZip(data, undefined, undefined, undefined, undefined, {
      ...snapshot,
      generation: snapshot.generation + 5,
    }),
    /match this saved project/i,
  );

  // A snapshot whose kept pin does not match the body's marker refuses.
  await assert.rejects(
    buildProjectZip(data, undefined, undefined, undefined, undefined, {
      ...snapshot,
      kept: snapshot.kept + 1,
    }),
    /match this saved project/i,
  );

  // A snapshot captured beside different playable bytes refuses on revision.
  const edited = { ...data, files: { ...data.files, "VOL.0": Uint8Array.of(9) } };
  await assert.rejects(
    buildProjectZip(edited, undefined, undefined, undefined, undefined, snapshot),
    /different game resources/i,
  );

  // A snapshot offered for a body with no creative claim refuses.
  const { creative: _marker, ...unmarked } = data;
  await assert.rejects(
    buildProjectZip(unmarked, undefined, undefined, undefined, undefined, snapshot),
    /without kept creative/i,
  );
});

test("the writer verifies every offered blob before packing", async () => {
  const { data, snapshot, src } = await keptProject("arch-verify");

  // A blobs map that does not cover the manifest refuses.
  const short = { ...snapshot.blobs };
  delete short[src.encoded.hash];
  await assert.rejects(
    buildProjectZip(data, undefined, undefined, undefined, undefined, {
      ...snapshot,
      blobs: short,
    }),
    /do not match its manifest|manifest descriptor/i,
  );

  // Bytes that fail the declared hash refuse.
  const tampered = { ...snapshot.blobs, [src.encoded.hash]: bytes(9, src.encoded.byteLength) };
  await assert.rejects(
    buildProjectZip(data, undefined, undefined, undefined, undefined, {
      ...snapshot,
      blobs: tampered,
    }),
    /manifest descriptor/i,
  );

  // A manifest that fails its own strict read refuses.
  const badSource = { ...snapshot.manifest!.sources[0], version: 2 } as unknown as CreativeSource;
  await assert.rejects(
    buildProjectZip(data, undefined, undefined, undefined, undefined, {
      ...snapshot,
      manifest: { ...snapshot.manifest!, sources: [badSource] },
    }),
    /unsupported|version/i,
  );
});

test("caller mutation while hashing cannot reach the archived bytes", async () => {
  const { data, snapshot, src, encoded } = await keptProject("arch-mutate");
  const promise = buildProjectZip(data, undefined, undefined, undefined, undefined, snapshot);
  // The offer was taken synchronously; mutating the caller's objects now —
  // while blob hashing is still in flight — must not reach the archive.
  snapshot.blobs[src.encoded.hash]!.fill(0);
  (snapshot.manifest!.sources[0]!.origin as { title: string }).title = "mutated title";
  (data as { title: string }).title = "mutated";
  const zip = await promise;
  const opened = await readGameZip(zip);
  assert.deepEqual([...opened.project!.creative!.blobs[src.encoded.hash]!], [...encoded]);
  assert.equal(opened.project!.creative!.manifest.sources[0]!.origin.title, "Source s1");
});

test("packed size is computed exactly before the output is allocated", async () => {
  const { data, snapshot } = await keptProject("arch-packed");
  const zip = await buildProjectZip(data, undefined, undefined, undefined, undefined, snapshot);
  // Walk the local headers (each begins PK\x03\x04) and hand-compute the
  // stored ZIP total: 30+name local and 46+name central per entry, +22 EOCD.
  let names = 0;
  let sizes = 0;
  let count = 0;
  for (let i = 0; i < zip.length - 4;) {
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x03 && zip[i + 3] === 0x04) {
      const view = new DataView(zip.buffer, zip.byteOffset + i);
      const nameLen = view.getUint16(26, true);
      const dataLen = view.getUint32(18, true);
      names += nameLen;
      sizes += dataLen;
      count++;
      i += 30 + nameLen + dataLen;
    } else i++;
  }
  assert.equal(zip.length, sizes + count * 76 + names * 2 + 22);
});

test("archive entry count and per-entry size refuse at their exact boundaries", async () => {
  // 1024 entries is the ceiling: 1022 playable files plus the supplied
  // OBJECT and GAME.JSON entries fit; one more file does not.
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < 1022; i++) files[`N${i}DIR`] = Uint8Array.of(1);
  const atLimit = buildPublicGameZip({ title: "t", files });
  assert.ok(atLimit.length > 0);
  files["N1022DIR"] = Uint8Array.of(1);
  assert.throws(() => buildPublicGameZip({ title: "t", files }), /1024/);

  // One entry over the 64 MB per-entry bound refuses before packing.
  const tooBig = { title: "t", files: { "VOL.0": new Uint8Array(64 * 1024 * 1024 + 1) } };
  assert.throws(() => buildPublicGameZip(tooBig), /archive size/i);
});

test("a hand-built archive with corrupt creative claims refuses on import", async () => {
  const files = gameFiles();
  const manifestless = buildZip([
    ...Object.entries(files).map(([name, data]) => ({ name, data })),
    {
      name: "PROJECT.JSON",
      data: JSON.stringify({
        format: "monotio.agi.project",
        version: 2,
        authoringState: {},
        creative: { format: "monotio.agi.creative-project", version: 1, sources: [] },
      }),
    },
  ]);
  await assert.rejects(readGameZip(manifestless), /creative|blob|field/i);
});
