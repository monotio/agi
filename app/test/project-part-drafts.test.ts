import assert from "node:assert/strict";
import { test } from "node:test";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { openProjectDrafts } from "../src/project/projectPartDrafts.ts";

const records = installIndexedDbFixture();
function journal() {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    key(index: number) {
      return [...entries.keys()][index] ?? null;
    },
    getItem(key: string) {
      return entries.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      entries.set(key, value);
    },
    removeItem(key: string) {
      entries.delete(key);
    },
  };
}
function open(project: string, storage: ReturnType<typeof journal>) {
  return openProjectDrafts({ projectId: project, lifetime: "initial", journal: storage });
}

test("a draft saves only its part and reopens without an update or history", async () => {
  const storage = journal();
  const drafts = open("draft-basic", storage);
  await drafts.ready;
  drafts.stage([{ key: "logic:1", content: "if (" }]);
  await drafts.flush();
  assert.equal(records.get("part-drafts/draft-basic/logic:1") !== undefined, true);
  assert.equal(records.get("draft-basic"), undefined);
  const reopened = open("draft-basic", storage);
  await reopened.ready;
  assert.equal(reopened.changes()[0]?.content, "if (");
});

test("a rejected draft write retains its journal and retries exact bytes", async () => {
  const storage = journal();
  const drafts = open("draft-refused", storage);
  await drafts.ready;
  drafts.stage([{ key: "view:1", content: Uint8Array.of(1, 2) }]);
  const set = records.set.bind(records);
  records.set = (key, value) => {
    if (key === "part-drafts/draft-refused/view:1") throw new Error("disk full");
    return set(key, value);
  };
  await assert.rejects(drafts.flush(), /disk full/);
  records.set = set;
  assert.ok(storage.length > 0);
  await drafts.flush();
  assert.deepEqual(drafts.changes()[0]?.content, Uint8Array.of(1, 2));
});

test("two tabs cannot overwrite an unseen draft of the same part", async () => {
  const storage = journal();
  const first = open("draft-tabs", storage);
  const second = open("draft-tabs", storage);
  await Promise.all([first.ready, second.ready]);
  first.stage([{ key: "notes", content: "first tab" }]);
  second.stage([{ key: "notes", content: "second tab" }]);
  await first.flush();
  await assert.rejects(second.flush(), /another tab/);
  assert.equal(first.changes()[0]?.content, "first tab");
  assert.equal(second.changes()[0]?.content, "second tab");
});

test("reopening recovers the edited part when the page closes before a write commits", async () => {
  const storage = journal();
  const drafts = open("draft-close", storage);
  await drafts.ready;
  drafts.stage([{ key: "picture:1", content: "vis 4\nend\n" }]);
  // The page disappears with the synchronous journal, before its debounce drains.
  drafts.dispose();
  const reopened = open("draft-close", storage);
  await reopened.ready;
  assert.equal(reopened.changes()[0]?.content, "vis 4\nend\n");
  await reopened.flush();
  await reopened.clear();
  assert.deepEqual(reopened.changes(), []);
});

test("a refused recovery journal keeps the editor content until IndexedDB saves it", async () => {
  const storage = journal();
  storage.setItem = () => {
    throw new Error("journal full");
  };
  const drafts = open("draft-journal-full", storage);
  await drafts.ready;
  assert.doesNotThrow(() => drafts.stage([{ key: "notes", content: "kept in editor" }]));
  assert.equal(drafts.changes()[0]?.content, "kept in editor");
  assert.match(drafts.status().error, /recovery copy/);
  await drafts.flush();
  assert.equal(drafts.status().error, "");
  const reopened = open("draft-journal-full", journal());
  await reopened.ready;
  assert.equal(reopened.changes()[0]?.content, "kept in editor");
});

test("discard removes a rejected draft without writing it first", async () => {
  const storage = journal();
  const drafts = open("draft-discard", storage);
  await drafts.ready;
  drafts.stage([{ key: "logic:1", content: "broken source" }]);
  const set = records.set.bind(records);
  records.set = (key, value) => {
    if (key === "part-drafts/draft-discard/logic:1") throw new Error("part write refused");
    return set(key, value);
  };
  try {
    await assert.rejects(drafts.flush(), /part write refused/);
    await drafts.clear();
    assert.deepEqual(drafts.changes(), []);
    assert.equal(storage.length, 0);
  } finally {
    records.set = set;
  }
});

test("unknown draft versions are rejected without rewriting their records", async () => {
  const raw = {
    projectId: "part-drafts/draft-future",
    format: "monotio.agi.part-drafts",
    version: 2,
    keys: [],
  };
  records.set(raw.projectId, raw);
  const drafts = open("draft-future", journal());
  await assert.rejects(drafts.ready, /newer app/);
  assert.deepEqual(records.get(raw.projectId), raw);
});

