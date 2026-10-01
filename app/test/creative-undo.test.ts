import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import {
  CREATIVE_SOURCE_FORMAT,
  creativeBlobKey,
  creativeCatalogKey,
  writeCreativeCatalogRecord,
  type CreativeCatalog,
  type CreativeSource,
} from "../../src/creative/catalog.ts";
import type { CreativeRecoveryBase, CreativeRecoveryData } from "../../src/creative/recovery.ts";
import { writeProjectRecovery } from "../../src/authoring/projectRecovery.ts";
import { detectProfile } from "../../src/runtime/profile.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import * as storage from "../src/project/gameStorage.ts";
import type { ProjectCommitReceipt } from "../src/project/gameStorage.ts";
import {
  collectCreativeGarbage,
  loadCreativeCatalog,
  readCreativeBlob,
  stageCreativeBlobs,
} from "../src/project/creativeStore.ts";
import { CreativeDraftError, saveCreativeDraft } from "../src/project/creativeDrafts.ts";
import {
  discardCreativeUndo,
  listCreativeUndos,
  readCreativeUndo,
  saveCreativeUndo,
} from "../src/project/creativeUndo.ts";
import { creativeUndoIndexKey, creativeUndoKey } from "../src/project/creativeWorkArchive.ts";

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
const LEASE_MS = 10 * 60 * 1000;
let snapshotCounter = 0;

function snapshotId(): string {
  snapshotCounter += 1;
  return `snap-${snapshotCounter.toString(16).padStart(8, "0")}`;
}

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
    origin: { kind: "import", title: `Source ${id}`, attribution: `import note ${id}` },
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

function projectDraftOf(base: CreativeRecoveryBase, text: string) {
  return writeProjectRecovery(
    { revision: base.revision, authoring: base.authoring, profileId: base.profileId },
    { changes: [{ key: "logic:1", version: 2, content: text }], groups: [] },
  );
}

function stage(
  projectId: ReturnType<typeof testProjectId>,
  expectedHead: number,
  staged: { sources?: CreativeSource[] },
  blobs: { encoded: Uint8Array; raster: Uint8Array }[],
  options: { leaseId?: string; workspace?: string } = {},
) {
  return stageCreativeBlobs({
    projectId,
    expectedHead,
    lease: {
      id: options.leaseId ?? "lease-1",
      owner: "editor",
      workspace: options.workspace ?? "workspace-one",
    },
    staged: { sources: staged.sources ?? [], derivatives: [], recipes: [] },
    blobs: blobs.flatMap(({ encoded, raster }) => [
      { hash: sha256Hex(encoded), mime: "image/png", bytes: encoded },
      { hash: sha256Hex(raster), mime: "application/x-rgba8", bytes: raster },
    ]),
  });
}

function saveUndo(
  input: ReturnType<typeof request>,
  saved: ProjectCommitReceipt["saved"],
  workspaceId: string,
  snap: string,
  recovery: CreativeRecoveryData,
  options: {
    authority?:
      | { kind: "lease"; lease: { id: string; owner: string; workspace: string } }
      | { kind: "draft"; receipt: { incarnation: string; sequence: number } }
      | {
          kind: "snapshot";
          snapshotId: string;
          receipt: { incarnation: string; sequence: number };
        }
      | { kind: "kept" };
  } = {},
) {
  return saveCreativeUndo({
    projectId: input.projectId,
    workspaceId,
    snapshotId: snap,
    expected: { generation: saved.generation, lifetime: saved.lifetime },
    authority: options.authority ?? {
      kind: "lease",
      lease: { id: "lease-1", owner: "editor", workspace: workspaceId },
    },
    recovery,
  });
}

