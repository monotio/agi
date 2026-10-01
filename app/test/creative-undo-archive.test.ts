import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import {
  CREATIVE_SOURCE_FORMAT,
  creativeBlobKey,
  type CreativeCatalog,
  type CreativeSource,
} from "../../src/creative/catalog.ts";
import type { CreativeRecoveryBase } from "../../src/creative/recovery.ts";
import { writeProjectRecovery } from "../../src/authoring/projectRecovery.ts";
import { detectProfile } from "../../src/runtime/profile.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import * as storage from "../src/project/gameStorage.ts";
import type { ProjectCommitReceipt } from "../src/project/gameStorage.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import {
  loadCreativeCatalog,
  readCreativeBlob,
  stageCreativeBlobs,
} from "../src/project/creativeStore.ts";
import { saveCreativeDraft, listCreativeDrafts } from "../src/project/creativeDrafts.ts";
import {
  listCreativeUndos,
  readCreativeUndo,
  saveCreativeUndo,
} from "../src/project/creativeUndo.ts";
import { captureCreativeProject } from "../src/project/creativeProjectSnapshot.ts";
import { publishProjectWithCreative } from "../src/project/creativeProjectPublication.ts";
import {
  creativeUndoIndexKey,
  writeCreativeUndoIndexRecord,
} from "../src/project/creativeWorkArchive.ts";
import { buildProjectZip, buildPublicGameZip } from "../src/archive/projectArchive.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { copyLibraryGame } from "../src/library/gameLibrary.ts";

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
    origin: { kind: "import", title: `Source ${id}` },
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

/** Commit a project, stage sources and retain one snapshot per workspace. */
async function snapshotProject(name: string, notes: string[]) {
  const input = request(name);
  const first = await storage.commitProject(input);
  const saved = first.receipt.saved;
  const encoded = bytes(1, 64);
  const src = source("s1", encoded);
  await stage(input.projectId, 0, { sources: [src] }, [{ encoded, raster: RASTER }]);
  const base = await baseFor(input.projectId, saved, 0);
  const snaps: string[] = [];
  for (const note of notes) {
    const snap = snapshotId();
    snaps.push(snap);
    await saveCreativeUndo({
      projectId: input.projectId,
      workspaceId: "workspace-one",
      snapshotId: snap,
      expected: { generation: saved.generation, lifetime: saved.lifetime },
      authority: {
        kind: "lease",
        lease: { id: "lease-1", owner: "editor", workspace: "workspace-one" },
      },
      recovery: {
        base,
        sources: [src],
        derivatives: [],
        board: [],
        recipes: [],
        drafts: [
          {
            identity: { id: "d1", incarnation: "inc", revision: 0 },
            sources: [src.identity],
            notes: note,
          },
        ],
        ...(note === "with draft"
          ? {
              projectDraft: writeProjectRecovery(
                {
                  revision: base.revision,
                  authoring: base.authoring,
                  profileId: base.profileId,
                },
                { changes: [{ key: "logic:1", version: 2, content: "// wip\n" }], groups: [] },
              ),
            }
          : {}),
      },
    });
  }
  return { input, first, saved, src, encoded, snaps };
}

async function publishOpened(
  opened: Awaited<ReturnType<typeof readGameZip>>,
  target: ReturnType<typeof testProjectId>,
) {
  const project = opened.project!;
  const revision = await gameRevision(opened.files);
  return publishProjectWithCreative({
    projectId: target,
    data: {
      title: opened.title ?? "Adventure",
      library: {
        ...(opened.metadata ?? {}),
        version: 1 as const,
        revision,
        source: "zip" as const,
        ...(opened.profile !== undefined ? { profile: opened.profile } : {}),
        validation: { status: "unverified" as const, message: "Opening not checked yet." },
      },
      provider: project.provider,
      model: project.model,
      transcript: project.transcript,
      sessionId: project.sessionId,
      authoringState: project.authoringState,
      conversationHistory: project.conversationHistory,
      recoveryDraft: project.recoveryDraft,
      workspace: project.workspace,
      references: project.references,
      roomGeneration: opened.roomGeneration,
      files: opened.files,
      words: opened.words,
      imported: true,
    },
    ...(project.creative === undefined ? {} : { creative: project.creative }),
    ...(project.creativeWork === undefined ? {} : { work: project.creativeWork }),
  });
}

