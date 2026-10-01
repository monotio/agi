import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/crypto.ts";
import {
  CREATIVE_SOURCE_FORMAT,
  CreativeCatalogError,
  SELECTION_COMPOSITE_ALGORITHM,
  checkSourceDerivations,
  readCreativeSource,
  versionRefKey,
  type CreativeSource,
  type CreativeSourceDerivation,
  type Rect,
  type VersionRef,
} from "../src/creative/catalog.ts";

function blobBytes(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (seed + i) & 0xff;
  return bytes;
}

function blobRef(bytes: Uint8Array, mime: string) {
  return { hash: sha256Hex(bytes), byteLength: bytes.length, mime };
}

function ref(id: string, revision = 0): VersionRef {
  return { id, incarnation: `inc-${id}`, revision };
}

function source(
  id: string,
  encoded: Uint8Array,
  raster: { bytes: Uint8Array; width: number; height: number },
  origin: CreativeSource["origin"] = { kind: "import", title: `Source ${id}` },
  derivation?: CreativeSourceDerivation,
): CreativeSource {
  return {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: ref(id),
    encoded: blobRef(encoded, "image/png"),
    availability: "original",
    normalized: {
      blob: blobRef(raster.bytes, "application/x-rgba8"),
      format: "rgba8-srgb-unpremultiplied-v1",
      width: raster.width,
      height: raster.height,
    },
    origin,
    ...(derivation !== undefined ? { derivation } : {}),
  };
}

const BASE = source("base", blobBytes(1, 32), {
  bytes: new Uint8Array(4 * 4 * 4).fill(7),
  width: 4,
  height: 4,
});
const PROVIDER = source(
  "provider",
  blobBytes(2, 48),
  { bytes: new Uint8Array(8 * 8 * 4).fill(9), width: 8, height: 8 },
  { kind: "generated", title: "Provider output" },
);
const SELECTION: Rect = { x: 1, y: 1, width: 2, height: 2 };

function compositeSource(over: Partial<CreativeSourceDerivation> = {}): CreativeSource {
  const derivation: CreativeSourceDerivation = {
    kind: "selection-composite",
    version: 1,
    base: BASE.identity,
    provider: PROVIDER.identity,
    selection: SELECTION,
    algorithm: SELECTION_COMPOSITE_ALGORITHM,
    ...over,
  };
  return source(
    "composite",
    blobBytes(3, 40),
    { bytes: new Uint8Array(4 * 4 * 4).fill(5), width: 4, height: 4 },
    { kind: "composite", title: "Edit composite" },
    derivation,
  );
}

test("a composite source round-trips its derivation through the strict codec", () => {
  const composite = compositeSource();
  const read = readCreativeSource(structuredClone(composite));
  assert.deepEqual(read, composite);
  assert.equal(read.origin.kind, "composite");
  assert.equal(read.derivation?.kind, "selection-composite");
  assert.equal(read.derivation?.version, 1);
  assert.equal(read.derivation?.algorithm, "agi.edit-selection-composite-v1");
  assert.equal(versionRefKey(read.derivation!.base), versionRefKey(BASE.identity));
});

test("a generated or imported source carries no derivation", () => {
  const plain = readCreativeSource(structuredClone(BASE));
  assert.equal(plain.derivation, undefined);
});

test("origin.kind 'composite' without derivation, and derivation on another kind, refuse", () => {
  const without = source(
    "c1",
    blobBytes(3, 40),
    { bytes: new Uint8Array(64).fill(5), width: 4, height: 4 },
    { kind: "composite", title: "Fake composite" },
  );
  assert.throws(() => readCreativeSource(structuredClone(without)), /derivation/);

  const wrongKind = source(
    "c2",
    blobBytes(3, 40),
    { bytes: new Uint8Array(64).fill(5), width: 4, height: 4 },
    { kind: "generated", title: "Wrong kind" },
    compositeSource().derivation,
  );
  assert.throws(() => readCreativeSource(structuredClone(wrongKind)), /composite/);
});

test("unknown derivation fields, kinds, versions and algorithms refuse", () => {
  const written = structuredClone(compositeSource()) as unknown as Record<string, unknown>;
  const derivation = written["derivation"] as Record<string, unknown>;

  const extra = { ...derivation, extra: 1 };
  assert.throws(() => readCreativeSource({ ...written, derivation: extra }), /unknown field/i);
  for (const [field, value] of [
    ["kind", "full-replace"],
    ["version", 2],
    ["algorithm", "agi.other-composite-v1"],
  ] as const) {
    assert.throws(
      () => readCreativeSource({ ...written, derivation: { ...derivation, [field]: value } }),
      (error: unknown) => error instanceof CreativeCatalogError && error.code === "unsupported",
    );
  }
});

test("self-parent and equal parents refuse at read", () => {
  const selfBase = compositeSource({ base: compositeSource().identity });
  assert.throws(() => readCreativeSource(structuredClone(selfBase)), /itself/);
  const equal = compositeSource({ provider: BASE.identity });
  assert.throws(() => readCreativeSource(structuredClone(equal)), /differ|distinct|same/i);
});

