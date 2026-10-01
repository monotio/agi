import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sha256Hex } from "../src/crypto.ts";
import { ProjectModel } from "../src/authoring/projectModel.ts";
import { ProjectHistory } from "../src/authoring/projectHistory.ts";
import {
  readProjectHistory,
  writeProjectHistory,
  PROJECT_HISTORY_LIMITS,
  PROJECT_HISTORY_FORMAT,
} from "../src/authoring/projectHistoryCodec.ts";

const meta = { label: "Initial", origin: "template", author: "creator", time: 0 } as const;
function start() {
  const model = new ProjectModel({
    documents: { "logic:1": "return;\r\n", "view:1": Uint8Array.of(1, 2) },
    digest: sha256Hex,
  });
  const history = new ProjectHistory(sha256Hex);
  const initial = history.record(model.capture().documents(), meta)!;
  return { model, history, initial };
}
function change(model: ProjectModel, history: ProjectHistory, text: string, time: number) {
  model.apply(
    model.issueApplication(
      model.propose(model.capture(), "Type", [{ key: "logic:1", content: text }]),
    ),
  );
  return history.record(model.capture().documents(), {
    label: "Type",
    origin: "logic",
    author: "creator",
    time,
  });
}

test("History commits, reverses, redoes, tags and restores by creating a new commit", () => {
  const { model, history, initial } = start();
  const second = change(model, history, "if (unfinished\ud800", 1)!;
  assert.equal(second.parent, initial.id);
  assert.deepEqual(second.changed, ["logic:1"]);
  assert.equal(Object.keys(history.capture().blobs).length, 3);
  const undo = history.undo(model)!;
  model.apply(model.issueApplication(undo.proposal));
  history.accept(undo);
  assert.equal(model.capture().read("logic:1")?.content, "return;\r\n");
  const redo = history.redo(model)!;
  model.apply(model.issueApplication(redo.proposal));
  history.accept(redo);
  assert.equal(model.capture().read("logic:1")?.content, "if (unfinished\ud800");
  history.tag("First room", initial.id);
  const restore = history.restore(model, initial.id, {
    label: "Restore room",
    author: "creator",
    time: 2,
  });
  model.apply(model.issueApplication(restore.proposal));
  history.accept(restore);
  const state = history.capture();
  assert.equal(state.commits.length, 3);
  assert.equal(state.commits[2]!.parent, second.id);
  assert.deepEqual(state.commits[2]!.documents, initial.documents);
  assert.equal(state.commits[2]!.origin, "history");
  assert.equal(state.tags["First room"], initial.id);
  assert.ok(
    Object.values(
      readProjectHistory(writeProjectHistory(state, sha256Hex), sha256Hex).blobs,
    ).includes("if (unfinished\ud800"),
  );
});

test("no-op after Undo keeps Redo; a new edit ends Redo and retains the old commit", () => {
  const { model, history, initial } = start();
  const second = change(model, history, "second", 1)!;
  const undo = history.undo(model)!;
  model.apply(model.issueApplication(undo.proposal));
  history.accept(undo);
  assert.equal(change(model, history, "return;\r\n", 2), null);
  assert.ok(history.redo(model));
  const third = change(model, history, "third", 3)!;
  assert.equal(third.parent, initial.id);
  assert.equal(history.redo(model), undefined);
  assert.ok(history.capture().commits.some(({ id }) => id === second.id));
  assert.throws(() => history.accept(undo), /issued|consumed|stale/);
});

test("Restore reproduces an older manifest exactly, including absence of later documents", () => {
  const { model, history, initial } = start();
  model.apply(
    model.issueApplication(
      model.propose(model.capture(), "Add room", [{ key: "logic:2", content: "return;" }]),
    ),
  );
  history.record(model.capture().documents(), { ...meta, time: 1 });
  const restore = history.restore(model, initial.id, {
    label: "Restore",
    author: "creator",
    time: 2,
  });
  model.apply(model.issueApplication(restore.proposal));
  history.accept(restore);
  assert.deepEqual(history.capture().commits.at(-1)!.documents, initial.documents);
  assert.equal(model.capture().read("logic:2"), undefined);
  // An explicit Restore still records the selected version when its content
  // happens to equal the current documents.
  const again = history.restore(model, initial.id, {
    label: "Restore again",
    author: "creator",
    time: 3,
  });
  model.apply(model.issueApplication(again.proposal));
  history.accept(again);
  assert.equal(history.capture().commits.length, 4);
});

