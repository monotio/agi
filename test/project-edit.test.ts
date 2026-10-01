import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/crypto.ts";
import { ProjectModel } from "../src/authoring/projectModel.ts";
import { prepareProjectEdit } from "../src/authoring/projectEdit.ts";
import {
  compileProjectDocuments,
  readProjectDocuments,
} from "../src/authoring/projectDocuments.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import { containerFromResources, openContainer } from "../src/container/container.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { buildWordsTok, parseWordsTok } from "../src/logic/words.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { PROFILES } from "../src/runtime/profile.ts";

function setup() {
  const project = createStarterProject("blank");
  const files = Object.fromEntries(project.files());
  const documents = readProjectDocuments({ files, profileId: "2.936" }).documents;
  const build = compileProjectDocuments({ files, documents, profileId: "2.936" });
  return new ProjectModel({
    documents: { ...documents, tests: "[]", references: Uint8Array.of(9, 8) },
    digest: sha256Hex,
    build,
  });
}

test("invalid current source survives while the last admissible image stays fixed", () => {
  const model = setup();
  const before = model.capture();
  const proposal = model.propose(before, "Type", [{ key: "logic:1", content: "if (broken" }]);
  const edit = prepareProjectEdit({ model, proposal, profileId: "2.936", policy: {} });
  assert.equal(edit.status, "diagnostics");
  assert.equal(edit.compiled, undefined);
  assert.ok(edit.diagnostics.some(({ document }) => document === "logic:1"));
  model.apply(edit.application);
  assert.equal(model.capture().read("logic:1")?.content, "if (broken");
  assert.equal(
    model.capture().lastAdmissibleBuild?.identity.buildId,
    before.lastAdmissibleBuild?.identity.buildId,
  );
  assert.notEqual(model.capture().documentId, before.documentId);
  const repaired = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Repair", [{ key: "logic:1", content: "return;" }]),
    profileId: "2.936",
    policy: {},
  });
  assert.equal(repaired.status, "ready");
  model.apply(repaired.application);
  assert.equal(model.capture().lastAdmissibleBuild?.documentId, model.capture().documentId);
});

test("a complete coordinated LOGIC, WORDS, bindings and OBJECT edit preserves metadata", () => {
  const model = setup();
  const proposal = model.propose(model.capture(), "Add lamp", [
    { key: "logic:1", content: 'if (said("lamp")) { get(0); } load.view(hero); return;' },
    { key: "words", content: '[["lamp",200]]' },
    { key: "inventory", content: '[{"name":"lamp","startingRoom":1}]' },
    { key: "bindings", content: '{"hero":{"kind":"view","num":2}}' },
    {
      key: "view:2",
      content: '{"loops":[{"cels":[{"width":1,"height":1,"transparentColor":0,"pixels":[1]}]}]}',
    },
  ]);
  const before = model.capture();
  const edit = prepareProjectEdit({ model, proposal, profileId: "2.936", policy: {} });
  assert.equal(edit.status, "ready", JSON.stringify(edit.diagnostics));
  assert.deepEqual(model.capture().documents(), before.documents());
  assert.equal(edit.compiled!.documents()["tests"], "[]");
  assert.deepEqual(edit.compiled!.documents()["references"], Uint8Array.of(9, 8));
  assert.equal(parseWordsTok(edit.compiled!.files().get("WORDS.TOK")!)[0]?.id, 200);
  assert.ok(edit.dependencies["logic:1"]?.includes("inventory"));
  assert.ok(edit.dependencies["logic:1"]?.includes("words"));
  model.apply(edit.application);
  assert.ok(openContainer(model.capture().lastAdmissibleBuild!.files()).getResource("view", 2));
});