test("retained snapshots export, import and keep ordered exact state", async () => {
  const { input, saved, src, encoded, snaps } = await snapshotProject("undo-arc-round", [
    "first state",
    "with draft",
  ]);
  const snapshot = await captureCreativeProject(input.projectId);
  assert.ok(snapshot?.work, "the capture must carry the work envelope");
  assert.equal(snapshot.work.undos.length, 2);
  assert.equal(snapshot.work.undos[0]!.status, "current");
  // A snapshot-owned hold travels under undos, never under retained.
  assert.equal(snapshot.work.retained.length, 0);

  const data = (await storage.loadAuthoredGame(input.projectId))!;
  const zip = await buildProjectZip(data, undefined, undefined, undefined, undefined, snapshot);
  const opened = await readGameZip(zip);
  assert.equal(opened.project!.creativeWork!.work.undos.length, 2);
  assert.equal(
    opened.project!.creativeWork!.work.undos[1]!.recovery.projectDraft !== undefined,
    true,
  );

  const targetId = testProjectId("undo-arc-round-copy");
  await publishOpened(opened, targetId);
  const listed = await listCreativeUndos(targetId);
  assert.equal(listed.length, 2);
  assert.equal(listed[0]!.status, "current");
  assert.equal(listed[1]!.status, "current");
  // Fresh target-local ids and receipts: source snapshot ids do not travel.
  assert.notEqual(listed[0]!.snapshotId, snaps[0]);
  const readFirst = await readCreativeUndo(targetId, listed[0]!.snapshotId);
  assert.equal(readFirst!.recovery.drafts[0]!.notes, "first state");
  const readSecond = await readCreativeUndo(targetId, listed[1]!.snapshotId);
  assert.equal(readSecond!.recovery.drafts[0]!.notes, "with draft");
  const document = readSecond!.recovery.projectDraft!.documents.find(
    (doc) => doc.key === "logic:1",
  )!;
  assert.deepEqual(document.content, { type: "text", text: "// wip\n" });
  // The exact original and canonical bytes republished once.
  const original = await readCreativeBlob(targetId, src.encoded.hash);
  assert.deepEqual([...original.bytes], [...encoded]);
  const raster = await readCreativeBlob(targetId, src.normalized.blob.hash);
  assert.deepEqual([...raster.bytes], [...RASTER]);
  // Every snapshot row carries its own retained-undo hold.
  const catalog = (await loadCreativeCatalog(targetId)).catalog!;
  assert.equal(catalog.holds.filter((hold) => hold.kind === "retained-undo").length, 2);
  void saved;
});

test("a work-only project with snapshots and no kept set round-trips", async () => {
  const { input } = await snapshotProject("undo-work-only", ["only"]);
  const snapshot = await captureCreativeProject(input.projectId);
  assert.ok(snapshot !== null);
  assert.equal(snapshot.kept, 0);
  assert.equal(snapshot.manifest, null);
  const data = (await storage.loadAuthoredGame(input.projectId))!;
  const zip = await buildProjectZip(data, undefined, undefined, undefined, undefined, snapshot);
  const opened = await readGameZip(zip);
  assert.equal(opened.project!.creative, undefined);
  const targetId = testProjectId("undo-work-only-copy");
  await publishOpened(opened, targetId);
  const listed = await listCreativeUndos(targetId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.status, "current");
});

