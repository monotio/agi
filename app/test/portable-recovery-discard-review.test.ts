import assert from "node:assert/strict";
import { test } from "node:test";
import {
  writeProjectRecovery,
  type PortableProjectRecovery,
} from "../../src/authoring/projectRecovery.ts";
import { readProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import type { ProjectId } from "../../src/gameIdentity.ts";
import {
  openEditableProject,
  recoveryBaseOf,
  type EditableProject,
} from "../src/project/editableProject.ts";
import * as storage from "../src/project/gameStorage.ts";
import { discardPortableRecovery } from "../src/project/gameStorage.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { listProjectDrafts, saveProjectDraft } from "../src/project/projectDrafts.ts";
import { recoveryEntries } from "../src/studio/logic/logicRecovery.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

const records = installIndexedDbFixture();
const cache = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => cache.get(key) ?? null,
  setItem: (key: string, value: string) => {
    cache.set(key, value);
  },
  removeItem: (key: string) => cache.delete(key),
};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: localStorageStub,
});

const CARRIED_TEXT = "// carried work\nreturn;";
const ROOM1_REDRAW = "// Room 1\nif (isset(f5)) {\n  accept.input();\n}\nreturn;";

async function storedBody(projectId: ProjectId): Promise<CachedGameData> {
  const data = await storage.loadAuthoredGame(projectId);
  assert.ok(data);
  return data;
}

/** A stored body carrying a readable portable draft; `stale` keeps it parseable but off-base. */
async function seedCarriedProject(
  name: string,
  options?: { readonly stale?: boolean },
): Promise<{ projectId: ProjectId; recovery: PortableProjectRecovery }> {
  const prepared = prepareLocalProject({ title: name, kind: "blank" });
  await prepared.save();
  const data = await storedBody(prepared.projectId);
  const base = recoveryBaseOf(data);
  const recovery = writeProjectRecovery(
    options?.stale ? { ...base, authoring: "0".repeat(64) } : base,
    { changes: [{ key: "logic:1", version: 1, content: CARRIED_TEXT }], groups: [] },
  );
  data.recoveryDraft = recovery;
  assert.equal(await storage.saveAuthoredGame(prepared.projectId, data), true);
  return { projectId: prepared.projectId, recovery };
}

/** The reviewed identity a Discard click hands the service. */
function expectedOf(ws: EditableProject, recovery: unknown) {
  const saved = ws.savedIdentity();
  return {
    generation: saved.generation,
    lifetime: saved.lifetime,
    revision: saved.revision,
    authoring: saved.authoring,
    recovery,
  };
}

function editSource(ws: EditableProject, key: string, content: string): void {
  const snapshot = ws.draft.capture();
  ws.draft.edit(key, content, snapshot.version(key));
}

/** Fields the discard must never touch, flattened for an exact comparison. */
function preservedView(data: CachedGameData) {
  return {
    title: data.title,
    templateId: data.templateId,
    provider: data.provider,
    model: data.model,
    sessionId: data.sessionId,
    imported: data.imported,
    roomGeneration: data.roomGeneration,
    transcript: data.transcript,
    authoringState: data.authoringState,
    conversationHistory: data.conversationHistory,
    references: data.references,
    workspace: data.workspace,
    words: data.words,
    library: data.library,
    files: data.files,
  };
}

