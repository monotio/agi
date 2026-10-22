import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createWorkspaceHistorySummary } from "../src/studio/workspace/workspaceHistorySummary.ts";

test("draft status changes reuse Undo and Redo without reading the commit list", () => {
  let reads = 0;
  const summary = createWorkspaceHistorySummary();
  const commits = [
    { id: "first", parent: null },
    { id: "second", parent: "first" },
  ];
  summary.update({
    get commits() {
      reads++;
      return commits;
    },
    cursor: "second",
    future: [],
  });
  reads = 0;
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(summary.read({ canUndo: false, canRedo: false }), {
      canUndo: true,
      canRedo: false,
    });
    assert.deepEqual(summary.read({ canUndo: true, canRedo: false }), {
      canUndo: true,
      canRedo: false,
    });
  }
  assert.equal(reads, 0);
  // Keep the workspace subscription on the summary path: a session capture copies history blobs.
  const source = readFileSync(
    new URL("../src/studio/workspace/CreateWorkspace.vue", import.meta.url),
    "utf8",
  );
  const body = source.slice(
    source.indexOf("function draftChanged("),
    source.indexOf("const writes ="),
  );
  assert.ok(!body.includes("session.capture()"));
});

test("pruned parents disable Undo and draft edits hide committed Redo", () => {
  const summary = createWorkspaceHistorySummary();
  summary.update({
    commits: [{ id: "current", parent: "pruned" }],
    cursor: "current",
    future: ["next"],
  });
  assert.deepEqual(summary.read({ canUndo: false, canRedo: false }), {
    canUndo: false,
    canRedo: true,
  });
  assert.deepEqual(summary.read({ canUndo: true, canRedo: false }), {
    canUndo: true,
    canRedo: false,
  });
  assert.deepEqual(summary.read({ canUndo: true, canRedo: true }), {
    canUndo: true,
    canRedo: true,
  });
  summary.update(undefined);
  assert.deepEqual(summary.read({ canUndo: false, canRedo: false }), {
    canUndo: false,
    canRedo: false,
  });
});
