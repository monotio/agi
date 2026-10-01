import assert from "node:assert/strict";
import { test } from "node:test";
import { writeProjectRecovery } from "../../src/authoring/projectRecovery.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject, type EditableProject } from "../src/project/editableProject.ts";
import { listProjectDrafts, saveProjectDraft } from "../src/project/projectDrafts.ts";
import { LogicDraftPersister, type LogicDraftCapture } from "../src/studio/logic/logicRecovery.ts";
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

const ROOM1_ALT = "// Room 1 variant\nif (isset(f5)) {\n  show.pic();\n}\nreturn;";

async function seedWorkspace(name: string) {
  const prepared = prepareLocalProject({ title: name, kind: "blank" });
  await prepared.save();
  const ws = await openEditableProject(prepared.projectId);
  return { projectId: prepared.projectId, ws };
}

function baseline(ws: EditableProject, key: string): string {
  const content = ws.inspection.documents[key];
  assert.ok(typeof content === "string", `expected text ${key}`);
  return content;
}

function editSource(ws: EditableProject, key: string, content: string): void {
  const snapshot = ws.draft.capture();
  ws.draft.edit(key, content, snapshot.version(key));
}

/**
 * The same write-time capture LogicStudio installs: superseded workspaces
 * answer null, a still-owned clean draft answers { clean: true }, and a
 * dirty draft answers its recovery payload.
 */
function captureRecovery(
  ws: EditableProject,
  mounted: { current: boolean } = { current: true },
): { capture: LogicDraftCapture; mounted: { current: boolean } } {
  return {
    mounted,
    capture: () => {
      if (!mounted.current) return null;
      if (ws.draft.dirtyKeys().length === 0) return { clean: true };
      const saved = ws.savedIdentity();
      return {
        expected: { generation: saved.generation, lifetime: saved.lifetime },
        recovery: writeProjectRecovery(
          { revision: saved.revision, authoring: saved.authoring, profileId: ws.profileId },
          ws.draft.captureRecovery(),
        ),
      };
    },
  };
}

/** The capture result of a dirty draft, for direct writes by a second writer. */
function dirtyPayload(ws: EditableProject) {
  const captured = captureRecovery(ws).capture();
  if (captured === null || "clean" in captured) throw new Error("expected a dirty capture payload");
  return captured;
}

