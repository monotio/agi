import { buildView } from "../../src/view/view.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectModel } from "../../src/authoring/projectModel.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { prepareWorkspaceAction } from "../src/studio/workspace/workspaceGuided.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { emptyWorkspaceChanges } from "../src/studio/workspace/emptyWorkspace.ts";
import { readProjectDocuments } from "../../src/authoring/projectDocuments.ts";

function starterModel(): ProjectModel {
  const starter = createStarterProject("starter");
  const files = Object.fromEntries(starter.files());
  const sources = Object.fromEntries(
    [...starter.sources.logics].map(([id, text]) => [`logic:${id}`, text]),
  );
  const { documents } = readProjectDocuments({
    files,
    sources,
    bindings: starter.bindings,
    profileId: starter.profileId,
  });
  return new ProjectModel({
    documents,
    build: compileProjectDocuments({ files, documents, profileId: starter.profileId }),
    digest: sha256Hex,
  });
}

test("teach a new thing and its full sentence reply together, with explicit same meanings", () => {
  const model = starterModel();
  for (const sameAs of [undefined, 101]) {
    const snapshot = model.capture();
    const result = prepareWorkspaceAction(snapshot, "2.936", {
      kind: "response",
      room: 1,
      command: "look at sun",
      response: "The sun shines.",
      teach: { word: "sun", ...(sameAs === undefined ? {} : { sameAs }) },
      alsoCommands: ["inspect sun"],
    });
    assert.ok(result.ok, JSON.stringify(result));
    const words = JSON.parse(
      result.changes.find((change) => change.key === "words")!.content as string,
    ) as [string, number][];
    const sun = words.find(([word]) => word === "sun")![1];
    assert.equal(sameAs === undefined ? sun !== 100 && sun !== 101 : sun === sameAs, true);
    const logic = result.changes.find((change) => change.key === "logic:1")!.content as string;
    assert.match(logic, /said\("look", "sun"\)/);
    assert.match(logic, /said\("inspect", "sun"\)/);
    assert.match(logic, /print\("The sun shines\."\)/);
    assert.equal(snapshot.read("logic:1")!.content, model.capture().read("logic:1")!.content);
  }
});

test("a sound can answer a new whole sentence and teach its words in the same change", () => {
  const snapshot = starterModel().capture();
  const result = prepareWorkspaceAction(snapshot, "2.936", {
    kind: "play-sound",
    room: 1,
    command: "ring the bell",
    sound: 1,
    preset: "discovery",
  });
  assert.ok(result.ok, JSON.stringify(result));
  const logic = result.changes.find((change) => change.key === "logic:1")!.content as string;
  assert.match(logic, /said\("ring", "bell"\)/);
  assert.match(logic, /load\.sound\(2\)/);
  assert.ok(result.changes.some((change) => change.key === "sound:2"));
  assert.ok(result.changes.some((change) => change.key === "words"));
  assert.ok(result.showCode.some((preview) => preview.text.includes('said("ring", "bell")')));
});

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
  // E5: round((3,579,545 / 32) / 659.2551138) = 170 = 0x0aa.
  assert.deepEqual([...cue.content.slice(8, 13)], [10, 0, 10, 138, 148]);
  assert.ok(result.changes.some((change) => change.key === "logic:1"));
  assert.equal(snapshot.read("sound:2"), undefined);
  assert.equal(model.capture().revision, snapshot.revision);
});
