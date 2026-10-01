import { buildView } from "../../src/view/view.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectModel } from "../../src/authoring/projectModel.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { prepareWorkspaceAction } from "../src/studio/workspace/workspaceGuided.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { emptyWorkspaceChanges } from "../src/studio/workspace/emptyWorkspace.ts";

test("guided room creation reads a detached snapshot and returns one coordinated change", () => {
  const documents = Object.fromEntries(
    emptyWorkspaceChanges("room").map((change) => [change.key, change.content!]),
  );
  const build = compileProjectDocuments({ files: {}, documents, profileId: "2.936" });
  const model = new ProjectModel({ documents, build, digest: sha256Hex });
  const snapshot = model.capture();
  const result = prepareWorkspaceAction(snapshot, "2.936", { kind: "add-room", title: "Garden" });
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.changes.some((change) => change.key === "logic:2"));
  assert.ok(result.changes.some((change) => change.key === "picture:2"));
  assert.ok(result.changes.some((change) => change.key === "world"));
  assert.equal(model.capture().revision, snapshot.revision);
  assert.deepEqual(model.capture().documents(), snapshot.documents());
  assert.equal(snapshot.read("logic:2"), undefined);
});

test("guided sound preset creates a cue and command playback in one detached change", () => {
  const starter = createStarterProject("starter");
  const documents = {
    ...Object.fromEntries(
      emptyWorkspaceChanges("room").map((change) => [change.key, change.content!]),
    ),
    "logic:1": starter.sources.logics.get(1)!,
    "view:0": buildView(starter.sources.views.get(0)!),
    "sound:1": JSON.stringify(starter.sources.sounds.get(1)),
    words: JSON.stringify([...starter.sources.words]),
    bindings: JSON.stringify(starter.bindings),
  };
  const build = compileProjectDocuments({ files: {}, documents, profileId: "2.936" });
  const model = new ProjectModel({ documents, build, digest: sha256Hex });
  const snapshot = model.capture();
  const result = prepareWorkspaceAction(snapshot, "2.936", {
    kind: "play-sound",
    room: 1,
    sound: 1,
    command: "help",
    preset: "discovery",
  });
  assert.ok(result.ok, JSON.stringify(result));
  const cue = result.changes.find((change) => change.key === "sound:2");
  assert.ok(cue?.content instanceof Uint8Array);
  assert.deepEqual([...cue.content.slice(8, 13)], [10, 0, 9, 135, 148]);
  assert.ok(result.changes.some((change) => change.key === "logic:1"));
  assert.equal(snapshot.read("sound:2"), undefined);
  assert.equal(model.capture().revision, snapshot.revision);
});
