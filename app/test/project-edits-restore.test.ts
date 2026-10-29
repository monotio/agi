import assert from "node:assert/strict";
import type * as GameStorageModule from "../src/project/gameStorage.ts";
import { test } from "node:test";
import { ProjectHistory } from "../../src/authoring/projectHistory.ts";
import { createContainer } from "../../src/container/container.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import {
  commitProject,
  authoringFingerprint,
  loadAuthoredGameWithHistoryLifetime,
  clearCachedGame,
} from "../src/project/gameStorage.ts";
import { restoreProjectEdits } from "../src/project/projectEditsRestore.ts";
import {
  decodeProjectSaveJournal,
  writeProjectSaveJournal,
  projectSaveJournalKey,
  markProjectSaveRecovery,
  readProjectSaveRecoveries,
} from "../src/project/projectSaveJournal.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { installWebLocksFixture } from "./webLocksFixture.ts";
import { testProjectId } from "./identity.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { encodeJournalValue } from "../src/project/projectJournalCapture.ts";
import { rebuildProjectJournal } from "../src/project/projectSessionCore.ts";

const records = installIndexedDbFixture();
installWebLocksFixture();
const values = new Map<string, string>();
const storage = {
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
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
let frame: FrameRequestCallback | undefined;
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: () => {
    frame = undefined;
  },
});

async function pending(name: string, successor = false, withHistory = true) {
  values.clear();
  const documents = { "logic:0": "return;", notes: "Original notes" };
  const image = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const id = testProjectId(name);
  const history = new ProjectHistory(sha256Hex);
  history.record(documents, { label: "Opened", origin: "logic", author: "creator", time: 1 });
  await commitProject({
    projectId: id,
    workspaceId: "initial",
    commitId: "initial",
    expected: null,
    buildId: image.build.identity.buildId,
    documents: [],
    data: {
      title: name,
      files: Object.fromEntries(image.files()),
      words: [],
      workspace: writeProjectWorkspace(documents),
      ...(withHistory ? { projectHistory: history.capturePortable() } : {}),
    },
  });
  const original = (await loadAuthoredGameWithHistoryLifetime(id))!;
  const owner = openProjectSession({
    data: original.data,
    lifetime: original.lifetime!,
    admission: {
      runToken: name,
      admit: async () => ({
        status: "committed",
        expected: null,
        current: null,
        patchGeneration: 0,
      }),
    },
  });
  await owner.submit({
    proposal: owner.model.propose(owner.model.capture(), "Notes", [
      { key: "notes", content: "Restored notes" },
    ]),
    label: "Notes",
    origin: "logic",
    author: "creator",
  });
  frame?.(0);
  const first = [...values].find(([key]) => key.startsWith("monotio_agi.project-writes."))![1];
  if (successor)
    await owner.submit({
      proposal: owner.model.propose(owner.model.capture(), "More notes", [
        { key: "notes", content: "Latest notes" },
      ]),
      label: "More notes",
      origin: "logic",
      author: "creator",
    });
  owner.dispose();
  let raw = [...values].find(([key]) => key.startsWith("monotio_agi.project-writes."))![1];
  if (successor) {
    const initial = decodeProjectSaveJournal(first)[0]!;
    initial.attempted = true;
    raw = JSON.stringify({
      version: 2,
      entries: encodeJournalValue([initial, ...decodeProjectSaveJournal(raw)]),
    });
  }
  values.clear(); // The player downloaded, then discarded the journal.
  return {
    id,
    raw,
    original,
    entries: new Map([["RECOVERY-DATA/JOURNAL-1.JSON", new TextEncoder().encode(raw)]]),
  };
}
function notes(
  data: NonNullable<Awaited<ReturnType<typeof loadAuthoredGameWithHistoryLifetime>>>["data"],
) {
  const content = data.workspace!.documents.find(({ key }) => key === "notes")!.content;
  assert.equal(content.type, "text");
  return content.type === "text" ? content.text : "";
}

