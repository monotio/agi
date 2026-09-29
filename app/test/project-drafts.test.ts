import assert from "node:assert/strict";
import { test } from "node:test";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
import * as storage from "../src/project/gameStorage.ts";
import {
  listProjectDrafts,
  saveProjectDraft,
  discardProjectDraft,
} from "../src/project/projectDrafts.ts";

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
async function project(name: string) {
  const projectId = testProjectId(name);
  const commit = await storage.commitProject({
    projectId,
    commitId: crypto.randomUUID(),
    workspaceId: "creator",
    buildId: "a".repeat(64),
    expected: null,
    documents: [],
    data: {
      title: "Recover me",
      provider: "",
      model: "",
      files: { "WORDS.TOK": new Uint8Array(52) },
      words: [],
    },
  });
  const saved = commit.receipt.saved;
  return {
    projectId,
    workspaceId: "tab-one",
    expectedReceipt: null,
    expected: { generation: saved.generation, lifetime: saved.lifetime },
    recovery: {
      format: "monotio.agi.recovery-draft",
      version: 1,
      base: { revision: saved.revision, authoring: saved.authoring, profileId: "2.936" },
      documents: [
        { key: "logic:1", version: 2, content: { type: "text", text: 'print("unfinished' } },
      ],
      operations: [],
    },
  };
}

test("unfinished drafts survive independently in two workspaces without replacing saved bytes", async () => {
  const input = await project("draft-two-tabs");
  const before = structuredClone(records.get(input.projectId));
  assert.equal((await saveProjectDraft(input)).sequence, 1);
  const other = { ...input, workspaceId: "tab-two", recovery: structuredClone(input.recovery) };
  other.recovery.documents[0]!.content.text = "different unfinished text";
  await saveProjectDraft(other);
  const drafts = await listProjectDrafts(input.projectId);
  assert.deepEqual(
    drafts.map(({ workspaceId, status }) => [workspaceId, status]),
    [
      ["tab-one", "current"],
      ["tab-two", "current"],
    ],
  );
  assert.equal(drafts[0]!.recovery.documents[0]!.content.type, "text");
  assert.deepEqual(records.get(input.projectId), before);
  assert.equal(
    drafts[0]!.recovery.documents[0]!.content.type === "text" &&
      drafts[0]!.recovery.documents[0]!.content.text,
    'print("unfinished',
  );
});