test("a stale snapshot stays byte-identical and stale through copy", async () => {
  const { input } = await snapshotProject("undo-stale-arc", ["before the move"]);
  const before = (await storage.loadAuthoredGame(input.projectId))!;
  assert.equal(
    await storage.saveAuthoredGame(input.projectId, { ...before, title: "Moved" }),
    true,
  );
  const listed = await listCreativeUndos(input.projectId);
  assert.equal(listed[0]!.status, "stale");
  const snapshot = (await captureCreativeProject(input.projectId))!;
  assert.equal(snapshot.work!.undos[0]!.status, "stale");
  const moved = (await storage.loadAuthoredGame(input.projectId))!;
  const zip = await buildProjectZip(moved, undefined, undefined, undefined, undefined, snapshot);
  const opened = await readGameZip(zip);
  const targetId = testProjectId("undo-stale-arc-copy");
  await publishOpened(opened, targetId);
  const targetListed = await listCreativeUndos(targetId);
  assert.equal(targetListed[0]!.status, "stale");
  const read = await readCreativeUndo(targetId, targetListed[0]!.snapshotId);
  assert.equal(read!.recovery.drafts[0]!.notes, "before the move");
});

test("shared kept, recovery and snapshot hashes dedupe to one archive entry", async () => {
  const input = request("undo-dedup");
  const first = await storage.commitProject(input);
  const saved0 = first.receipt.saved;
  const encoded = bytes(3, 96);
  const keptSource = source("s-k", encoded);
  await stage(input.projectId, 0, { sources: [keptSource] }, [{ encoded, raster: RASTER }]);
  const kept = await storage.commitProject({
    ...input,
    commitId: "keep",
    expected: saved0,
    creative: {
      expectedHead: (await loadCreativeCatalog(input.projectId)).catalog!.head,
      asOf: Date.now(),
      lease: { id: "lease-1", owner: "editor", workspace: "workspace-one" },
      keep: { sources: [keptSource.identity], derivatives: [], recipes: [], board: [] },
    },
  });
  const saved = kept.receipt.saved;
  // The Keep consumed lease-1; a fresh lease stages the recovery's claims.
  await stage(input.projectId, (await loadCreativeCatalog(input.projectId)).catalog!.head, {}, [], {
    leaseId: "lease-2",
  });
  // A recovery row pinning the same kept source, and a snapshot claiming it.
  await saveCreativeDraft({
    projectId: input.projectId,
    workspaceId: "workspace-one",
    expectedReceipt: null,
    expected: { generation: saved.generation, lifetime: saved.lifetime },
    authority: {
      kind: "lease",
      lease: { id: "lease-2", owner: "editor", workspace: "workspace-one" },
    },
    recovery: {
      base: await baseFor(input.projectId, saved, 1, [keptSource.identity]),
      sources: [keptSource],
      derivatives: [],
      board: [],
      recipes: [],
      drafts: [],
    },
  });
  await saveCreativeUndo({
    projectId: input.projectId,
    workspaceId: "workspace-one",
    snapshotId: snapshotId(),
    expected: { generation: saved.generation, lifetime: saved.lifetime },
    authority: { kind: "kept" },
    recovery: {
      base: await baseFor(input.projectId, saved, 1, [keptSource.identity]),
      sources: [keptSource],
      derivatives: [],
      board: [],
      recipes: [],
      drafts: [],
    },
  });
  const snapshot = (await captureCreativeProject(input.projectId))!;
  const data = (await storage.loadAuthoredGame(input.projectId))!;
  const zip = await buildProjectZip(data, undefined, undefined, undefined, undefined, snapshot);
  const opened = await readGameZip(zip);
  const work = opened.project!.creativeWork!;
  assert.equal(work.work.drafts.length, 1);
  assert.equal(work.work.undos.length, 1);
  // encA + RASTER appear once in the registry and once as zip members.
  assert.equal(Object.keys(work.work.blobs).length, 2);
  const targetId = testProjectId("undo-dedup-copy");
  await publishOpened(opened, targetId);
  assert.equal((await listCreativeDrafts(targetId)).length, 1);
  assert.equal((await listCreativeUndos(targetId)).length, 1);
  const original = await readCreativeBlob(targetId, keptSource.encoded.hash);
  assert.deepEqual([...original.bytes], [...encoded]);
});

test("an orphan undo index member refuses capture", async () => {
  const { input } = await snapshotProject("undo-orphan-index", ["x"]);
  const ghost = snapshotId();
  records.set(
    creativeUndoIndexKey(input.projectId),
    writeCreativeUndoIndexRecord(creativeUndoIndexKey(input.projectId), [
      { workspace: "workspace-one", snapshot: ghost },
    ]),
  );
  await assert.rejects(captureCreativeProject(input.projectId), /missing|integrity/i);
});