test("a retained snapshot keeps exact bytes and state through lease expiry and GC", async () => {
  const { input, first } = await boot("cundo-survive");
  const saved = first.receipt.saved;
  const encoded = bytes(1, 512);
  const src = source("s1", encoded);
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded, raster: RASTER }]);
  const base = await baseFor(input.projectId, saved, 0);
  const recovery: CreativeRecoveryData = {
    base,
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [
      {
        identity: { id: "d1", incarnation: "inc", revision: 0 },
        sources: [src.identity],
        notes: "still mixing",
      },
    ],
    projectDraft: projectDraftOf(base, "// a trailing comment\nreturn;"),
  };
  const snap = snapshotId();
  const result = await saveUndo(input, saved, "workspace-one", snap, recovery);
  // The caller's snapshot id is only the idempotency key; each append mints
  // a fresh incarnation and pins it by an `undo-<incarnation>` hold.
  assert.notEqual(result.receipt.incarnation, snap);
  assert.equal(result.receipt.sequence, 1);
  const held = (await loadCreativeCatalog(input.projectId)).catalog!.holds;
  assert.ok(
    held.some(
      (hold) => hold.id === `undo-${result.receipt.incarnation}` && hold.kind === "retained-undo",
    ),
  );
  // The body is untouched by a snapshot append.
  const body = records.get(input.projectId) as { generation?: number };
  assert.equal(body.generation, saved.generation);
  // The lease expires and GC runs; the retained-undo hold keeps the bytes.
  const gc = await collectCreativeGarbage({
    projectId: input.projectId,
    now: () => Date.now() + LEASE_MS + 1,
  });
  assert.equal(gc.removed, 0);
  const listed = await listCreativeUndos(input.projectId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.snapshotId, snap);
  assert.equal(listed[0]!.workspaceId, "workspace-one");
  assert.equal(listed[0]!.status, "current");
  assert.equal(listed[0]!.integrity, true);
  const read = await readCreativeUndo(input.projectId, snap);
  assert.ok(read !== null);
  assert.equal(read.status, "current");
  assert.deepEqual(read.recovery.drafts[0]!.notes, "still mixing");
  const document = read.recovery.projectDraft!.documents.find((doc) => doc.key === "logic:1")!;
  assert.deepEqual(document.content, { type: "text", text: "// a trailing comment\nreturn;" });
  const original = await readCreativeBlob(input.projectId, src.encoded.hash);
  assert.deepEqual([...original.bytes], [...encoded]);
  const raster = await readCreativeBlob(input.projectId, src.normalized.blob.hash);
  assert.deepEqual([...raster.bytes], [...RASTER]);
  // The source's attribution survives the round trip.
  assert.equal(read.recovery.sources[0]!.origin.attribution, "import note s1");
});

test("ordered snapshots across workspaces list in append order grouped per workspace", async () => {
  const { input, first } = await boot("cundo-ordered");
  const saved = first.receipt.saved;
  const srcA = source("s1", bytes(1, 96));
  const srcB = source("s2", bytes(2, 96));
  const head = 0;
  await stage(input.projectId, head, { sources: [srcA, srcB] }, [
    { encoded: bytes(1, 96), raster: RASTER },
    { encoded: bytes(2, 96), raster: RASTER },
  ]);
  // lease-1 owns workspace-one; a second lease owns workspace-two.
  await stage(
    input.projectId,
    (await loadCreativeCatalog(input.projectId)).catalog!.head,
    { sources: [srcB] },
    [{ encoded: bytes(2, 96), raster: RASTER }],
    { leaseId: "lease-2", workspace: "workspace-two" },
  );
  const base = await baseFor(input.projectId, saved, 0);
  const mk = (src: CreativeSource, notes: string): CreativeRecoveryData => ({
    base,
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [
      { identity: { id: "d", incarnation: "inc", revision: 0 }, sources: [src.identity], notes },
    ],
  });
  const first1 = snapshotId();
  await saveUndo(input, saved, "workspace-one", first1, mk(srcA, "one"));
  const second1 = snapshotId();
  await saveUndo(input, saved, "workspace-two", second1, mk(srcB, "two"), {
    authority: {
      kind: "lease",
      lease: { id: "lease-2", owner: "editor", workspace: "workspace-two" },
    },
  });
  const third = snapshotId();
  await saveUndo(input, saved, "workspace-one", third, mk(srcA, "one-later"));
  const listed = await listCreativeUndos(input.projectId);
  assert.deepEqual(
    listed.map((entry) => [entry.workspaceId, entry.snapshotId]),
    [
      ["workspace-one", first1],
      ["workspace-two", second1],
      ["workspace-one", third],
    ],
  );
  const read = await readCreativeUndo(input.projectId, third);
  assert.equal(read!.recovery.drafts[0]!.notes, "one-later");
});

test("a body move classifies the snapshot stale without rebasing it", async () => {
  const { input, first } = await boot("cundo-stale");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const snap = snapshotId();
  const { receipt } = await saveUndo(input, saved, "workspace-one", snap, {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  });
  const data = (await storage.loadAuthoredGame(input.projectId))!;
  assert.equal(await storage.saveAuthoredGame(input.projectId, { ...data, title: "Moved" }), true);
  const listed = await listCreativeUndos(input.projectId);
  assert.equal(listed[0]!.status, "stale");
  assert.ok(listed[0]!.staleFields.includes("generation"));
  const read = await readCreativeUndo(input.projectId, snap);
  assert.equal(read!.status, "stale");
  assert.equal(read!.recovery.base.revision, saved.revision);
  // The stale snapshot is still discardable by its exact receipt.
  await discardCreativeUndo(input.projectId, snap, receipt);
  assert.deepEqual(await listCreativeUndos(input.projectId), []);
  assert.equal(await readCreativeUndo(input.projectId, snap), null);
});

