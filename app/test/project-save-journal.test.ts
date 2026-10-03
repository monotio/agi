import assert from "node:assert/strict";
import { test } from "node:test";
import { testProjectId } from "./identity.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import {
  commitProject,
  loadAuthoredGame,
  type ProjectCommitRequest,
} from "../src/project/gameStorage.ts";
import {
  projectSaveJournalKey,
  resumeProjectSaveJournals,
  writeProjectSaveJournal,
} from "../src/project/projectSaveJournal.ts";

installIndexedDbFixture();
const values = new Map<string, string>();
const cache = {
  get length() {
    return values.size;
  },
  key: (index: number) => [...values.keys()][index] ?? null,
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
} as Storage;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: cache });

function request(name: string): ProjectCommitRequest {
  return {
    projectId: testProjectId(name),
    commitId: "first",
    workspaceId: "editor",
    buildId: "a".repeat(64),
    expected: null,
    documents: [{ key: "sound:1", version: 1 }],
    data: { title: "Sound", files: { "VOL.0": Uint8Array.of(1, 2, 3) }, words: [] },
  };
}

test("an interrupted receipt and its newer capture replay once in order with exact bytes", async () => {
  const first = request("journal-interrupted");
  const next = {
    ...first,
    commitId: "next",
    data: { ...first.data, title: "Redo", files: { "VOL.0": Uint8Array.of(4, 5, 6) } },
  };
  const key = projectSaveJournalKey(first.projectId, "run");
  writeProjectSaveJournal(cache, key, [
    { request: first, attempted: true },
    { request: next, attempted: false },
  ]);
  await assert.rejects(
    async () =>
      resumeProjectSaveJournals(cache, first.projectId, async (input) => {
        await commitProject(input);
        throw new Error("Page closed before receipt");
      }),
    /Page closed/,
  );
  const saved = await loadAuthoredGame(first.projectId);
  assert.equal(saved!.generation, 2);
  assert.equal(saved!.title, "Redo");
  assert.deepEqual(saved!.files["VOL.0"], Uint8Array.of(4, 5, 6));
  assert.equal(cache.getItem(key), null);
  assert.equal((await loadAuthoredGame(first.projectId))!.generation, 2);
});

test("a stale journal preserves its work and opens the newer project without overwriting it", async () => {
  const first = request("journal-concurrent");
  const saved = (await commitProject(first)).receipt.saved;
  await commitProject({
    ...first,
    commitId: "other-tab",
    expected: saved,
    data: { ...first.data, title: "Other tab" },
  });
  const key = projectSaveJournalKey(first.projectId, "stale-run");
  writeProjectSaveJournal(cache, key, [
    { request: { ...first, commitId: "unsaved", expected: saved }, attempted: true },
  ]);
  const raw = cache.getItem(key);
  assert.equal((await loadAuthoredGame(first.projectId))!.title, "Other tab");
  assert.equal(cache.getItem(key), raw);
});

test("an unknown journal version is refused without changing its bytes", async () => {
  const input = request("journal-future");
  await commitProject(input);
  const key = projectSaveJournalKey(input.projectId, "future");
  const raw = '{"version":999,"entries":[]}';
  cache.setItem(key, raw);
  await assert.rejects(loadAuthoredGame(input.projectId), /version is not supported/);
  assert.equal(cache.getItem(key), raw);
});

test("an exact journal retry preserves negative zero in commit metadata", async () => {
  const input = request("journal-numeric-metadata");
  const original = { ...input, data: { ...input.data, authoringState: { value: -0 } } };
  await commitProject(original);
  const key = projectSaveJournalKey(input.projectId, "numeric");
  writeProjectSaveJournal(cache, key, [{ request: original, attempted: true }]);
  const saved = await loadAuthoredGame(input.projectId);
  assert.ok(Object.is(saved!.authoringState!["value"], -0));
  assert.equal(cache.getItem(key), null);
});

test("an exact journal retry preserves sparse metadata arrays", async () => {
  const input = request("journal-sparse-metadata");
  const original = { ...input, data: { ...input.data, authoringState: { values: Array(1) } } };
  await commitProject(original);
  const key = projectSaveJournalKey(input.projectId, "sparse");
  writeProjectSaveJournal(cache, key, [{ request: original, attempted: true }]);
  assert.equal((await loadAuthoredGame(input.projectId))!.generation, 1);
  assert.equal(cache.getItem(key), null);
});

