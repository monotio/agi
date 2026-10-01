/**
 * Material-owned staging authority: the opaque capture the generation
 * review mints, the axes it pins, and the refusals each drift produces —
 * driven against a real CreativeMaterialWorkspace over the IndexedDB
 * fixture. Also covers atomic pair admission, forged-composite bytes,
 * rollback, double Use, the grouped undo inverse, recovery ancestry and
 * private-archive round-trips with a tampered composite. No provider or
 * network anywhere: the "provider original" here is a synthetic intake.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CREATIVE_SOURCE_FORMAT,
  RASTER_FORMAT,
  SELECTION_COMPOSITE_ALGORITHM,
  creativeBlobKey,
  versionRefKey,
  type CreativeSource,
  type Rect,
} from "../../src/creative/catalog.ts";
import { compositeSelection, encodePngRgba } from "../../src/creative/composite.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { encodePngRgb } from "../../src/picture/png.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject, type EditableProject } from "../src/project/editableProject.ts";
import { loadCreativeCatalog, readCreativeBlob } from "../src/project/creativeStore.ts";
import { clearCachedGame } from "../src/project/gameStorage.ts";
import { readCreativeDraft } from "../src/project/creativeDrafts.ts";
import {
  openCreativeWorkspace,
  type CreativeMaterialUse,
} from "../src/studio/creative/creativeWorkspace.ts";
import type { CreativeImageIntake } from "../src/references/creativeImageDecode.ts";

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

/** A real intake shape: an encoded PNG original plus its canonical raster. */
function intake(
  width: number,
  height: number,
  paint: (x: number, y: number) => readonly [number, number, number, number],
): CreativeImageIntake {
  const pixels = new Uint8Array(width * height * 4);
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const p = (y * width + x) * 4;
      pixels[p] = r;
      pixels[p + 1] = g;
      pixels[p + 2] = b;
      pixels[p + 3] = a;
      const q = (y * width + x) * 3;
      rgb[q] = r;
      rgb[q + 1] = g;
      rgb[q + 2] = b;
    }
  }
  const encodedBytes = encodePngRgb(width, height, rgb);
  return {
    format: "png",
    sourceWidth: width,
    sourceHeight: height,
    orientation: 1,
    encoded: { hash: sha256Hex(encodedBytes), byteLength: encodedBytes.length, mime: "image/png" },
    encodedBytes,
    normalized: {
      format: RASTER_FORMAT,
      width,
      height,
      blob: { hash: sha256Hex(pixels), byteLength: pixels.length, mime: "application/x-rgba8" },
    },
    pixels,
  };
}

const BASE_4X4 = intake(4, 4, () => [0, 0, 255, 255]);
const PROVIDER_4X4 = intake(4, 4, () => [0, 255, 0, 255]);
const OTHER_2X2 = intake(2, 2, () => [255, 0, 0, 255]);
const SELECTION: Rect = { x: 1, y: 1, width: 2, height: 2 };

