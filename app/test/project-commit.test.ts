import assert from "node:assert/strict";
import { test } from "node:test";
import { testProjectId } from "./identity.ts";
import * as storage from "../src/project/gameStorage.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

const records = installIndexedDbFixture();
const cache = new Map<string, string>();
let cacheFails = false;
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem(key: string, value: string) {
      if (cacheFails) throw new Error("cache quota");
      cache.set(key, value);
    },
    removeItem: (key: string) => cache.delete(key),
  },
});
function request(name: string) {
  return {
    commitId: "first",
    workspaceId: "workspace-one",
    buildId: "a".repeat(64),
    projectId: testProjectId(name),
    expected: null,
    documents: [{ key: "logic:1", version: 2 }],
    data: {
      title: "New adventure",
      provider: "",
      model: "",
      files: { "VOL.0": Uint8Array.of(1, 2, 3) },
      words: [] as [string, number][],
      authoringState: { sources: { logics: [[1, "return;"]] } },
    },
  };
}

test("a durable commit remains successful and loadable when the disposable cache fails", async () => {
  const input = request("receipt-cache-failure");
  cacheFails = true;
  try {
    const result = await storage.commitProject(input);
    assert.equal(result.receipt.saved.generation, 1);
    assert.deepEqual(result.warnings, ["indexRepairPending"]);
    assert.equal((await storage.loadAuthoredGame(input.projectId))!.title, input.data.title);
    assert.equal(records.has(input.projectId), true);
    assert.ok(
      (await storage.listStoredProjects()).some((entry) => entry.projectId === input.projectId),
    );
    const retry = await storage.commitProject(input);
    assert.deepEqual(retry.receipt, result.receipt);
    assert.equal((await storage.loadAuthoredGame(input.projectId))!.generation, 1);
  } finally {
    cacheFails = false;
  }
});

test("commit identity binds content, workspace and captured versions", async () => {
  const input = request("receipt-content-binding");
  await storage.commitProject(input);
  for (const changed of [
    { ...input, data: { ...input.data, title: "Different" } },
    { ...input, workspaceId: "another-workspace" },
    { ...input, documents: [{ key: "logic:1", version: 3 }] },
  ])
    await assert.rejects(storage.commitProject(changed), /commit.*different|reused/i);
  assert.equal((await storage.loadAuthoredGame(input.projectId))!.generation, 1);
});

test("a retry resolves its receipt before an obsolete generation check, without repeating a write", async () => {
  const input = request("receipt-after-new-save");
  const first = await storage.commitProject(input);
  const next = {
    ...input,
    commitId: "second",
    expected: first.receipt.saved,
    data: { ...input.data, title: "Second save" },
  };
  const second = await storage.commitProject(next);
  assert.equal(second.receipt.saved.generation, 2);
  assert.deepEqual((await storage.commitProject(input)).receipt, first.receipt);
  assert.equal((await storage.loadAuthoredGame(input.projectId))!.title, "Second save");
  assert.equal(storage.getCachedGameMeta(input.projectId)!.title, "Second save");
  await assert.rejects(
    storage.commitProject({ ...next, commitId: "stale-third" }),
    /modified|stale|generation/i,
  );
});

test("a deleted/recreated lifetime cannot inherit an old receipt", async () => {
  const input = request("receipt-recreated");
  const first = await storage.commitProject(input);
  await storage.clearCachedGame(input.projectId);
  const recreated = await storage.commitProject({ ...input, commitId: "recreate" });
  assert.notEqual(recreated.receipt.saved.lifetime, first.receipt.saved.lifetime);
  await assert.rejects(storage.commitProject(input), /removed|replaced|lifetime/i);
  assert.equal((await storage.loadAuthoredGame(input.projectId))!.generation, 1);
});

