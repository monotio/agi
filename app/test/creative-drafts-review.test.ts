import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import {
  creativeBlobKey,
  creativeCatalogKey,
  type CreativeSource,
} from "../../src/creative/catalog.ts";
import { detectProfile } from "../../src/runtime/profile.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import * as storage from "../src/project/gameStorage.ts";
import { stageCreativeBlobs } from "../src/project/creativeStore.ts";
import {
  listCreativeDrafts,
  readCreativeDraft,
  saveCreativeDraft,
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

async function fixture(name: string) {
  const projectId = testProjectId(name);
  const workspaceId = "workspace-one";
  const commit = await storage.commitProject({
    projectId,
    commitId: "initial",
    workspaceId,
    buildId: "a".repeat(64),
    expected: null,
    documents: [{ key: "logic:1", version: 1 }],
    data: {
      title: "Recovery review",
      provider: "",
      model: "",
      files: { "VOL.0": Uint8Array.of(1) },
      words: [],
    },
  });
  const original = Uint8Array.of(1, 2, 3);
  const raster = new Uint8Array(16);
  const extra = Uint8Array.of(4, 5, 6);
  const source: CreativeSource = {
    format: "agi.creative-source",
    version: 1,
    identity: { id: "source", incarnation: "inc", revision: 0 },
    encoded: { hash: sha256Hex(original), byteLength: original.length, mime: "image/png" },
    availability: "original",
    normalized: {
      blob: { hash: sha256Hex(raster), byteLength: raster.length, mime: "application/x-rgba8" },
      format: "rgba8-srgb-unpremultiplied-v1",
      width: 2,
      height: 2,
    },
    origin: { kind: "import", title: "Original" },
  };
  await stageCreativeBlobs({
    projectId,
    expectedHead: 0,
    lease: { id: "lease", owner: "editor", workspace: workspaceId },
    staged: {
      sources: [
        source,
        {
          ...source,
          identity: { ...source.identity, id: "other" },
          encoded: { hash: sha256Hex(extra), byteLength: extra.length, mime: "image/png" },
        },
      ],
    },
    blobs: [
      { hash: sha256Hex(original), mime: "image/png", bytes: original },
      { hash: sha256Hex(raster), mime: "application/x-rgba8", bytes: raster },
      { hash: sha256Hex(extra), mime: "image/png", bytes: extra },
    ],
  });
  const body = (await storage.loadAuthoredGame(projectId))!;
  const saved = commit.receipt.saved;
  const recovery = {
    base: {
      revision: saved.revision,
      authoring: saved.authoring,
      profileId: detectProfile(new Map(Object.entries(body.files)), body.library?.profile).id,
      kept: 0,
      pins: [],
    },
    sources: [source],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  };
  const input = {
    projectId,
    workspaceId,
    expectedReceipt: null,
    expected: { generation: saved.generation, lifetime: saved.lifetime },
    authority: {
      kind: "lease" as const,
      lease: { id: "lease", owner: "editor", workspace: workspaceId },
    },
    recovery,
  };
  return { projectId, workspaceId, input, source, extra, body };
}

test("a recovery hold with extra hashes is classified as damaged", async () => {
  const f = await fixture("review-recovery-extra-hold");
  const result = await saveCreativeDraft(f.input);
  const key = creativeCatalogKey(f.projectId);
  const catalog = structuredClone(records.get(key)) as {
    holds: { id: string; hashes: string[] }[];
  };
  catalog.holds
    .find((h) => h.id === `recovery-${result.receipt.incarnation}`)!
    .hashes.push(sha256Hex(f.extra));
  records.set(key, catalog);
  assert.equal((await readCreativeDraft(f.projectId, f.workspaceId))?.integrity, false);
  assert.equal((await listCreativeDrafts(f.projectId))[0]?.integrity, false);
});

test("a hold of another kind cannot prove creative recovery integrity", async () => {
  const f = await fixture("review-recovery-wrong-hold-kind");
  const result = await saveCreativeDraft(f.input);
  const key = creativeCatalogKey(f.projectId);
  const catalog = structuredClone(records.get(key)) as { holds: { id: string; kind: string }[] };
  catalog.holds.find((h) => h.id === `recovery-${result.receipt.incarnation}`)!.kind =
    "retained-undo";
  records.set(key, catalog);
  assert.equal((await readCreativeDraft(f.projectId, f.workspaceId))?.integrity, false);
});

test("an existing stale receipt cannot authorize rebasing its captured work", async () => {
  const f = await fixture("review-recovery-rebase");
  const result = await saveCreativeDraft(f.input);
  assert.equal(
    await storage.saveAuthoredGame(f.projectId, { ...f.body, title: "New project generation" }),
    true,
  );
  const current = (await storage.loadAuthoredGame(f.projectId))!;
  assert.equal((await readCreativeDraft(f.projectId, f.workspaceId))?.status, "stale");
  await assert.rejects(
    saveCreativeDraft({
      ...f.input,
      expectedReceipt: result.receipt,
      expected: { ...f.input.expected, generation: storage.generationOf(current) },
      authority: { kind: "recovery" },
    }),
    /stale|moved|base/i,
  );
  assert.equal((await readCreativeDraft(f.projectId, f.workspaceId))?.receipt.sequence, 1);
});

test("save verifies the blob descriptor along with its bytes", async () => {
  const f = await fixture("review-recovery-blob-descriptor");
  const key = creativeBlobKey(f.projectId, f.source.encoded.hash);
  records.set(key, { ...(records.get(key) as Record<string, unknown>), mime: "image/jpeg" });
  await assert.rejects(saveCreativeDraft(f.input), /descriptor|mime|match/i);
  assert.equal(await readCreativeDraft(f.projectId, f.workspaceId), null);
});