async function waitFor(check: () => Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("undoing a dirty draft back to its saved baseline retires its own recovery record", async () => {
  const { projectId, ws } = await seedWorkspace("clean-flush");
  const original = baseline(ws, "logic:1");
  const persister = new LogicDraftPersister({
    projectId,
    workspaceId: "clean-tab-1",
    capture: captureRecovery(ws).capture,
    delay: 0,
  });
  try {
    editSource(ws, "logic:1", ROOM1_ALT);
    assert.equal(await persister.flush(), true);
    assert.equal((await listProjectDrafts(projectId)).length, 1);
    assert.ok(persister.currentReceipt);

    editSource(ws, "logic:1", original);
    assert.deepEqual(ws.draft.dirtyKeys(), []);
    assert.equal(await persister.flush(), true);
    assert.deepEqual(await listProjectDrafts(projectId), []);
    assert.equal(persister.currentReceipt, null);
  } finally {
    persister.dispose();
  }
});

test("the debounced write also retires a clean draft's record", async () => {
  const { projectId, ws } = await seedWorkspace("clean-debounce");
  const original = baseline(ws, "logic:1");
  const persister = new LogicDraftPersister({
    projectId,
    workspaceId: "clean-tab-2",
    capture: captureRecovery(ws).capture,
    delay: 10,
  });
  try {
    editSource(ws, "logic:1", ROOM1_ALT);
    await persister.flush();
    assert.equal((await listProjectDrafts(projectId)).length, 1);

    editSource(ws, "logic:1", original);
    persister.schedule();
    await waitFor(
      async () => (await listProjectDrafts(projectId)).length === 0,
      "the debounced clean write did not retire the recovery record",
    );
  } finally {
    persister.dispose();
  }
});

test("a clean close settles the retirement instead of cancelling the pending debounce", async () => {
  const { projectId, ws } = await seedWorkspace("clean-close");
  const original = baseline(ws, "logic:1");
  const persister = new LogicDraftPersister({
    projectId,
    workspaceId: "clean-tab-3",
    capture: captureRecovery(ws).capture,
    delay: 10_000,
  });
  try {
    editSource(ws, "logic:1", ROOM1_ALT);
    await persister.flush();
    assert.equal((await listProjectDrafts(projectId)).length, 1);

    // The host's clean close: undo, a pending debounce, then discard() is
    // awaited before the component unmounts.
    editSource(ws, "logic:1", original);
    persister.schedule();
    assert.equal(await persister.discard(), true);
    assert.deepEqual(await listProjectDrafts(projectId), []);
  } finally {
    persister.dispose();
  }
});

test("a dirty write already in flight is retired by the clean write queued behind it", async () => {
  const { projectId, ws } = await seedWorkspace("clean-inflight");
  const original = baseline(ws, "logic:1");
  const persister = new LogicDraftPersister({
    projectId,
    workspaceId: "clean-tab-4",
    capture: captureRecovery(ws).capture,
    delay: 0,
  });
  try {
    editSource(ws, "logic:1", ROOM1_ALT);
    const dirty = persister.flush();
    // Let the first write capture its dirty snapshot and enter storage before
    // the draft returns clean: the queued clean write must still delete the
    // record that write is about to land.
    await Promise.resolve();
    editSource(ws, "logic:1", original);
    const clean = persister.flush();
    assert.equal(await dirty, true);
    assert.equal(await clean, true);
    assert.deepEqual(await listProjectDrafts(projectId), []);
    assert.equal(persister.currentReceipt, null);
  } finally {
    persister.dispose();
  }
});

test("new typing during a clean retirement stays dirty and persists as its own record", async () => {
  const { projectId, ws } = await seedWorkspace("clean-retail");
  const original = baseline(ws, "logic:1");
  const persister = new LogicDraftPersister({
    projectId,
    workspaceId: "clean-tab-5",
    capture: captureRecovery(ws).capture,
    delay: 0,
  });
  try {
    editSource(ws, "logic:1", ROOM1_ALT);
    await persister.flush();
    assert.equal((await listProjectDrafts(projectId)).length, 1);

    editSource(ws, "logic:1", original);
    const retiring = persister.flush();
    // New typing while the delete is running is a later queued write, not a
    // reason to keep the old record or to lose the new one.
    await Promise.resolve();
    editSource(ws, "logic:1", "// typed during cleanup\nreturn;");
    const again = persister.flush();
    assert.equal(await retiring, true);
    assert.equal(await again, true);
    const drafts = await listProjectDrafts(projectId);
    assert.equal(drafts.length, 1);
    const document = drafts[0]!.recovery.documents.find((entry) => entry.key === "logic:1")!;
    assert.equal(
      document.content.type === "text" && document.content.text,
      "// typed during cleanup\nreturn;",
    );
  } finally {
    persister.dispose();
  }
});

test("a superseded workspace's null capture never deletes the record", async () => {
  const { projectId, ws } = await seedWorkspace("clean-superseded");
  const { capture, mounted } = captureRecovery(ws);
  const persister = new LogicDraftPersister({
    projectId,
    workspaceId: "clean-tab-6",
    capture,
    delay: 0,
  });
  try {
    editSource(ws, "logic:1", ROOM1_ALT);
    await persister.flush();
    assert.equal((await listProjectDrafts(projectId)).length, 1);
    // The workspace is no longer the mounted one: a null capture is not a
    // clean draft and must leave storage untouched.
    mounted.current = false;
    editSource(ws, "logic:1", baseline(ws, "logic:1"));
    assert.equal(await persister.flush(), true);
    assert.equal((await listProjectDrafts(projectId)).length, 1);
    assert.ok(persister.currentReceipt);
  } finally {
    persister.dispose();
  }
});

test("a foreign replacement under the same workspace is not deleted by the clean retire", async () => {
  const { projectId, ws } = await seedWorkspace("clean-foreign");
  const original = baseline(ws, "logic:1");
  const errors: string[] = [];
  const { capture } = captureRecovery(ws);
  const persister = new LogicDraftPersister({
    projectId,
    workspaceId: "clean-tab-7",
    capture,
    delay: 0,
    onError: (message) => errors.push(message),
  });
  try {
    editSource(ws, "logic:1", ROOM1_ALT);
    await persister.flush();
    const receipt = persister.currentReceipt;
    assert.ok(receipt);
    // Another writer holding this receipt publishes a newer record: a second
    // tab that restored and edited the same workspace id.
    editSource(ws, "logic:1", `${ROOM1_ALT}\n// foreign tab edit\n`);
    const foreignReceipt = await saveProjectDraft({
      projectId,
      workspaceId: "clean-tab-7",
      expectedReceipt: receipt,
      ...dirtyPayload(ws),
    });
    assert.equal(foreignReceipt.sequence, receipt.sequence + 1);

    editSource(ws, "logic:1", original);
    assert.equal(await persister.flush(), false);
    assert.equal(errors.length, 1);
    const drafts = await listProjectDrafts(projectId);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]!.receipt.sequence, foreignReceipt.sequence);
    const document = drafts[0]!.recovery.documents.find((entry) => entry.key === "logic:1")!;
    assert.equal(
      document.content.type === "text" && document.content.text.includes("foreign tab edit"),
      true,
      "the newer foreign record must be untouched",
    );
    assert.deepEqual(persister.currentReceipt, receipt, "the failed retire keeps authority");
  } finally {
    persister.dispose();
  }
});

