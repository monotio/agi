import assert from "node:assert/strict";
import { test } from "node:test";
import { writeProjectRecovery } from "../../src/authoring/projectRecovery.ts";
import { readProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { openEditableProject, type EditableProject } from "../src/project/editableProject.ts";
import * as storage from "../src/project/gameStorage.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import {
  discardProjectDraft,
  listProjectDrafts,
  saveProjectDraft,
} from "../src/project/projectDrafts.ts";
import { LogicDraftPersister, recoveryEntries } from "../src/studio/logic/logicRecovery.ts";
import {
  analysisBindings,
  analysisWords,
  byteLines,
  derivedLogicSource,
  documentLabel,
  logicDocumentUri,
  workspaceDocuments,
} from "../src/studio/logic/logicWorkspace.ts";
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

async function seedProject(
  name: string,
  kind: "boilerplate" | "starter" = "boilerplate",
  adjust?: (data: CachedGameData) => void,
) {
  const prepared = prepareLocalProject({ title: name, kind });
  await prepared.save();
  if (adjust) {
    const data = await storage.loadAuthoredGame(prepared.projectId);
    assert.ok(data);
    adjust(data);
    assert.equal(await storage.saveAuthoredGame(prepared.projectId, data), true);
  }
  return prepared.projectId;
}

function editSource(ws: EditableProject, key: string, content: string): void {
  const snapshot = ws.draft.capture();
  ws.draft.edit(key, content, snapshot.version(key));
}

const ROOM1_REDRAW = "// Room 1\nif (isset(f5)) {\n  accept.input();\n}\nreturn;";
const ROOM1_ALT = "// Room 1 variant\nif (isset(f5)) {\n  show.pic();\n}\nreturn;";

/** Capture what a recovery write needs, the way the host does it at write time. */
function captureRecovery(ws: EditableProject) {
  return () => {
    if (ws.draft.dirtyKeys().length === 0) return null;
    const saved = ws.savedIdentity();
    return {
      expected: { generation: saved.generation, lifetime: saved.lifetime },
      recovery: writeProjectRecovery(
        { revision: saved.revision, authoring: saved.authoring, profileId: ws.profileId },
        ws.draft.captureRecovery(),
      ),
    };
  };
}

test("an unfinished draft reopens inside a fresh workspace under its reviewed receipt", async () => {
  const projectId = await seedProject("logic-host-restore");
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", ROOM1_REDRAW);
  const capture = captureRecovery(ws);
  const receipt = await saveProjectDraft({
    projectId,
    workspaceId: "tab-a",
    expectedReceipt: null,
    ...capture()!,
  });

  const restored = await openEditableProject(projectId, {
    restore: { workspaceId: "tab-a", receipt },
  });
  assert.equal(restored.draft.capture().read("logic:1")!.content, ROOM1_REDRAW);
  assert.deepEqual(restored.draft.dirtyKeys(), ["logic:1"]);
  assert.deepEqual(restored.restoredRecovery, { workspaceId: "tab-a", receipt });
  // The restored draft keeps through the ordinary reviewed candidate path.
  const kept = await restored.keepCandidate(restored.buildSelected(["logic:1"]));
  assert.equal(kept.kind, "savedOnly");
  const data = await storage.loadAuthoredGame(projectId);
  assert.equal(readProjectWorkspace(data!.workspace)["logic:1"], ROOM1_REDRAW);
});

test("restore refuses an unreviewed receipt and a draft whose saved base moved", async () => {
  const projectId = await seedProject("logic-host-receipt");
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", ROOM1_REDRAW);
  const capture = captureRecovery(ws);
  const receipt = await saveProjectDraft({
    projectId,
    workspaceId: "tab-b",
    expectedReceipt: null,
    ...capture()!,
  });
  await assert.rejects(
    openEditableProject(projectId, {
      restore: { workspaceId: "tab-b", receipt: { ...receipt, sequence: 99 } },
    }),
    /changed|review/i,
  );
  await assert.rejects(
    openEditableProject(projectId, { restore: { workspaceId: "missing", receipt } }),
    /gone|missing|reopen/i,
  );

  // The kept base moves; the stored draft is then stale and must not restore.
  editSource(ws, "logic:1", ROOM1_ALT);
  await ws.keepCandidate(ws.buildSelected(["logic:1"]));
  assert.equal((await listProjectDrafts(projectId))[0]!.status, "stale");
  await assert.rejects(
    openEditableProject(projectId, { restore: { workspaceId: "tab-b", receipt } }),
    /This draft belongs to an older saved project\. Choose Download or Discard\./,
  );
  await discardProjectDraft(projectId, "tab-b", receipt);
});

