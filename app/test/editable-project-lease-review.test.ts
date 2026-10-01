import assert from "node:assert/strict";
import { test } from "node:test";
import { DraftBusyError } from "../../src/authoring/projectDraft.ts";
import { openEditableProject } from "../src/project/editableProject.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import * as storage from "../src/project/gameStorage.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

const records = installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => {
      cache.set(key, value);
    },
    removeItem: (key: string) => cache.delete(key),
  },
});

async function seedProject(name: string, adjust?: (data: CachedGameData) => void) {
  const prepared = prepareLocalProject({ title: name, kind: "blank" });
  await prepared.save();
  if (adjust) {
    const data = await storage.loadAuthoredGame(prepared.projectId);
    assert.ok(data);
    adjust(data);
    assert.equal(await storage.saveAuthoredGame(prepared.projectId, data), true);
  }
  return prepared.projectId;
}

function editSource(
  ws: Awaited<ReturnType<typeof openEditableProject>>,
  key: string,
  content: string,
) {
  const snapshot = ws.draft.capture();
  ws.draft.edit(key, content, snapshot.version(key));
}

function busy(error: unknown, reason: string): boolean {
  assert.ok(error instanceof DraftBusyError, `expected DraftBusyError, got ${String(error)}`);
  assert.equal(error.reason, reason);
  return true;
}

test("a lease-refused Keep performs zero durable writes before a genuine retry", async () => {
  const projectId = await seedProject("actual-busy-keep-storage");
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", "return; // pending candidate");
  const candidate = ws.buildSelected(["logic:1"]);
  const body = structuredClone(records.get(projectId));
  const write = records.set.bind(records);
  let writes = 0;
  records.set = (key, value) => {
    writes++;
    return write(key, value);
  };
  const lease = ws.draft.acquireHistoryMutation(ws.draft.capture().revision);
  try {
    await assert.rejects(ws.keepCandidate(candidate), (error: unknown) =>
      busy(error, "native-history"),
    );
    assert.equal(writes, 0);
    assert.deepEqual(records.get(projectId), body);
  } finally {
    ws.draft.releaseHistoryMutation(lease);
    records.set = write;
  }
  const result = await ws.keepCandidate(candidate);
  assert.equal(result.kind, "savedOnly");
  assert.deepEqual(ws.draft.dirtyKeys(), []);
});

test("failed durable publication releases the Keep reservation and exact candidate retry reacquires it", async () => {
  const projectId = await seedProject("actual-keep-retry-lease");
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", "return; // exact retry");
  const candidate = ws.buildSelected(["logic:1"]);
  const before = ws.savedIdentity();
  const body = structuredClone(records.get(projectId));
  const write = records.set.bind(records);
  let failed = false;
  records.set = (key, value) => {
    if (!failed && key === projectId) {
      failed = true;
      throw new DOMException("Injected publication quota", "QuotaExceededError");
    }
    return write(key, value);
  };
  try {
    await assert.rejects(ws.keepCandidate(candidate));
    assert.equal(failed, true);
    assert.deepEqual(records.get(projectId), body);
    assert.equal(ws.savedIdentity(), before);
    assert.deepEqual(ws.draft.dirtyKeys(), ["logic:1"]);
  } finally {
    records.set = write;
  }
  const lease = ws.draft.acquireHistoryMutation(ws.draft.capture().revision);
  ws.draft.releaseHistoryMutation(lease);
  const retry = ws.keepCandidate(candidate);
  assert.throws(
    () => ws.draft.acquireHistoryMutation(ws.draft.capture().revision),
    (error: unknown) => busy(error, "keep-pending"),
  );
  const kept = await retry;
  assert.equal(kept.saved.generation, before.generation + 1);
  assert.deepEqual(ws.draft.dirtyKeys(), []);
  const replay = await ws.keepCandidate(candidate);
  assert.equal(replay.commitId, kept.commitId);
  assert.equal(ws.savedIdentity().generation, before.generation + 1);
  ws.draft.releaseHistoryMutation(ws.draft.acquireHistoryMutation(ws.draft.capture().revision));
});