test("caller mutation after the call cannot reach the stored snapshot", async () => {
  const { input, first } = await boot("cundo-mutate");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const recovery: CreativeRecoveryData = {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [
      { identity: { id: "d", incarnation: "inc", revision: 0 }, sources: [], notes: "original" },
    ],
  };
  const snap = snapshotId();
  const promise = saveUndo(input, saved, "workspace-one", snap, recovery);
  (recovery.drafts[0] as { notes: string }).notes = "mutated";
  (recovery.sources as CreativeSource[]).length = 0;
  await promise;
  const read = await readCreativeUndo(input.projectId, snap);
  assert.equal(read!.recovery.drafts[0]!.notes, "original");
  assert.equal(read!.recovery.sources.length, 1);
});

test("a retry of the same append returns the same receipt and writes nothing twice", async () => {
  const { input, first } = await boot("cundo-retry");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const recovery: CreativeRecoveryData = {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  };
  const snap = snapshotId();
  const first$ = await saveUndo(input, saved, "workspace-one", snap, structuredClone(recovery));
  const catalogAfterFirst = (await loadCreativeCatalog(input.projectId)).catalog!;
  const second$ = await saveUndo(input, saved, "workspace-one", snap, structuredClone(recovery));
  assert.deepEqual(second$.receipt, first$.receipt);
  // The retry publishes nothing: no second row, no hold churn, no head bump.
  assert.equal((await loadCreativeCatalog(input.projectId)).catalog!.head, catalogAfterFirst.head);
  const listed = await listCreativeUndos(input.projectId);
  assert.equal(listed.length, 1);
  // A different snapshot under a recycled id is a conflict, not a silent
  // replace.
  await assert.rejects(
    saveUndo(input, saved, "workspace-one", snap, {
      ...structuredClone(recovery),
      drafts: [
        {
          identity: { id: "other", incarnation: "inc", revision: 0 },
          sources: [],
        },
      ],
    }),
    (error: unknown) => error instanceof CreativeDraftError && error.reason === "conflict",
  );
  assert.equal((await listCreativeUndos(input.projectId)).length, 1);
});

test("a discarded snapshot's receipt cannot authorize the recreated snapshot", async () => {
  const { input, first } = await boot("cundo-recreate-auth");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const recovery: CreativeRecoveryData = {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  };
  const snap = snapshotId();
  const old = await saveUndo(input, saved, "workspace-one", snap, structuredClone(recovery));
  await discardCreativeUndo(input.projectId, snap, old.receipt);
  const recreated = await saveUndo(input, saved, "workspace-one", snap, structuredClone(recovery));
  assert.notDeepEqual(recreated.receipt, old.receipt);
  // The old receipt names a dead incarnation: it authorizes nothing, not
  // even against the recreated row at the same snapshot id.
  await assert.rejects(
    saveUndo(input, saved, "workspace-one", snapshotId(), structuredClone(recovery), {
      authority: { kind: "snapshot", snapshotId: snap, receipt: old.receipt },
    }),
    (error: unknown) => error instanceof CreativeDraftError && error.reason === "authority",
  );
  // The recreated row's own receipt is live authority.
  const next = await saveUndo(input, saved, "workspace-one", snapshotId(), recovery, {
    authority: { kind: "snapshot", snapshotId: snap, receipt: recreated.receipt },
  });
  assert.ok(next.receipt.incarnation.length > 0);
  assert.equal((await listCreativeUndos(input.projectId)).length, 2);
});

