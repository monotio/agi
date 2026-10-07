import assert from "node:assert/strict";
import { test } from "node:test";
import { DraftBusyError } from "../../src/authoring/projectDraft.ts";
import { openEditableProject, type EditableCandidate } from "../src/project/editableProject.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import * as storage from "../src/project/gameStorage.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

installIndexedDbFixture();
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

test("a Keep refused during a history lease commits nothing and stays keepable", async () => {
  const projectId = await seedProject("ws-lease-blocks-keep");
  const ws = await openEditableProject(projectId);
  const before = ws.savedIdentity();
  editSource(ws, "logic:1", "return; // a");
  const candidate = ws.buildSelected(["logic:1"]);
  const lease = ws.draft.acquireHistoryMutation(ws.draft.capture().revision);
  // The refusal lands before admission: no request was registered, no storage
  // attempt ran, and the candidate is neither pending nor consumed.
  await assert.rejects(ws.keepCandidate(candidate), (e: unknown) => busy(e, "native-history"));
  assert.equal(ws.savedIdentity(), before);
  ws.draft.releaseHistoryMutation(lease);
  const result = await ws.keepCandidate(candidate);
  assert.equal(result.kind, "savedOnly");
  assert.notEqual(ws.savedIdentity(), before);
  assert.deepEqual(ws.draft.dirtyKeys(), []);
});

test("an admitted Keep reserves the draft until it settles while typing stays free", async () => {
  const projectId = await seedProject("ws-keep-reserves");
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", "return; // a");
  const candidate = ws.buildSelected(["logic:1"]);
  const pending = ws.keepCandidate(candidate);
  // The synchronous window after admission: the durable attempt is in flight,
  // so history acquisition waits — but ordinary typing is not locked.
  assert.throws(
    () => ws.draft.acquireHistoryMutation(ws.draft.capture().revision),
    (e: unknown) => busy(e, "keep-pending"),
  );
  editSource(ws, "logic:1", "return; // newer");
  await pending;
  // The admitted baseline acknowledged only the kept key's captured content;
  // the newer typing stays dirty.
  assert.deepEqual(ws.draft.dirtyKeys(), ["logic:1"]);
  const lease = ws.draft.acquireHistoryMutation(ws.draft.capture().revision);
  ws.draft.releaseHistoryMutation(lease);
});

test("a duplicate pending Keep shares the admitted attempt and its receipt", async () => {
  const projectId = await seedProject("ws-keep-dup");
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", "return; // a");
  const before = ws.savedIdentity();
  const candidate: EditableCandidate = ws.buildSelected(["logic:1"]);
  const first = ws.keepCandidate(candidate);
  // The second call joins the in-flight admission instead of admitting anew;
  // the async service wraps the shared pending promise, so compare the result.
  const [one, two] = await Promise.all([first, ws.keepCandidate(candidate)]);
  assert.equal(two.commitId, one.commitId);
  assert.equal(ws.savedIdentity().generation, before.generation + 1);
});

test("a failed storage attempt releases its reservation and retry is a fresh admission", async () => {
  const projectId = await seedProject("ws-keep-failure");
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", "return; // a");
  const candidate = ws.buildSelected(["logic:1"]);
  // Another service moves the stored body out from under the admitted request.
  const other = await openEditableProject(projectId);
  editSource(other, "logic:1", "return; // moved");
  await other.keepCandidate(other.buildSelected(["logic:1"]));
  await assert.rejects(ws.keepCandidate(candidate), /changed elsewhere|modified by another/i);
  // Settlement released the reservation: history acquisition is free again.
  const lease = ws.draft.acquireHistoryMutation(ws.draft.capture().revision);
  ws.draft.releaseHistoryMutation(lease);
  // The failed attempt left the workspace editable and dirty as before.
  assert.deepEqual(ws.draft.dirtyKeys(), ["logic:1"]);
});

test("a settled candidate replays its receipt during a lease without baseline drift", async () => {
  const projectId = await seedProject("ws-lease-replay");
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", "return; // a");
  const candidate = ws.buildSelected(["logic:1"]);
  const first = await ws.keepCandidate(candidate);
  const saved = ws.savedIdentity();
  const lease = ws.draft.acquireHistoryMutation(ws.draft.capture().revision);
  const replay = await ws.keepCandidate(candidate);
  assert.equal(replay.commitId, first.commitId);
  assert.deepEqual(replay.saved, saved);
  assert.equal(ws.savedIdentity(), saved);
  ws.draft.releaseHistoryMutation(lease);
  assert.deepEqual(ws.draft.dirtyKeys(), []);
});