test("another open tab cannot adopt a journal whose draft is still being edited", async () => {
  const storage = journal();
  const first = open("draft-active", storage);
  await first.ready;
  first.stage([{ key: "notes", content: "private pending edit" }]);
  const second = open("draft-active", storage);
  await second.ready;
  assert.deepEqual(second.changes(), []);
  first.dispose();
  second.dispose();
  const reopened = open("draft-active", storage);
  await reopened.ready;
  assert.equal(reopened.changes()[0]?.content, "private pending edit");
  await reopened.flush();
});

test("a recovered draft from an older update remains available without replacing the newer game", async () => {
  const storage = journal();
  const first = openProjectDrafts({
    projectId: "draft-old-update",
    lifetime: "initial",
    journal: storage,
    currentImage: () => "first-update",
  });
  await first.ready;
  first.stage([{ key: "logic:1", content: "older pending edit" }]);
  first.dispose();
  const reopened = openProjectDrafts({
    projectId: "draft-old-update",
    lifetime: "initial",
    journal: storage,
    currentImage: () => "newer-update",
  });
  await reopened.ready;
  assert.equal(reopened.changes()[0]?.content, "older pending edit");
  assert.match(reopened.status().error, /another tab/);
  await assert.rejects(reopened.flush(), /another tab/);
  assert.equal(records.get("part-drafts/draft-old-update/logic:1"), undefined);
});

test("typing while drafts open preserves the newer buffer and rebases its receipt", async () => {
  const storage = journal();
  const first = open("draft-open-race", storage);
  await first.ready;
  first.stage([{ key: "notes", content: "saved draft" }]);
  await first.flush();
  first.dispose();
  const second = open("draft-open-race", storage);
  second.stage([{ key: "notes", content: "typed while opening" }]);
  await second.ready;
  assert.equal(second.changes()[0]?.content, "typed while opening");
  await second.flush();
  const third = open("draft-open-race", storage);
  await third.ready;
  assert.equal(third.changes()[0]?.content, "typed while opening");
});

test("a draft burst saves the latest content of each edited part", async () => {
  const drafts = open("draft-burst", journal());
  await drafts.ready;
  drafts.stage([{ key: "logic:1", content: "p" }]);
  drafts.stage([{ key: "logic:1", content: "print" }]);
  drafts.stage([{ key: "picture:1", content: "red" }]);
  drafts.stage([{ key: "logic:1", content: "return;" }]);
  await drafts.flush();
  assert.equal(
    (records.get("part-drafts/draft-burst/logic:1") as { content: string }).content,
    "return;",
  );
  assert.equal(
    (records.get("part-drafts/draft-burst/picture:1") as { content: string }).content,
    "red",
  );
  drafts.dispose();
});

test("a draft acknowledgement preserves an edit arriving during its write", async () => {
  const storage = journal();
  const drafts = open("draft-inflight", storage);
  await drafts.ready;
  drafts.stage([{ key: "notes", content: "first" }]);
  const set = records.set.bind(records);
  let arrived = false;
  records.set = (key, value) => {
    if (key === "part-drafts/draft-inflight/notes" && !arrived) {
      arrived = true;
      drafts.stage([{ key: "notes", content: "latest" }]);
    }
    return set(key, value);
  };
  try {
    await drafts.flush();
    assert.equal(
      (records.get("part-drafts/draft-inflight/notes") as { content: string }).content,
      "latest",
    );
    assert.equal(storage.length, 0);
  } finally {
    records.set = set;
    drafts.dispose();
  }
});

test("a stopped session retains its draft without starting a storage write", async () => {
  let writable = true;
  const storage = journal();
  const drafts = openProjectDrafts({
    projectId: "draft-stopped",
    lifetime: "initial",
    journal: storage,
    canWrite: () => writable,
  });
  await drafts.ready;
  drafts.stage([{ key: "notes", content: "kept pending" }]);
  writable = false;
  try {
    await assert.rejects(drafts.flush(), /another tab/);
    assert.equal(records.get("part-drafts/draft-stopped/notes"), undefined);
    assert.equal(drafts.changes()[0]?.content, "kept pending");
    assert.equal(storage.length, 1);
  } finally {
    drafts.dispose();
  }
});

test("recovery keeps the old journal until IndexedDB saves when a new journal is refused", async () => {
  const storage = journal();
  const first = open("draft-recovery-full", storage);
  await first.ready;
  first.stage([{ key: "notes", content: "recover this exact text" }]);
  first.dispose();
  storage.setItem = () => {
    throw new Error("journal full");
  };
  const recovered = open("draft-recovery-full", storage);
  try {
    await recovered.ready;
    assert.equal(recovered.changes()[0]?.content, "recover this exact text");
    assert.equal(storage.length, 1);
    await recovered.flush();
    assert.equal(storage.length, 0);
    await recovered.clear();
    const reopened = open("draft-recovery-full", storage);
    await reopened.ready;
    assert.deepEqual(reopened.changes(), []);
    reopened.dispose();
  } finally {
    recovered.dispose();
  }
});