test("unsupported commit metadata cannot become valid through journal serialization", () => {
  const input = request("journal-invalid-metadata");
  const key = projectSaveJournalKey(input.projectId, "invalid");
  const original = cache.getItem(key);
  for (const value of [NaN, Infinity, new Date(0), new Map(), () => {}]) {
    assert.throws(() =>
      writeProjectSaveJournal(cache, key, [
        {
          request: { ...input, data: { ...input.data, authoringState: { value } } },
          attempted: false,
        },
      ]),
    );
    assert.equal(cache.getItem(key), original);
  }
});

test("recovery acknowledges only its exact entry when a writer appends during the await", async () => {
  const first = request("journal-append");
  const next = { ...first, commitId: "newest" };
  const key = projectSaveJournalKey(first.projectId, "writer");
  writeProjectSaveJournal(cache, key, [{ request: first, attempted: true }]);
  await resumeProjectSaveJournals(cache, first.projectId, async (input) => {
    const result = await commitProject(input);
    writeProjectSaveJournal(cache, key, [
      { request: first, attempted: true },
      { request: next, attempted: false },
    ]);
    return result;
  });
  // The next recovery uses the acknowledged predecessor's receipt.
  assert.equal((await loadAuthoredGame(first.projectId))!.generation, 2);
});

test("conflict restoration preserves an entry appended while recovery awaits", async () => {
  const first = request("journal-conflict-append");
  const next = { ...first, commitId: "newest" };
  const key = projectSaveJournalKey(first.projectId, "writer");
  writeProjectSaveJournal(cache, key, [{ request: first, attempted: false }]);
  await resumeProjectSaveJournals(cache, first.projectId, async () => {
    writeProjectSaveJournal(cache, key, [
      { request: first, attempted: true },
      { request: next, attempted: false },
    ]);
    throw Object.assign(new Error("conflict"), { name: "ConcurrencyConflictError" });
  });
  const raw = cache.getItem(key)!;
  assert.match(raw, /newest/);
  assert.equal(raw.includes("true"), false);
});

test("a terminal recovery conflict is surfaced once with its original bytes", async () => {
  const input = request("journal-terminal");
  const key = projectSaveJournalKey(input.projectId, "retired");
  writeProjectSaveJournal(cache, key, [{ request: input, attempted: false }]);
  const raw = cache.getItem(key);
  let attempts = 0;
  const conflict = async () => {
    attempts++;
    throw Object.assign(new Error("Project lifetime ended"), { name: "ProjectDeletedError" });
  };
  await resumeProjectSaveJournals(cache, input.projectId, conflict);
  await resumeProjectSaveJournals(cache, input.projectId, conflict);
  assert.equal(attempts, 1);
  assert.equal(cache.getItem(key), raw);
});

test("a recovery marker failure still opens the project and exposes retained edits", async () => {
  const input = request("journal-marker-quota");
  const key = projectSaveJournalKey(input.projectId, "ended");
  writeProjectSaveJournal(cache, key, [{ request: input, attempted: false }]);
  const raw = cache.getItem(key);
  const setItem = cache.setItem;
  cache.setItem = (key, value) => {
    if (key.startsWith("monotio_agi.project-recovery.")) throw new Error("Recovery marker quota");
    setItem(key, value);
  };
  try {
    await resumeProjectSaveJournals(cache, input.projectId, async () => {
      throw Object.assign(new Error("Removed project"), { name: "ProjectDeletedError" });
    });
    const { readProjectSaveRecoveries } = await import("../src/project/projectSaveJournal.ts");
    assert.equal(readProjectSaveRecoveries(cache, input.projectId)[0]?.raw, raw);
    assert.equal(cache.getItem(key), raw);
  } finally {
    cache.setItem = setItem;
  }
});

test("discard removes only the observed recovery bytes and removal clears both journal namespaces", async () => {
  const { discardProjectSaveRecoveries, clearProjectSaveJournals } =
    await import("../src/project/projectSaveJournal.ts");
  const values = new Map<string, string>();
  const storage = {
    clear: () => values.clear(),
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } as Storage;
  const project = "discard-recovery" as never;
  const key = projectSaveJournalKey(project, "owner");
  const marker = key.replace("project-writes.", "project-recovery.");
  values.set(key, "newer");
  values.set(marker, "marker");
  discardProjectSaveRecoveries(storage, project, [{ key, raw: "older" }]);
  assert.equal(values.get(key), "newer");
  discardProjectSaveRecoveries(storage, project, [{ key, raw: "newer" }]);
  assert.equal(values.size, 0);
  values.set(key, "pending");
  values.set(marker, "marker");
  values.set(projectSaveJournalKey("other" as never, "owner"), "other");
  clearProjectSaveJournals(storage, project);
  assert.equal(values.size, 1);
});
