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
  const { request, history } = capture("history-abort");
  request.data.projectHistory = history.capturePortable();
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
  const offered = history.capturePortable();
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

test("library discovery reads the manifest; an open rejection offers raw recovery", async () => {
  const { request } = capture("history-envelope-only");
  await storage.commitProject(request);
  const key = [...records.keys()].find((key) =>
    String(key).startsWith(`project-history/${request.projectId}/blobs/`),
  )!;
  const row = records.get(key) as Record<string, unknown>;
  records.set(key, { ...row, content: Uint8Array.of(213, 214, 215) });
  const from = Array.from;
  Array.from = ((value: unknown, ...args: unknown[]) => {
    if (value instanceof Uint8Array && value[0] === 213)
      throw new Error("Full History content was read");
    return Reflect.apply(from, Array, [value, ...args]);
  }) as typeof Array.from;
  try {
    assert.equal(
      (await storage.listUnsupportedStoredProjects()).some(
        (entry) => entry.projectId === request.projectId,
      ),
      false,
    );
    await assert.rejects(
      storage.loadAuthoredGame(request.projectId),
      /Full History content was read/,
    );
    assert.equal(
      (await storage.listUnsupportedStoredProjects()).find(
        (entry) => entry.projectId === request.projectId,
      )?.state,
      "corrupt",
    );
  } finally {
    Array.from = from;
    records.delete(key);
    records.delete(request.projectId);
  }
});

test("removing a corrupt project retires its rejected-open classification", async () => {
  const { request } = capture("recreated-history");
  await storage.commitProject(request);
  const key = [...records.keys()].find((key) =>
    String(key).startsWith(`project-history/${request.projectId}/blobs/`),
  )!;
  records.set(key, { ...(records.get(key) as object), content: 42 });
  await assert.rejects(storage.loadAuthoredGame(request.projectId));
  await storage.clearCachedGame(request.projectId);
  await storage.commitProject({ ...request, commitId: "recreated" });
  assert.equal(
    (await storage.listUnsupportedStoredProjects()).some(
      (entry) => entry.projectId === request.projectId,
    ),
    false,
  );
});

test("recovery captures creative records and checks every record for encoding", async () => {
  const { request } = capture("creative-recovery");
  await storage.commitProject(request);
  const body = records.get(request.projectId) as Record<string, unknown>;
  records.set(request.projectId, { ...body, creative: { version: 1 } });
  const keys = [`creative/${request.projectId}`, `creative/${request.projectId}/images/a`];
  for (const key of keys) records.set(key, { projectId: key, bytes: Uint8Array.of(1, 255) });
  const downloaded = JSON.parse(await storage.downloadUnsupportedStoredProject(request.projectId));
  for (const key of keys) assert.match(JSON.stringify(downloaded.records), new RegExp(key));
  records.set(keys[1]!, { projectId: keys[1], image: new Blob(["image"]) });
  const card = (await storage.listUnsupportedStoredProjects()).find(
    (entry) => entry.projectId === request.projectId,
  )!;
  assert.equal(card.recoverable, false);
  await assert.rejects(
    storage.downloadUnsupportedStoredProject(request.projectId),
    /cannot preserve/,
  );
});

test("recovery disables Download for an unencodable sibling History record", async () => {
  const { request } = capture("unencodable-recovery");
  await storage.commitProject(request);
  records.set(request.projectId, { ...(records.get(request.projectId) as object), version: 999 });
  records.set(`project-history/${request.projectId}/unknown`, {
    projectId: `project-history/${request.projectId}/unknown`,
    content: new Blob(["data"]),
  });
  const card = (await storage.listUnsupportedStoredProjects()).find(
    (entry) => entry.projectId === request.projectId,
  )!;
  assert.equal(card.recoverable, false);
});

test("Home discovery reads project bodies without any History blob I/O", async () => {
  const { request } = capture("home-history-io");
  await storage.commitProject(request);
  const get = records.get;
  const reads: IDBValidKey[] = [];
  records.get = function (key) {
    reads.push(key);
    return get.call(this, key);
  };
  try {
    await storage.listUnsupportedStoredProjects();
    await storage.reconcileGameIndex();
    const { bindSavedProgressTarget } = await import("../src/project/progressBinding.ts");
    await bindSavedProgressTarget(request.projectId);
    assert.equal(
      reads.some((key) => String(key).startsWith(`project-history/${request.projectId}/`)),
      false,
    );
  } finally {
    records.get = get;
  }
});

