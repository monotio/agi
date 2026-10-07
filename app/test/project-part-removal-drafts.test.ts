import assert from "node:assert/strict";
import { test } from "node:test";
import {
  preparePartDraftRemoval,
  inspectPartDraftRemovals,
  openProjectDrafts,
} from "../src/project/projectPartDrafts.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { prepareProjectEdit } from "../../src/authoring/projectEdit.ts";
import { ProjectModel } from "../../src/authoring/projectModel.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { createContainer } from "../../src/container/container.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { createSoundDocument } from "../../src/sound/document.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
installIndexedDbFixture();
const profile = PROFILES["2.936"];
function project(extra: Record<string, string | Uint8Array> = {}) {
  const documents = {
    "logic:0": "new.room(1); return;",
    "logic:1": "assignn(v50,1);\nload.pic(v50);\ndraw.pic(v50);\nreturn;",
    "picture:1": "end\n",
    world: JSON.stringify({
      rooms: { "1": { title: "Home", description: "", exits: {} } },
      facts: {},
      quests: {},
    }),
    ...extra,
  };
  const build = compileProjectDocuments({
    documents,
    files: Object.fromEntries(createContainer().files),
    profileId: profile.id,
  });
  return new ProjectModel({ documents, build, digest: sha256Hex });
}
test("draft review lists each source line using a SOUND", () => {
  const model = project({
    "sound:1": createSoundDocument().encode(),
    "logic:2": "load.sound(1);\nreturn;\nsound(1,f10);\nload.sound(1);",
  });
  const review = preparePartDraftRemoval(model.capture(), "sound:1", profile);
  assert.deepEqual(review.messages, [
    "Used in LOGIC 2 line 1",
    "Used in LOGIC 2 line 3",
    "Used in LOGIC 2 line 4",
  ]);
});
test("a deleted SOUND marks every surviving use at its own operand", () => {
  const source = "load.sound(1);\nreturn;\nsound(1,f10);\nload.sound(1);";
  const model = project({
    "sound:1": createSoundDocument().encode(),
    "logic:2": source,
  });
  const prepared = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Delete sound", [{ key: "sound:1", content: null }]),
    profileId: profile.id,
    policy: {},
  });
  assert.equal(prepared.status, "diagnostics");
  const uses = prepared.diagnostics.filter(
    (entry) => entry.document === "logic:2" && entry.code === "removal-use",
  );
  assert.deepEqual(
    uses.map(({ start, end }) => ({ start, end })),
    [
      { start: 11, end: 12 },
      { start: 29, end: 30 },
      { start: 48, end: 49 },
    ],
  );
  assert.ok(uses.every((entry) => entry.severity === "error"));
  assert.ok(uses.every((entry) => source.slice(entry.start, entry.end) === "1"));
});
test("draft room deletion keeps incoming code and exits, prunes Launches, and Undo restores all", async () => {
  const world = JSON.stringify({
    rooms: {
      "1": { title: "Home", description: "", exits: {} },
      "2": { title: "Hall", description: "", exits: { door: 1 } },
    },
    facts: {},
    quests: {},
    launches: {
      "1": { entries: [{ id: "home", name: "Home" }] },
      "2": { entries: [{ id: "hall", name: "Hall", cameFrom: { room: 1, edge: 2 } }] },
    },
  });
  const model = project({ world });
  const before = model.capture();
  const plan = preparePartDraftRemoval(before, "logic:1", profile, 1);
  assert.deepEqual(
    plan.changes.map((change) => change.key),
    ["logic:1", "world"],
  );
  const next = JSON.parse(String(plan.changes[1]!.content));
  assert.equal(next.rooms["1"], undefined);
  assert.deepEqual(next.rooms["2"].exits, { door: 1 });
  assert.equal(next.launches["1"], undefined);
  assert.equal(next.launches["2"].entries[0].cameFrom, undefined);
  assert.deepEqual(before.documents(), model.capture().documents());
  const drafts = openProjectDrafts({
    projectId: "room-draft-delete",
    lifetime: "initial",
    read: (key) => before.read(key)?.content,
  });
  await drafts.ready;
  try {
    drafts.stageTransaction(plan.changes);
    assert.equal(drafts.undo(), true);
    assert.deepEqual(
      drafts.changes().map(({ key, content }) => [key, content]),
      [
        ["logic:1", before.read("logic:1")!.content],
        ["world", world],
      ],
    );
  } finally {
    drafts.dispose();
  }
});
test("deleting and replacing a PICTURE leaves the last build and code intact", () => {
  const model = project();
  const before = model.capture();
  const review = preparePartDraftRemoval(before, "picture:1", profile);
  assert.deepEqual(review.messages, ["Used in LOGIC 1 line 2", "Used in LOGIC 1 line 3"]);
  assert.equal(review.changes.length, 1);
  const deleted = { ...before.documents() };
  delete deleted["picture:1"];
  const snapshot = { ...before, documents: () => deleted };
  assert.ok(
    inspectPartDraftRemovals(snapshot, ["picture:1"], profile).some(
      (problem) => problem.document === "logic:1",
    ),
  );
  assert.deepEqual(
    inspectPartDraftRemovals(
      { ...snapshot, documents: () => ({ ...deleted, "picture:1": "end\n" }) },
      [],
      profile,
    ),
    [],
  );
  assert.deepEqual(before.documents(), model.capture().documents());
});