test("a refused clean deletion keeps the record and receipt; a retry succeeds", async () => {
  const { projectId, ws } = await seedWorkspace("clean-refused");
  const original = baseline(ws, "logic:1");
  const errors: string[] = [];
  const workspaceId = "clean-tab-8";
  const persister = new LogicDraftPersister({
    projectId,
    workspaceId,
    capture: captureRecovery(ws).capture,
    delay: 0,
    onError: (message) => errors.push(message),
  });
  const realDelete = records.delete.bind(records);
  try {
    editSource(ws, "logic:1", ROOM1_ALT);
    await persister.flush();
    const receipt = persister.currentReceipt;
    records.delete = (key) => {
      if (key === `draft/${projectId}/${workspaceId}`) throw new Error("temporary storage failure");
      return realDelete(key);
    };
    editSource(ws, "logic:1", original);
    assert.equal(await persister.flush(), false);
    assert.equal(errors.length, 1);
    assert.equal((await listProjectDrafts(projectId)).length, 1);
    assert.deepEqual(persister.currentReceipt, receipt);

    records.delete = realDelete;
    assert.equal(await persister.discard(), true);
    assert.deepEqual(await listProjectDrafts(projectId), []);
  } finally {
    records.delete = realDelete;
    persister.dispose();
  }
});

test("a restored draft's receipt follows the same clean contract", async () => {
  const { projectId, ws } = await seedWorkspace("clean-restored");
  editSource(ws, "logic:1", ROOM1_ALT);
  const receipt = await saveProjectDraft({
    projectId,
    workspaceId: "restored-tab",
    expectedReceipt: null,
    ...dirtyPayload(ws),
  });
  const restored = await openEditableProject(projectId, {
    restore: { workspaceId: "restored-tab", receipt },
  });
  assert.deepEqual(restored.restoredRecovery, { workspaceId: "restored-tab", receipt });
  assert.deepEqual(restored.draft.dirtyKeys(), ["logic:1"]);

  const persister = new LogicDraftPersister({
    projectId,
    workspaceId: restored.restoredRecovery!.workspaceId,
    capture: captureRecovery(restored).capture,
    delay: 0,
    receipt: restored.restoredRecovery!.receipt,
  });
  try {
    editSource(restored, "logic:1", baseline(restored, "logic:1"));
    assert.deepEqual(restored.draft.dirtyKeys(), []);
    assert.equal(await persister.flush(), true);
    assert.deepEqual(await listProjectDrafts(projectId), []);
    assert.equal(persister.currentReceipt, null);
  } finally {
    persister.dispose();
  }
});