test("History rejection is scoped to lifetime and successful validation clears it", async () => {
  const { request } = capture("history-cache-lifetime");
  await storage.commitProject(request);
  const key = [...records.keys()].find((key) =>
    String(key).startsWith(`project-history/${request.projectId}/blobs/`),
  )!;
  const original = structuredClone(records.get(key));
  records.set(key, { ...(original as object), content: 42 });
  await assert.rejects(storage.loadAuthoredGame(request.projectId));
  assert.equal(
    (await storage.listUnsupportedStoredProjects()).some(
      (entry) => entry.projectId === request.projectId,
    ),
    true,
  );
  const lifetimeKey = `lifetime/${request.projectId}`;
  const lifetime = records.get(lifetimeKey) as Record<string, unknown>;
  records.set(lifetimeKey, { ...lifetime, epoch: "replacement-lifetime" });
  assert.equal(
    (await storage.listUnsupportedStoredProjects()).some(
      (entry) => entry.projectId === request.projectId,
    ),
    false,
  );
  records.set(lifetimeKey, lifetime);
  records.set(key, original);
  assert.ok(await storage.loadAuthoredGame(request.projectId));
  assert.equal(
    (await storage.listUnsupportedStoredProjects()).some(
      (entry) => entry.projectId === request.projectId,
    ),
    false,
  );
});

test("an Update reads and writes only newly added History blobs", async () => {
  const { history, documents, request } = capture("history-delta-io");
  const first = await storage.commitProject(request);
  const changed = { ...documents, "view:1": Uint8Array.of(13, 29) };
  history.record(changed, { label: "View", origin: "view", author: "creator", time: 2 });
  const get = records.get;
  const set = records.set;
  const reads: string[] = [];
  const writes: string[] = [];
  records.get = function (key) {
    reads.push(String(key));
    return get.call(this, key);
  };
  records.set = function (key, value) {
    writes.push(String(key));
    return set.call(this, key, value);
  };
  try {
    await storage.commitProject({
      ...request,
      commitId: "delta",
      expected: first.receipt.saved,
      data: {
        ...request.data,
        workspace: writeProjectWorkspace(changed),
        projectHistory: writeProjectHistory(history.capture(), sha256Hex),
      },
    });
    const prefix = `project-history/${request.projectId}/blobs/`;
    assert.equal(reads.filter((key) => key.startsWith(prefix)).length, 1);
    assert.equal(writes.filter((key) => key.startsWith(prefix)).length, 1);
  } finally {
    records.get = get;
    records.set = set;
  }
  assert.deepEqual(
    (await storage.loadAuthoredGame(request.projectId))!.projectHistory,
    writeProjectHistory(history.capture(), sha256Hex),
  );
});

test("metadata writers preserve History without reading its blob rows", async () => {
  const { request } = capture("history-metadata-io");
  await storage.commitProject(request);
  const before = structuredClone(
    (records.get(request.projectId) as { editHistory: unknown }).editHistory,
  );
  const get = records.get;
  const reads: string[] = [];
  records.get = function (key) {
    reads.push(String(key));
    return get.call(this, key);
  };
  try {
    assert.equal(await storage.renameAuthoredGame(request.projectId, "Renamed"), true);
    assert.equal(await storage.setLibraryGameProfile(request.projectId, "2.936"), true);
    assert.equal(
      reads.some((key) => key.startsWith(`project-history/${request.projectId}/`)),
      false,
    );
    assert.deepEqual(
      (get.call(records, request.projectId) as { editHistory: unknown }).editHistory,
      before,
    );
  } finally {
    records.get = get;
  }
});

test("a blob newly attached to a project checks existing row ownership, version and content", async () => {
  for (const corruption of [
    { projectId: "another-owner" },
    { version: 999 },
    { content: "wrong" },
  ]) {
    const { history, documents, request } = capture(`history-row-${Object.keys(corruption)[0]}`);
    const first = await storage.commitProject(request);
    const changed = { ...documents, "view:1": Uint8Array.of(14, 15) };
    const commit = history.record(changed, {
      label: "View",
      origin: "view",
      author: "creator",
      time: 2,
    })!;
    const key = `project-history/${request.projectId}/blobs/${commit.documents["view:1"]}`;
    records.set(key, {
      projectId: key,
      format: "monotio.agi.project-history-blob",
      version: 1,
      content: Uint8Array.of(14, 15),
      ...corruption,
    });
    const before = structuredClone(records.get(request.projectId));
    await assert.rejects(
      storage.commitProject({
        ...request,
        commitId: "delta",
        expected: first.receipt.saved,
        data: {
          ...request.data,
          workspace: writeProjectWorkspace(changed),
          projectHistory: writeProjectHistory(history.capture(), sha256Hex),
        },
      }),
      /version|hash/,
    );
    assert.deepEqual(records.get(request.projectId), before);
  }
});

