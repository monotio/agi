import assert from "node:assert/strict";
import { test } from "node:test";
import { writeProjectRecovery } from "../../src/authoring/projectRecovery.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject } from "../src/project/editableProject.ts";
import { listProjectDrafts } from "../src/project/projectDrafts.ts";
import { LogicDraftPersister } from "../src/studio/logic/logicRecovery.ts";
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

async function workspace() {
  const project = prepareLocalProject({ title: "Recovery review", kind: "blank" });
  await project.save();
  const editable = await openEditableProject(project.projectId);
  const snapshot = editable.draft.capture();
  editable.draft.edit("logic:1", "// unfinished work\nreturn;", snapshot.version("logic:1"));
  const capture = () => {
    const saved = editable.savedIdentity();
    return {
      expected: { generation: saved.generation, lifetime: saved.lifetime },
      recovery: writeProjectRecovery(
        { revision: saved.revision, authoring: saved.authoring, profileId: editable.profileId },
        editable.draft.captureRecovery(),
      ),
    };
  };
  return { projectId: project.projectId, capture };
}

test("failed recovery discard retains the receipt so the same reviewed record can be retried", async () => {
  const input = await workspace();
  const errors: string[] = [];
  const persister = new LogicDraftPersister({
    ...input,
    workspaceId: "discard-review",
    onError: (error) => errors.push(error),
  });
  await persister.flush();
  const receipt = structuredClone(persister.currentReceipt);
  const originalDelete = records.delete.bind(records);
  records.delete = (key) => {
    if (key === `draft/${input.projectId}/discard-review`)
      throw new Error("temporary storage failure");
    return originalDelete(key);
  };
  try {
    await persister.discard();
    assert.equal(errors.length, 1);
    assert.equal((await listProjectDrafts(input.projectId)).length, 1);
    assert.deepEqual(
      persister.currentReceipt,
      receipt,
      "failed deletion does not surrender retry authority",
    );
    records.delete = originalDelete;
    await persister.discard();
    assert.deepEqual(await listProjectDrafts(input.projectId), []);
  } finally {
    records.delete = originalDelete;
    persister.dispose();
  }
});

test("a draft capture failure is reported without poisoning later recovery writes", async () => {
  const input = await workspace();
  const errors: string[] = [];
  let fail = true;
  const persister = new LogicDraftPersister({
    projectId: input.projectId,
    workspaceId: "capture-review",
    capture: () => {
      if (fail) throw new Error("draft cannot yet be serialized");
      return input.capture();
    },
    onError: (error) => errors.push(error),
  });
  try {
    await persister.flush().catch(() => {});
    fail = false;
    await persister.flush().catch(() => {});
    assert.equal(errors.length, 1, "capture failures reach the same visible error channel");
    assert.equal(
      (await listProjectDrafts(input.projectId)).length,
      1,
      "a later valid draft still persists",
    );
  } finally {
    persister.dispose();
  }
});

test("displaying a recovery receipt cannot retarget the persister's next save", async () => {
  const input = await workspace();
  const errors: string[] = [];
  const persister = new LogicDraftPersister({
    ...input,
    workspaceId: "receipt-review",
    onError: (error) => errors.push(error),
  });
  try {
    await persister.flush();
    const exposed = persister.currentReceipt;
    assert.ok(exposed);
    try {
      (exposed as { sequence: number }).sequence = 999;
    } catch {
      // A frozen receipt is also a valid detached authority boundary.
    }
    await persister.flush();
    assert.deepEqual(errors, []);
    assert.equal((await listProjectDrafts(input.projectId))[0]!.receipt.sequence, 2);
  } finally {
    persister.dispose();
  }
});
