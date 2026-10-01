import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import {
  CREATIVE_SOURCE_FORMAT,
  creativeBlobKey,
  creativeCatalogKey,
  readCreativeCatalogRecord,
  type CreativeRecipe,
  type CreativeSource,
} from "../../src/creative/catalog.ts";
import type {
  CreativeRecoveryBase,
  CreativeRecoveryData,
  CreativeRecipeDraft,
} from "../../src/creative/recovery.ts";
import { detectProfile } from "../../src/runtime/profile.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import * as storage from "../src/project/gameStorage.ts";
import type { ProjectCommitReceipt } from "../src/project/gameStorage.ts";
import {
  collectCreativeGarbage,
  holdCreativeBlobs,
  loadCreativeCatalog,
  readCreativeBlob,
  releaseCreativeLease,
  stageCreativeBlobs,
} from "../src/project/creativeStore.ts";
import {
  CreativeDraftError,
  discardCreativeDraft,
  listCreativeDrafts,
  readCreativeDraft,
  saveCreativeDraft,
  type CreativeDraftAuthority,
} from "../src/project/creativeDrafts.ts";

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

function draftOf(id: string, src: CreativeSource): CreativeRecipeDraft {
  return {
    identity: { id, incarnation: "inc", revision: 0 },
    sources: [src.identity],
    notes: "unfinished",
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
  staged: { sources?: CreativeSource[]; recipes?: CreativeRecipe[] },
  blobs: { encoded: Uint8Array; raster: Uint8Array }[],
  options: { leaseId?: string; workspace?: string; now?: () => number } = {},
) {
  return stageCreativeBlobs({
    projectId,
    expectedHead,
    lease: {
      id: options.leaseId ?? "lease-1",
      owner: "editor",
      workspace: options.workspace ?? "workspace-one",
    },
    staged: { sources: staged.sources ?? [], recipes: staged.recipes ?? [] },
    blobs: blobs.flatMap(({ encoded, raster }) => [
      { hash: sha256Hex(encoded), mime: "image/png", bytes: encoded },
      { hash: sha256Hex(raster), mime: "application/x-rgba8", bytes: raster },
    ]),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

async function keepPublication(
  projectId: ReturnType<typeof testProjectId>,
  sources: CreativeSource[],
  leaseId = "lease-1",
) {
  return {
    expectedHead: (await loadCreativeCatalog(projectId)).catalog!.head,
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
  sources: CreativeSource[],
  commitId = "keep",
  leaseId = "lease-1",
) {
  return storage.commitProject({
    ...input,
    commitId,
    expected: saved,
    creative: await keepPublication(input.projectId, sources, leaseId),
  });
}

async function baseFor(
  projectId: ReturnType<typeof testProjectId>,
  saved: ProjectCommitReceipt["saved"],
  kept: number,
  pins: CreativeRecoveryBase["pins"] = [],
): Promise<CreativeRecoveryBase> {
  const data = (await storage.loadAuthoredGame(projectId))!;
  return {
    revision: saved.revision,
    authoring: saved.authoring,
    profileId: detectProfile(new Map(Object.entries(data.files)), data.library?.profile).id,
    kept,
    pins,
  };
}

function saveInput(
  input: ReturnType<typeof request>,
  saved: ProjectCommitReceipt["saved"],
  recovery: CreativeRecoveryData,
  options: {
    workspaceId?: string;
    expectedReceipt?: { incarnation: string; sequence: number } | null;
    authority?: CreativeDraftAuthority;
    now?: () => number;
  } = {},
) {
  const workspaceId = options.workspaceId ?? "workspace-one";
  return saveCreativeDraft({
    projectId: input.projectId,
    workspaceId,
    expectedReceipt: options.expectedReceipt ?? null,
    expected: { generation: saved.generation, lifetime: saved.lifetime },
    authority: options.authority ?? {
      kind: "lease",
      lease: { id: "lease-1", owner: "editor", workspace: workspaceId },
    },
    recovery,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

const LEASE_MS = 10 * 60 * 1000;

test("a staged original, raster and recipe survive lease expiry and GC", async () => {
  const { input, first } = await boot("cdraft-survive");
  const saved = first.receipt.saved;
  const encoded = bytes(1, 512);
  const src = source("s1", encoded);
  const rec = recipe("r1", src);
  const draft = draftOf("r2", src);
  await stage(input.projectId, 0, { sources: [src], recipes: [rec] }, [
    { encoded, raster: RASTER },
  ]);
  const bodyBefore = structuredClone(records.get(input.projectId));
  const result = await saveInput(input, saved, {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [rec],
    drafts: [draft],
  });
  assert.equal(result.receipt.sequence, 1);
  // The body is untouched: generation and resource revision do not move.
  assert.deepEqual(records.get(input.projectId), bodyBefore);
  // Expire the staging lease and collect: the durable hold keeps the bytes.
  const afterLease = Date.now() + LEASE_MS;
  const gc = await collectCreativeGarbage({
    projectId: input.projectId,
    now: () => afterLease + 1,
  });
  assert.equal(gc.removed, 0);
  const listed = await listCreativeDrafts(input.projectId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.status, "current");
  assert.equal(listed[0]!.integrity, true);
  const recovered = await readCreativeDraft(input.projectId, "workspace-one");
  assert.ok(recovered !== null);
  assert.equal(recovered.status, "current");
  assert.deepEqual(recovered.staleFields, []);
  assert.equal(recovered.recovery.recipes[0]!.identity.id, "r1");
  assert.equal(recovered.recovery.drafts[0]!.notes, "unfinished");
  const original = await readCreativeBlob(input.projectId, src.encoded.hash);
  assert.deepEqual([...original.bytes], [...encoded]);
  const raster = await readCreativeBlob(input.projectId, src.normalized.blob.hash);
  assert.deepEqual([...raster.bytes], [...RASTER]);
});

test("a kept-marker-free staging catalog supports recovery without inventing Keep", async () => {
  const { input, first } = await boot("cdraft-marker0");
  const saved = first.receipt.saved;
  const encoded = bytes(1, 256);
  const src = source("s1", encoded);
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded, raster: RASTER }]);
  const { catalog, marker } = await loadCreativeCatalog(input.projectId);
  assert.equal(catalog?.kept, 0);
  assert.equal(marker, null);
  await saveInput(input, saved, {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  });
  // Staging stays staging-only: the body never gains a kept marker here.
  const after = await loadCreativeCatalog(input.projectId);
  assert.equal(after.catalog?.kept, 0);
  assert.equal(after.marker, null);
  assert.equal((records.get(input.projectId) as { creative?: unknown }).creative, undefined);
});

test("discard removes only its own row, index entry and hold, preserving the kept image", async () => {
  const { input, first } = await boot("cdraft-discard-kept");
  let saved = first.receipt.saved;
  const keptEncoded = bytes(1, 400);
  const keptSource = source("s0", keptEncoded);
  await stage(input.projectId, 0, { sources: [keptSource] }, [
    { encoded: keptEncoded, raster: RASTER },
  ]);
  const published = await publish(input, saved, [keptSource]);
  saved = published.receipt.saved;
  const pending = source("s1", bytes(2, 300));
  await stage(
    input.projectId,
    (await loadCreativeCatalog(input.projectId)).catalog!.head,
    { sources: [pending] },
    [{ encoded: bytes(2, 300), raster: RASTER }],
  );
  const { receipt } = await saveInput(input, saved, {
    base: await baseFor(input.projectId, saved, 1, [keptSource.identity]),
    sources: [pending, keptSource],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  });
  await discardCreativeDraft(input.projectId, "workspace-one", receipt);
  assert.deepEqual(await listCreativeDrafts(input.projectId), []);
  assert.equal(await readCreativeDraft(input.projectId, "workspace-one"), null);
  // The kept image, its marker and catalog survived untouched.
  const keptBytes = await readCreativeBlob(input.projectId, keptSource.encoded.hash);
  assert.deepEqual([...keptBytes.bytes], [...keptEncoded]);
  const { catalog, marker } = await loadCreativeCatalog(input.projectId);
  assert.equal(marker?.kept, 1);
  assert.equal(catalog?.kept, 1);
  assert.equal(catalog?.holds.length, 0);
});

test("replacing a recovery releases old-only hashes but keeps shared, kept, undo and live staging", async () => {
  const { input, first } = await boot("cdraft-replace-gc");
  const saved = first.receipt.saved;
  const oldEncoded = bytes(1, 400);
  const oldSource = source("s1", oldEncoded);
  const undoBytes = bytes(50, 128);
  const undoSource = source("u1", undoBytes); // claims undoBytes so it can be staged
  const liveEncoded = bytes(9, 128);
  const liveSource = source("s9", liveEncoded);
  await stage(input.projectId, 0, { sources: [oldSource, undoSource] }, [
    { encoded: oldEncoded, raster: RASTER },
    { encoded: undoBytes, raster: RASTER },
  ]);
  // A retained-undo hold on its own bytes; a second live lease keeps its own.
  const head1 = (await loadCreativeCatalog(input.projectId)).catalog!.head;
  await holdCreativeBlobs({
    projectId: input.projectId,
    hold: { id: "undo-1", kind: "retained-undo", hashes: [sha256Hex(undoBytes)] },
  });
  await stage(
    input.projectId,
    head1 + 1,
    { sources: [liveSource] },
    [{ encoded: liveEncoded, raster: RASTER }],
    { leaseId: "lease-2", workspace: "foreign-ws" },
  );
  const receipt1 = await saveInput(input, saved, {
    base: await baseFor(input.projectId, saved, 0),
    sources: [oldSource],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  });
  // Replace with a different staged source under the same workspace.
  const newSource = source("s2", bytes(3, 300));
  const head = (await loadCreativeCatalog(input.projectId)).catalog!.head;
  await stage(input.projectId, head, { sources: [newSource] }, [
    { encoded: bytes(3, 300), raster: RASTER },
  ]);
  await saveInput(
    input,
    saved,
    {
      base: await baseFor(input.projectId, saved, 0),
      sources: [newSource],
      derivatives: [],
      board: [],
      recipes: [],
      drafts: [],
    },
    { expectedReceipt: receipt1.receipt },
  );
  // Collect while both leases are still live: only the old-only encoded bytes go.
  const collected = await collectCreativeGarbage({ projectId: input.projectId });
  assert.ok(collected.removed >= 1);
  await assert.rejects(readCreativeBlob(input.projectId, oldSource.encoded.hash), /missing|found/i);
  const raster = await readCreativeBlob(input.projectId, newSource.normalized.blob.hash);
  assert.deepEqual([...raster.bytes], [...RASTER]);
  assert.deepEqual(
    [...(await readCreativeBlob(input.projectId, sha256Hex(undoBytes))).bytes],
    [...undoBytes],
  );
  assert.deepEqual(
    [...(await readCreativeBlob(input.projectId, sha256Hex(liveEncoded))).bytes],
    [...liveEncoded],
  );
});

test("two writers racing with the same receipt produce exactly one winner", async () => {
  const { input, first } = await boot("cdraft-race");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const data = {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  };
  const outcomes = await Promise.allSettled([
    saveInput(input, saved, structuredClone(data)),
    saveInput(input, saved, structuredClone(data)),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = outcomes.find(({ status }) => status === "rejected");
  assert.ok(rejected !== undefined);
  assert.ok(rejected.status === "rejected" && rejected.reason instanceof CreativeDraftError);
  const listed = await listCreativeDrafts(input.projectId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.receipt.sequence, 1);
  // The losing write published nothing partial: exactly one row, one hold.
  const catalog = (await loadCreativeCatalog(input.projectId)).catalog!;
  assert.equal(catalog.holds.filter((h) => h.kind === "recovery").length, 1);
});

test("a moved project body fences stale saves but keeps the stale recovery readable", async () => {
  const { input, first } = await boot("cdraft-stale-body");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const receipt = await saveInput(input, saved, {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  });
  const data = (await storage.loadAuthoredGame(input.projectId))!;
  assert.equal(
    await storage.saveAuthoredGame(input.projectId, { ...data, title: "Changed" }),
    true,
  );
  const listed = await listCreativeDrafts(input.projectId);
  assert.equal(listed[0]!.status, "stale");
  assert.ok(listed[0]!.staleFields.includes("generation"));
  // The stale recovery's own receipt cannot silently rebase onto the moved body.
  await assert.rejects(
    saveInput(
      input,
      saved,
      {
        base: await baseFor(input.projectId, saved, 0),
        sources: [src],
        derivatives: [],
        board: [],
        recipes: [],
        drafts: [],
      },
      { expectedReceipt: receipt.receipt },
    ),
  );
  const stale = await readCreativeDraft(input.projectId, "workspace-one");
  assert.equal(stale?.status, "stale");
  assert.equal(stale?.receipt.sequence, 1);
  await discardCreativeDraft(input.projectId, "workspace-one", receipt.receipt);
});

test("a stale history lifetime fences writes and classifies the recovery", async () => {
  const { input, first } = await boot("cdraft-stale-lifetime");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  await saveInput(input, saved, {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  });
  // The lifetime epoch moved under the row — as if the project were replaced.
  records.set(`lifetime/${input.projectId}`, {
    projectId: `lifetime/${input.projectId}`,
    epoch: "newer-epoch",
    deleted: false,
  });
  const listed = await listCreativeDrafts(input.projectId);
  assert.equal(listed[0]!.status, "stale");
  assert.ok(listed[0]!.staleFields.includes("lifetime"));
  await assert.rejects(
    saveInput(input, saved, {
      base: await baseFor(input.projectId, saved, 0),
      sources: [src],
      derivatives: [],
      board: [],
      recipes: [],
      drafts: [],
    }),
    /removed|lifetime/i,
  );
});

test("a creative Keep makes the saved recovery stale on the kept pin without losing it", async () => {
  const { input, first } = await boot("cdraft-stale-kept");
  const saved = first.receipt.saved;
  const stagedSource = source("s1", bytes(1, 300));
  await stage(input.projectId, 0, { sources: [stagedSource] }, [
    { encoded: bytes(1, 300), raster: RASTER },
  ]);
  const receipt = await saveInput(input, saved, {
    base: await baseFor(input.projectId, saved, 0),
    sources: [stagedSource],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  });
  await publish(input, saved, [stagedSource]);
  const listed = await listCreativeDrafts(input.projectId);
  assert.equal(listed[0]!.status, "stale");
  assert.ok(listed[0]!.staleFields.includes("kept"));
  const stale = await readCreativeDraft(input.projectId, "workspace-one");
  assert.equal(stale?.status, "stale");
  assert.equal(stale?.integrity, true); // the hold still covers its bytes
  await discardCreativeDraft(input.projectId, "workspace-one", receipt.receipt);
});

test("a corrupt or missing blob record refuses the save without a partial write", async () => {
  const { input, first } = await boot("cdraft-blob-corrupt");
  const saved = first.receipt.saved;
  const encoded = bytes(1, 256);
  const src = source("s1", encoded);
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded, raster: RASTER }]);
  const head = (await loadCreativeCatalog(input.projectId)).catalog!.head;
  const data = {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  };
  // Tamper with the stored blob: the save must verify bytes and refuse.
  const blobKey = creativeBlobKey(input.projectId, src.encoded.hash);
  const stored = records.get(blobKey) as { bytes: Uint8Array };
  records.set(blobKey, { ...stored, bytes: bytes(99, 256) });
  await assert.rejects(saveInput(input, saved, structuredClone(data)), CreativeDraftError);
  assert.deepEqual(await listCreativeDrafts(input.projectId), []);
  const catalog = (await loadCreativeCatalog(input.projectId)).catalog!;
  assert.equal(catalog.head, head);
  assert.equal(catalog.holds.length, 0);
  // Restore and delete instead: a missing blob record also refuses.
  records.set(blobKey, stored);
  records.delete(blobKey);
  await assert.rejects(saveInput(input, saved, structuredClone(data)), CreativeDraftError);
  assert.deepEqual(await listCreativeDrafts(input.projectId), []);
});

test("unsupported sidecar and envelope versions refuse without rewriting", async () => {
  const { input, first } = await boot("cdraft-future");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const receipt = await saveInput(input, saved, {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  });
  const rowKey = `creative/${input.projectId}/draft/workspace-one`;
  const row = records.get(rowKey) as { version: number; recovery: { version: number } };
  row.version = 999;
  const mutated = structuredClone(row);
  await assert.rejects(readCreativeDraft(input.projectId, "workspace-one"), /supported/i);
  await assert.rejects(
    saveInput(
      input,
      saved,
      {
        base: await baseFor(input.projectId, saved, 0),
        sources: [src],
        derivatives: [],
        board: [],
        recipes: [],
        drafts: [],
      },
      { expectedReceipt: receipt.receipt },
    ),
    /supported/i,
  );
  // The refused save did not rewrite or repair the row it could not trust.
  assert.deepEqual(records.get(rowKey), mutated);
});

test("caller mutation after save cannot reach the durable row", async () => {
  const { input, first } = await boot("cdraft-alias");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const recovery = {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [draftOf("r2", src)],
  };
  const pending = saveInput(input, saved, recovery);
  // Mutate the caller's structures before the write resolves.
  (recovery.sources[0]!.identity as { id: string }).id = "mutated";
  (recovery.drafts[0]!.identity as { id: string }).id = "mutated";
  recovery.drafts.length = 0;
  await pending;
  const stored = await readCreativeDraft(input.projectId, "workspace-one");
  assert.equal(stored?.recovery.sources[0]!.identity.id, "s1");
  assert.equal(stored?.recovery.drafts.length, 1);
});

test("the workspace cap refuses instead of evicting an existing recovery", async () => {
  const { input, first } = await boot("cdraft-cap");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 64));
  for (let i = 0; i < 16; i++) {
    const workspaceId = `ws-${String(i).padStart(2, "0")}`;
    const head = (await loadCreativeCatalog(input.projectId)).catalog?.head ?? 0;
    await stage(
      input.projectId,
      head,
      { sources: [src] },
      [{ encoded: bytes(1, 64), raster: RASTER }],
      { leaseId: `lease-${i}`, workspace: workspaceId },
    );
    await saveInput(
      input,
      saved,
      {
        base: await baseFor(input.projectId, saved, 0),
        sources: [src],
        derivatives: [],
        board: [],
        recipes: [],
        drafts: [],
      },
      {
        workspaceId,
        authority: {
          kind: "lease",
          lease: { id: `lease-${i}`, owner: "editor", workspace: workspaceId },
        },
      },
    );
    await releaseCreativeLease({
      projectId: input.projectId,
      lease: { id: `lease-${i}`, owner: "editor" },
    });
  }
  assert.equal((await listCreativeDrafts(input.projectId)).length, 16);
  // A 17th workspace has no eviction path: it refuses, and all 16 remain.
  const head = (await loadCreativeCatalog(input.projectId)).catalog!.head;
  await stage(
    input.projectId,
    head,
    { sources: [src] },
    [{ encoded: bytes(1, 64), raster: RASTER }],
    { leaseId: "lease-16", workspace: "ws-16" },
  );
  await assert.rejects(
    saveInput(
      input,
      saved,
      {
        base: await baseFor(input.projectId, saved, 0),
        sources: [src],
        derivatives: [],
        board: [],
        recipes: [],
        drafts: [],
      },
      {
        workspaceId: "ws-16",
        authority: {
          kind: "lease",
          lease: { id: "lease-16", owner: "editor", workspace: "ws-16" },
        },
      },
    ),
    CreativeDraftError,
  );
  assert.equal((await listCreativeDrafts(input.projectId)).length, 16);
});

test("a deliberate transaction failure leaves index, row and hold unpublished", async () => {
  const { input, first } = await boot("cdraft-atomic");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const catalogKey = creativeCatalogKey(input.projectId);
  const head = (await loadCreativeCatalog(input.projectId)).catalog!.head;
  const originalSet = records.set.bind(records);
  records.set = function (key: IDBValidKey, value: unknown) {
    if (key === catalogKey) throw new Error("injected write failure");
    return originalSet(key, value);
  };
  try {
    await assert.rejects(
      saveInput(input, saved, {
        base: await baseFor(input.projectId, saved, 0),
        sources: [src],
        derivatives: [],
        board: [],
        recipes: [],
        drafts: [],
      }),
    );
  } finally {
    records.set = originalSet;
  }
  assert.deepEqual(await listCreativeDrafts(input.projectId), []);
  const catalog = readCreativeCatalogRecord(records.get(catalogKey), input.projectId);
  assert.ok(catalog);
  assert.equal(catalog.head, head);
  assert.equal(catalog.holds.length, 0);
});

test("an owned recovery re-saves after its lease expires; a foreign lease id cannot authorize", async () => {
  const { input, first } = await boot("cdraft-authority");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const data = {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  };
  // A lease id that was never staged cannot authorize a save.
  await assert.rejects(
    saveInput(input, saved, structuredClone(data), {
      authority: {
        kind: "lease",
        lease: { id: "lease-9", owner: "editor", workspace: "workspace-one" },
      },
    }),
    CreativeDraftError,
  );
  // A lease staged by another workspace cannot authorize this workspace.
  await assert.rejects(
    saveInput(input, saved, structuredClone(data), {
      workspaceId: "workspace-two",
    }),
    CreativeDraftError,
  );
  const receipt = await saveInput(input, saved, structuredClone(data));
  // Recovery authority works without a live lease: the receipt owns it.
  const head = (await loadCreativeCatalog(input.projectId)).catalog!.head;
  const resave = await saveInput(input, saved, structuredClone(data), {
    expectedReceipt: receipt.receipt,
    authority: { kind: "recovery" },
  });
  assert.equal(resave.receipt.sequence, 2);
  assert.equal((await loadCreativeCatalog(input.projectId)).catalog!.head, head + 1);
  // Recovery authority cannot mint a first row for a foreign workspace.
  await assert.rejects(
    saveInput(input, saved, structuredClone(data), {
      workspaceId: "workspace-two",
      authority: { kind: "recovery" },
    }),
    CreativeDraftError,
  );
});

test("a record that was never staged, kept or recovered cannot ride the hold", async () => {
  const { input, first } = await boot("cdraft-pool");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  const foreign = source("s2", bytes(2, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  await assert.rejects(
    saveInput(input, saved, {
      base: await baseFor(input.projectId, saved, 0),
      sources: [src, foreign],
      derivatives: [],
      board: [],
      recipes: [],
      drafts: [],
    }),
    CreativeDraftError,
  );
  assert.deepEqual(await listCreativeDrafts(input.projectId), []);
});

test("a discarded workspace cannot be reopened by an old receipt or incarnation", async () => {
  const { input, first } = await boot("cdraft-id-reuse");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const data = {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  };
  const receipt = await saveInput(input, saved, structuredClone(data));
  await discardCreativeDraft(input.projectId, "workspace-one", receipt.receipt);
  // Recreated under the same workspace id, the fresh incarnation owns a new row.
  const again = await saveInput(input, saved, structuredClone(data));
  assert.equal(again.receipt.sequence, 1);
  assert.notEqual(again.receipt.incarnation, receipt.receipt.incarnation);
  await assert.rejects(
    saveInput(input, saved, structuredClone(data), { expectedReceipt: receipt.receipt }),
    CreativeDraftError,
  );
  await assert.rejects(
    discardCreativeDraft(input.projectId, "workspace-one", receipt.receipt),
    CreativeDraftError,
  );
});

test("a wrong-kind hold under the recovery id blocks save without being repaired", async () => {
  const { input, first } = await boot("cdraft-hold-kind");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const data = {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  };
  const receipt = await saveInput(input, saved, structuredClone(data));
  // Corrupt the row's own hold into another kind.
  const key = creativeCatalogKey(input.projectId);
  const catalog = structuredClone(records.get(key)) as {
    holds: { id: string; kind: string; hashes: string[] }[];
  };
  const holdId = `recovery-${receipt.receipt.incarnation}`;
  catalog.holds.find((entry) => entry.id === holdId)!.kind = "retained-undo";
  records.set(key, catalog);
  assert.equal((await readCreativeDraft(input.projectId, "workspace-one"))?.integrity, false);
  // Re-saving must refuse: it cannot overwrite a hold it does not own.
  await assert.rejects(
    saveInput(input, saved, structuredClone(data), {
      expectedReceipt: receipt.receipt,
      authority: { kind: "recovery" },
    }),
    CreativeDraftError,
  );
  // The foreign-kind hold survived, untouched.
  const after = readCreativeCatalogRecord(records.get(key), input.projectId);
  assert.ok(after);
  assert.equal(after.holds.find((entry) => entry.id === holdId)?.kind, "retained-undo");
  assert.equal((await readCreativeDraft(input.projectId, "workspace-one"))?.receipt.sequence, 1);
});

test("discard removes the row but preserves a same-id hold of another kind", async () => {
  const { input, first } = await boot("cdraft-discard-kind");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const receipt = await saveInput(input, saved, {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  });
  const key = creativeCatalogKey(input.projectId);
  const catalog = structuredClone(records.get(key)) as {
    holds: { id: string; kind: string }[];
  };
  const holdId = `recovery-${receipt.receipt.incarnation}`;
  catalog.holds.find((entry) => entry.id === holdId)!.kind = "retained-undo";
  records.set(key, catalog);
  await discardCreativeDraft(input.projectId, "workspace-one", receipt.receipt);
  assert.deepEqual(await listCreativeDrafts(input.projectId), []);
  const after = readCreativeCatalogRecord(records.get(key), input.projectId);
  assert.ok(after);
  assert.equal(after.holds.find((entry) => entry.id === holdId)?.kind, "retained-undo");
});

test("a recovery hold missing a referenced hash is damaged", async () => {
  const { input, first } = await boot("cdraft-hold-missing");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const receipt = await saveInput(input, saved, {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  });
  const key = creativeCatalogKey(input.projectId);
  const catalog = structuredClone(records.get(key)) as {
    holds: { id: string; hashes: string[] }[];
  };
  const hold = catalog.holds.find(
    (entry) => entry.id === `recovery-${receipt.receipt.incarnation}`,
  )!;
  hold.hashes.splice(0, 1);
  records.set(key, catalog);
  assert.equal((await readCreativeDraft(input.projectId, "workspace-one"))?.integrity, false);
  assert.equal((await listCreativeDrafts(input.projectId))[0]?.integrity, false);
});

test("a stale previous recovery cannot be rebased by a fresh lease either", async () => {
  const { input, first } = await boot("cdraft-lease-rebase");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const data = {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  };
  const receipt = await saveInput(input, saved, structuredClone(data));
  const moved = (await storage.loadAuthoredGame(input.projectId))!;
  assert.equal(await storage.saveAuthoredGame(input.projectId, { ...moved, title: "Moved" }), true);
  const current = (await storage.loadAuthoredGame(input.projectId))!;
  // A brand-new lease still cannot rebase the stale row.
  const head = (await loadCreativeCatalog(input.projectId)).catalog!.head;
  await stage(
    input.projectId,
    head,
    { sources: [src] },
    [{ encoded: bytes(1, 128), raster: RASTER }],
    { leaseId: "lease-2" },
  );
  await assert.rejects(
    saveCreativeDraft({
      projectId: input.projectId,
      workspaceId: "workspace-one",
      expectedReceipt: receipt.receipt,
      expected: { generation: storage.generationOf(current), lifetime: saved.lifetime },
      authority: {
        kind: "lease",
        lease: { id: "lease-2", owner: "editor", workspace: "workspace-one" },
      },
      recovery: structuredClone(data),
    }),
    CreativeDraftError,
  );
  assert.equal((await readCreativeDraft(input.projectId, "workspace-one"))?.receipt.sequence, 1);
});