test("sealed Update saves never expand retained binary History into number arrays", async () => {
  const { history, documents, request } = capture("history-sealed-bytes");
  for (let i = 0; i < 400; i++)
    history.record(
      { ...documents, "view:1": Uint8Array.of(213, i >> 8, i & 255) },
      { label: "View", origin: "view", author: "creator", time: i + 2 },
    );
  const initialDocuments = { ...documents, "view:1": Uint8Array.of(213, 1, 143) };
  const first = await storage.commitProject({
    ...request,
    data: {
      ...request.data,
      workspace: writeProjectWorkspace(initialDocuments),
      projectHistory: writeProjectHistory(history.capture(), sha256Hex),
    },
  });
  const changed = { ...documents, "view:1": Uint8Array.of(214, 7) };
  history.record(changed, { label: "View", origin: "view", author: "creator", time: 500 });
  const from = Array.from;
  let oldArrays = 0;
  Array.from = ((value: unknown, ...args: unknown[]) => {
    if (value instanceof Uint8Array && value[0] === 213 && !(value[1] === 1 && value[2] === 143))
      oldArrays++;
    return Reflect.apply(from, Array, [value, ...args]);
  }) as typeof Array.from;
  try {
    await storage.commitProject({
      ...request,
      commitId: "sealed",
      expected: first.receipt.saved,
      data: {
        ...request.data,
        workspace: writeProjectWorkspace(changed),
        projectHistory: history.capturePortable(),
      },
    });
    assert.equal(oldArrays, 0);
  } finally {
    Array.from = from;
  }
});

test("a receipt from the released candidate encoding still acknowledges its exact retry", async () => {
  const { request } = capture("history-legacy-retry");
  await storage.commitProject(request);
  const key = `commit/${request.projectId}/${request.commitId}`;
  const stored = records.get(key) as { receipt: storage.ProjectCommitReceipt };
  // Fixed legacy receipt for this candidate, produced by the released writer.
  const candidateHash = "37e49a213c58a8216551a273e299db950e905e354207667d8c055c68da559b75";
  records.set(key, { ...stored, receipt: { ...stored.receipt, candidateHash } });
  const before = structuredClone(records.get(request.projectId));
  assert.equal((await storage.commitProject(request)).receipt.candidateHash, candidateHash);
  assert.deepEqual(records.get(request.projectId), before);
});

test("a sealed capture reclaims unreferenced blobs from an imported history", async () => {
  const { request } = capture("history-sealed-unreachable");
  const { projectContentHash } = await import("../../src/authoring/projectContent.ts");
  const { readProjectHistory } = await import("../../src/authoring/projectHistoryCodec.ts");
  const orphan = projectContentHash("unused", sha256Hex);
  const portable = {
    ...request.data.projectHistory!,
    blobs: {
      ...request.data.projectHistory!.blobs,
      [orphan]: { type: "text" as const, text: "unused" },
    },
  };
  const history = new ProjectHistory(sha256Hex, readProjectHistory(portable, sha256Hex));
  await storage.commitProject({
    ...request,
    data: { ...request.data, projectHistory: history.capturePortable() },
  });
  assert.equal(records.has(`project-history/${request.projectId}/blobs/${orphan}`), false);
});

test("a runnable body read can omit History while editable reads still verify every blob", async () => {
  const { request } = capture("history-play-body");
  await storage.commitProject(request);
  const get = records.get;
  const reads: string[] = [];
  records.get = function (key) {
    reads.push(String(key));
    return get.call(this, key);
  };
  try {
    const loaded = await storage.loadAuthoredGameWithHistoryLifetime(request.projectId, false);
    assert.ok(loaded);
    assert.equal(loaded.data.projectHistory, undefined);
    assert.equal(
      reads.some((key) => key.startsWith(`project-history/${request.projectId}/`)),
      false,
    );
  } finally {
    records.get = get;
  }
  const key = [...records.keys()].find((key) =>
    String(key).startsWith(`project-history/${request.projectId}/blobs/`),
  )!;
  records.set(key, { ...(records.get(key) as object), content: "corrupt" });
  await assert.rejects(storage.loadAuthoredGame(request.projectId), /hash/);
});