test("commit captures input before its first await and refuses future project bodies", async () => {
  const input = request("receipt-owned-input");
  const pending = storage.commitProject(input);
  input.data.files["VOL.0"][0] = 99;
  input.data.title = "Changed while waiting";
  const result = await pending;
  const saved = (await storage.loadAuthoredGame(input.projectId))!;
  assert.equal(saved.files["VOL.0"]![0], 1);
  assert.equal(saved.title, "New adventure");
  records.set(input.projectId, { ...(records.get(input.projectId) as object), version: 999 });
  await assert.rejects(
    storage.commitProject({
      ...request("receipt-owned-input"),
      commitId: "future",
      expected: result.receipt.saved,
    }),
    /version.*not supported/i,
  );
  assert.equal((records.get(input.projectId) as { version: number }).version, 999);
});

test("unknown nested library versions are refused before a receipt retry or replacement", async () => {
  const input = request("receipt-future-library");
  const first = await storage.commitProject(input);
  const body = records.get(input.projectId) as { library: object };
  const future = { ...body, library: { ...body.library, version: 999 } };
  records.set(input.projectId, future);
  await assert.rejects(storage.commitProject(input), /version.*not supported/i);
  await assert.rejects(
    storage.commitProject({
      ...input,
      commitId: "replace",
      expected: first.receipt.saved,
    }),
    /version.*not supported/i,
  );
  assert.deepEqual(records.get(input.projectId), future);
});

test("damaged disposable cache entries do not hide committed bodies or prevent receipt recovery", async () => {
  const input = request("receipt-corrupt-cache");
  const first = await storage.commitProject(input);
  for (const raw of ["{broken", "null", "7", "[]"]) {
    cache.set(storage.getStorageKey(input.projectId), raw);
    assert.equal((await storage.loadAuthoredGame(input.projectId))!.title, input.data.title);
    assert.deepEqual((await storage.commitProject(input)).receipt, first.receipt);
    assert.equal((await storage.loadAuthoredGame(input.projectId))!.generation, 1);
  }
  const future = JSON.stringify({
    format: "monotio.agi.project-index",
    version: 999,
    storage: "indexeddb",
  });
  cache.set(storage.getStorageKey(input.projectId), future);
  await assert.rejects(storage.loadAuthoredGame(input.projectId), /version.*not supported/i);
  await assert.rejects(storage.commitProject(input), /version.*not supported/i);
  assert.equal(cache.get(storage.getStorageKey(input.projectId)), future);
});

test("durable discovery isolates malformed bodies and normalizes readable library metadata", async () => {
  const input = request("discovery-readable");
  await storage.commitProject(input);
  const original = records.get(input.projectId) as { library: object };
  const changed = {
    ...original,
    library: { ...original.library, preview: "https://example.invalid/remote.png" },
  };
  records.set(input.projectId, changed);
  const badIds: string[] = [];
  try {
    for (const [index, fields] of [
      { authoredAt: 5 },
      { title: null },
      { provider: [] },
      { model: false },
      { library: { version: 1, revision: "invalid" } },
      { library: { ...original.library, version: 999 } },
    ].entries()) {
      const id = `discovery-bad-${index}`;
      badIds.push(id);
      records.set(id, { ...original, ...fields, projectId: id });
    }
    const entries = await storage.listStoredProjects();
    assert.equal(
      entries.some((entry) => badIds.includes(entry.projectId)),
      false,
    );
    assert.equal(
      entries.find((entry) => entry.projectId === input.projectId)?.library?.preview,
      undefined,
    );
    assert.deepEqual(records.get(input.projectId), changed);
  } finally {
    for (const id of badIds) records.delete(id);
  }
});

test("receipt content distinguishes negative zero and rejects unsupported metadata before storage", async () => {
  const input = request("receipt-number-identity");
  const negative = { ...input, data: { ...input.data, transcript: [-0] } };
  await storage.commitProject(negative);
  await assert.rejects(
    storage.commitProject({ ...input, data: { ...input.data, transcript: [0] } }),
    /commit.*different|reused/i,
  );
  const unsupported = request("receipt-unsupported");
  await assert.rejects(
    storage.commitProject({
      ...unsupported,
      data: { ...unsupported.data, transcript: [new Date(0)] },
    }),
    /unsupported value/i,
  );
  assert.equal(records.has(unsupported.projectId), false);
});
