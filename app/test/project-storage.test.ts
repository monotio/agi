import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import * as storage from "../src/project/gameStorage.ts";
import { decodeJournalValue } from "../src/project/projectJournalCapture.ts";

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
const manual = () => ({
  title: "Manual adventure",
  files: { "WORDS.TOK": new Uint8Array(52) },
  words: [] as [string, number][],
});

test("unsupported nested History stays recoverable beside a readable project", async () => {
  const id = testProjectId("nested-history");
  const valid = testProjectId("beside-history");
  await storage.saveAuthoredGame(id, manual());
  await storage.saveAuthoredGame(valid, manual());
  const body = records.get(id) as Record<string, unknown>;
  body["editHistory"] = { format: "monotio.agi.project-history", version: 2 };
  const siblingKey = `project-history/${id}/future/entry`;
  const sibling = { projectId: siblingKey, bytes: new Uint8Array([0, 128, 255]) };
  records.set(siblingKey, sibling);
  const before = structuredClone(body);
  const index = cache.get(storage.getStorageKey(id));
  cache.delete(storage.getStorageKey(valid));
  assert.throws(() => storage.readStoredBody(body, id), /history version/);
  assert.ok(
    (await storage.listUnsupportedStoredProjects()).some((entry) => entry.projectId === id),
  );
  assert.ok((await storage.listStoredProjects()).some((entry) => entry.projectId === valid));
  assert.ok((await storage.listStoredProjects()).every((entry) => entry.projectId !== id));
  await storage.reconcileGameIndex();
  assert.ok(cache.get(storage.getStorageKey(valid)));
  const downloaded = JSON.parse(await storage.downloadUnsupportedStoredProject(id));
  assert.deepEqual(decodeJournalValue(downloaded.record), before);
  assert.deepEqual(decodeJournalValue(downloaded.records), [{ key: siblingKey, value: sibling }]);
  assert.deepEqual(records.get(id), before);
  assert.equal(cache.get(storage.getStorageKey(id)), index);
});

for (const [field, format] of [
  ["workspace", "monotio.agi.project-workspace"],
  ["chats", "monotio.agi.chats"],
  ["recoveryDraft", "monotio.agi.recovery-draft"],
  ["library", undefined],
] as const) {
  test(`unsupported nested ${field} stays on the recovery shelf without writes`, async () => {
    const id = testProjectId(`nested-${field}`);
    await storage.saveAuthoredGame(id, manual());
    const body = records.get(id) as Record<string, unknown>;
    body[field] = {
      ...(body[field] as object),
      ...(format ? { format } : {}),
      version: 999,
      future: new Uint8Array([255, 0]),
    };
    const before = structuredClone(body);
    const index = cache.get(storage.getStorageKey(id));
    const entry = (await storage.listUnsupportedStoredProjects()).find(
      (entry) => entry.projectId === id,
    );
    assert.ok(entry);
    assert.equal(entry.state, "unsupported");
    assert.ok(entry.reason);
    assert.equal(entry.recoverable, true);
    await storage.reconcileGameIndex();
    const downloaded = JSON.parse(await storage.downloadUnsupportedStoredProject(id));
    assert.deepEqual(decodeJournalValue(downloaded.record), before);
    assert.deepEqual(records.get(id), before);
    assert.equal(cache.get(storage.getStorageKey(id)), index);
    assert.equal(await storage.saveAuthoredGame(id, manual()), false);
  });
}

for (const [name, patch] of [
  [
    "workspace",
    { workspace: { format: "monotio.agi.project-workspace", version: 1, documents: "broken" } },
  ],
  [
    "history",
    { editHistory: { format: "monotio.agi.project-history", version: 1, blobs: "broken" } },
  ],
  ["files", { files: null }],
  ["identity", { projectId: "different-project" }],
] as const) {
  test(`corrupt ${name} is downloadable and cannot interrupt index repair`, async () => {
    const id = testProjectId(`corrupt-${name}`);
    const valid = testProjectId(`beside-corrupt-${name}`);
    await storage.saveAuthoredGame(id, manual());
    await storage.saveAuthoredGame(valid, manual());
    Object.assign(records.get(id) as object, patch);
    const before = structuredClone(records.get(id));
    const index = cache.get(storage.getStorageKey(id));
    cache.delete(storage.getStorageKey(valid));
    const entry = (await storage.listUnsupportedStoredProjects()).find(
      (entry) => entry.projectId === id,
    );
    assert.ok(entry);
    assert.equal(entry.state, "corrupt");
    assert.ok(entry.reason);
    assert.equal(entry.recoverable, true);
    await storage.reconcileGameIndex();
    assert.ok(cache.get(storage.getStorageKey(valid)));
    assert.ok((await storage.listStoredProjects()).some((entry) => entry.projectId === valid));
    assert.ok((await storage.listStoredProjects()).every((entry) => entry.projectId !== id));
    const downloaded = JSON.parse(await storage.downloadUnsupportedStoredProject(id));
    assert.deepEqual(decodeJournalValue(downloaded.record), before);
    assert.deepEqual(records.get(id), before);
    assert.equal(cache.get(storage.getStorageKey(id)), index);
  });
}