test("discarding the carried draft removes exactly it and advances the generation", async () => {
  const { projectId, recovery } = await seedCarriedProject("portable-discard-exact");
  // Another tab's unfinished work sits beside the body and must survive.
  const ws = await openEditableProject(projectId);
  editSource(ws, "logic:1", ROOM1_REDRAW);
  const saved = ws.savedIdentity();
  const sidecar = await saveProjectDraft({
    projectId,
    workspaceId: "other-tab",
    expectedReceipt: null,
    expected: { generation: saved.generation, lifetime: saved.lifetime },
    recovery: writeProjectRecovery(
      { revision: saved.revision, authoring: saved.authoring, profileId: ws.profileId },
      ws.draft.captureRecovery(),
    ),
  });
  const before = await storedBody(projectId);
  const rawBefore = structuredClone(records.get(projectId));
  const lifetimeBefore = structuredClone(records.get(`lifetime/${projectId}`));

  const committed = await discardPortableRecovery(projectId, expectedOf(ws, recovery));

  const after = await storedBody(projectId);
  assert.equal(after.recoveryDraft, undefined);
  assert.equal(after.generation, before.generation! + 1);
  assert.deepEqual(preservedView(after), preservedView(before));
  assert.deepEqual(committed.data, after);
  assert.deepEqual(committed.warnings, []);
  // The disposable index follows the committed generation.
  assert.equal(storage.getCachedGameMeta(projectId)!.generation, after.generation);
  // The planted metadata extension and the lifetime receipt survive byte-exact.
  assert.deepEqual(records.get(`lifetime/${projectId}`), lifetimeBefore);
  // Sidecar drafts and their manifest are untouched, even though the body moved.
  const drafts = await listProjectDrafts(projectId);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.workspaceId, "other-tab");
  assert.deepEqual(drafts[0]!.receipt, sidecar);
  // The recovery list no longer offers the carried draft.
  const entries = await recoveryEntries(after);
  assert.ok(entries.every((entry) => entry.kind !== "portable"));
  // The removed draft was the only body change.
  const rawAfter = records.get(projectId) as Record<string, unknown>;
  const { recoveryDraft: _gone, ...rest } = rawBefore as Record<string, unknown>;
  assert.deepEqual({ ...rest, generation: before.generation! + 1 }, rawAfter);
});

test("a metadata extension carried on the raw body survives the discard", async () => {
  const { projectId, recovery } = await seedCarriedProject("portable-discard-extension");
  const ws = await openEditableProject(projectId);
  const raw = records.get(projectId) as Record<string, unknown>;
  records.set(projectId, { ...raw, futureExtension: { keep: [1, 2, 3] } });
  await discardPortableRecovery(projectId, expectedOf(ws, recovery));
  const after = records.get(projectId) as Record<string, unknown>;
  assert.deepEqual(after["futureExtension"], { keep: [1, 2, 3] });
  assert.equal(after["recoveryDraft"], undefined);
});

test("a moved generation, a changed draft and a recreated project all refuse untouched", async () => {
  const { projectId, recovery } = await seedCarriedProject("portable-discard-guards");
  const ws = await openEditableProject(projectId);
  const expected = expectedOf(ws, recovery);
  const before = structuredClone(records.get(projectId)) as Record<string, unknown>;

  // A body write elsewhere bumps the generation.
  const moved = await storedBody(projectId);
  moved.title = "Renamed elsewhere";
  assert.equal(await storage.saveAuthoredGame(projectId, moved), true);
  await assert.rejects(discardPortableRecovery(projectId, expected), /modified|changed|removed/i);
  const raw = records.get(projectId) as Record<string, unknown>;
  assert.equal(raw["generation"], (before["generation"] as number) + 1);
  assert.deepEqual(raw["recoveryDraft"], recovery);

  // The draft changed under an unmoved generation (a writer outside the
  // shared rules): refuse rather than delete an unreviewed payload.
  const other = writeProjectRecovery(recoveryBaseOf(await storedBody(projectId)), {
    changes: [{ key: "logic:2", version: 1, content: "return;" }],
    groups: [],
  });
  records.set(projectId, { ...raw, recoveryDraft: other });
  const fresh = await openEditableProject(projectId);
  await assert.rejects(
    discardPortableRecovery(projectId, expectedOf(fresh, recovery)),
    /changed|reviewed/i,
  );
  assert.deepEqual((records.get(projectId) as Record<string, unknown>)["recoveryDraft"], other);
});

test("delete and recreate at the same generation refuses on the new lifetime", async () => {
  const { projectId, recovery } = await seedCarriedProject("portable-discard-lifetime");
  const ws = await openEditableProject(projectId);
  const expected = expectedOf(ws, recovery);
  const doomed = await storedBody(projectId);
  await storage.clearCachedGame(projectId);
  // A different project life reuses the id and the same generation number:
  // each recreate bumps the counter from scratch, so save until it reaches
  // the generation the workspace last saw.
  const { projectId: _id, authoredAt: _at, ...doomedData } = doomed;
  do {
    await storage.saveAuthoredGame(projectId, { ...doomedData, recoveryDraft: recovery });
  } while ((await storedBody(projectId)).generation !== expected.generation);
  const recreated = await storedBody(projectId);
  assert.equal(recreated.generation, expected.generation);
  await assert.rejects(discardPortableRecovery(projectId, expected), /removed|replaced/i);
  assert.deepEqual((await storedBody(projectId)).recoveryDraft, recovery);
});

