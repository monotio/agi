import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../../src/container/container.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import { inspectEditableProject } from "../src/project/projectWorkspaceSource.ts";

function data(sources: Record<string, unknown>) {
  return {
    projectId: requireProjectId("source-review"),
    title: "Source review",
    authoredAt: "2026-01-01",
    files: { ...Object.fromEntries(createContainer().files), "WORDS.TOK": new Uint8Array(52) },
    words: [] as [string, number][],
    authoringState: { sources },
  };
}

test("an undefined legacy builder for an absent resource still requires source review", () => {
  const project = data({ views: [[4, undefined]] });
  const inspected = inspectEditableProject(project);
  assert.equal(inspected.requiresSourceReview, true);
  assert.ok(Object.keys(inspected.rejectedSources).length > 0);
  assert.equal(project.authoringState.sources["views"] instanceof Array, true);
});

test("multiple malformed legacy claims for the same resource are all retained for review", () => {
  const project = data({
    logics: [
      [4, 17],
      [4, 23],
    ],
  });
  const inspected = inspectEditableProject(project);
  assert.equal(inspected.requiresSourceReview, true);
  assert.deepEqual(Object.values(inspected.rejectedSources).sort(), ["17", "23"]);
});

test("legacy source lists exceeding the native resource count refuse before traversal", () => {
  const entries = Array.from({ length: 257 }, (_, index) => [index, "return;"]);
  assert.throws(() => inspectEditableProject(data({ logics: entries })), /limit|256|too many/i);
});

test("a refused text claim cannot overwrite a malformed claim for the same legacy resource", () => {
  for (const entries of [
    [
      [4, 17],
      [4, "return;"],
    ],
    [
      [4, "return;"],
      [4, 17],
    ],
  ]) {
    const inspected = inspectEditableProject(data({ logics: entries }));
    assert.equal(inspected.requiresSourceReview, true);
    assert.deepEqual(Object.values(inspected.rejectedSources).sort(), ["17", "return;"]);
  }
});