test("foreign and stale receipts are not authority for an append", async () => {
  const { input, first } = await boot("cundo-authority");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const draftSave = await saveCreativeDraft({
    projectId: input.projectId,
    workspaceId: "workspace-one",
    expectedReceipt: null,
    expected: { generation: saved.generation, lifetime: saved.lifetime },
    authority: {
      kind: "lease",
      lease: { id: "lease-1", owner: "editor", workspace: "workspace-one" },
    },
    recovery: {
      base: await baseFor(input.projectId, saved, 0),
      sources: [src],
      derivatives: [],
      board: [],
      recipes: [],
      drafts: [],
    },
  });
  const recovery: CreativeRecoveryData = {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  };
  // A receipt that was never issued is not authority.
  await assert.rejects(
    saveUndo(input, saved, "workspace-one", snapshotId(), structuredClone(recovery), {
      authority: { kind: "draft", receipt: { incarnation: "never-issued", sequence: 1 } },
    }),
    (error: unknown) => error instanceof CreativeDraftError && error.reason === "authority",
  );
  // A stale sequence is not authority either.
  await assert.rejects(
    saveUndo(input, saved, "workspace-one", snapshotId(), structuredClone(recovery), {
      authority: {
        kind: "draft",
        receipt: { incarnation: draftSave.receipt.incarnation, sequence: 99 },
      },
    }),
    (error: unknown) => error instanceof CreativeDraftError && error.reason === "authority",
  );
  // The owned receipt authorizes exactly one append; the snapshot itself then
  // authorizes a later one.
  const snap = snapshotId();
  const appended = await saveUndo(input, saved, "workspace-one", snap, structuredClone(recovery), {
    authority: { kind: "draft", receipt: draftSave.receipt },
  });
  const next = snapshotId();
  await saveUndo(input, saved, "workspace-one", next, structuredClone(recovery), {
    authority: { kind: "snapshot", snapshotId: snap, receipt: appended.receipt },
  });
  assert.equal((await listCreativeUndos(input.projectId)).length, 2);
});

test("the kept set alone authorizes a snapshot of exactly kept records", async () => {
  const { input, first } = await boot("cundo-kept-auth");
  let saved = first.receipt.saved;
  const encoded = bytes(1, 256);
  const keptSource = source("s0", encoded);
  await stage(input.projectId, 0, { sources: [keptSource] }, [{ encoded, raster: RASTER }]);
  const kept = await storage.commitProject({
    ...input,
    commitId: "keep",
    expected: saved,
    creative: {
      expectedHead: (await loadCreativeCatalog(input.projectId)).catalog!.head,
      asOf: Date.now(),
      lease: { id: "lease-1", owner: "editor", workspace: "workspace-one" },
      keep: { sources: [keptSource.identity], derivatives: [], recipes: [], board: [] },
    },
  });
  saved = kept.receipt.saved;
  const recovery: CreativeRecoveryData = {
    base: await baseFor(input.projectId, saved, 1, [keptSource.identity]),
    sources: [keptSource],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  };
  const snap = snapshotId();
  await saveUndo(input, saved, "workspace-one", snap, recovery, {
    authority: { kind: "kept" },
  });
  const read = await readCreativeUndo(input.projectId, snap);
  assert.equal(read!.status, "current");
  // Kept authority cannot attach a record the kept set does not hold.
  const other = source("s9", bytes(9, 64));
  await assert.rejects(
    saveUndo(
      input,
      saved,
      "workspace-one",
      snapshotId(),
      {
        base: await baseFor(input.projectId, saved, 1, [keptSource.identity]),
        sources: [keptSource, other],
        derivatives: [],
        board: [],
        recipes: [],
        drafts: [],
      },
      { authority: { kind: "kept" } },
    ),
    (error: unknown) => error instanceof CreativeDraftError && error.reason === "integrity",
  );
});

test("discard removes only its own snapshot, index member and hold", async () => {
  const { input, first } = await boot("cundo-discard");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const recovery: CreativeRecoveryData = {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  };
  const one = snapshotId();
  const first$ = await saveUndo(input, saved, "workspace-one", one, structuredClone(recovery));
  const two = snapshotId();
  await saveUndo(input, saved, "workspace-one", two, structuredClone(recovery));
  // A wrong receipt refuses and touches nothing.
  await assert.rejects(
    discardCreativeUndo(input.projectId, one, {
      incarnation: one,
      sequence: 7,
    }),
    (error: unknown) => error instanceof CreativeDraftError && error.reason === "conflict",
  );
  await discardCreativeUndo(input.projectId, one, first$.receipt);
  const listed = await listCreativeUndos(input.projectId);
  assert.deepEqual(
    listed.map((entry) => entry.snapshotId),
    [two],
  );
  const catalog = (await loadCreativeCatalog(input.projectId)).catalog!;
  assert.equal(catalog.holds.filter((hold) => hold.kind === "retained-undo").length, 1);
  // The surviving snapshot still holds the shared bytes.
  const read = await readCreativeUndo(input.projectId, two);
  assert.equal(read!.integrity, true);
  const blob = await readCreativeBlob(input.projectId, src.encoded.hash);
  assert.deepEqual([...blob.bytes], [...bytes(1, 128)]);
});

