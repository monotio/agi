import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectModel } from "../src/authoring/projectModel.ts";
import { ProjectHistory } from "../src/authoring/projectHistory.ts";
import {
  PROJECT_HISTORY_LIMITS,
  readProjectHistory,
  writeProjectHistory,
} from "../src/authoring/projectHistoryCodec.ts";
import { pruneProjectHistory } from "../src/authoring/projectHistoryPruning.ts";
import { sha256Hex } from "../src/crypto.ts";
import { largeProjectHistory } from "./projectHistoryCapFixture.ts";

for (const count of [417, 1024]) {
  test(`a 315-document project accepts version ${count} without changing its archive version`, () => {
    const history = new ProjectHistory(sha256Hex, largeProjectHistory(count - 1));
    const before = history.capture();
    const documents = Object.fromEntries(
      Object.entries(before.commits.at(-1)!.documents).map(([key, hash]) => [
        key,
        before.blobs[hash!]!,
      ]),
    );
    const commit = history.record(
      { ...documents, "logic:0": "// Next\nreturn;" },
      { label: "Next", origin: "logic", author: "creator", time: count },
    );
    assert.equal(history.capture().commits.length, count);
    assert.equal(history.capture().cursor, commit!.id);
    const stored = writeProjectHistory(history.capture(), sha256Hex);
    assert.equal(stored.version, 1);
    assert.equal(readProjectHistory(stored, sha256Hex).commits.length, count);
  });
}

test("version 1,025 prunes the oldest version and keeps the newest 1,024 identities", () => {
  const state = largeProjectHistory(1025);
  assert.throws(() => writeProjectHistory(state, sha256Hex), /commit count/);
  assert.throws(
    () =>
      pruneProjectHistory(
        {
          ...state,
          commits: [{ ...state.commits[0]!, label: "Tampered" }, ...state.commits.slice(1)],
        },
        sha256Hex,
      ),
    /commit hash/,
    "even a version about to be pruned must be validated",
  );
  const result = pruneProjectHistory(state, sha256Hex);
  assert.deepEqual(result.removed, [state.commits[0]!.id]);
  assert.deepEqual(
    result.state.commits.map((commit) => commit.id),
    state.commits.slice(1).map((commit) => commit.id),
  );
  assert.equal(result.state.cursor, state.cursor);
  const reopened = new ProjectHistory(sha256Hex, result.state);
  assert.equal(reopened.capture().commits.length, 1024);
});

test("the manifest ceiling permits every retained version to hold every document", () => {
  assert.equal(
    PROJECT_HISTORY_LIMITS.maxManifestEntries,
    PROJECT_HISTORY_LIMITS.maxCommits * PROJECT_HISTORY_LIMITS.maxDocuments,
  );
});

test("record and Restore keep accepting edits after version 1,024 and reopen with exact documents", () => {
  const state = largeProjectHistory(1024);
  const history = new ProjectHistory(sha256Hex, state);
  const documents = Object.fromEntries(
    Object.entries(state.commits.at(-1)!.documents).map(([key, hash]) => [
      key,
      state.blobs[hash!]!,
    ]),
  );
  const next = { ...documents, "logic:0": "// Version 1025\nreturn;" };
  const recorded = history.record(next, {
    label: "Next",
    origin: "logic",
    author: "creator",
    time: 1025,
  })!;
  assert.equal(history.capture().commits.length, 1024);
  assert.equal(history.capture().commits[0]!.id, state.commits[1]!.id);
  assert.equal(history.capture().cursor, recorded.id);
  const model = new ProjectModel({ documents: next, digest: sha256Hex });
  const target = state.commits[1]!;
  const restore = history.restore(model, target.id, {
    label: "Restore",
    author: "creator",
    time: 1026,
  });
  model.apply(model.issueApplication(restore.proposal));
  history.accept(restore);
  assert.equal(model.capture().read("logic:0")!.content, "// Edit 1\nreturn;");
  const reopened = readProjectHistory(history.capturePortable(), sha256Hex);
  assert.equal(reopened.commits.length, 1024);
  assert.equal(
    reopened.blobs[reopened.commits.at(-1)!.documents["logic:0"]!],
    "// Edit 1\nreturn;",
  );
  history.record(
    { ...next, "logic:0": "// After Restore\nreturn;" },
    { label: "Again", origin: "logic", author: "creator", time: 1027 },
  );
  assert.equal(history.capture().commits.length, 1024);
});

test("Restore refuses all-pinned overflow before issuing a proposal", () => {
  const state = largeProjectHistory(1024);
  const history = new ProjectHistory(sha256Hex, {
    ...state,
    tags: Object.fromEntries(state.commits.map((commit, i) => [`Version ${i}`, commit.id])),
  });
  const documents = Object.fromEntries(
    Object.entries(state.commits.at(-1)!.documents).map(([key, hash]) => [
      key,
      state.blobs[hash!]!,
    ]),
  );
  const model = new ProjectModel({ documents, digest: sha256Hex });
  assert.throws(
    () =>
      history.restore(model, state.commits[0]!.id, {
        label: "Restore",
        author: "creator",
        time: 1025,
      }),
    /Pinned/,
  );
  assert.equal(model.capture().revision, 0);
});