test("downloaded pending edits restore into their original project with Undo and safe retries", async () => {
  const input = await pending("restore-undo");
  assert.equal(await restoreProjectEdits(input.entries), input.id);
  const saved = (await loadAuthoredGameWithHistoryLifetime(input.id))!;
  assert.equal(notes(saved.data), "Restored notes");
  assert.equal(await restoreProjectEdits(input.entries), input.id);
  assert.equal(
    (await loadAuthoredGameWithHistoryLifetime(input.id))!.data.generation,
    saved.data.generation,
  );
  const owner = openProjectSession({
    data: saved.data,
    lifetime: saved.lifetime!,
    admission: {
      runToken: "undo-restored",
      admit: async () => ({
        status: "committed",
        expected: null,
        current: null,
        patchGeneration: 0,
      }),
    },
  });
  assert.equal((await owner.undo())?.status, "committed");
  assert.equal(owner.model.capture().read("notes")?.content, "Original notes");
  owner.discard();
});

test("ordinary game archives with retained recovery data remain game imports", async () => {
  const input = await pending("restore-game-archive");
  input.entries.set("LOGDIR", Uint8Array.of(255, 255, 255));
  assert.equal(await restoreProjectEdits(input.entries), null);
  assert.equal(
    notes((await loadAuthoredGameWithHistoryLifetime(input.id))!.data),
    "Original notes",
  );
});

for (const fault of ["version", "hash", "identity", "empty", "invalid"] as const) {
  test(`a downloaded ${fault} journal is refused before any project or file bytes change`, async () => {
    const input = await pending(`restore-invalid-${fault}`);
    let raw = input.raw;
    if (fault === "version") raw = raw.replace('"version":2', '"version":999');
    if (fault === "hash") raw = raw.replace("Restored notes", "Tampered notes");
    if (fault === "identity") raw = raw.replaceAll(input.id, "a-different-project");
    if (fault === "empty") raw = '{"version":2,"entries":["array",[]]}';
    if (fault === "invalid") raw = '{"version":2,"entries":["array",[["record",[]]]]}';
    const file = new TextEncoder().encode(raw);
    const bytes = file.slice();
    input.entries.set("RECOVERY-DATA/JOURNAL-2.JSON", file);
    const before = structuredClone([...records]);
    await assert.rejects(restoreProjectEdits(input.entries));
    assert.deepEqual([...records], before);
    assert.deepEqual(file, bytes);
    assert.equal(values.size, 0);
  });
}

for (const field of ["generation", "revision", "authoring", "lifetime"] as const) {
  test(`a project's changed ${field} refuses the file and keeps the newer project`, async () => {
    const input = await pending(`restore-changed-${field}`);
    const body = structuredClone(records.get(input.id)) as {
      generation: number;
      library: { revision: string };
      authoringState: object;
    };
    if (field === "generation") body.generation++;
    if (field === "revision") body.library.revision = "e".repeat(64);
    if (field === "authoring") body.authoringState = { newer: true };
    if (field === "lifetime")
      records.set(`lifetime/${input.id}`, {
        projectId: `lifetime/${input.id}`,
        epoch: "reimported",
        deleted: false,
      });
    else records.set(input.id, body);
    const before = structuredClone([...records]);
    await assert.rejects(restoreProjectEdits(input.entries), /changed|reimported/);
    assert.deepEqual([...records], before);
  });
}

test("a missing original project refuses its download instead of making a copy", async () => {
  const input = await pending("restore-missing");
  await clearCachedGame(input.id);
  const before = structuredClone([...records]);
  await assert.rejects(restoreProjectEdits(input.entries), /original project/);
  assert.deepEqual([...records], before);
});

test("a second storage client changing the project after file selection wins", async () => {
  const input = await pending("restore-second-client");
  const path = "../src/project/gameStorage.ts?restore-second-tab";
  const other = (await import(path)) as typeof GameStorageModule;
  const entry = decodeProjectSaveJournal(input.raw)[0]!;
  await other.commitProject({
    ...entry.capture!.identity,
    commitId: "second-tab",
    documents: [],
    data: { ...input.original.data, title: "Second tab" },
  });
  const before = structuredClone([...records]);
  await assert.rejects(restoreProjectEdits(input.entries), /changed/);
  assert.deepEqual([...records], before);
});

test("a rejected restore write leaves all project rows intact and its file retryable", async () => {
  const input = await pending("restore-write-failure");
  const before = structuredClone([...records]);
  const set = records.set;
  records.set = (key, value) => {
    if (key === input.id) throw new DOMException("Full", "QuotaExceededError");
    return set.call(records, key, value);
  };
  try {
    await assert.rejects(restoreProjectEdits(input.entries), /storage/);
  } finally {
    records.set = set;
  }
  assert.deepEqual([...records], before);
  await restoreProjectEdits(input.entries);
  assert.equal(
    notes((await loadAuthoredGameWithHistoryLifetime(input.id))!.data),
    "Restored notes",
  );
});

