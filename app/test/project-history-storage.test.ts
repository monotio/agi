import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectHistory } from "../../src/authoring/projectHistory.ts";
import { writeProjectHistory } from "../../src/authoring/projectHistoryCodec.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import * as storage from "../src/project/gameStorage.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";

const records = installIndexedDbFixture();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
});
function capture(name: string) {
  const history = new ProjectHistory(sha256Hex);
  const documents = { "logic:1": "return;", world: "{}" };
  history.record(documents, { label: "Start", origin: "template", author: "creator", time: 1 });
  const request: storage.ProjectCommitRequest = {
    projectId: testProjectId(name),
    commitId: "first",
    workspaceId: "editor",
    buildId: "a".repeat(64),
    expected: null,
    documents: [{ key: "logic:1", version: 1 }],
    data: {
      title: "Adventure",
      files: { "VOL.0": Uint8Array.of(1) },
      words: [],
      workspace: writeProjectWorkspace(documents),
      projectHistory: writeProjectHistory(history.capture(), sha256Hex),
    },
  };
  return { history, documents, request };
}

test("body, History, blobs, cursor and receipt abort together and retry exactly", async () => {
  const { request } = capture("history-abort");
  const before = new Map(records);
  const nativeSet = records.set;
  records.set = function (key, value) {
    if (String(key).startsWith("project-history/history-abort/blobs/"))
      throw new Error("injected History write failure");
    return nativeSet.call(this, key, value);
  };
  try {
    await assert.rejects(storage.commitProject(request), /injected History/);
  } finally {
    delete (records as { set?: unknown }).set;
  }
  assert.deepEqual(records, before);
  const saved = await storage.commitProject(request);
  assert.deepEqual(
    (await storage.loadAuthoredGame(request.projectId))!.projectHistory,
    request.data.projectHistory,
  );
  const written = new Map(records);
  assert.deepEqual((await storage.commitProject(request)).receipt, saved.receipt);
  assert.deepEqual(records, written);
  await assert.rejects(
    storage.commitProject({
      ...request,
      data: {
        ...request.data,
        projectHistory: {
          ...request.data.projectHistory!,
          tags: { checkpoint: request.data.projectHistory!.cursor! },
        },
      },
    }),
    /different|reused/,
  );
});

test("newer capture survives late retry and stale save; blobs deduplicate and reclaim", async () => {
  const { history, documents, request } = capture("history-order");
  const first = await storage.commitProject(request);
  const changed = { ...documents, "logic:1": "// changed\nreturn;" };
  history.record(changed, { label: "Edit", origin: "logic", author: "creator", time: 2 });
  const next = {
    ...request,
    commitId: "second",
    expected: first.receipt.saved,
    data: {
      ...request.data,
      workspace: writeProjectWorkspace(changed),
      projectHistory: writeProjectHistory(history.capture(), sha256Hex),
    },
  };
  await storage.commitProject(next);
  const keys = [...records.keys()].filter((key) =>
    String(key).startsWith("project-history/history-order/blobs/"),
  );
  assert.equal(keys.length, 3);
  await storage.commitProject(request);
  await assert.rejects(
    storage.commitProject({ ...request, commitId: "late", expected: first.receipt.saved }),
    /modified/,
  );
  assert.equal(
    (await storage.loadAuthoredGame(request.projectId))!.projectHistory!.cursor,
    next.data.projectHistory.cursor,
  );
  const { pruneProjectHistory } = await import("../../src/authoring/projectHistoryPruning.ts");
  const pruned = pruneProjectHistory(history.capture(), sha256Hex, { maxCommits: 1 });
  const current = (await storage.commitProject(next)).receipt.saved;
  await storage.commitProject({
    ...next,
    commitId: "prune",
    expected: current,
    data: { ...next.data, projectHistory: writeProjectHistory(pruned.state, sha256Hex) },
  });
  assert.equal(
    [...records.keys()].filter((key) =>
      String(key).startsWith("project-history/history-order/blobs/"),
    ).length,
    2,
  );
});

test("future History versions refuse read, retry and replacement without rewriting", async () => {
  const { request } = capture("history-future");
  const first = await storage.commitProject(request);
  const key = request.projectId;
  const body = records.get(key) as { editHistory: object };
  records.set(key, { ...body, editHistory: { ...body.editHistory, version: 999 } });
  const before = new Map(records);
  await assert.rejects(storage.loadAuthoredGame(request.projectId), /history version/i);
  await assert.rejects(storage.commitProject(request), /history version/i);
  await assert.rejects(
    storage.commitProject({ ...request, commitId: "next", expected: first.receipt.saved }),
    /history version/i,
  );
  assert.deepEqual(records, before);
});

test("unreferenced offered blobs are reclaimed instead of retained by the body", async () => {
  const { request } = capture("history-unreachable");
  const { projectContentHash } = await import("../../src/authoring/projectContent.ts");
  const orphan = projectContentHash("unused", sha256Hex);
  const history = {
    ...request.data.projectHistory!,
    blobs: {
      ...request.data.projectHistory!.blobs,
      [orphan]: { type: "text" as const, text: "unused" },
    },
  };
  await storage.commitProject({ ...request, data: { ...request.data, projectHistory: history } });
  const loaded = (await storage.loadAuthoredGame(request.projectId))!;
  assert.equal(Object.hasOwn(loaded.projectHistory!.blobs, orphan), false);
  assert.equal(records.has(`project-history/${request.projectId}/blobs/${orphan}`), false);
});

test("binary History blobs use owned byte rows and hydrate exact portable content", async () => {
  const { history, documents, request } = capture("history-binary");
  const bytes = Uint8Array.of(0, 255, 7);
  const next = { ...documents, "view:1": bytes };
  const commit = history.record(next, {
    label: "View",
    origin: "view",
    author: "creator",
    time: 2,
  })!;
  const offered = writeProjectHistory(history.capture(), sha256Hex);
  const pending = storage.commitProject({
    ...request,
    data: { ...request.data, workspace: writeProjectWorkspace(next), projectHistory: offered },
  });
  bytes.fill(8);
  await pending;
  const row = records.get(
    `project-history/${request.projectId}/blobs/${commit.documents["view:1"]}`,
  ) as { content: unknown };
  assert.ok(row.content instanceof Uint8Array);
  assert.deepEqual(row.content, Uint8Array.of(0, 255, 7));
  assert.deepEqual((await storage.loadAuthoredGame(request.projectId))!.projectHistory, offered);
});