test("a conditional settle skips the delete while the draft is dirty again", async () => {
  const { projectId, ws } = await seedWorkspace("clean-settle-dirty");
  const original = baseline(ws, "logic:1");
  const persister = new LogicDraftPersister({
    projectId,
    workspaceId: "clean-tab-10",
    capture: captureRecovery(ws).capture,
    delay: 0,
  });
  try {
    editSource(ws, "logic:1", ROOM1_ALT);
    await persister.flush();
    assert.equal((await listProjectDrafts(projectId)).length, 1);

    // Typing resumed before the settle's run: the record protects live work.
    editSource(ws, "logic:1", `${ROOM1_ALT}\n// resumed typing`);
    assert.equal(await persister.discard({ onlyIfClean: true }), true);
    assert.equal((await listProjectDrafts(projectId)).length, 1);
    assert.ok(persister.currentReceipt, "authority retained for the live draft");

    // Flush the resumed work, undo it clean, and the settle retires the record.
    assert.equal(await persister.flush(), true);
    editSource(ws, "logic:1", original);
    assert.equal(await persister.discard({ onlyIfClean: true }), true);
    assert.deepEqual(await listProjectDrafts(projectId), []);
  } finally {
    persister.dispose();
  }
});

test("typing mid-delete still leaves the draft dirty for the closer's recheck", async () => {
  const { projectId, ws } = await seedWorkspace("clean-settle-midcommit");
  const original = baseline(ws, "logic:1");
  const persister = new LogicDraftPersister({
    projectId,
    workspaceId: "clean-tab-11",
    capture: captureRecovery(ws).capture,
    delay: 0,
  });
  const realDelete = records.delete.bind(records);
  try {
    editSource(ws, "logic:1", ROOM1_ALT);
    await persister.flush();
    assert.equal((await listProjectDrafts(projectId)).length, 1);

    // The delete transaction commits while the draft turns dirty: the settle
    // reviewed a clean draft, so the caller's post-settle recheck must see
    // the new work and refuse the close.
    records.delete = (key) => {
      if (key === `draft/${projectId}/clean-tab-11`)
        editSource(ws, "logic:1", `${original}\n// mid-delete typing`);
      return realDelete(key);
    };
    editSource(ws, "logic:1", original);
    assert.equal(await persister.discard({ onlyIfClean: true }), true);
    assert.deepEqual(ws.draft.dirtyKeys(), ["logic:1"]);
    assert.equal(persister.currentReceipt, null);
  } finally {
    records.delete = realDelete;
    persister.dispose();
  }
});

test("editing again after a clean retirement writes a fresh record normally", async () => {
  const { projectId, ws } = await seedWorkspace("clean-rewrite");
  const original = baseline(ws, "logic:1");
  const persister = new LogicDraftPersister({
    projectId,
    workspaceId: "clean-tab-9",
    capture: captureRecovery(ws).capture,
    delay: 0,
  });
  try {
    editSource(ws, "logic:1", ROOM1_ALT);
    await persister.flush();
    editSource(ws, "logic:1", original);
    assert.equal(await persister.flush(), true);
    assert.deepEqual(await listProjectDrafts(projectId), []);

    editSource(ws, "logic:1", "// fresh work\nreturn;");
    assert.equal(await persister.flush(), true);
    const drafts = await listProjectDrafts(projectId);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]!.receipt.sequence, 1);
    const document = drafts[0]!.recovery.documents.find((entry) => entry.key === "logic:1")!;
    assert.equal(
      document.content.type === "text" && document.content.text,
      "// fresh work\nreturn;",
    );
  } finally {
    persister.dispose();
  }
});