async function seed(name: string): Promise<EditableProject> {
  const prepared = prepareLocalProject({ title: name, kind: "boilerplate" });
  await prepared.save();
  return openEditableProject(prepared.projectId);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The provider record and the composite record + bytes the host would build. */
function materialPair(
  base: CreativeSource,
  basePixels: Uint8Array,
  providerIntake: CreativeImageIntake,
  selection: Rect,
  tamper?: { forgedPixels?: Uint8Array },
) {
  const provider: CreativeSource = {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: {
      id: `source-${crypto.randomUUID()}`,
      incarnation: crypto.randomUUID(),
      revision: 0,
    },
    encoded: { ...providerIntake.encoded },
    availability: "original",
    normalized: { ...providerIntake.normalized, blob: { ...providerIntake.normalized.blob } },
    origin: { kind: "generated", title: "Provider edit" },
  };
  const composed = compositeSelection(
    { width: base.normalized.width, height: base.normalized.height, pixels: basePixels },
    {
      width: providerIntake.normalized.width,
      height: providerIntake.normalized.height,
      pixels: providerIntake.pixels,
    },
    selection,
  );
  const pixels = tamper?.forgedPixels ?? composed.pixels;
  const png = encodePngRgba(composed.width, composed.height, pixels);
  const composite: CreativeSource = {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: {
      id: `source-${crypto.randomUUID()}`,
      incarnation: crypto.randomUUID(),
      revision: 0,
    },
    encoded: { hash: sha256Hex(png), byteLength: png.length, mime: "image/png" },
    availability: "original",
    normalized: {
      blob: {
        hash: sha256Hex(pixels),
        byteLength: pixels.length,
        mime: "application/x-rgba8",
      },
      format: RASTER_FORMAT,
      width: composed.width,
      height: composed.height,
    },
    origin: { kind: "composite", title: "Composite" },
    derivation: {
      kind: "selection-composite",
      version: 1,
      base: { ...base.identity },
      provider: { ...provider.identity },
      selection: { ...selection },
      algorithm: SELECTION_COMPOSITE_ALGORITHM,
    },
  };
  return {
    provider,
    composite,
    use: {
      sources: [
        { record: provider, pixels: providerIntake.pixels, encoded: providerIntake.encodedBytes },
        { record: composite, pixels, encoded: png },
      ],
    } satisfies CreativeMaterialUse,
    pixels: composed.pixels,
    png,
  };
}

/** Seed a workspace with one imported base source. */
async function baseWorkspace(name: string) {
  const ws = await seed(name);
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  const base = await cw.importIntake(BASE_4X4, { title: "Base" });
  const basePixels = BASE_4X4.pixels;
  return { ws, cw, base, basePixels };
}

test("a material use admits the pair atomically; one undo step inverts it", async () => {
  const { ws, cw, base, basePixels } = await baseWorkspace("mat-use-basic");
  try {
    const capture = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
    const { provider, composite, use, png } = materialPair(
      base,
      basePixels,
      PROVIDER_4X4,
      SELECTION,
    );
    const undoBefore = cw.undoHistory.length;
    const result = await cw.stageMaterialUse(capture, use);
    assert.ok(!("refusal" in result), `unexpected refusal ${JSON.stringify(result)}`);
    assert.equal(result.sources.length, 2);
    assert.equal(result.recoverabilityError, null);
    assert.equal(cw.sources.length, 3);
    const [stagedProvider, stagedComposite] = cw.sources.slice(-2).map((e) => e.record);
    assert.equal(stagedProvider!.identity.id, provider.identity.id);
    assert.equal(stagedComposite!.origin.kind, "composite");

    // Bytes durably staged: composite canonical + deterministic PNG.
    const canonical = await readCreativeBlob(ws.projectId, composite.normalized.blob.hash);
    const expected = compositeSelection(
      { width: 4, height: 4, pixels: BASE_4X4.pixels },
      { width: 4, height: 4, pixels: PROVIDER_4X4.pixels },
      SELECTION,
    ).pixels;
    assert.deepEqual([...canonical.bytes], [...expected]);
    const original = await readCreativeBlob(ws.projectId, composite.encoded.hash);
    assert.deepEqual([...original.bytes], [...png]);

    // One grouped undo step; undo returns to the lone base, redo restores.
    await flush();
    assert.equal(cw.undoHistory.length, undoBefore + 1, "the pair is one undo step");
    await cw.undo();
    assert.equal(cw.sources.length, 1);
    assert.equal(cw.sources[0]!.record.identity.id, base.identity.id);
    await cw.redo();
    assert.equal(cw.sources.length, 3);
  } finally {
    await cw.dispose();
  }
});

test("a foreign workspace's capture and a fabricated capture refuse 'authority'", async () => {
  const { cw, base, basePixels } = await baseWorkspace("mat-use-foreign");
  const otherProject = await seed("mat-use-foreign-2");
  const second = openCreativeWorkspace(otherProject);
  await second.ready;
  try {
    const pair = materialPair(base, basePixels, PROVIDER_4X4, SELECTION);
    // A capture minted by another workspace — over its own pending
    // source — is live there but carries no authority here.
    const other = await second.importIntake(OTHER_2X2, { title: "Other" });
    const foreign = second.issueMaterialCapture({ keys: [versionRefKey(other.identity)] });
    const result = await cw.stageMaterialUse(foreign, pair.use);
    assert.deepEqual(result, { refusal: "authority" });
    // A fabricated object copying the real context is not the capability.
    const real = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
    const forged = { context: real.context };
    const again = await cw.stageMaterialUse(forged, {
      sources: pair.use.sources.map((entry) => ({
        record: entry.record,
        pixels: entry.pixels,
        encoded: entry.encoded,
      })),
    });
    assert.deepEqual(again, { refusal: "authority" });
    assert.equal(cw.sources.length, 1, "nothing staged");
  } finally {
    await second.dispose();
    await cw.dispose();
  }
});

test("replacing a real capture's public context cannot refresh obsolete authority", async () => {
  const { ws, cw, base, basePixels } = await baseWorkspace("mat-use-tamper");
  try {
    const capture = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
    // Move the shared draft under the issued pins, then hand the frozen
    // envelope a replacement context carrying the newer revision — direct
    // assignment and defineProperty both count.
    const before = ws.draft.capture();
    ws.draft.edit("logic:1", "return; // newer author input", before.version("logic:1"));
    const newer = { ...capture.context, draftRevision: ws.draft.capture().revision };
    try {
      Object.defineProperty(capture, "context", { value: newer });
    } catch {
      /* a frozen envelope may refuse the replacement outright */
    }
    const result = await cw.stageMaterialUse(
      capture,
      materialPair(base, basePixels, PROVIDER_4X4, SELECTION).use,
    );
    assert.deepEqual(result, { refusal: "superseded" });
    assert.equal(cw.sources.length, 1, "no source joined the pending set");
    const { catalog } = await loadCreativeCatalog(ws.projectId);
    assert.equal(
      catalog?.leases[0]?.staged.sources.length ?? 0,
      1,
      "no durable admission happened",
    );
  } finally {
    await cw.dispose();
  }
});

test("a cyclical composite offered at the entry point refuses promptly", async () => {
  const { cw, base, basePixels } = await baseWorkspace("mat-use-cycle");
  try {
    const capture = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
    const honest = materialPair(base, basePixels, PROVIDER_4X4, SELECTION);
    // Two composites each naming the other as base: structurally valid
    // records, self-consistent bytes, but the ancestry is a cycle.
    const a = honest.composite;
    const b: CreativeSource = {
      ...honest.provider,
      identity: {
        id: `source-${crypto.randomUUID()}`,
        incarnation: crypto.randomUUID(),
        revision: 0,
      },
      origin: { kind: "composite" as const, title: "Looping composite" },
      derivation: {
        kind: "selection-composite" as const,
        version: 1 as const,
        base: { ...a.identity },
        provider: { ...honest.provider.identity },
        selection: { ...SELECTION },
        algorithm: SELECTION_COMPOSITE_ALGORITHM,
      },
    };
    const cycledA = {
      ...a,
      derivation: { ...a.derivation!, base: { ...b.identity } },
    };
    const result = await cw.stageMaterialUse(capture, {
      sources: [
        {
          record: cycledA,
          pixels: honest.use.sources[1]!.pixels,
          encoded: honest.use.sources[1]!.encoded,
        },
        {
          record: b,
          pixels: honest.use.sources[0]!.pixels,
          encoded: honest.use.sources[0]!.encoded,
        },
        honest.use.sources[0]!,
      ],
    });
    assert.deepEqual(result, { refusal: "conflict" });
    assert.equal(cw.sources.length, 1);
  } finally {
    await cw.dispose();
  }
});

test("drift on every pinned axis refuses 'superseded' before any write", async () => {
  // Workspace version: an unrelated import moves the capture's pin.
  {
    const { cw, base, basePixels } = await baseWorkspace("mat-use-version");
    try {
      const capture = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
      await cw.importIntake(OTHER_2X2, { title: "Unrelated" });
      const result = await cw.stageMaterialUse(
        capture,
        materialPair(base, basePixels, PROVIDER_4X4, SELECTION).use,
      );
      assert.deepEqual(result, { refusal: "superseded" });
      assert.equal(cw.sources.length, 2);
    } finally {
      await cw.dispose();
    }
  }
  // Shared draft revision: an unrelated document edit moves the pin.
  {
    const { ws, cw, base, basePixels } = await baseWorkspace("mat-use-draft");
    try {
      const capture = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
      const snapshot = ws.draft.capture();
      ws.draft.apply(
        ws.draft.propose(snapshot, "Foreign edit", [
          { key: "picture:1", content: new Uint8Array([1, 2, 3]) },
        ]),
      );
      const result = await cw.stageMaterialUse(
        capture,
        materialPair(base, basePixels, PROVIDER_4X4, SELECTION).use,
      );
      assert.deepEqual(result, { refusal: "superseded" });
      assert.equal(cw.sources.length, 1);
    } finally {
      await cw.dispose();
    }
  }
  // Saved identity + kept revision: a Keep moves them together.
  {
    const { cw, base, basePixels } = await baseWorkspace("mat-use-keep");
    try {
      const capture = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
      await cw.keep();
      const result = await cw.stageMaterialUse(
        capture,
        materialPair(base, basePixels, PROVIDER_4X4, SELECTION).use,
      );
      assert.deepEqual(result, { refusal: "superseded" });
      assert.equal(cw.sources.length, 0);
    } finally {
      await cw.dispose();
    }
  }
});

test("a moved consulted record's bytes refuse 'unavailable'", async () => {
  const { ws, cw, base, basePixels } = await baseWorkspace("mat-use-missing");
  try {
    // Keep the base, then delete its canonical blob: a consulted parent
    // record still resolves but its bytes are gone.
    await cw.keep();
    const capture = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
    const pair = materialPair(base, basePixels, PROVIDER_4X4, SELECTION);
    records.delete(creativeBlobKey(ws.projectId, base.normalized.blob.hash));
    const result = await cw.stageMaterialUse(capture, pair.use);
    assert.deepEqual(result, { refusal: "unavailable" });
    assert.equal(cw.sources.length, 0, "nothing joined the pending set");
  } finally {
    await cw.dispose();
  }
});

test("an aborted signal refuses 'cancelled' even while queued", async () => {
  const { cw, base, basePixels } = await baseWorkspace("mat-use-abort");
  try {
    const capture = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
    const controller = new AbortController();
    const pending = cw.stageMaterialUse(capture, {
      ...materialPair(base, basePixels, PROVIDER_4X4, SELECTION).use,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    assert.deepEqual(result, { refusal: "cancelled" });
    assert.equal(cw.sources.length, 1);
    // A pre-aborted issue refuses outright.
    assert.throws(() => cw.issueMaterialCapture({ keys: [], signal: controller.signal }), /abort/i);
  } finally {
    await cw.dispose();
  }
});

test("a removed project moves the pinned lifetime and the stage refuses", async () => {
  const { ws, cw, base, basePixels } = await baseWorkspace("mat-use-conflict");
  try {
    const capture = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
    // The project is deleted under us: the history-lifetime CAS inside the
    // serialized stage transaction refuses the write by name rather than
    // resurrecting rows into a removed project.
    await clearCachedGame(ws.projectId);
    const result = await cw.stageMaterialUse(
      capture,
      materialPair(base, basePixels, PROVIDER_4X4, SELECTION).use,
    );
    assert.deepEqual(result, { refusal: "unavailable" });
    assert.equal(cw.sources.length, 1, "the pending set is untouched");
  } finally {
    await cw.dispose();
  }
});

test("a hash-correct forged composite refuses before anything writes", async () => {
  const { cw, base, basePixels } = await baseWorkspace("mat-use-forge");
  try {
    const capture = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
    // Forged canonical pixels — wrong transform, but every descriptor and
    // hash recomputed so the record is internally consistent.
    const forged = new Uint8Array(4 * 4 * 4).fill(1);
    const pair = materialPair(base, basePixels, PROVIDER_4X4, SELECTION, {
      forgedPixels: forged,
    });
    const result = await cw.stageMaterialUse(capture, pair.use);
    assert.deepEqual(result, { refusal: "conflict" });
    assert.equal(cw.sources.length, 1, "the forge never touched the pending set");
  } finally {
    await cw.dispose();
  }
});

test("a use queued before dispose still completes, then the workspace closes", async () => {
  const { cw, base, basePixels } = await baseWorkspace("mat-use-dispose-race");
  const capture = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
  const pending = cw.stageMaterialUse(
    capture,
    materialPair(base, basePixels, PROVIDER_4X4, SELECTION).use,
  );
  const disposing = cw.dispose();
  // The serialized tail finishes the admitted stage before disposal's own
  // recovery save: the work is durable, then the workspace closes.
  const result = await pending;
  assert.ok(!("refusal" in result));
  await disposing;
  const after = await cw.stageMaterialUse(
    capture,
    materialPair(base, basePixels, PROVIDER_4X4, SELECTION).use,
  );
  assert.deepEqual(after, { refusal: "closed" });
});

test("a second use of the same capture refuses; disposal revokes the capture", async () => {
  const { cw, base, basePixels } = await baseWorkspace("mat-use-double");
  try {
    const capture = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
    const pair = materialPair(base, basePixels, PROVIDER_4X4, SELECTION);
    const first = await cw.stageMaterialUse(capture, pair.use);
    assert.ok(!("refusal" in first));
    // The commit advanced the pinned version: the same capture cannot
    // stage the pair again — no duplicates, a typed refusal instead.
    const second = await cw.stageMaterialUse(capture, pair.use);
    assert.deepEqual(second, { refusal: "superseded" });
    assert.equal(cw.sources.length, 3);
    await cw.dispose();
    const after = await cw.stageMaterialUse(capture, pair.use);
    assert.deepEqual(after, { refusal: "closed" });
  } finally {
    await cw.dispose();
  }
});

test("recovery carries the kept parent a pending composite needs; reopen restores it", async () => {
  const { ws, cw, base, basePixels } = await baseWorkspace("mat-use-recovery");
  try {
    await cw.keep(); // the base is kept
    const capture = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
    const pair = materialPair(base, basePixels, PROVIDER_4X4, SELECTION);
    const staged = await cw.stageMaterialUse(capture, pair.use);
    assert.ok(!("refusal" in staged));
    await cw.saveRecovery();
    const row = await readCreativeDraft(ws.projectId, ws.workspaceId);
    assert.ok(row !== null);
    const carried = row.recovery.sources.map((entry) => versionRefKey(entry.identity));
    // Composite, provider AND the kept base travel in the recovery set.
    assert.ok(carried.includes(versionRefKey(pair.composite.identity)));
    assert.ok(carried.includes(versionRefKey(pair.provider.identity)));
    assert.ok(carried.includes(versionRefKey(base.identity)), "kept parent carried");
    const pins = row.recovery.base.pins.map(versionRefKey);
    assert.ok(pins.includes(versionRefKey(base.identity)));

    // A cold reopen adopts the row and resolves the pair plus the parent.
    const again = openCreativeWorkspace(ws);
    await again.ready;
    try {
      await again.restoreRecovery(ws.workspaceId);
      const keys = again.sources.map((entry) => versionRefKey(entry.record.identity));
      assert.ok(keys.includes(versionRefKey(pair.composite.identity)));
      assert.ok(keys.includes(versionRefKey(pair.provider.identity)));
    } finally {
      await again.dispose();
    }
  } finally {
    await cw.dispose();
  }
});

test("a nested composite derives from a composite base; Keep seals the chain", async () => {
  const { ws, cw, base, basePixels } = await baseWorkspace("mat-use-nested");
  try {
    // First composite: base -> composite1.
    const first = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
    const pair1 = materialPair(base, basePixels, PROVIDER_4X4, SELECTION);
    assert.ok(!("refusal" in (await cw.stageMaterialUse(first, pair1.use))));
    // Second composite: composite1 -> composite2 over a different selection.
    const inner: Rect = { x: 0, y: 0, width: 1, height: 1 };
    const capture2 = cw.issueMaterialCapture({ keys: [versionRefKey(pair1.composite.identity)] });
    const pair2 = materialPair(pair1.composite, pair1.pixels, OTHER_2X2, inner);
    const second = await cw.stageMaterialUse(capture2, pair2.use);
    assert.ok(!("refusal" in second), `nested stage refused: ${JSON.stringify(second)}`);
    assert.equal(cw.sources.length, 5, "base + two pairs");

    await cw.keep();
    const { catalog } = await loadCreativeCatalog(ws.projectId);
    assert.equal(catalog?.sources.length, 5);
    const nested = catalog?.sources.find(
      (entry) => entry.identity.id === pair2.composite.identity.id,
    );
    assert.ok(nested?.derivation !== undefined);
    assert.equal(nested.derivation.base.id, pair1.composite.identity.id);
    // Every ancestor survives the Keep and stays byte-readable.
    for (const source of catalog!.sources) {
      const raster = await readCreativeBlob(ws.projectId, source.normalized.blob.hash);
      assert.equal(raster.bytes.length, source.normalized.blob.byteLength);
    }
  } finally {
    await cw.dispose();
  }
});

test("the private archive round-trips composite ancestry; a hash-correct pixel lie refuses", async () => {
  const { ws, cw, base, basePixels } = await baseWorkspace("mat-use-archive");
  try {
    const capture = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
    const pair = materialPair(base, basePixels, PROVIDER_4X4, SELECTION);
    assert.ok(!("refusal" in (await cw.stageMaterialUse(capture, pair.use))));
    await cw.keep();

    // The kept manifest travels in the private project archive with the
    // composite's whole ancestry, and the transform still verifies on read.
    const { captureCreativeProject } = await import("../src/project/creativeProjectSnapshot.ts");
    const { loadAuthoredGame } = await import("../src/project/gameStorage.ts");
    const { buildProjectZip } = await import("../src/archive/projectArchive.ts");
    const { readGameZip } = await import("../src/archive/gameZip.ts");
    const snapshot = (await captureCreativeProject(ws.projectId))!;
    assert.ok(snapshot !== null && snapshot.manifest !== null);
    const data = (await loadAuthoredGame(ws.projectId))!;
    const zip = await buildProjectZip(data, undefined, undefined, undefined, undefined, snapshot);
    const opened = await readGameZip(zip);
    const carried = opened.project!.creative!.manifest.sources;
    const composite = carried.find((entry) => entry.origin.kind === "composite")!;
    assert.ok(composite !== undefined);
    assert.deepEqual(composite.derivation, {
      kind: "selection-composite",
      version: 1,
      base: pair.composite.derivation!.base,
      provider: pair.composite.derivation!.provider,
      selection: SELECTION,
      algorithm: SELECTION_COMPOSITE_ALGORITHM,
    });
    // Both parents and the deterministic PNG original arrive byte-exact.
    for (const source of carried) {
      const raster = opened.project!.creative!.blobs[source.normalized.blob.hash]!;
      assert.ok(raster !== undefined);
      assert.equal(sha256Hex(raster), source.normalized.blob.hash);
      const original = opened.project!.creative!.blobs[source.encoded.hash]!;
      assert.equal(sha256Hex(original), source.encoded.hash);
    }

    // Forge: a recomputed-hash descriptor over pixels the transform did not
    // produce — the archive's byte admission must refuse the manifest.
    const forged = new Uint8Array(composite.normalized.blob.byteLength).fill(7);
    const forgedHash = sha256Hex(forged);
    const oldHash = composite.normalized.blob.hash;
    const registered = snapshot.manifest!.blobs[oldHash]!;
    const registry = { ...snapshot.manifest!.blobs };
    delete registry[oldHash];
    registry[forgedHash] = { ...registered, hash: forgedHash };
    const tamperedBlobs = { ...snapshot.blobs };
    delete tamperedBlobs[oldHash];
    tamperedBlobs[forgedHash] = forged;
    const tampered = {
      ...snapshot,
      manifest: {
        ...snapshot.manifest!,
        blobs: registry,
        sources: snapshot.manifest!.sources.map((entry) =>
          entry.identity.id === composite.identity.id
            ? {
                ...entry,
                normalized: {
                  ...entry.normalized,
                  blob: {
                    hash: forgedHash,
                    byteLength: forged.length,
                    mime: entry.normalized.blob.mime,
                  },
                },
              }
            : entry,
        ),
      },
      blobs: tamperedBlobs,
    };
    const badZip = await buildProjectZip(
      data,
      undefined,
      undefined,
      undefined,
      undefined,
      tampered,
    );
    await assert.rejects(readGameZip(badZip), /not produced by|transform|composite/i);
  } finally {
    await cw.dispose();
  }
});

test("admitted work with a refused autosave stays visible and reports recoverabilityError", async () => {
  const ws = await seed("mat-use-autosave");
  const cw = openCreativeWorkspace(ws);
  await cw.ready;
  try {
    const base = await cw.importIntake(BASE_4X4, { title: "Base" });
    // A foreign row CAS'd over this workspace's receipt makes the next
    // autosave refuse while the stage itself stays admitted. The import
    // already autosaved once, so the foreign write must chain that receipt.
    const saved = ws.savedIdentity();
    const { saveCreativeDraft } = await import("../src/project/creativeDrafts.ts");
    const existing = await readCreativeDraft(ws.projectId, ws.workspaceId);
    assert.ok(existing !== null, "the import autosaved a draft row");
    await saveCreativeDraft({
      projectId: ws.projectId,
      workspaceId: ws.workspaceId,
      expectedReceipt: existing.receipt,
      expected: { generation: saved.generation, lifetime: saved.lifetime },
      authority: {
        kind: "lease",
        lease: { id: cw.leaseId, owner: ws.workspaceId, workspace: ws.workspaceId },
      },
      recovery: {
        base: {
          revision: saved.revision,
          authoring: saved.authoring,
          profileId: ws.profileId,
          kept: 0,
          pins: [],
        },
        sources: [],
        derivatives: [],
        board: [],
        recipes: [],
        drafts: [],
      },
    });
    const capture = cw.issueMaterialCapture({ keys: [versionRefKey(base.identity)] });
    const pair = materialPair(base, BASE_4X4.pixels, PROVIDER_4X4, SELECTION);
    const result = await cw.stageMaterialUse(capture, pair.use);
    assert.ok(!("refusal" in result), "the stage is admitted despite the failed save");
    assert.equal(cw.sources.length, 3, "the admitted pair is visible");
    assert.ok(result.recoverabilityError !== null, "the recoverability gap is named");
  } finally {
    await cw.dispose();
  }
});