test("an indexed snapshot whose retained hold vanished refuses capture", async () => {
  const { input } = await snapshotProject("undo-orphan-hold", ["x"]);
  const catalog = (await loadCreativeCatalog(input.projectId)).catalog!;
  const tampered: CreativeCatalog = {
    ...catalog,
    holds: catalog.holds.filter((hold) => hold.kind !== "retained-undo"),
  };
  const { writeCreativeCatalogRecord } = await import("../../src/creative/catalog.ts");
  records.set(`creative/${input.projectId}`, writeCreativeCatalogRecord(tampered));
  await assert.rejects(captureCreativeProject(input.projectId), /hold|missing|integrity/i);
});

test("a tampered snapshot blob refuses capture before any export", async () => {
  const { input, src } = await snapshotProject("undo-tamper", ["x"]);
  const blobKey = creativeBlobKey(input.projectId, src.encoded.hash);
  const stored = records.get(blobKey) as { bytes: Uint8Array };
  records.set(blobKey, { ...stored, bytes: bytes(99, 64) });
  await assert.rejects(captureCreativeProject(input.projectId), /match|hash|integrity/i);
});

test("an envelope claiming current for a stale snapshot refuses publication", async () => {
  const { input, first } = await snapshotProject("undo-forged-current", ["x"]);
  // A Keep moves the kept base the snapshot was captured against: the entry
  // is preserved stale, and forging it current is refused before any write.
  const keptEncoded = bytes(5, 64);
  const keptSource = source("s-k", keptEncoded);
  await stage(
    input.projectId,
    (await loadCreativeCatalog(input.projectId)).catalog!.head,
    {
      sources: [keptSource],
    },
    [{ encoded: keptEncoded, raster: RASTER }],
    { leaseId: "lease-2" },
  );
  await storage.commitProject({
    ...input,
    commitId: "keep",
    expected: first.receipt.saved,
    creative: {
      expectedHead: (await loadCreativeCatalog(input.projectId)).catalog!.head,
      asOf: Date.now(),
      lease: { id: "lease-2", owner: "editor", workspace: "workspace-one" },
      keep: { sources: [keptSource.identity], derivatives: [], recipes: [], board: [] },
    },
  });
  const listed = await listCreativeUndos(input.projectId);
  assert.equal(listed[0]!.status, "stale");
  assert.ok(listed[0]!.staleFields.includes("kept"));
  const snapshot = (await captureCreativeProject(input.projectId))!;
  assert.equal(snapshot.work!.undos[0]!.status, "stale");
  const work = JSON.parse(JSON.stringify(snapshot.work)) as {
    undos: { status: string }[];
  };
  // Forge the stale entry current: the codec checks the claim against the
  // carried base before any write.
  work.undos[0]!.status = "current";
  const { readCreativeWork, writeCreativeWork } = await import("../../src/creative/workArchive.ts");
  assert.throws(() => writeCreativeWork(work as never), /current|basis/i);
  assert.throws(() => readCreativeWork(work), /current|basis/i);
});

test("the public game archive never carries retained snapshots", async () => {
  const { input } = await snapshotProject("undo-public-clean", ["secret notes"]);
  const data = (await storage.loadAuthoredGame(input.projectId))!;
  const publicZip = buildPublicGameZip(data);
  const text = new TextDecoder("latin1").decode(publicZip);
  assert.equal(text.includes("secret notes"), false);
  assert.equal(text.includes("creative-work"), false);
});

test("copy carries snapshots through the library copy path", async () => {
  const { input } = await snapshotProject("undo-copy", ["copied state"]);
  const copyId = await copyLibraryGame(input.projectId);
  const listed = await listCreativeUndos(copyId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.status, "current");
  const read = await readCreativeUndo(copyId, listed[0]!.snapshotId);
  assert.equal(read!.recovery.drafts[0]!.notes, "copied state");
});