test("concurrent autosaves cannot overwrite a newer recovery or discard it with an old receipt", async () => {
  const input = await project("draft-autosave-cas");
  const receipt = await saveProjectDraft(input);
  const next = { ...input, expectedReceipt: receipt };
  const outcomes = await Promise.allSettled([saveProjectDraft(next), saveProjectDraft(next)]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal((await listProjectDrafts(input.projectId))[0]!.receipt.sequence, 2);
  await assert.rejects(
    discardProjectDraft(input.projectId, input.workspaceId, receipt),
    /changed|stale/i,
  );
  await discardProjectDraft(input.projectId, input.workspaceId, { ...receipt, sequence: 2 });
  assert.deepEqual(await listProjectDrafts(input.projectId), []);
});

test("saved project changes retain recovery for comparison and fence old autosaves", async () => {
  const input = await project("draft-stale-base");
  const receipt = await saveProjectDraft(input);
  const data = (await storage.loadAuthoredGame(input.projectId))!;
  assert.equal(
    await storage.saveAuthoredGame(input.projectId, { ...data, title: "New title" }),
    true,
  );
  assert.equal((await listProjectDrafts(input.projectId))[0]!.status, "stale");
  await assert.rejects(saveProjectDraft({ ...input, expectedReceipt: receipt }), /changed|stale/i);
  assert.equal((await listProjectDrafts(input.projectId))[0]!.receipt.sequence, 1);
  await discardProjectDraft(input.projectId, input.workspaceId, receipt);
  assert.deepEqual(await listProjectDrafts(input.projectId), []);
});

test("a deleted project removes all recovery and rejects a late writer even after recreation", async () => {
  const input = await project("draft-deleted");
  const receipt = await saveProjectDraft(input);
  await saveProjectDraft({ ...input, workspaceId: "tab-two" });
  await storage.clearCachedGame(input.projectId);
  assert.deepEqual(await listProjectDrafts(input.projectId), []);
  assert.equal(
    [...records.keys()].some((key) => String(key).startsWith(`draft/${input.projectId}/`)),
    false,
  );
  await project("draft-deleted");
  await assert.rejects(
    saveProjectDraft({ ...input, expectedReceipt: receipt }),
    /removed|lifetime|changed|stale/i,
  );
  assert.deepEqual(await listProjectDrafts(input.projectId), []);
});

test("future sidecar and recovery versions refuse read, replacement and discard without rewriting", async () => {
  for (const nested of [false, true]) {
    const input = await project(`draft-future-${nested}`);
    const receipt = await saveProjectDraft(input);
    const key = `draft/${input.projectId}/${input.workspaceId}`;
    const stored = records.get(key) as { version: number; recovery: { version: number } };
    if (nested) stored.recovery.version = 999;
    else stored.version = 999;
    const before = structuredClone(stored);
    await assert.rejects(listProjectDrafts(input.projectId), /version|supported/i);
    await assert.rejects(
      saveProjectDraft({ ...input, expectedReceipt: receipt }),
      /version|supported/i,
    );
    await assert.rejects(
      discardProjectDraft(input.projectId, input.workspaceId, receipt),
      /version|supported/i,
    );
    assert.deepEqual(records.get(key), before);
  }
});

test("autosave owns its input before awaiting storage and verifies all portable base identities", async () => {
  const input = await project("draft-capture-base");
  const pending = saveProjectDraft(input);
  input.recovery.documents[0]!.content.text = "later typing";
  const receipt = await pending;
  const saved = (await listProjectDrafts(input.projectId))[0]!;
  assert.equal(
    saved.recovery.documents[0]!.content.type === "text" &&
      saved.recovery.documents[0]!.content.text,
    'print("unfinished',
  );
  for (const base of [
    { ...input.recovery.base, revision: "b".repeat(64) },
    { ...input.recovery.base, authoring: "b".repeat(64) },
    { ...input.recovery.base, profileId: "3.002.149" },
  ]) {
    await assert.rejects(
      saveProjectDraft({
        ...input,
        expectedReceipt: receipt,
        recovery: { ...input.recovery, base },
      }),
      /changed|stale/i,
    );
  }
  assert.equal((await listProjectDrafts(input.projectId))[0]!.receipt.sequence, 1);
});

test("a failed draft write publishes neither a partial record nor a discovery entry", async () => {
  const input = await project("draft-quota");
  const before = structuredClone(records);
  const originalSet = records.set;
  records.set = function (key, value) {
    if (key === `draft/${input.projectId}/${input.workspaceId}`)
      throw new Error("simulated storage quota");
    return originalSet.call(this, key, value);
  };
  try {
    await assert.rejects(saveProjectDraft(input), /quota/);
  } finally {
    Reflect.deleteProperty(records, "set");
  }
  assert.deepEqual(records, before);
  assert.deepEqual(await listProjectDrafts(input.projectId), []);
  assert.equal((await saveProjectDraft(input)).sequence, 1);
});

test("a future recovery discovery index cannot be downgraded by any writer", async () => {
  const input = await project("draft-future-index");
  const receipt = await saveProjectDraft(input);
  const key = `draft/${input.projectId}`;
  const stored = records.get(key) as { version: number };
  stored.version = 999;
  const before = structuredClone(records);
  await assert.rejects(listProjectDrafts(input.projectId), /version|supported/i);
  await assert.rejects(
    saveProjectDraft({ ...input, workspaceId: "another" }),
    /version|supported/i,
  );
  await assert.rejects(
    discardProjectDraft(input.projectId, input.workspaceId, receipt),
    /version|supported/i,
  );
  assert.deepEqual(records, before);
});

test("recovery capacity refuses a new workspace without evicting existing drafts", async () => {
  const input = await project("draft-capacity");
  for (let index = 0; index < 16; index++)
    await saveProjectDraft({ ...input, workspaceId: `tab-${index}` });
  await assert.rejects(saveProjectDraft(input), /too many recoverable/i);
  assert.equal((await listProjectDrafts(input.projectId)).length, 16);
  const first = (await listProjectDrafts(input.projectId)).find(
    (draft) => draft.workspaceId === "tab-0",
  )!;
  const receipt = await saveProjectDraft({
    ...input,
    workspaceId: "tab-0",
    expectedReceipt: first.receipt,
  });
  await discardProjectDraft(input.projectId, "tab-0", receipt);
  assert.equal((await saveProjectDraft(input)).sequence, 1);
  assert.equal((await listProjectDrafts(input.projectId)).length, 16);
});

test("discarded and recreated recovery never accepts an earlier incarnation's requests", async () => {
  const input = await project("draft-incarnation");
  const old = await saveProjectDraft(input);
  await discardProjectDraft(input.projectId, input.workspaceId, old);
  const current = await saveProjectDraft(input);
  assert.equal(current.sequence, old.sequence);
  assert.notEqual(current.incarnation, old.incarnation);
  await assert.rejects(saveProjectDraft({ ...input, expectedReceipt: old }), /changed/i);
  await assert.rejects(discardProjectDraft(input.projectId, input.workspaceId, old), /changed/i);
  assert.deepEqual((await listProjectDrafts(input.projectId))[0]!.receipt, current);
});