test("a portable recovery restores through the same verified base, stale ones refuse", async () => {
  const projectId = await seedProject("logic-host-portable");
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", ROOM1_REDRAW);
  const capture = captureRecovery(ws);
  const recovery = capture()!.recovery;

  const restored = await openEditableProject(projectId, { restore: { portable: recovery } });
  assert.equal(restored.draft.capture().read("logic:1")!.content, ROOM1_REDRAW);
  assert.equal(restored.restoredRecovery, undefined);

  editSource(ws, "logic:1", ROOM1_ALT);
  await ws.keepCandidate(ws.buildSelected(["logic:1"]));
  await assert.rejects(
    openEditableProject(projectId, { restore: { portable: recovery } }),
    /stale/i,
  );
});

test("recovery entries report current and stale drafts and a carried portable draft", async () => {
  const projectId = await seedProject("logic-host-entries");
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", ROOM1_REDRAW);
  const capture = captureRecovery(ws);
  const receipt = await saveProjectDraft({
    projectId,
    workspaceId: "tab-c",
    expectedReceipt: null,
    ...capture()!,
  });
  const stored = await storage.loadAuthoredGame(projectId);
  const entries = await recoveryEntries(stored!);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind, "stored");
  assert.equal(entries[0]!.status, "current");
  assert.deepEqual(entries[0]!.receipt, receipt);
  assert.ok(entries[0]!.keys.includes("logic:1"));

  // A portable draft carried inside the stored body is exposed, not consumed.
  stored!.recoveryDraft = capture()!.recovery as CachedGameData["recoveryDraft"];
  const withPortable = await recoveryEntries(stored!);
  const portable = withPortable.find((entry) => entry.kind === "portable");
  assert.ok(portable);
  assert.equal(portable.status, "current");
  assert.ok(portable.keys.includes("logic:1"));
});

test("the persister writes debounced, serialized snapshots and chains its receipt", async () => {
  const projectId = await seedProject("logic-host-persist");
  const ws = await openEditableProject(projectId);
  const errors: string[] = [];
  const persister = new LogicDraftPersister({
    projectId,
    workspaceId: "logic-tab-1",
    capture: captureRecovery(ws),
    delay: 5,
    onError: (message) => errors.push(message),
  });
  editSource(ws, "logic:1", ROOM1_REDRAW);
  persister.schedule();
  persister.schedule();
  await persister.flush();
  let drafts = await listProjectDrafts(projectId);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.receipt.sequence, 1);
  const incarnation = drafts[0]!.receipt.incarnation;
  const first = drafts[0]!.recovery.documents.find((doc) => doc.key === "logic:1")!;
  assert.equal(first.content.type === "text" && first.content.text, ROOM1_REDRAW);

  editSource(ws, "logic:1", ROOM1_ALT);
  persister.schedule();
  await persister.flush();
  drafts = await listProjectDrafts(projectId);
  assert.equal(drafts[0]!.receipt.sequence, 2);
  assert.equal(drafts[0]!.receipt.incarnation, incarnation);
  const next = drafts[0]!.recovery.documents.find((doc) => doc.key === "logic:1")!;
  assert.equal(next.content.type === "text" && next.content.text, ROOM1_ALT);
  assert.deepEqual(errors, []);
  persister.dispose();
});

test("a persister write failure is reported and later writes still land", async () => {
  const projectId = await seedProject("logic-host-persist-fail");
  const ws = await openEditableProject(projectId);
  const errors: string[] = [];
  const persister = new LogicDraftPersister({
    projectId,
    workspaceId: "logic-tab-2",
    capture: captureRecovery(ws),
    delay: 0,
    onError: (message) => errors.push(message),
  });
  const realSet = records.set.bind(records);
  let fail = true;
  records.set = (key, value) => {
    if (fail && key === `draft/${projectId}/logic-tab-2`) throw new Error("quota");
    return realSet(key, value);
  };
  try {
    editSource(ws, "logic:1", ROOM1_REDRAW);
    await persister.flush();
    assert.ok(errors.length > 0, "the persistence failure is surfaced");
    fail = false;
    await persister.flush();
    assert.equal((await listProjectDrafts(projectId)).length, 1);
  } finally {
    records.set = realSet;
    persister.dispose();
  }
});

test("after Keep the remaining draft persists against the new kept base, not the old one", async () => {
  const projectId = await seedProject("logic-host-keep-remainder");
  const ws = await openEditableProject(projectId);
  const persister = new LogicDraftPersister({
    projectId,
    workspaceId: "logic-tab-3",
    capture: captureRecovery(ws),
    delay: 0,
  });
  editSource(ws, "logic:1", ROOM1_REDRAW);
  const candidate = ws.buildSelected(["logic:1"]);

  // Type during the admitted storage wait: the newer text stays dirty.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = storage.serializeWrite(projectId, () => gate);
  const keeping = ws.keepCandidate(candidate);
  editSource(ws, "logic:1", ROOM1_ALT);
  release();
  await blocker;
  await keeping;

  await persister.flush();
  const drafts = await listProjectDrafts(projectId);
  assert.equal(drafts.length, 1);
  const saved = ws.savedIdentity();
  assert.equal(drafts[0]!.expected.generation, saved.generation);
  assert.equal(drafts[0]!.status, "current");
  const doc = drafts[0]!.recovery.documents.find((entry) => entry.key === "logic:1")!;
  assert.equal(doc.content.type === "text" && doc.content.text, ROOM1_ALT);
  persister.dispose();
});