test("opaque pre-existing reference damage warns; newly broken references block the image", () => {
  const profile = PROFILES["2.936"];
  const opaque = buildLogicResource(Uint8Array.of(0xc8, 0), []);
  const valid = compileProjectLogic("load.view(8); return;", {
    profile,
    dictionary: new Map(),
    bindings: {},
  }).assembly.payload;
  const container = containerFromResources({
    logic: new Map([
      [0, valid],
      [7, opaque],
    ]),
    picture: new Map([[1, Uint8Array.of(0xff)]]),
  });
  container.putFile("WORDS.TOK", buildWordsTok([]));
  const files = Object.fromEntries(container.files);
  const documents = readProjectDocuments({ files, profileId: "2.936" }).documents;
  const model = new ProjectModel({
    documents,
    digest: sha256Hex,
    build: compileProjectDocuments({ files, documents, profileId: "2.936" }),
  });
  const edit = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Paint", [
      { key: "picture:1", content: "vis 4\nfill 1,1\nend\n" },
    ]),
    profileId: "2.936",
    policy: {},
  });
  assert.equal(edit.status, "ready", JSON.stringify(edit.diagnostics));
  assert.ok(
    edit.diagnostics.some(({ severity, preExisting }) => severity === "warning" && preExisting),
  );
  const broken = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "New use", [
      { key: "logic:0", content: "load.view(9); return;" },
    ]),
    profileId: "2.936",
    policy: {},
  });
  assert.equal(broken.status, "diagnostics");
  assert.equal(broken.compiled, undefined);
  assert.ok(
    broken.diagnostics.some(({ severity, preExisting }) => severity === "error" && !preExisting),
  );
});

test("unchanged opaque WORDS bytes survive a picture edit; changed malformed WORDS block", () => {
  const container = containerFromResources({ picture: new Map([[1, Uint8Array.of(0xff)]]) });
  container.putFile("WORDS.TOK", Uint8Array.of(1));
  const files = Object.fromEntries(container.files);
  const documents = readProjectDocuments({ files, profileId: "2.936" }).documents;
  const build = compileProjectDocuments({ files, documents, profileId: "2.936" });
  const model = new ProjectModel({ documents, digest: sha256Hex, build });
  const edit = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Paint", [
      { key: "picture:1", content: "vis 2\nfill 1,1\nend\n" },
    ]),
    profileId: "2.936",
    policy: {},
  });
  assert.equal(edit.status, "ready", JSON.stringify(edit.diagnostics));
  assert.deepEqual(edit.compiled!.files().get("WORDS.TOK"), Uint8Array.of(1));
  assert.ok(
    edit.diagnostics.some(({ document, preExisting }) => document === "words" && preExisting),
  );
  const broken = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Words", [
      { key: "words", content: Uint8Array.of(2) },
    ]),
    profileId: "2.936",
    policy: {},
  });
  assert.equal(broken.status, "diagnostics");
});

test("preparation refuses foreign or stale proposals, and applies only the issued image", () => {
  const model = setup();
  const foreign = setup();
  const proposal = model.propose(model.capture(), "Room", [{ key: "logic:1", content: "return;" }]);
  assert.throws(
    () => prepareProjectEdit({ model: foreign, proposal, profileId: "2.936", policy: {} }),
    /issued/,
  );
  const edit = prepareProjectEdit({ model, proposal, profileId: "2.936", policy: {} });
  assert.throws(() => model.issueApplication(proposal, { ...edit.compiled! }), /compiled|issued/);
  const image = edit.compiled!.files();
  image.get("VOL.0")!.fill(0);
  model.apply(edit.application);
  assert.ok(openContainer(model.capture().lastAdmissibleBuild!.files()).getResource("logic", 1));
  assert.throws(
    () => prepareProjectEdit({ model, proposal, profileId: "2.936", policy: {} }),
    /stale/,
  );
});

test("coordinated resource deletion checks surviving metadata and references", () => {
  const model = setup();
  const add = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Room", [
      { key: "logic:0", content: "return;" },
      { key: "tests", content: '{"format":"monotio.agi.tests.v1","tests":[]}' },
      { key: "references", content: "[]" },
      { key: "logic:2", content: "return;" },
      { key: "logic:1", content: "call(2); return;" },
    ]),
    profileId: "2.936",
    policy: {},
  });
  assert.equal(add.status, "ready");
  model.apply(add.application);
  const remove = (changes: Parameters<ProjectModel["propose"]>[2]) =>
    prepareProjectEdit({
      model,
      proposal: model.propose(model.capture(), "Remove", changes),
      profileId: "2.936",
      policy: {},
    });
  assert.equal(remove([{ key: "logic:2", content: null }]).status, "diagnostics");
  assert.equal(
    remove([
      { key: "logic:2", content: null },
      { key: "logic:1", content: "return;" },
    ]).status,
    "ready",
  );
  const metadata = remove([
    { key: "logic:2", content: null },
    { key: "logic:1", content: "return;" },
    {
      key: "world",
      content:
        '{"rooms":{"2":{"title":"Room","description":"","exits":{}}},"facts":{},"quests":{}}',
    },
  ]);
  assert.equal(metadata.status, "diagnostics");
  assert.ok(metadata.diagnostics.some(({ document }) => document === "world"));
});