test("closing before the restore transaction commits keeps the original and permits file retry", async () => {
  const input = await pending("restore-close");
  const db = await new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open("ignored");
    request.onsuccess = () => resolve(request.result);
  });
  const transaction = db.transaction;
  let aborted = false;
  db.transaction = (...args: Parameters<IDBDatabase["transaction"]>) => {
    const tx = transaction.apply(db, args);
    if (args[1] === "readwrite") {
      const objectStore = tx.objectStore.bind(tx);
      tx.objectStore = (name) => {
        const store = objectStore(name);
        const put = store.put.bind(store);
        store.put = (...putArgs) => {
          const request = put(...putArgs);
          if (!aborted) {
            aborted = true;
            queueMicrotask(() => tx.abort());
          }
          return request;
        };
        return store;
      };
    }
    return tx;
  };
  const before = structuredClone([...records]);
  try {
    await assert.rejects(restoreProjectEdits(input.entries), /storage/);
  } finally {
    db.transaction = transaction;
  }
  assert.ok(aborted);
  assert.deepEqual([...records], before);
  await restoreProjectEdits(input.entries);
  assert.equal(
    notes((await loadAuthoredGameWithHistoryLifetime(input.id))!.data),
    "Restored notes",
  );
});

test("all journals in a download are checked before any recovered edit is published", async () => {
  const input = await pending("restore-atomic-conflict");
  const other = await pending("restore-other-project");
  input.entries.set("RECOVERY-DATA/JOURNAL-2.JSON", new TextEncoder().encode(other.raw));
  const before = structuredClone([...records]);
  await assert.rejects(restoreProjectEdits(input.entries));
  assert.deepEqual([...records], before);
  assert.equal(
    sha256Hex(input.entries.get("RECOVERY-DATA/JOURNAL-1.JSON")!),
    sha256Hex(new TextEncoder().encode(input.raw)),
  );
});

test("an older request journal restores the same project without changing its envelope", async () => {
  const input = await pending("restore-legacy");
  const capture = decodeProjectSaveJournal(input.raw)[0]!.capture!;
  const request = await rebuildProjectJournal(input.original.data, capture, {
    commit: commitProject,
    fingerprint: authoringFingerprint,
  });
  writeProjectSaveJournal(storage, "legacy", [{ request, attempted: true }]);
  const raw = storage.getItem("legacy")!;
  assert.equal(JSON.parse(raw).version, 1);
  values.clear();
  input.entries.set("RECOVERY-DATA/JOURNAL-1.JSON", new TextEncoder().encode(raw));
  await restoreProjectEdits(input.entries);
  assert.equal(
    notes((await loadAuthoredGameWithHistoryLifetime(input.id))!.data),
    "Restored notes",
  );
  assert.equal(new TextDecoder().decode(input.entries.get("RECOVERY-DATA/JOURNAL-1.JSON")), raw);
});

test("attempted and unattempted successor edits restore atomically and retry exactly once", async () => {
  const input = await pending("restore-successors", true);
  assert.equal(decodeProjectSaveJournal(input.raw).length, 2);
  await restoreProjectEdits(input.entries);
  const saved = (await loadAuthoredGameWithHistoryLifetime(input.id))!;
  assert.equal(notes(saved.data), "Latest notes");
  assert.equal(saved.data.generation, input.original.data.generation! + 2);
  // Another downloaded journal can retain the already acknowledged predecessor.
  input.entries.set(
    "RECOVERY-DATA/JOURNAL-2.JSON",
    new TextEncoder().encode(
      JSON.stringify({
        version: 2,
        entries: encodeJournalValue([decodeProjectSaveJournal(input.raw)[0]!]),
      }),
    ),
  );
  await restoreProjectEdits(input.entries);
  assert.equal(
    (await loadAuthoredGameWithHistoryLifetime(input.id))!.data.generation,
    saved.data.generation,
  );
});

