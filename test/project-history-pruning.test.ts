import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectHistory } from "../src/authoring/projectHistory.ts";
import { pruneProjectHistory } from "../src/authoring/projectHistoryPruning.ts";
import { readProjectHistory, writeProjectHistory } from "../src/authoring/projectHistoryCodec.ts";
import { sha256Hex } from "../src/crypto.ts";

test("explicit oldest-first pruning keeps tags and cursor, immutable ids, and only reachable blobs", () => {
  const history = new ProjectHistory(sha256Hex);
  const commits = Array.from({ length: 4 }, (_, i) =>
    history.record(
      { "logic:1": String(i) },
      {
        label: "Edit",
        origin: "logic",
        author: "creator",
        time: i,
      },
    )!,
  );
  history.tag("Start", commits[0]!.id);
  const result = pruneProjectHistory(history.capture(), sha256Hex, { maxCommits: 2 });
  assert.deepEqual(result.removed, [commits[1]!.id, commits[2]!.id]);
  assert.deepEqual(
    result.state.commits.map((commit) => commit.id),
    [commits[0]!.id, commits[3]!.id],
  );
  assert.equal(result.state.cursor, commits[3]!.id);
  assert.equal(Object.keys(result.state.blobs).length, 2);
  assert.deepEqual(
    readProjectHistory(writeProjectHistory(result.state, sha256Hex), sha256Hex),
    result.state,
  );
  assert.throws(
    () => pruneProjectHistory(history.capture(), sha256Hex, { maxCommits: 1 }),
    /pinned|limit/,
  );
});

test("pruning a discarded boundary branch releases its blobs and obsolete boundary markers", () => {
  const history = new ProjectHistory(sha256Hex);
  const commits = Array.from({ length: 3 }, (_, i) =>
    history.record(
      { "logic:1": String(i) },
      {
        label: "Edit",
        origin: "logic",
        author: "creator",
        time: i,
      },
    )!,
  );
  history.tag("Start", commits[0]!.id);
  const first = pruneProjectHistory(history.capture(), sha256Hex, { maxCommits: 2 }).state;
  const result = pruneProjectHistory({ ...first, cursor: commits[0]!.id, future: [] }, sha256Hex, {
    maxCommits: 1,
  });
  assert.deepEqual(result.removed, [commits[2]!.id]);
  assert.equal(result.state.prunedParents, undefined);
  assert.equal(Object.keys(result.state.blobs).length, 1);
});
