import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import {
  CREATIVE_SOURCE_FORMAT,
  creativeBlobKey,
  type CreativeCatalog,
  type CreativeSource,
} from "../../src/creative/catalog.ts";
import type { CreativeRecoveryBase, CreativeRecoveryData } from "../../src/creative/recovery.ts";
import { detectProfile } from "../../src/runtime/profile.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import * as storage from "../src/project/gameStorage.ts";
import type { ProjectCommitReceipt } from "../src/project/gameStorage.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import {
  collectCreativeGarbage,
  holdCreativeBlobs,
  loadCreativeCatalog,
  readCreativeBlob,
  stageCreativeBlobs,
} from "../src/project/creativeStore.ts";
import {
  listCreativeDrafts,
  readCreativeDraft,
  saveCreativeDraft,
} from "../src/project/creativeDrafts.ts";
import { captureCreativeProject } from "../src/project/creativeProjectSnapshot.ts";
import { publishProjectWithCreative } from "../src/project/creativeProjectPublication.ts";
import { creativeDraftKey } from "../src/project/creativeWorkArchive.ts";
import {
  buildProjectZip,
  buildPublicGameZip,
  readProjectContext,
} from "../src/archive/projectArchive.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { buildZip } from "../src/archive/zip.ts";
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

/** Stage + durably save one workspace's recovery against the live base. */
async function saveWorkspaceDraft(
  projectId: ReturnType<typeof testProjectId>,
  saved: ProjectCommitReceipt["saved"],
  workspaceId: string,
  src: CreativeSource,
  encoded: Uint8Array,
  notes: string,
  leaseId = `lease-${workspaceId}`,
) {
  const catalog = await loadCreativeCatalog(projectId);
  const head = catalog.catalog?.head ?? 0;
  const staged = await stageCreativeBlobs({
    projectId,
    expectedHead: head,
    lease: { id: leaseId, owner: "editor", workspace: workspaceId },
    staged: { sources: [src], derivatives: [], recipes: [] },
    blobs: [
      { hash: sha256Hex(encoded), mime: "image/png", bytes: encoded },
      { hash: sha256Hex(RASTER), mime: "application/x-rgba8", bytes: RASTER },
    ],
  });
  const recovery: CreativeRecoveryData = {
    base: await baseFor(projectId, saved, catalog.catalog?.kept ?? 0),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [
      {
        identity: { id: `draft-${workspaceId}`, incarnation: "inc", revision: 0 },
        sources: [src.identity],
        notes,
      },
    ],
  };
  const result = await saveCreativeDraft({
    projectId,
    workspaceId,
    expectedReceipt: null,
    expected: { generation: saved.generation, lifetime: saved.lifetime },
    authority: { kind: "lease", lease: { id: leaseId, owner: "editor", workspace: workspaceId } },
    recovery,
  });
  return { staged, saved: result };
}

/** Commit a project body, then save one durable draft; no Keep anywhere. */
async function workspaceProject(name: string, notes = "unfinished notes") {
  const input = request(name);
  const first = await storage.commitProject(input);
  const encoded = bytes(1, 64);
  const src = source("s1", encoded);
  const saved = await saveWorkspaceDraft(
    input.projectId,
    first.receipt.saved,
    "workspace-one",
    src,
    encoded,
    notes,
    "lease-1",
  );
  return { input, first, saved, src, encoded };
}

/**
 * Publish an opened archive into a fresh target id, mirroring the data
 * shape `addLibraryGame` builds for `publishProjectWithCreative`.
 */