test("an absent, unreadable or unreadable-reviewed draft refuses without touching the body", async () => {
  const prepared = prepareLocalProject({ title: "portable-discard-absent", kind: "blank" });
  await prepared.save();
  const ws = await openEditableProject(prepared.projectId);
  const saved = ws.savedIdentity();
  const cleanRecovery = writeProjectRecovery(recoveryBaseOf(await storedBody(prepared.projectId)), {
    changes: [{ key: "logic:1", version: 1, content: "return;" }],
    groups: [],
  });
  const expected = {
    generation: saved.generation,
    lifetime: saved.lifetime,
    revision: saved.revision,
    authoring: saved.authoring,
    recovery: cleanRecovery,
  };
  // Nothing carried: the reviewed draft is already gone.
  await assert.rejects(
    discardPortableRecovery(prepared.projectId, expected),
    /no longer carries|changed|reviewed/i,
  );
  // An unreadable reviewed payload is refused before storage is touched.
  assert.throws(() =>
    discardPortableRecovery(prepared.projectId, { ...expected, recovery: { junk: true } }),
  );
  // A stored payload this release cannot read stays: no destructive action
  // may drop bytes it cannot account for.
  const raw = records.get(prepared.projectId) as Record<string, unknown>;
  records.set(prepared.projectId, {
    ...raw,
    recoveryDraft: { format: "monotio.agi.recovery-draft", version: 999 },
  });
  const snapshot = structuredClone(records.get(prepared.projectId));
  await assert.rejects(discardPortableRecovery(prepared.projectId, expected));
  assert.deepEqual(records.get(prepared.projectId), snapshot);
});

test("a caller mutating the reviewed payload or identity while queued cannot retarget the discard", async () => {
  const { projectId, recovery } = await seedCarriedProject("portable-discard-mutation");
  const ws = await openEditableProject(projectId);
  const saved = ws.savedIdentity();
  const mutable = JSON.parse(JSON.stringify(recovery)) as PortableProjectRecovery;
  const expected = {
    generation: saved.generation,
    lifetime: saved.lifetime,
    revision: saved.revision,
    authoring: saved.authoring,
    recovery: mutable,
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const blocker = storage.serializeWrite(projectId, () => gate);
  const pending = discardPortableRecovery(projectId, expected);
  // Tampering after the call must not reach the queued write.
  (mutable.documents[0] as unknown as { content: { text: string } }).content.text = "// swapped";
  expected.generation = 0;
  release();
  await blocker;
  await pending;
  const after = await storedBody(projectId);
  assert.equal(after.recoveryDraft, undefined);
  assert.equal(after.generation, saved.generation + 1);
});

test("a failed transaction keeps every byte and a retry succeeds", async () => {
  const { projectId, recovery } = await seedCarriedProject("portable-discard-retry");
  const ws = await openEditableProject(projectId);
  const expected = expectedOf(ws, recovery);
  const realSet = records.set.bind(records);
  let fail = true;
  records.set = (key, value) => {
    if (fail && key === projectId) throw new Error("injected storage failure");
    return realSet(key, value);
  };
  const before = structuredClone(records.get(projectId));
  try {
    await assert.rejects(discardPortableRecovery(projectId, expected), /injected/);
    assert.deepEqual(records.get(projectId), before);
    fail = false;
    await discardPortableRecovery(projectId, expected);
    assert.equal((await storedBody(projectId)).recoveryDraft, undefined);
  } finally {
    records.set = realSet;
  }
});

test("a metadata-cache failure after the committed write warns but never undoes it", async () => {
  const { projectId, recovery } = await seedCarriedProject("portable-discard-index");
  const ws = await openEditableProject(projectId);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      ...localStorageStub,
      setItem: () => {
        throw new Error("quota");
      },
    },
  });
  try {
    const committed = await discardPortableRecovery(projectId, expectedOf(ws, recovery));
    assert.deepEqual(committed.warnings, ["indexRepairPending"]);
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: localStorageStub,
    });
  }
  // The durable outcome stands: the body dropped the draft and the index can
  // be reconciled; a stale advisory cache never makes a commit look failed.
  assert.equal((await storedBody(projectId)).recoveryDraft, undefined);
});