test("closure requires both parents, a generated provider parent and matching geometry", () => {
  const composite = compositeSource();
  assert.doesNotThrow(() => checkSourceDerivations([BASE, PROVIDER, composite]));

  assert.throws(() => checkSourceDerivations([PROVIDER, composite]), /base|missing|resolve/i);
  assert.throws(() => checkSourceDerivations([BASE, composite]), /provider|missing|resolve/i);

  const imported = source(
    "not-provider",
    blobBytes(4, 40),
    { bytes: new Uint8Array(256).fill(9), width: 8, height: 8 },
    { kind: "import", title: "Imported" },
  );
  const wrongRole = compositeSource({ provider: imported.identity });
  assert.throws(() => checkSourceDerivations([BASE, imported, wrongRole]), /generated|provider/i);

  const compositeProvider = compositeSource();
  const second = source(
    "composite2",
    blobBytes(5, 40),
    { bytes: new Uint8Array(64).fill(5), width: 4, height: 4 },
    { kind: "composite", title: "Second" },
    {
      kind: "selection-composite",
      version: 1,
      base: BASE.identity,
      provider: compositeProvider.identity,
      selection: SELECTION,
      algorithm: SELECTION_COMPOSITE_ALGORITHM,
    },
  );
  assert.throws(
    () => checkSourceDerivations([BASE, PROVIDER, compositeProvider, second]),
    /generated|provider|composite/i,
  );

  const wrongDims = source(
    "wrongdims",
    blobBytes(6, 40),
    { bytes: new Uint8Array(64).fill(5), width: 2, height: 4 },
    { kind: "composite", title: "Dims" },
    composite.derivation,
  );
  assert.throws(
    () => checkSourceDerivations([BASE, PROVIDER, wrongDims]),
    /dimension|width|height/i,
  );

  for (const selection of [
    { x: -0, y: 0, width: 5, height: 2 },
    { x: 0, y: 0, width: 2, height: 5 },
    { x: 3, y: 0, width: 2, height: 2 },
    { x: 0, y: 3, width: 2, height: 2 },
  ]) {
    assert.throws(
      () => checkSourceDerivations([BASE, PROVIDER, compositeSource({ selection })]),
      /selection|inside|bounds/i,
    );
  }
});

test("a composite base may itself be a composite; cycles and revision mismatches refuse", () => {
  const first = compositeSource();
  const nested = source(
    "nested",
    blobBytes(6, 40),
    { bytes: new Uint8Array(64).fill(5), width: 4, height: 4 },
    { kind: "composite", title: "Nested" },
    {
      kind: "selection-composite",
      version: 1,
      base: first.identity,
      provider: PROVIDER.identity,
      selection: { x: 0, y: 0, width: 4, height: 4 },
      algorithm: SELECTION_COMPOSITE_ALGORITHM,
    },
  );
  assert.doesNotThrow(() => checkSourceDerivations([BASE, PROVIDER, first, nested]));

  const mismatched = source(
    "mismatched",
    blobBytes(7, 40),
    { bytes: new Uint8Array(64).fill(5), width: 4, height: 4 },
    { kind: "composite", title: "Mismatch" },
    {
      kind: "selection-composite",
      version: 1,
      base: { ...BASE.identity, revision: 9 },
      provider: PROVIDER.identity,
      selection: SELECTION,
      algorithm: SELECTION_COMPOSITE_ALGORITHM,
    },
  );
  assert.throws(
    () => checkSourceDerivations([BASE, PROVIDER, mismatched]),
    /base|missing|resolve/i,
  );

  // Hand-built cycle: two composites naming each other as base. Such records
  // cannot come out of the codec cleanly (equal-parent rule passes here), so
  // the closure walk itself must detect the revisit.
  const a = source(
    "cycle-a",
    blobBytes(8, 40),
    { bytes: new Uint8Array(64).fill(5), width: 4, height: 4 },
    { kind: "composite", title: "A" },
    {
      kind: "selection-composite",
      version: 1,
      base: ref("cycle-b"),
      provider: PROVIDER.identity,
      selection: SELECTION,
      algorithm: SELECTION_COMPOSITE_ALGORITHM,
    },
  );
  const b = source(
    "cycle-b",
    blobBytes(9, 40),
    { bytes: new Uint8Array(64).fill(5), width: 4, height: 4 },
    { kind: "composite", title: "B" },
    {
      kind: "selection-composite",
      version: 1,
      base: ref("cycle-a"),
      provider: PROVIDER.identity,
      selection: SELECTION,
      algorithm: SELECTION_COMPOSITE_ALGORITHM,
    },
  );
  assert.throws(() => checkSourceDerivations([PROVIDER, a, b]), /cycle|revisit/i);
});

test("identity reuse with a different record refuses", () => {
  const composite = compositeSource();
  const impostor: CreativeSource = {
    ...BASE,
    origin: { kind: "import", title: "Different record, same identity" },
  };
  assert.throws(
    () => checkSourceDerivations([BASE, impostor, PROVIDER, composite]),
    /identity|reuse|different/i,
  );
});