test("History starts immutable and refuses forged, foreign, stale and unapplied moves", () => {
  const { model, history } = start();
  const state = history.capture();
  assert.ok(Object.isFrozen(state.commits));
  assert.ok(Object.isFrozen(state.tags));
  const byteHash = state.commits[0]!.documents["view:1"]!;
  (state.blobs[byteHash] as Uint8Array).fill(0);
  assert.deepEqual(history.capture().blobs[byteHash], Uint8Array.of(1, 2));
  change(model, history, "second", 1);
  const action = history.undo(model)!;
  assert.throws(() => history.accept({ ...action }), /issued/);
  const foreign = new ProjectHistory(sha256Hex, history.capture());
  assert.throws(() => foreign.accept(action), /issued/);
  assert.throws(() => history.accept(action), /applied/);
  change(model, history, "third", 2);
  assert.throws(() => history.accept(action), /stale/);
});

test("coordinated deletions reverse exact text and bytes after codec reopen", () => {
  const { model, history } = start();
  model.apply(
    model.issueApplication(
      model.propose(model.capture(), "Remove", [
        { key: "logic:1", content: null },
        { key: "view:1", content: null },
      ]),
    ),
  );
  const removed = history.record(model.capture().documents(), {
    ...meta,
    label: "Remove",
    time: 1,
  })!;
  assert.deepEqual(removed.documents, { "logic:1": null, "view:1": null });
  const reopened = new ProjectHistory(
    sha256Hex,
    readProjectHistory(writeProjectHistory(history.capture(), sha256Hex), sha256Hex),
  );
  const undo = reopened.undo(model)!;
  assert.throws(() => reopened.accept(undo), /documents|applied/);
  model.apply(model.issueApplication(undo.proposal));
  reopened.accept(undo);
  assert.deepEqual(model.capture().documents(), {
    "logic:1": "return;\r\n",
    "view:1": Uint8Array.of(1, 2),
  });
});

test("History codec reads a frozen fixture and refuses unknown versions, corruption and bounds", () => {
  const fixture: unknown = JSON.parse(
    readFileSync(new URL("./formats/project-history-v1.json", import.meta.url), "utf8"),
  );
  const state = readProjectHistory(fixture, sha256Hex);
  assert.equal(state.commits[0]!.label, "Initial");
  assert.deepEqual(writeProjectHistory(state, sha256Hex), fixture);
  assert.throws(
    () => readProjectHistory({ format: PROJECT_HISTORY_FORMAT, version: 3 }, sha256Hex),
    /Unsupported.*version/,
  );
  const { history } = start();
  const encoded = writeProjectHistory(history.capture(), sha256Hex);
  const corrupt = {
    ...encoded,
    commits: encoded.commits.map((commit) => ({ ...commit, label: "Changed" })),
  };
  assert.throws(() => readProjectHistory(corrupt, sha256Hex), /hash|identity/i);
  assert.throws(
    () =>
      readProjectHistory(
        {
          ...encoded,
          commits: Array(PROJECT_HISTORY_LIMITS.maxCommits + 1).fill(encoded.commits[0]),
        },
        sha256Hex,
      ),
    /limit/i,
  );
  const hash = Object.keys(encoded.blobs)[0]!;
  assert.throws(
    () =>
      readProjectHistory(
        {
          ...encoded,
          blobs: {
            [hash]: { type: "text", text: "x".repeat(PROJECT_HISTORY_LIMITS.maxBlobBytes / 2 + 1) },
          },
        },
        sha256Hex,
      ),
    /limit/i,
  );
  assert.throws(() => history.tag("x", "a".repeat(64)), /commit/i);
});

test("codec rejects sparse changed keys and writes tag names in code point order", () => {
  const { history, initial } = start();
  history.tag("\ue000", initial.id);
  history.tag("\u{1f600}", initial.id);
  const encoded = writeProjectHistory(history.capture(), sha256Hex);
  assert.deepEqual(Object.keys(encoded.tags), ["\ue000", "\u{1f600}"]);
  const changed = Array<string>(initial.changed.length);
  assert.throws(
    () => readProjectHistory({ ...encoded, commits: [{ ...initial, changed }] }, sha256Hex),
    /changed/,
  );
});