test("a corrupt null body preserves its index and remains downloadable", async (t) => {
  const id = testProjectId("corrupt-null");
  await storage.saveAuthoredGame(id, manual());
  records.set(id, null);
  const index = cache.get(storage.getStorageKey(id));
  const key = storage.getStorageKey(id);
  // Native Storage exposes saved keys to Object.keys during stale-index repair.
  Object.defineProperty(localStorage, key, { configurable: true, enumerable: true, value: index });
  t.after(() => Reflect.deleteProperty(localStorage, key));
  const entry = (await storage.listUnsupportedStoredProjects()).find(
    (entry) => entry.projectId === id,
  );
  assert.ok(entry);
  assert.equal(entry.state, "corrupt");
  const downloaded = JSON.parse(await storage.downloadUnsupportedStoredProject(id));
  assert.equal(decodeJournalValue(downloaded.record), null);
  await storage.reconcileGameIndex();
  assert.equal(cache.get(storage.getStorageKey(id)), index);
  assert.equal(records.get(id), null);
});

test("future stored projects remain discoverable and download their untouched record", async () => {
  const id = testProjectId("future-body");
  await storage.saveAuthoredGame(id, manual());
  const body = records.get(id) as Record<string, unknown>;
  body["version"] = 999;
  body["future"] = { bytes: new Uint8Array([0, 128, 255]), optional: undefined, zero: -0 };
  const blobKey = `project-history/${id}/blobs/future-content`;
  const blob = { projectId: blobKey, version: 999, content: new Uint8Array([7, 0, 255]) };
  records.set(blobKey, blob);
  records.set(`project-history/${id}-other/blobs/unrelated`, { content: "Another project" });
  const before = structuredClone(body);
  const index = cache.get(storage.getStorageKey(id));
  assert.ok(
    (await storage.listUnsupportedStoredProjects()).some(
      (entry) => entry.projectId === id && entry.title === "Manual adventure",
    ),
  );
  await assert.rejects(storage.loadAuthoredGame(id), /version is not supported/);
  const downloaded = JSON.parse(await storage.downloadUnsupportedStoredProject(id));
  assert.deepEqual(decodeJournalValue(downloaded.record), before);
  assert.deepEqual(decodeJournalValue(downloaded.records), [{ key: blobKey, value: blob }]);
  assert.equal(downloaded.index, index);
  await storage.reconcileGameIndex();
  assert.deepEqual(records.get(id), before);
  assert.deepEqual(records.get(blobKey), blob);
  assert.equal(cache.get(storage.getStorageKey(id)), index);
  assert.equal(await storage.saveAuthoredGame(id, manual()), false);
  assert.deepEqual(records.get(id), before);
});

test("future stored projects need neither readable resources nor a title to stay on the shelf", async () => {
  const id = testProjectId("future-layout");
  const body = {
    projectId: id,
    format: "monotio.agi.stored-project",
    version: 2,
    futureFiles: [1, 2],
  };
  records.set(id, body);
  records.set("history/future-layout", { ...body, projectId: "history/future-layout" });
  const entries = await storage.listUnsupportedStoredProjects();
  assert.deepEqual(
    entries.find((entry) => entry.projectId === id),
    {
      projectId: id,
      title: "Saved project",
      state: "unsupported",
      reason: storage.UNREADABLE_PROJECT_MESSAGE,
      recoverable: true,
    },
  );
  assert.ok(entries.every((entry) => !entry.projectId.includes("/")));
  assert.deepEqual(records.get(id), body);
});

test("manual saves use v1 body and index envelopes without provider metadata", async () => {
  const id = testProjectId("manual-body-v1");
  assert.equal(await storage.saveAuthoredGame(id, manual()), true);
  const body = records.get(id) as Record<string, unknown>;
  assert.equal(body["version"], 1);
  assert.equal(body["provider"], undefined);
  assert.equal(body["model"], undefined);
  const index = JSON.parse(cache.get(storage.getStorageKey(id))!);
  assert.equal(index.version, 1);
  assert.equal(Object.hasOwn(index, "provider"), false);
  assert.equal(Object.hasOwn(index, "model"), false);
  assert.equal((await storage.loadAuthoredGame(id))!.title, "Manual adventure");
  assert.ok((await storage.listStoredProjects()).some((entry) => entry.projectId === id));
});

