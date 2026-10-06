import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspacePending } from "../src/studio/workspace/workspacePending.ts";
import { ProjectModel } from "../../src/authoring/projectModel.ts";
import { sha256Hex } from "../../src/crypto.ts";

test("typing rechecks only its part while another draft's metadata waits", () => {
  const model = new ProjectModel({
    documents: { notes: "original", world: "large metadata" },
    digest: sha256Hex,
  });
  const owned = model.capture();
  const reads: string[] = [];
  const snapshot = {
    ...owned,
    read(key: string) {
      reads.push(key);
      return owned.read(key);
    },
  };
  const derived: string[] = [];
  const pending = createWorkspacePending((change) => {
    derived.push(change.key);
    return [change.key];
  });
  const metadata = { key: "world", content: "changed metadata" };
  const first = pending.changes(snapshot, [metadata, { key: "notes", content: "first" }]);
  assert.deepEqual(pending.parts(snapshot, first), ["world", "notes"]);
  reads.length = derived.length = 0;
  const second = pending.changes(snapshot, [metadata, { key: "notes", content: "second" }]);
  assert.deepEqual(pending.parts(snapshot, second), ["world", "notes"]);
  assert.deepEqual(reads, ["notes"]);
  assert.deepEqual(derived, ["notes"]);
});

test("accepting a different snapshot invalidates pending comparisons and part counts", () => {
  const first = new ProjectModel({ documents: { notes: "original" }, digest: sha256Hex }).capture();
  const accepted = new ProjectModel({ documents: { notes: "draft" }, digest: sha256Hex }).capture();
  const pending = createWorkspacePending((change) => [change.key]);
  const changes = [{ key: "notes", content: "draft" }];
  assert.equal(pending.changes(first, changes).length, 1);
  assert.deepEqual(pending.changes(accepted, changes), []);
  assert.deepEqual(pending.parts(accepted, []), []);
});

test("metadata belonging to an edited resource counts as one part", () => {
  const base = new ProjectModel({ documents: {}, digest: sha256Hex }).capture();
  const pending = createWorkspacePending((change) => (change.key === "music" ? [] : [change.key]));
  assert.deepEqual(
    pending.parts(base, [
      { key: "sound:1", content: "notes" },
      { key: "music", content: "tempo" },
    ]),
    ["sound:1"],
  );
  assert.deepEqual(pending.parts(base, [{ key: "music", content: "tempo" }]), ["music"]);
});