test("discarding a clean workspace removes exactly its own recovery record", async () => {
  const projectId = await seedProject("logic-host-discard");
  const ws = await openEditableProject(projectId);
  const persister = new LogicDraftPersister({
    projectId,
    workspaceId: "logic-tab-4",
    capture: captureRecovery(ws),
    delay: 0,
  });
  editSource(ws, "logic:1", ROOM1_REDRAW);
  await persister.flush();
  const other = new LogicDraftPersister({
    projectId,
    workspaceId: "logic-tab-5",
    capture: captureRecovery(ws),
    delay: 0,
  });
  await other.flush();
  assert.equal((await listProjectDrafts(projectId)).length, 2);
  await persister.discard();
  const remaining = await listProjectDrafts(projectId);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.workspaceId, "logic-tab-5");
  other.dispose();
});

test("document helpers enumerate every slot, label bytes read-only and build unique URIs", () => {
  const projectId = "local-abc";
  const uriA = logicDocumentUri(projectId, "ws-1", "logic:1");
  const uriB = logicDocumentUri(projectId, "ws-2", "logic:1");
  assert.notEqual(uriA, uriB);
  assert.ok(uriA.includes(projectId) && uriA.includes("ws-1") && uriA.includes("logic%3A1"));
  assert.equal(documentLabel("logic:0"), "LOGIC 0");
  assert.equal(documentLabel("logic:255"), "LOGIC 255");
  assert.equal(documentLabel("picture:12"), "PIC 12");
  assert.equal(documentLabel("view:3"), "VIEW 3");
  assert.equal(documentLabel("sound:7"), "SND 7");
  assert.equal(documentLabel("words"), "WORDS.TOK");
  assert.equal(documentLabel("bindings"), "Bindings");

  const documents = workspaceDocuments(
    {
      "logic:0": "return;",
      "logic:255": "return;",
      "picture:1": new Uint8Array([1, 2]),
      words: "[]",
      bindings: "{}",
    },
    ["logic:255"],
  );
  assert.deepEqual(
    documents.map((doc) => [doc.key, doc.kind, doc.dirty]),
    [
      ["logic:0", "text", false],
      ["logic:255", "text", true],
      ["picture:1", "bytes", false],
      ["words", "text", false],
      ["bindings", "text", false],
    ],
  );
});

test("byte inspection renders offsets, hex and printable text read-only", () => {
  const lines = byteLines(new Uint8Array([0x41, 0x42, 0x00, 0x7f, 0x20]));
  assert.deepEqual(lines, ["0000  41 42 00 7F 20                                   AB.. "]);
  const wide = byteLines(new Uint8Array(17).fill(0x2e));
  assert.equal(wide.length, 2);
  assert.match(wide[1]!, /^0010 {2}2E {47}\./);
});

test("a bytes-only logic gets a clearly derived preview, never treated as source", async () => {
  const projectId = await seedProject("logic-host-bytes");
  const stored = await storage.loadAuthoredGame(projectId);
  // Drop the source claim: the stored body still plays, the workspace sees bytes.
  stored!.workspace = undefined;
  stored!.authoringState = {};
  assert.equal(await storage.saveAuthoredGame(projectId, stored!), true);
  const bytesOnly = await openEditableProject(projectId);
  const doc = bytesOnly.draft.capture().read("logic:1");
  assert.ok(doc && doc.content instanceof Uint8Array, "unclaimed logic opens as bytes");
  const preview = derivedLogicSource(doc.content, bytesOnly.profileId, []);
  assert.ok(preview.source.includes("return"), "the preview renders disassembly text");
  const entry = workspaceDocuments({ "logic:1": doc.content }, []).find(
    (item) => item.key === "logic:1",
  )!;
  assert.equal(entry.kind, "bytes");
});

test("analysis context reads draft words and bindings and reports invalid context", async () => {
  const projectId = await seedProject("logic-host-context", "starter");
  const ws = await openEditableProject(projectId);
  const snapshot = ws.draft.capture();
  const words = analysisWords(snapshot.read("words")?.content);
  assert.ok(words.some(([word]) => word === "look"));
  const bindings = analysisBindings(snapshot.read("bindings")?.content);
  assert.equal(bindings["first_room"]?.num, 1);
  assert.throws(() => analysisBindings("{not json"), /bindings|JSON|invalid/i);
  assert.throws(() => analysisWords("not json"), /words|JSON|invalid/i);
});