test("a divergent second journal refuses the complete download without publishing its first edits", async () => {
  const input = await pending("restore-divergent");
  const entries = decodeProjectSaveJournal(input.raw);
  const { hash: _hash, ...original } = entries[0]!.capture!;
  const capture = { ...original, identity: { ...original.identity, commitId: "stale-session" } };
  entries[0]!.capture = {
    ...capture,
    hash: sha256Hex(new TextEncoder().encode(JSON.stringify(encodeJournalValue(capture)))),
  };
  const raw = JSON.stringify({ version: 2, entries: encodeJournalValue(entries) });
  input.entries.set("RECOVERY-DATA/JOURNAL-2.JSON", new TextEncoder().encode(raw));
  const before = structuredClone([...records]);
  await assert.rejects(restoreProjectEdits(input.entries), /changed/);
  assert.deepEqual([...records], before);
});

for (const changed of ["generation", "lifetime"] as const) {
  test(`a second client's ${changed} change during preparation is checked inside publication`, async () => {
    const input = await pending(`restore-publication-${changed}`);
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("ignored");
      request.onsuccess = () => resolve(request.result);
    });
    const transaction = db.transaction;
    let updated = false;
    let newer: unknown;
    db.transaction = (...args: Parameters<IDBDatabase["transaction"]>) => {
      const tx = transaction.apply(db, args);
      if (args[1] === "readwrite" && !updated) {
        updated = true;
        if (changed === "generation") {
          newer = {
            ...(records.get(input.id) as object),
            title: "Second page",
            generation: input.original.data.generation! + 1,
          };
          records.set(input.id, newer);
        } else {
          newer = { projectId: `lifetime/${input.id}`, epoch: "new-lifetime", deleted: false };
          records.set(`lifetime/${input.id}`, newer);
        }
      }
      return tx;
    };
    try {
      await assert.rejects(restoreProjectEdits(input.entries), /changed|reimported/);
    } finally {
      db.transaction = transaction;
    }
    assert.ok(updated);
    assert.deepEqual(
      records.get(changed === "generation" ? input.id : `lifetime/${input.id}`),
      newer,
    );
    assert.equal(
      [...records.keys()].filter(
        (key) => typeof key === "string" && key.startsWith(`commit/${input.id}/`),
      ).length,
      1,
    );
  });
}

test("an unsupported project version arriving during restore keeps its exact bytes", async () => {
  const input = await pending("restore-future-body-race");
  const db = await new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open("ignored");
    request.onsuccess = () => resolve(request.result);
  });
  const transaction = db.transaction;
  let future: unknown;
  db.transaction = (...args: Parameters<IDBDatabase["transaction"]>) => {
    const tx = transaction.apply(db, args);
    if (args[1] === "readwrite" && future === undefined) {
      future = { ...(records.get(input.id) as object), version: 999 };
      records.set(input.id, future);
    }
    return tx;
  };
  try {
    await assert.rejects(restoreProjectEdits(input.entries));
  } finally {
    db.transaction = transaction;
  }
  assert.deepEqual(records.get(input.id), future);
});

test("an unsupported orphan History blob is preserved when restoring its document", async () => {
  const input = await pending("restore-future-blob");
  const capture = decodeProjectSaveJournal(input.raw)[0]!.capture!;
  const request = await rebuildProjectJournal(input.original.data, capture, {
    commit: commitProject,
    fingerprint: authoringFingerprint,
  });
  const hash = Object.entries(request.data.projectHistory!.blobs).find(
    ([, blob]) => blob.type === "text" && blob.text === "Restored notes",
  )![0];
  const { projectHistoryBlobKey } = await import("../src/project/projectHistoryStorage.ts");
  const key = projectHistoryBlobKey(input.id, hash);
  const future = {
    projectId: key,
    format: "monotio.agi.project-history-blob",
    version: 999,
    content: "Untouched",
  };
  records.set(key, future);
  const before = structuredClone([...records]);
  await assert.rejects(restoreProjectEdits(input.entries));
  assert.deepEqual([...records], before);
});

test("hash-valid unreadable operations explain the file problem instead of asking to retry storage", async () => {
  const input = await pending("restore-unreadable-operations");
  const entries = decodeProjectSaveJournal(input.raw);
  const { hash: _hash, ...capture } = entries[0]!.capture!;
  const invalid = { ...capture, operations: null };
  const raw = JSON.stringify({
    version: 2,
    entries: encodeJournalValue([
      {
        attempted: false,
        capture: {
          ...invalid,
          hash: sha256Hex(new TextEncoder().encode(JSON.stringify(encodeJournalValue(invalid)))),
        },
      },
    ]),
  });
  input.entries.set("RECOVERY-DATA/JOURNAL-1.JSON", new TextEncoder().encode(raw));
  const before = structuredClone([...records]);
  await assert.rejects(restoreProjectEdits(input.entries), /unreadable data/);
  assert.deepEqual([...records], before);
});

