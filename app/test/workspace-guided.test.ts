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
import { prepareProjectEdit } from "../../src/authoring/projectEdit.ts";
import { ProjectHistory } from "../../src/authoring/projectHistory.ts";
import { openContainer } from "../../src/container/container.ts";

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

for (const key of ["picture:9", "view:9"]) {
  test(`Make it a room, Undo and Make it a room again rebuild native resources for ${key}`, () => {
    const model = starterModel();
    const art = key.startsWith("picture:")
      ? "vis 5\nfill 0,0\nend\n"
      : model.capture().read("view:0")!.content;
    const added = prepareProjectEdit({
      model,
      proposal: model.propose(model.capture(), "Add art", [{ key, content: art }]),
      profileId: "2.936",
      policy: {},
    });
    assert.equal(added.status, "ready");
    model.apply(added.application);
    const history = new ProjectHistory(sha256Hex);
    history.record(model.capture().documents(), {
      label: "Art",
      origin: "template",
      author: "creator",
      time: 0,
    });
    const makeRoom = () => {
      const prepared = prepareWorkspaceAction(model.capture(), "2.936", { kind: "make-room", key });
      assert.ok(prepared.ok, JSON.stringify(prepared));
      const edit = prepareProjectEdit({
        model,
        proposal: model.propose(model.capture(), prepared.label, prepared.changes),
        profileId: "2.936",
        policy: {},
      });
      assert.equal(edit.status, "ready", JSON.stringify(edit.diagnostics));
      model.apply(edit.application);
      return prepared.changes.find(({ key }) => key.startsWith("logic:"))!.key;
    };
    const logicKey = makeRoom();
    const room = Number(logicKey.slice(6));
    assert.ok(
      openContainer(model.capture().lastAdmissibleBuild!.files()).getResource("logic", room),
    );
    history.record(model.capture().documents(), {
      label: "Make it a room",
      origin: "guided",
      author: "creator",
      time: 1,
    });
    const undo = history.undo(model)!;
    const reverted = prepareProjectEdit({
      model,
      proposal: undo.proposal,
      profileId: "2.936",
      policy: {},
    });
    model.apply(reverted.application);
    history.accept(undo);
    assert.equal(model.capture().read(logicKey), undefined);
    assert.equal(
      openContainer(model.capture().lastAdmissibleBuild!.files()).getResource("logic", room),
      null,
      JSON.stringify(reverted.diagnostics),
    );
    assert.equal(makeRoom(), logicKey);
    assert.ok(
      openContainer(model.capture().lastAdmissibleBuild!.files()).getResource("logic", room),
    );
  });
}

test("making an unused picture a room keeps the art and returns one coordinated change", () => {
  const snapshot = starterModel().capture();
  const result = prepareWorkspaceAction(snapshot, "2.936", { kind: "make-room", key: "picture:1" });
  assert.ok(result.ok, JSON.stringify(result));
  const logic = result.changes.find((change) => change.key.startsWith("logic:"))!;
  assert.match(logic.content as string, /assignn\([^,]+, 1\)/);
  assert.equal(
    result.changes.some((change) => change.key.startsWith("picture:")),
    false,
  );
  assert.ok(result.changes.some((change) => change.key === "world"));
  const built = compileProjectDocuments({
    files: Object.fromEntries(snapshot.lastAdmissibleBuild!.files()),
    documents: {
      ...snapshot.documents(),
      ...Object.fromEntries(result.changes.map((c) => [c.key, c.content!])),
    },
    profileId: "2.936",
  });
  assert.ok(built.files().size > 0);
});

test("making an unused view a room creates a picture and places that view", () => {
  const snapshot = starterModel().capture();
  const result = prepareWorkspaceAction(snapshot, "2.936", { kind: "make-room", key: "view:0" });
  assert.ok(result.ok, JSON.stringify(result));
  const logic = result.changes.find((change) => change.key.startsWith("logic:"))!;
  assert.match(logic.content as string, /set\.view\(o0, 0\)/);
  assert.ok(result.changes.some((change) => change.key.startsWith("picture:")));
});

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
  const documents: Record<string, string | Uint8Array> = {
    words: JSON.stringify([...starter.sources.words]),
    inventory: JSON.stringify(starter.sources.objects),
    bindings: JSON.stringify(starter.bindings),
    world: JSON.stringify({ rooms: {}, facts: {}, quests: {} }),
  };
  for (const [num, source] of starter.sources.logics) documents[`logic:${num}`] = source;
  for (const [num, source] of starter.sources.pictures) documents[`picture:${num}`] = source;
  for (const [num, source] of starter.sources.sounds)
    documents[`sound:${num}`] = JSON.stringify(source);
  documents["view:0"] = buildView(starter.sources.views.get(0)!);
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