test("v1 bodies read without mutation and keep version 1 on the next conditional save", async () => {
  const id = testProjectId("legacy-body-v1");
  await storage.saveAuthoredGame(id, {
    ...manual(),
    provider: "stub",
    model: "legacy",
    transcript: [],
  });
  const stored = records.get(id) as Record<string, unknown>;
  stored["version"] = 1;
  const oldIndex = JSON.parse(cache.get(storage.getStorageKey(id))!);
  oldIndex.version = 1;
  cache.set(storage.getStorageKey(id), JSON.stringify(oldIndex));
  const before = structuredClone(stored);
  const loaded = (await storage.loadAuthoredGame(id))!;
  assert.deepEqual(records.get(id), before);
  assert.equal(loaded.provider, "stub");
  assert.equal(
    await storage.saveAuthoredGame(
      id,
      { ...loaded, title: "After save" },
      { expectedGeneration: loaded.generation },
    ),
    true,
  );
  assert.equal((records.get(id) as Record<string, unknown>)["version"], 1);
  assert.equal((await storage.loadAuthoredGame(id))!.model, "legacy");
});

test("unknown nested recovery refuses a v1 load without rewriting the record", async () => {
  const id = testProjectId("future-nested-recovery");
  await storage.saveAuthoredGame(id, manual());
  const body = records.get(id) as Record<string, unknown>;
  body["version"] = 1;
  body["recoveryDraft"] = { format: "monotio.agi.recovery-draft", version: 999 };
  const before = structuredClone(body);
  await assert.rejects(storage.loadAuthoredGame(id), /recovery.*version|version.*recovery/i);
  assert.equal(await storage.saveAuthoredGame(id, manual()), false);
  assert.deepEqual(records.get(id), before);
});

test("source-only commits change authoring identity while preserving playable revision", async () => {
  const projectId = testProjectId("workspace-source-only");
  const input = {
    projectId,
    commitId: "first",
    workspaceId: "editor",
    buildId: "a".repeat(64),
    expected: null,
    documents: [{ key: "logic:0", version: 1 }],
    data: { ...manual(), workspace: writeProjectWorkspace({ "logic:0": "return;" }) },
  };
  const first = await storage.commitProject(input);
  const second = await storage.commitProject({
    ...input,
    commitId: "second",
    buildId: "b".repeat(64),
    expected: first.receipt.saved,
    data: {
      ...input.data,
      workspace: writeProjectWorkspace({ "logic:0": "// source comment\nreturn;" }),
    },
  });
  assert.equal(second.receipt.saved.revision, first.receipt.saved.revision);
  assert.notEqual(second.receipt.saved.authoring, first.receipt.saved.authoring);
  const saved = (await storage.loadAuthoredGame(projectId))!;
  assert.deepEqual(
    saved.workspace,
    writeProjectWorkspace({ "logic:0": "// source comment\nreturn;" }),
  );
  const current = records.get(projectId) as Record<string, unknown>;
  current["workspace"] = { format: "monotio.agi.project-workspace", version: 999 };
  const before = structuredClone(current);
  await assert.rejects(storage.loadAuthoredGame(projectId), /workspace.*version/);
  assert.equal(await storage.saveAuthoredGame(projectId, manual()), false);
  assert.deepEqual(records.get(projectId), before);
});

test("removed index and commit versions refuse reads and writes without rewriting records", async () => {
  const id = testProjectId("unknown-index");
  await storage.saveAuthoredGame(id, manual());
  const key = storage.getStorageKey(id);
  const index = JSON.parse(cache.get(key)!);
  index.version = 2;
  const raw = JSON.stringify(index);
  cache.set(key, raw);
  const before = structuredClone(records.get(id));
  await assert.rejects(storage.loadAuthoredGame(id), /version is not supported/);
  assert.equal(await storage.saveAuthoredGame(id, manual()), false);
  assert.equal(cache.get(key), raw);
  assert.deepEqual(records.get(id), before);

  const projectId = testProjectId("unknown-commit");
  const input = {
    projectId,
    commitId: "initial",
    workspaceId: "test",
    expected: null,
    buildId: "a".repeat(64),
    documents: [],
    data: manual(),
  };
  await storage.commitProject(input);
  const receiptKey = `commit/${projectId}/initial`;
  const receipt = records.get(receiptKey) as Record<string, unknown>;
  assert.equal(receipt["version"], 1);
  receipt["version"] = 2;
  const storedBefore = structuredClone([...records]);
  await assert.rejects(storage.commitProject(input), /commit version is not supported/);
  assert.deepEqual([...records], storedBefore);
});