test("a History row created during preparation is checked before restore publishes", async () => {
  const input = await pending("restore-blob-race");
  const capture = decodeProjectSaveJournal(input.raw)[0]!.capture!;
  const request = await rebuildProjectJournal(input.original.data, capture, {
    commit: commitProject,
    fingerprint: authoringFingerprint,
  });
  const hash = Object.entries(request.data.projectHistory!.blobs).find(
    ([, blob]) => blob.type === "text" && blob.text === "Restored notes",
  )![0];
  const { projectHistoryBlobKey } = await import("../src/project/projectHistoryStorage.ts");
  const key = projectHistoryBlobKey(input.id, hash);
  const future = {
    projectId: key,
    format: "monotio.agi.project-history-blob",
    version: 999,
    content: "Untouched",
  };
  const db = await new Promise<IDBDatabase>((resolve) => {
    const request = indexedDB.open("ignored");
    request.onsuccess = () => resolve(request.result);
  });
  const transaction = db.transaction;
  db.transaction = (...args: Parameters<IDBDatabase["transaction"]>) => {
    const tx = transaction.apply(db, args);
    if (args[1] === "readwrite") records.set(key, future);
    return tx;
  };
  const before = structuredClone(records.get(input.id));
  try {
    await assert.rejects(restoreProjectEdits(input.entries), /changed/);
  } finally {
    db.transaction = transaction;
  }
  assert.deepEqual(records.get(input.id), before);
  assert.deepEqual(records.get(key), future);
});

test("an unknown orphan History blob stays untouched when the project predates History", async () => {
  const input = await pending("restore-prehistory-orphan", false, false);
  const capture = decodeProjectSaveJournal(input.raw)[0]!.capture!;
  const request = await rebuildProjectJournal(input.original.data, capture, {
    commit: commitProject,
    fingerprint: authoringFingerprint,
  });
  const hash = Object.entries(request.data.projectHistory!.blobs).find(
    ([, blob]) => blob.type === "text" && blob.text === "Restored notes",
  )![0];
  const { projectHistoryBlobKey } = await import("../src/project/projectHistoryStorage.ts");
  const key = projectHistoryBlobKey(input.id, hash);
  records.set(key, {
    projectId: key,
    format: "monotio.agi.project-history-blob",
    version: 999,
    content: "Untouched",
  });
  const before = structuredClone([...records]);
  await assert.rejects(restoreProjectEdits(input.entries));
  assert.deepEqual([...records], before);
});

test("restoring a download acknowledges only the exact retained recovery bytes it saved", async () => {
  const input = await pending("restore-retained");
  const key = projectSaveJournalKey(input.id, "retained");
  const newerKey = projectSaveJournalKey(input.id, "different-download");
  storage.setItem(key, input.raw);
  markProjectSaveRecovery(storage, key, "Temporary recovery failure");
  storage.setItem(newerKey, input.raw + " ");
  markProjectSaveRecovery(storage, newerKey, "Temporary recovery failure");
  await restoreProjectEdits(input.entries);
  assert.equal(storage.getItem(key), null);
  assert.equal(storage.getItem(newerKey), input.raw + " ");
  assert.deepEqual(
    readProjectSaveRecoveries(storage, input.id).map(({ key }) => key),
    [newerKey],
  );
  assert.equal(
    notes((await loadAuthoredGameWithHistoryLifetime(input.id))!.data),
    "Restored notes",
  );
});

test("an old download cannot report restored edits after the project has undone them", async () => {
  const input = await pending("restore-after-undo");
  await restoreProjectEdits(input.entries);
  const saved = (await loadAuthoredGameWithHistoryLifetime(input.id))!;
  const owner = openProjectSession({
    data: saved.data,
    lifetime: saved.lifetime!,
    admission: {
      runToken: "undo-import",
      admit: async () => ({
        status: "committed",
        expected: null,
        current: null,
        patchGeneration: 0,
      }),
    },
  });
  await owner.undo();
  await owner.flush();
  owner.dispose();
  assert.equal(
    notes((await loadAuthoredGameWithHistoryLifetime(input.id))!.data),
    "Original notes",
  );
  const before = structuredClone([...records]);
  await assert.rejects(restoreProjectEdits(input.entries), /changed/);
  assert.deepEqual([...records], before);
});