test("an invalid Restore is refused before its proposal can edit documents", () => {
  const { history, model, initial } = start();
  change(model, history, "second", 1);
  assert.throws(
    () => history.restore(model, initial.id, { label: "Restore", author: "creator", time: -1 }),
    /time/,
  );
  assert.equal(model.capture().read("logic:1")?.content, "second");
});

test("matching content from another edit cannot settle a History move", () => {
  const { history, model } = start();
  change(model, history, "second", 1);
  const undo = history.undo(model)!;
  model.apply(
    model.issueApplication(
      model.propose(model.capture(), "Other", [{ key: "logic:1", content: "return;\r\n" }]),
    ),
  );
  assert.throws(() => history.accept(undo), /applied|stale/);
});

test("typed blobs preserve empty source and bytes as distinct content and deduplicate each", () => {
  const history = new ProjectHistory(sha256Hex);
  const documents = {
    "logic:1": "",
    "logic:2": "",
    "picture:1": new Uint8Array(),
    "picture:2": new Uint8Array(),
  };
  const commit = history.record(documents, meta)!;
  assert.equal(Object.keys(history.capture().blobs).length, 2);
  assert.equal(commit.documents["logic:1"], commit.documents["logic:2"]);
  assert.equal(commit.documents["picture:1"], commit.documents["picture:2"]);
  assert.notEqual(commit.documents["logic:1"], commit.documents["picture:1"]);
});

test("the codec checks byte, total, manifest, tag, graph and field bounds", () => {
  const { history, initial } = start();
  const encoded = writeProjectHistory(history.capture(), sha256Hex);
  const byteHash = initial.documents["view:1"]!;
  for (const bytes of [[256], [1.5], ["1"], Array(1)])
    assert.throws(
      () =>
        readProjectHistory(
          { ...encoded, blobs: { [byteHash]: { type: "bytes", bytes } } },
          sha256Hex,
        ),
      /byte/,
    );
  assert.throws(() => readProjectHistory({ ...encoded, extra: true }, sha256Hex), /fields/);
  assert.throws(
    () => readProjectHistory({ ...encoded, cursor: "a".repeat(64) }, sha256Hex),
    /cursor/,
  );
  assert.throws(
    () => readProjectHistory({ ...encoded, future: [initial.id] }, sha256Hex),
    /future/,
  );
  assert.throws(
    () => readProjectHistory({ ...encoded, tags: { name: "a".repeat(64) } }, sha256Hex),
    /tag/,
  );
  assert.throws(
    () =>
      readProjectHistory(
        { ...encoded, tags: { ["x".repeat(PROJECT_HISTORY_LIMITS.maxTagLength + 1)]: initial.id } },
        sha256Hex,
      ),
    /limit/,
  );
  assert.throws(
    () =>
      readProjectHistory({ ...encoded, commits: [{ ...initial, parent: initial.id }] }, sha256Hex),
    /parent/,
  );
  assert.throws(
    () =>
      readProjectHistory(
        { ...encoded, commits: [{ ...initial, documents: { "logic:1": "a".repeat(64) } }] },
        sha256Hex,
      ),
    /blob/,
  );
  const documents = Object.fromEntries(
    Array.from({ length: PROJECT_HISTORY_LIMITS.maxDocuments + 1 }, (_, i) => [
      `key${i}`,
      byteHash,
    ]),
  );
  assert.throws(
    () => readProjectHistory({ ...encoded, commits: [{ ...initial, documents }] }, sha256Hex),
    /limit/,
  );
  const payload = "x".repeat(PROJECT_HISTORY_LIMITS.maxBlobBytes / 2);
  const blobs = Object.fromEntries(
    Array.from(
      { length: PROJECT_HISTORY_LIMITS.maxTotalBytes / PROJECT_HISTORY_LIMITS.maxBlobBytes + 1 },
      (_, i) => [i.toString(16).padStart(64, "0"), { type: "text", text: payload }],
    ),
  );
  assert.throws(() => readProjectHistory({ ...encoded, blobs }, sha256Hex), /total/);
  assert.throws(
    () =>
      writeProjectHistory(
        {
          ...history.capture(),
          blobs: { [byteHash]: new Uint8Array(PROJECT_HISTORY_LIMITS.maxBlobBytes + 1) },
        },
        sha256Hex,
      ),
    /limit/,
  );
});
