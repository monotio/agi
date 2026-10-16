import assert from "node:assert/strict";
import { test } from "node:test";
import { projectContentHash } from "../src/authoring/projectContent.ts";
import { projectCommitId, type ProjectHistoryCommit } from "../src/authoring/projectHistoryData.ts";
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

test("a prune hashes each admitted blob and commit once", () => {
  const history = new ProjectHistory(sha256Hex);
  for (let i = 0; i < 4; i++)
    history.record(
      { "logic:1": String(i) },
      { label: "Edit", origin: "logic", author: "creator", time: i },
    );
  const state = history.capture();
  let hashes = 0;
  const pruned = pruneProjectHistory(
    state,
    (bytes) => {
      hashes++;
      return sha256Hex(bytes);
    },
    { maxCommits: 2 },
  );
  assert.equal(hashes, Object.keys(state.blobs).length + state.commits.length);
  assert.ok(Object.isFrozen(pruned.state.commits[0]!.changed));
});

// The injected digest keeps large byte-limit tests inexpensive; framing and identities
// still distinguish every controlled input (each payload starts with its version).
const retentionDigest = (bytes: Uint8Array) => sha256Hex(bytes.subarray(0, 1024));

test("byte overflow prunes old versions and the next edit uses the retained totals", () => {
  const history = new ProjectHistory(retentionDigest);
  for (let i = 0; i < 10; i++) {
    const bytes = new Uint8Array(8 * 1024 * 1024);
    bytes[0] = i;
    history.record(
      { "view:1": bytes },
      { label: "View", origin: "view", author: "creator", time: i },
    );
  }
  const state = history.capture();
  assert.equal(state.commits.length, 8);
  assert.equal(state.commits[0]!.time, 2);
  assert.equal(new ProjectHistory(retentionDigest, state).capture().commits.length, 8);
});

test("image histories retain more than 64 MiB under their 128 MiB byte allowance", () => {
  const history = new ProjectHistory(retentionDigest);
  const bytes = new Uint8Array(40 * 1024 * 1024);
  const image = "attachment:" + "a".repeat(64);
  history.record({ [image]: bytes }, { label: "Image", origin: "agent", author: "agent", time: 0 });
  bytes[0] = 1;
  history.record({ [image]: bytes }, { label: "Image", origin: "agent", author: "agent", time: 1 });
  const result = pruneProjectHistory(history.capture(), retentionDigest);
  assert.deepEqual(result.removed, []);
  assert.equal(result.state.commits.length, 2);
});

test("blob count overflow prunes the oldest unpinned versions", () => {
  const blobs: Record<string, string> = {};
  const commits: ProjectHistoryCommit[] = [];
  for (let i = 0; i < 17; i++) {
    const documents: Record<string, string> = {};
    for (let j = 0; j < 1024; j++) {
      const content = `${i}:${j}`;
      const hash = projectContentHash(content, sha256Hex);
      blobs[hash] = content;
      const key =
        j < 256
          ? `logic:${j}`
          : j < 512
            ? `view:${j - 256}`
            : j < 768
              ? `picture:${j - 512}`
              : `sound:${j - 768}`;
      documents[key] = hash;
    }
    const body = {
      parent: commits.at(-1)?.id ?? null,
      documents,
      changed: Object.keys(documents).sort(),
      label: "Edit",
      origin: "logic" as const,
      author: "creator" as const,
      time: i,
    };
    commits.push({ ...body, id: projectCommitId(body, sha256Hex) });
  }
  const result = pruneProjectHistory(
    { blobs, commits, cursor: commits.at(-1)!.id, future: [], tags: {} },
    sha256Hex,
  );
  assert.deepEqual(result.removed, [commits[0]!.id]);
  assert.equal(Object.keys(result.state.blobs).length, 16384);
  const retained = new Set(
    commits.slice(0, 16).flatMap((commit) => Object.values(commit.documents)),
  );
  const history = new ProjectHistory(sha256Hex, {
    blobs: Object.fromEntries(Object.entries(blobs).filter(([hash]) => retained.has(hash))),
    commits: commits.slice(0, 16),
    cursor: commits[15]!.id,
    future: [],
    tags: {},
  });
  history.record(
    Object.fromEntries(
      Object.entries(commits[16]!.documents).map(([key, hash]) => [key, blobs[hash!]!]),
    ),
    { label: "Edit", origin: "logic", author: "creator", time: 16 },
  );
  assert.equal(history.capture().commits.length, 16);
  assert.equal(history.capture().commits.at(-1)!.id, commits[16]!.id);
  assert.equal(Object.keys(history.capture().blobs).length, 16384);
});