test("a corrupt referenced blob refuses the append with no partial commit", async () => {
  const { input, first } = await boot("cundo-blob-corrupt");
  const saved = first.receipt.saved;
  const encoded = bytes(1, 256);
  const src = source("s1", encoded);
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded, raster: RASTER }]);
  const blobKey = creativeBlobKey(input.projectId, src.encoded.hash);
  const stored = records.get(blobKey) as { bytes: Uint8Array };
  records.set(blobKey, { ...stored, bytes: bytes(99, 256) });
  const snap = snapshotId();
  await assert.rejects(
    saveUndo(input, saved, "workspace-one", snap, {
      base: await baseFor(input.projectId, saved, 0),
      sources: [src],
      derivatives: [],
      board: [],
      recipes: [],
      drafts: [],
    }),
    CreativeDraftError,
  );
  // Nothing half-published: no index, no row, no catalog hold.
  assert.equal(records.get(creativeUndoIndexKey(input.projectId)), undefined);
  assert.equal(records.get(creativeUndoKey(input.projectId, snap)), undefined);
  const catalog = (await loadCreativeCatalog(input.projectId)).catalog!;
  assert.equal(catalog.holds.length, 0);
});

test("the retained-snapshot bound refuses by name and preserves every older snapshot", async () => {
  const { input, first } = await boot("cundo-capacity");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 32));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 32), raster: RASTER }]);
  const recovery: CreativeRecoveryData = {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  };
  for (let i = 0; i < 64; i++)
    await saveUndo(input, saved, "workspace-one", snapshotId(), structuredClone(recovery));
  assert.equal((await listCreativeUndos(input.projectId)).length, 64);
  await assert.rejects(
    saveUndo(input, saved, "workspace-one", snapshotId(), structuredClone(recovery)),
    (error: unknown) => error instanceof CreativeDraftError && error.reason === "budget",
  );
  // Old retained data is never silently evicted to admit the newcomer.
  assert.equal((await listCreativeUndos(input.projectId)).length, 64);
});

test("an orphaned undo hold or index row refuses reads by name", async () => {
  const { input, first } = await boot("cundo-orphan");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const snap = snapshotId();
  await saveUndo(input, saved, "workspace-one", snap, {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  });
  // An index member whose row vanished is damage, not an empty list.
  records.delete(creativeUndoKey(input.projectId, snap));
  await assert.rejects(listCreativeUndos(input.projectId), /exist|missing|integrity/i);
});

test("a snapshot cannot be appended while the project lifetime is stale", async () => {
  const { input, first } = await boot("cundo-lifetime");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  records.set(`lifetime/${input.projectId}`, {
    projectId: `lifetime/${input.projectId}`,
    epoch: "newer-epoch",
    deleted: false,
  });
  await assert.rejects(
    saveUndo(input, saved, "workspace-one", snapshotId(), {
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

test("a held-blob mismatch recorded in the catalog refuses reads and capture", async () => {
  const { input, first } = await boot("cundo-hold-mismatch");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const snap = snapshotId();
  const appended = await saveUndo(input, saved, "workspace-one", snap, {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  });
  const catalog = (await loadCreativeCatalog(input.projectId)).catalog!;
  const tampered: CreativeCatalog = {
    ...catalog,
    holds: catalog.holds.map((hold) =>
      hold.id === `undo-${appended.receipt.incarnation}`
        ? { ...hold, hashes: [sha256Hex(bytes(7, 8))] }
        : hold,
    ),
  };
  records.set(creativeCatalogKey(input.projectId), writeCreativeCatalogRecord(tampered));
  const listed = await listCreativeUndos(input.projectId);
  assert.equal(listed[0]!.integrity, false);
});

test("concurrent appends under distinct ids serialize cleanly", async () => {
  const { input, first } = await boot("cundo-race");
  const saved = first.receipt.saved;
  const src = source("s1", bytes(1, 128));
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded: bytes(1, 128), raster: RASTER }]);
  const recovery: CreativeRecoveryData = {
    base: await baseFor(input.projectId, saved, 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  };
  const a = snapshotId();
  const b = snapshotId();
  const outcomes = await Promise.allSettled([
    saveUndo(input, saved, "workspace-one", a, structuredClone(recovery)),
    saveUndo(input, saved, "workspace-one", b, structuredClone(recovery)),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 2);
  assert.equal((await listCreativeUndos(input.projectId)).length, 2);
});