test("the live workspace adopts the committed baseline and a following Keep does not resurrect the draft", async () => {
  const { projectId, recovery } = await seedCarriedProject("portable-discard-keep");
  const ws = await openEditableProject(projectId);
  const saved = ws.savedIdentity();

  await ws.discardPortableRecovery(recovery);
  assert.equal(ws.storedData().recoveryDraft, undefined);
  assert.equal(ws.savedIdentity().generation, saved.generation + 1);
  assert.equal(ws.savedIdentity().lifetime, saved.lifetime);
  assert.equal(ws.savedIdentity().revision, saved.revision);
  assert.equal(ws.savedIdentity().authoring, saved.authoring);

  // An ordinary edit then Keep commits against the advanced baseline and
  // leaves the carried draft gone.
  editSource(ws, "logic:1", ROOM1_REDRAW);
  const kept = await ws.keepCandidate(ws.buildSelected(["logic:1"]));
  assert.equal(kept.saved.generation, saved.generation + 2);
  const after = await storedBody(projectId);
  assert.equal(after.recoveryDraft, undefined);
  assert.equal(readProjectWorkspace(after.workspace)["logic:1"], ROOM1_REDRAW);
});

test("Keep and discard serialize honestly in both orders", async () => {
  const keepFirst = await seedCarriedProject("portable-discard-order-a");
  {
    const ws = await openEditableProject(keepFirst.projectId);
    const recovery = ws.storedData().recoveryDraft!;
    editSource(ws, "logic:1", ROOM1_REDRAW);
    const keeping = ws.keepCandidate(ws.buildSelected(["logic:1"]));
    // Captured against the pre-Keep baseline; the admitted Keep lands first.
    await assert.rejects(ws.discardPortableRecovery(recovery), /modified|removed|changed/i);
    await keeping;
    assert.deepEqual((await storedBody(keepFirst.projectId)).recoveryDraft, recovery);
  }
  const discardFirst = await seedCarriedProject("portable-discard-order-b");
  {
    const ws = await openEditableProject(discardFirst.projectId);
    const recovery = ws.storedData().recoveryDraft!;
    const original = ws.draft.capture().read("logic:1")!.content;
    const generationBefore = ws.savedIdentity().generation;
    editSource(ws, "logic:1", ROOM1_REDRAW);
    const candidate = ws.buildSelected(["logic:1"]);
    const discarding = ws.discardPortableRecovery(recovery);
    // The discard lands first; the candidate's captured baseline is stale.
    await assert.rejects(ws.keepCandidate(candidate), /modified|removed|changed/i);
    await discarding;
    const after = await storedBody(discardFirst.projectId);
    assert.equal(after.recoveryDraft, undefined);
    assert.equal(readProjectWorkspace(after.workspace)["logic:1"], original);
    // A fresh candidate built on the new baseline keeps cleanly.
    const kept = await ws.keepCandidate(ws.buildSelected(["logic:1"]));
    assert.equal(kept.saved.generation, generationBefore + 2);
    const final = await storedBody(discardFirst.projectId);
    assert.equal(readProjectWorkspace(final.workspace)["logic:1"], ROOM1_REDRAW);
    assert.equal(final.recoveryDraft, undefined);
  }
});

test("a stale carried draft discards without ever applying to the draft", async () => {
  const { projectId, recovery } = await seedCarriedProject("portable-discard-stale", {
    stale: true,
  });
  const ws = await openEditableProject(projectId);
  const before = ws.draft.capture().read("logic:1")!.content;
  const entries = await recoveryEntries(ws.storedData());
  assert.equal(entries.find((entry) => entry.kind === "portable")?.status, "stale");
  await ws.discardPortableRecovery(recovery);
  assert.equal(ws.draft.capture().read("logic:1")!.content, before);
  assert.equal((await storedBody(projectId)).recoveryDraft, undefined);
});