for (const writer of ["save", "commit"] as const) {
  for (const corruption of ["missing", "content"] as const) {
    test(`unconditional ${writer} heals a ${corruption} stored History blob`, async () => {
      const { request } = capture(`history-heal-${writer}-${corruption}`);
      await storage.commitProject(request);
      const key = [...records.keys()].find((key) =>
        String(key).startsWith(`project-history/${request.projectId}/blobs/`),
      )!;
      if (corruption === "missing") records.delete(key);
      else records.set(key, { ...(records.get(key) as object), content: "corrupt" });
      await assert.rejects(storage.loadAuthoredGame(request.projectId));
      if (writer === "save")
        assert.equal(await storage.saveAuthoredGame(request.projectId, request.data), true);
      else {
        // Creation can encounter orphan rows from an earlier lifetime.
        records.delete(request.projectId);
        await storage.commitProject({ ...request, commitId: "replace" });
      }
      assert.deepEqual(
        (await storage.loadAuthoredGame(request.projectId))!.projectHistory,
        request.data.projectHistory,
      );
    });
  }
}

for (const unsupported of [false, true]) {
  test(`metadata updates keep a remembered ${unsupported ? "unsupported" : "corrupt"} History classification`, async () => {
    const { request } = capture(`history-remembered-${unsupported}`);
    await storage.commitProject(request);
    const key = [...records.keys()].find((key) =>
      String(key).startsWith(`project-history/${request.projectId}/blobs/`),
    )!;
    records.set(key, {
      ...(records.get(key) as object),
      ...(unsupported ? { version: 999 } : { content: "corrupt" }),
    });
    await assert.rejects(storage.loadAuthoredGame(request.projectId));
    const before = structuredClone(records.get(request.projectId));
    assert.equal(await storage.renameAuthoredGame(request.projectId, "Renamed"), false);
    assert.equal(await storage.setLibraryGameProfile(request.projectId, "2.936"), false);
    assert.deepEqual(records.get(request.projectId), before);
    assert.equal(
      (await storage.listUnsupportedStoredProjects()).find(
        (entry) => entry.projectId === request.projectId,
      )?.state,
      unsupported ? "unsupported" : "corrupt",
    );
  });
}

test("initial authored capture preserves its sealed History without expanding binary blobs", async () => {
  const { history, documents, request } = capture("history-initial-seal");
  const next = { ...documents, "view:1": Uint8Array.of(231, 17) };
  history.record(next, { label: "View", origin: "view", author: "creator", time: 2 });
  history.record(documents, { label: "Back", origin: "view", author: "creator", time: 3 });
  const portable = history.capturePortable();
  let expansions = 0;
  const from = Array.from;
  Array.from = ((value: unknown, ...args: unknown[]) => {
    if (value instanceof Uint8Array && value[0] === 231) expansions++;
    return Reflect.apply(from, Array, [value, ...args]);
  }) as typeof Array.from;
  try {
    const saved = await storage.saveAuthoredGameCapture(request.projectId, {
      ...request.data,
      workspace: writeProjectWorkspace(documents),
      projectHistory: portable,
    });
    assert.ok(saved);
    assert.equal(expansions, 0);
  } finally {
    Array.from = from;
  }
});

test("replacing a project heals target blobs and reclaims the previous History's unused rows", async () => {
  const { request } = capture("history-replace-cleanup");
  await storage.commitProject(request);
  const oldKeys = [...records.keys()].filter((key) =>
    String(key).startsWith(`project-history/${request.projectId}/blobs/`),
  );
  const history = new ProjectHistory(sha256Hex);
  const documents = { "logic:1": "// Replacement\nreturn;" };
  history.record(documents, {
    label: "Replacement",
    origin: "template",
    author: "creator",
    time: 2,
  });
  assert.equal(
    await storage.saveAuthoredGame(request.projectId, {
      ...request.data,
      workspace: writeProjectWorkspace(documents),
      projectHistory: history.capturePortable(),
    }),
    true,
  );
  for (const key of oldKeys) assert.equal(records.has(key), false);
  assert.deepEqual(
    (await storage.loadAuthoredGame(request.projectId))!.projectHistory!.commits.map(
      (commit) => commit.id,
    ),
    history.capture().commits.map((commit) => commit.id),
  );
});

test("stored image History reopens a blob above the ordinary 8 MiB limit", async () => {
  const { request } = capture("history-image-allowance");
  const history = new ProjectHistory(sha256Hex);
  const bytes = new Uint8Array(9 * 1024 * 1024);
  history.record(
    { [`attachment:${"a".repeat(64)}`]: bytes },
    { label: "Image", origin: "agent", author: "agent", time: 1 },
  );
  const { workspace: _workspace, ...data } = request.data;
  assert.equal(
    await storage.saveAuthoredGame(request.projectId, {
      ...data,
      projectHistory: history.capturePortable(),
    }),
    true,
  );
  const reopened = (await storage.loadAuthoredGame(request.projectId))!.projectHistory!;
  const blob = Object.values(reopened.blobs)[0]!;
  assert.equal(blob.type, "bytes");
  assert.equal(blob.type === "bytes" ? blob.bytes.length : 0, bytes.length);
});