async function publishOpened(
  opened: Awaited<ReturnType<typeof readGameZip>>,
  target: ReturnType<typeof testProjectId>,
  options?: { title?: string },
) {
  const project = opened.project!;
  const revision = await gameRevision(opened.files);
  return publishProjectWithCreative({
    projectId: target,
    data: {
      title: options?.title ?? opened.title ?? "Adventure",
      library: {
        ...(opened.metadata ?? {}),
        version: 1 as const,
        revision,
        source: "zip" as const,
        ...(opened.profile !== undefined ? { profile: opened.profile } : {}),
        validation: {
          status: "unverified" as const,
          message: "Opening not checked yet.",
        },
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

function zipEntryNames(zip: Uint8Array): string[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let at = zip.length - 22; at >= 0; at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  assert.ok(eocd >= 0, "zip end-of-central-directory record must exist");
  const count = view.getUint16(eocd + 10, true);
  const dirStart = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const names: string[] = [];
  let at = dirStart;
  for (let i = 0; i < count; i++) {
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    names.push(decoder.decode(zip.subarray(at + 46, at + 46 + nameLen)));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

test("a recovery-only project exports, imports and keeps its durable draft", async () => {
  const { input, saved, src, encoded } = await workspaceProject("work-recovery-only");
  const snapshot = await captureCreativeProject(input.projectId);
  assert.ok(snapshot, "a project with durable recovery work must capture");
  assert.equal(snapshot.kept, 0);
  assert.equal(snapshot.manifest, null);
  assert.ok(snapshot.work, "the capture must carry the portable work envelope");
  assert.equal(snapshot.work.drafts.length, 1);
  assert.equal(snapshot.work.drafts[0]!.workspace, "workspace-one");
  assert.equal(snapshot.work.drafts[0]!.status, "current");
  assert.deepEqual(snapshot.work.drafts[0]!.recovery.drafts[0]!.notes, "unfinished notes");

  const data = (await storage.loadAuthoredGame(input.projectId))!;
  const zip = await buildProjectZip(data, undefined, undefined, undefined, undefined, snapshot);
  const names = zipEntryNames(zip).filter((name) => name.startsWith("CREATIVE/"));
  assert.deepEqual(names.sort(), [
    `CREATIVE/${src.encoded.hash}.BIN`,
    `CREATIVE/${src.normalized.blob.hash}.BIN`,
  ]);
  const opened = await readGameZip(zip);
  assert.ok(opened.project?.creativeWork, "the private archive must carry the work envelope");
  assert.equal(opened.project!.creative, undefined, "no kept manifest is invented");

  const targetId = testProjectId("work-recovery-only-copy");
  const published = await publishOpened(opened, targetId);
  const listed = await listCreativeDrafts(targetId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.workspaceId, "workspace-one");
  assert.equal(listed[0]!.status, "current");
  const read = (await readCreativeDraft(targetId, "workspace-one"))!;
  assert.deepEqual(read.recovery.drafts[0]!.notes, "unfinished notes");
  // The restored row carries fresh target-local authority, not the source's.
  assert.notEqual(read.receipt.incarnation, saved.saved.receipt.incarnation);
  assert.equal(read.receipt.sequence, 1);
  const bytesBack = await readCreativeBlob(targetId, src.encoded.hash);
  assert.deepEqual([...bytesBack.bytes], [...encoded]);
  assert.equal(published.receipt.creative?.kept, 0);
});

test("kept data plus two workspaces and a shared retained undo dedupe to one entry per hash", async () => {
  const input = request("work-kept-two");
  const first = await storage.commitProject(input);
  const encA = bytes(10, 96);
  const encB = bytes(11, 96);
  const srcA = source("s-a", encA);
  const srcB = source("s-b", encB);
  const staged = await stageCreativeBlobs({
    projectId: input.projectId,
    expectedHead: 0,
    lease: { id: "lease-x", owner: "editor", workspace: "ws-a" },
    staged: { sources: [srcA, srcB], derivatives: [], recipes: [] },
    blobs: [
      { hash: sha256Hex(encA), mime: "image/png", bytes: encA },
      { hash: sha256Hex(encB), mime: "image/png", bytes: encB },
      { hash: sha256Hex(RASTER), mime: "application/x-rgba8", bytes: RASTER },
    ],
  });
  const published = await storage.commitProject({
    ...input,
    commitId: "keep",
    expected: first.receipt.saved,
    creative: {
      expectedHead: staged.head,
      asOf: Date.now(),
      lease: { id: "lease-x", owner: "editor", workspace: "ws-a" },
      keep: { sources: [srcA.identity], derivatives: [], recipes: [], board: [] },
    },
  });
  const savedMeta = published.receipt.saved;
  const kept = published.receipt.creative!.kept;
  // Two workspaces, both pinned to the kept source A as their pin so their
  // recoveries may carry the kept record.
  await saveWorkspaceDraft(input.projectId, savedMeta, "ws-a", srcB, encB, "workspace A");
  await saveWorkspaceDraft(
    input.projectId,
    savedMeta,
    "ws-b",
    srcB,
    encB,
    "workspace B",
    "lease-y",
  );
  await holdCreativeBlobs({
    projectId: input.projectId,
    hold: { id: "undo-1", kind: "retained-undo", hashes: [srcA.encoded.hash] },
  });
  void kept;

  const snapshot = (await captureCreativeProject(input.projectId))!;
  assert.equal(snapshot.kept, 1);
  assert.equal(snapshot.work!.drafts.length, 2);
  assert.equal(snapshot.work!.retained.length, 1);
  assert.deepEqual([...snapshot.work!.retained[0]!], [srcA.encoded.hash]);

  const current = (await storage.loadAuthoredGame(input.projectId))!;
  const zip = await buildProjectZip(current, undefined, undefined, undefined, undefined, snapshot);
  const names = zipEntryNames(zip).filter((name) => name.startsWith("CREATIVE/"));
  // Unique bytes: encA, encB, RASTER. encA is shared by the kept set, the
  // retained-undo inventory and workspace pins — it packs exactly once.
  assert.equal(names.length, 3);
  assert.equal(names.filter((n) => n === `CREATIVE/${srcA.encoded.hash}.BIN`).length, 1);

  const opened = await readGameZip(zip);
  const work = opened.project!.creativeWork!;
  assert.equal(work.work.drafts.length, 2);
  assert.equal(work.work.retained.length, 1);
  const targetId = testProjectId("work-kept-two-copy");
  await publishOpened(opened, targetId);
  const catalog = (await loadCreativeCatalog(targetId)).catalog!;
  assert.equal(catalog.kept, 1);
  assert.equal(catalog.holds.filter((hold) => hold.kind === "recovery").length, 2);
  assert.equal(catalog.holds.filter((hold) => hold.kind === "retained-undo").length, 1);
  const targetListed = await listCreativeDrafts(targetId);
  assert.deepEqual(targetListed.map((row) => row.workspaceId).sort(), ["ws-a", "ws-b"]);
  assert.ok(targetListed.every((row) => row.status === "current"));
});

test("held bytes survive staging lease expiry and garbage collection into the archive", async () => {
  const { input, src, encoded } = await workspaceProject("work-gc-survive");
  // Expire the staging lease, then collect: the durable hold keeps the bytes.
  const collected = await collectCreativeGarbage({
    projectId: input.projectId,
    now: () => Date.now() + 10 * 60 * 1000 + 1,
  });
  assert.ok(collected.removed >= 0);
  const snapshot = (await captureCreativeProject(input.projectId))!;
  assert.equal(snapshot.work!.drafts.length, 1);
  const data = (await storage.loadAuthoredGame(input.projectId))!;
  const zip = await buildProjectZip(data, undefined, undefined, undefined, undefined, snapshot);
  const opened = await readGameZip(zip);
  const work = opened.project!.creativeWork!;
  assert.deepEqual([...work.blobs[sha256Hex(encoded)]!], [...encoded]);
  assert.equal(work.blobs[sha256Hex(RASTER)] !== undefined, true);
  void src;
});

test("a stale draft keeps its stored basis and classification across the archive", async () => {
  const { input, saved } = await workspaceProject("work-stale");
  const data = (await storage.loadAuthoredGame(input.projectId))!;
  assert.equal(
    await storage.saveAuthoredGame(input.projectId, { ...data, title: "Changed" }),
    true,
  );
  const listed = await listCreativeDrafts(input.projectId);
  assert.equal(listed[0]!.status, "stale");
  assert.ok(listed[0]!.staleFields.includes("generation"));

  const snapshot = (await captureCreativeProject(input.projectId))!;
  assert.equal(snapshot.work!.drafts[0]!.status, "stale");
  const moved = (await storage.loadAuthoredGame(input.projectId))!;
  const zip = await buildProjectZip(moved, undefined, undefined, undefined, undefined, snapshot);
  const opened = await readGameZip(zip);
  assert.equal(opened.project!.creativeWork!.work.drafts[0]!.status, "stale");

  const targetId = testProjectId("work-stale-copy");
  await publishOpened(opened, targetId);
  const targetListed = await listCreativeDrafts(targetId);
  assert.equal(targetListed[0]!.status, "stale");
  assert.ok(targetListed[0]!.staleFields.length > 0);
  // The preserved recovery is still readable verbatim at the target.
  const read = (await readCreativeDraft(targetId, "workspace-one"))!;
  assert.deepEqual(read.recovery.drafts[0]!.notes, "unfinished notes");
  void saved;
});

test("corrupt or missing work records refuse capture without a partial bundle", async () => {
  const { input } = await workspaceProject("work-corrupt-row");
  const rowKey = creativeDraftKey(input.projectId, "workspace-one");
  records.set(rowKey, { junk: true });
  await assert.rejects(captureCreativeProject(input.projectId), /integrity|format|version/i);
  records.delete(rowKey);
  await assert.rejects(captureCreativeProject(input.projectId), /missing|draft|integrity/i);
});

test("a mismatched recovery hold refuses capture", async () => {
  const { input, src } = await workspaceProject("work-orphan-hold");
  // A stored hold whose hash inventory no longer covers its row is damage.
  const catalog = (await loadCreativeCatalog(input.projectId)).catalog!;
  const hold = catalog.holds.find((entry) => entry.kind === "recovery")!;
  const tampered: CreativeCatalog = {
    ...catalog,
    holds: catalog.holds.map((entry) =>
      entry.id === hold.id ? { ...entry, hashes: [sha256Hex(bytes(77, 8))] } : entry,
    ),
  };
  const { writeCreativeCatalogRecord } = await import("../../src/creative/catalog.ts");
  const record = writeCreativeCatalogRecord(tampered);
  records.set(`creative/${input.projectId}`, record);
  await assert.rejects(
    captureCreativeProject(input.projectId),
    /not registered|hold|inventory|integrity/i,
  );
  void src;
});

test("a held blob whose record vanished refuses capture", async () => {
  const { input, src } = await workspaceProject("work-missing-blob");
  records.delete(creativeBlobKey(input.projectId, src.encoded.hash));
  await assert.rejects(captureCreativeProject(input.projectId), /missing/i);
});

test("the archive reader refuses an unknown work version, extra field or tampered bytes", async () => {
  const { input } = await workspaceProject("work-reader-corrupt");
  const snapshot = (await captureCreativeProject(input.projectId))!;
  const data = (await storage.loadAuthoredGame(input.projectId))!;
  const zip = await buildProjectZip(data, undefined, undefined, undefined, undefined, snapshot);
  const opened = await readGameZip(zip);
  const work = opened.project!.creativeWork!.work;
  const files = data.files;

  function projectZip(workField: unknown, extraBlobs: [string, Uint8Array][] = []) {
    const entries = [
      ...Object.entries(files).map(([name, data]) => ({ name, data })),
      {
        name: "PROJECT.JSON",
        data: JSON.stringify({
          format: "monotio.agi.project",
          version: 2,
          authoringState: {},
          creativeWork: workField,
        }),
      },
      ...extraBlobs.map(([name, data]) => ({ name, data })),
    ];
    return buildZip(entries);
  }
  const goodRecord = JSON.parse(JSON.stringify(work)) as Record<string, unknown>;
  // Unknown work version refuses.
  const future = { ...goodRecord, version: 2 };
  const blobEntries: [string, Uint8Array][] = Object.keys(work.blobs).map((hash) => [
    `CREATIVE/${hash}.BIN`,
    opened.project!.creativeWork!.blobs[hash]!,
  ]);
  await assert.rejects(readGameZip(projectZip(future, [...blobEntries])), /version|supported/i);
  // An unknown field inside the envelope refuses.
  const extra = { ...goodRecord, authority: { owner: "me" } };
  await assert.rejects(readGameZip(projectZip(extra, [...blobEntries])), /field|unknown/i);
  // A tampered blob byte refuses.
  const hash = Object.keys(work.blobs)[0]!;
  const tampered = new Uint8Array(opened.project!.creativeWork!.blobs[hash]!);
  tampered[0]! ^= 0xff;
  const tamperedEntries: [string, Uint8Array][] = blobEntries.map(([name, data]) =>
    name === `CREATIVE/${hash}.BIN` ? [name, tampered] : [name, data],
  );
  await assert.rejects(
    readGameZip(projectZip(work, tamperedEntries)),
    /blob|match|hash|descriptor/i,
  );
  // A declared blob absent from the zip refuses.
  await assert.rejects(readGameZip(projectZip(work, [])), /missing|blob/i);
});

test("a version-1 project envelope refuses a creativeWork claim outright", () => {
  const bytesIn = new TextEncoder().encode(
    JSON.stringify({
      format: "monotio.agi.project",
      version: 1,
      provider: "stub",
      model: "stub",
      conversation: { formatVersion: 1, messages: [] },
      authoringState: {},
      creativeWork: { format: "monotio.agi.creative-work", version: 1 },
    }),
  );
  assert.throws(() => readProjectContext(bytesIn, new Map(), ""), /work|creative|version/i);
});

test("the public game archive carries no creative work", async () => {
  const { input } = await workspaceProject("work-public-clean");
  const data = (await storage.loadAuthoredGame(input.projectId))!;
  const publicZip = buildPublicGameZip(data);
  const names = zipEntryNames(publicZip);
  assert.equal(
    names.some((name) => name.startsWith("CREATIVE/")),
    false,
  );
  assert.equal(names.includes("PROJECT.JSON"), false);
  const text = new TextDecoder("latin1").decode(publicZip);
  assert.equal(text.includes("unfinished notes"), false);
});

test("copy carries the durable work through the coherent capture and publication", async () => {
  const { input } = await workspaceProject("work-copy");
  const copyId = await copyLibraryGame(input.projectId);
  const listed = await listCreativeDrafts(copyId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.workspaceId, "workspace-one");
  assert.equal(listed[0]!.status, "current");
  const read = (await readCreativeDraft(copyId, "workspace-one"))!;
  assert.deepEqual(read.recovery.drafts[0]!.notes, "unfinished notes");
});

test("a same-candidate republish is idempotent; a different candidate refuses", async () => {
  const { input } = await workspaceProject("work-idempotent");
  const snapshot = (await captureCreativeProject(input.projectId))!;
  const data = (await storage.loadAuthoredGame(input.projectId))!;
  const zip = await buildProjectZip(data, undefined, undefined, undefined, undefined, snapshot);
  const opened = await readGameZip(zip);
  const targetId = testProjectId("work-idempotent-copy");
  const first = await publishOpened(opened, targetId);
  const second = await publishOpened(opened, targetId);
  assert.deepEqual(second.receipt, first.receipt);
  // A conflicting candidate under the same identity refuses.
  await assert.rejects(
    publishOpened(opened, targetId, { title: "Different Title" }),
    /exists|reused|different|conflict/i,
  );
});

test("delete-and-recreate cannot acknowledge a stale publication", async () => {
  const { input } = await workspaceProject("work-recreate");
  const snapshot = (await captureCreativeProject(input.projectId))!;
  const data = (await storage.loadAuthoredGame(input.projectId))!;
  const zip = await buildProjectZip(data, undefined, undefined, undefined, undefined, snapshot);
  const opened = await readGameZip(zip);
  const targetId = testProjectId("work-recreate-copy");
  await publishOpened(opened, targetId);
  await storage.clearCachedGame(targetId);
  // The same candidate cannot acknowledge against a deleted lifetime.
  await assert.rejects(publishOpened(opened, targetId), /removed|deleted|lifetime/i);
});

test("caller mutation during the lazy archive build cannot reach the packed work", async () => {
  const { input, src, encoded } = await workspaceProject("work-mutation");
  const snapshot = (await captureCreativeProject(input.projectId))!;
  const data = (await storage.loadAuthoredGame(input.projectId))!;
  const promise = buildProjectZip(data, undefined, undefined, undefined, undefined, snapshot);
  // Mutate the offered objects after the call returned a promise: the offer
  // was captured synchronously, so neither the envelope nor its bytes move.
  const draft = snapshot.work!.drafts[0]!;
  (draft.recovery.drafts[0]! as { notes: string }).notes = "mutated after offer";
  snapshot.workBlobs[src.encoded.hash]!.fill(0);
  const zip = await promise;
  const opened = await readGameZip(zip);
  const work = opened.project!.creativeWork!;
  assert.deepEqual(work.work.drafts[0]!.recovery.drafts[0]!.notes, "unfinished notes");
  assert.deepEqual([...work.blobs[src.encoded.hash]!], [...encoded]);
});
