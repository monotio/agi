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

for (const [document, content] of [
  ["words", '[["look",1],["bad☃",2]]'],
  ["inventory", '[{"name":"lamp","startingRoom":1},{"name":"coin","startingRoom":999}]'],
] as const) {
  test(`${document} diagnostics identify the entry to open`, () => {
    const model = setup();
    const result = prepareProjectEdit({
      model,
      proposal: model.propose(model.capture(), "Invalid entry", [{ key: document, content }]),
      profileId: "2.936",
      policy: {},
    });
    const finding = result.diagnostics.find((entry) => entry.document === document)!;
    assert.ok(finding);
    assert.equal(finding.row, 1);
  });
}

test("a room-plan removal problem locates the exit in its world document", () => {
  const model = setup();
  const world =
    '{"rooms":{"1":{"title":"Meadow","description":"","exits":{"north":253}}},"facts":{},"quests":{}}';
  const added = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Plan", [
      { key: "logic:253", content: "return;" },
      { key: "world", content: world },
    ]),
    profileId: "2.936",
    policy: {},
  });
  model.apply(added.application);
  const removed = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Remove", [{ key: "logic:253", content: null }]),
    profileId: "2.936",
    policy: {},
  });
  const finding = removed.diagnostics.find((entry) => entry.document === "world")!;
  assert.ok(finding);
  assert.equal(world.slice(finding.start, finding.end), "253");
});

for (const [document, content, message] of [
  [
    "tests",
    '{"format":"monotio.agi.tests.v1","tests":[{"name":"Visit","room":253,"steps":[],"expect":{}}]}',
    "still enters",
  ],
  [
    "tests",
    '{"format":"monotio.agi.tests.v1","tests":[{"name":"Visit","room":1,"steps":[],"expect":{"room":253}}]}',
    "still expects",
  ],
  [
    "tests",
    '{"format":"monotio.agi.tests.v1","tests":[{"name":"Visit","room":1,"steps":[{"action":"wait","ticks":1,"until":{"room":253}}],"expect":{}}]}',
    "still waits",
  ],
  ["references", '[{"id":"ref","kind":"room","target":253,"images":[]}]', "still targets"],
] as const) {
  test(`${document} removal navigation locates the field that ${message}`, () => {
    const model = setup();
    const added = prepareProjectEdit({
      model,
      proposal: model.propose(model.capture(), "Metadata", [
        { key: "logic:253", content: "return;" },
        {
          key: "tests",
          content: document === "tests" ? content : '{"format":"monotio.agi.tests.v1","tests":[]}',
        },
        { key: "references", content: document === "references" ? content : "[]" },
      ]),
      profileId: "2.936",
      policy: {},
    });
    assert.equal(added.status, "ready", JSON.stringify(added.diagnostics));
    model.apply(added.application);
    const removed = prepareProjectEdit({
      model,
      proposal: model.propose(model.capture(), "Remove", [{ key: "logic:253", content: null }]),
      profileId: "2.936",
      policy: {},
    });
    const finding = removed.diagnostics.find(
      (entry) => entry.document === document && entry.message.includes(message),
    )!;
    assert.ok(finding, JSON.stringify(removed.diagnostics));
    assert.equal(content.slice(finding.start, finding.end), "253");
  });
}

for (const [name, state, message] of [
  ["missing inventory", { items: { "253": 1 } }, "Inventory item 253 is missing from OBJECT."],
  [
    "transition-owned flag",
    { flags: { "5": true } },
    "Launch flags 5 is set by the room transition.",
  ],
] as const) {
  test(`Launch ${name} problems locate their entry`, () => {
    const model = setup();
    const content = JSON.stringify({
      rooms: {},
      facts: {},
      quests: {},
      launches: { "1": { entries: [{ id: "bad", name: "Bad", ...state }] } },
    });
    const result = prepareProjectEdit({
      model,
      proposal: model.propose(model.capture(), "Launch", [{ key: "world", content }]),
      profileId: "2.936",
      policy: { launch: { room: 1, id: "bad" } },
    });
    const finding = result.diagnostics.find(
      (entry) => entry.document === "world" && entry.message.includes(message),
    );
    assert.ok(finding, JSON.stringify(result.diagnostics));
    assert.equal(JSON.parse(content.slice(finding.start, finding.end)).id, "bad");
  });
}

for (const [name, source, operand, message] of [
  ["SOUND", "sound(s5, f180); return;", "s5", "SOUND 5 is absent."],
  ["SOUND zero", "sound(s0, f180); return;", "s0", "SOUND 0 is absent."],
  ["VIEW", "set.view(o0, 253); return;", "253", "VIEW 253 is absent."],
  ["LOGIC", "call(253); return;", "253", "LOGIC 253 is absent."],
  ["sealed room", "new.room(253); return;", "253", "LOGIC 253 is absent."],
  [
    "word group",
    "if (said(12345)) { return; } return;",
    "12345",
    "Word group 12345 has no dictionary entry.",
  ],
  ["inventory item", "get(i253); return;", "i253", "Inventory item 253 is absent."],
  ["operand bounds", "sound(256, f180); return;", "256", "byte value out of range"],
  ["message", "print(m0); return;", "m0", "message numbers are 1-based"],
  ["syntax", "sound(s5 f180); return;", "f180", "expected"],
  [
    "quoted word",
    'if (said("missingword")) { return; } return;',
    '"missingword"',
    "is not in the dictionary",
  ],
  ["object bounds", "animate.obj(o256); return;", "o256", "index out of range"],
  [
    "second said group",
    "if (said(1,12345)) { return; } return;",
    "12345",
    "Word group 12345 has no dictionary entry.",
  ],
] as const) {
  test(`project ${name} diagnostic retains its authored operand range`, () => {
    const model = setup();
    const content = `// authored origin\n${source}`;
    const result = prepareProjectEdit({
      model,
      proposal: model.propose(model.capture(), "Broken operand", [{ key: "logic:1", content }]),
      profileId: "2.936",
      policy: {},
    });
    const finding = result.diagnostics.find(
      (entry) => entry.document === "logic:1" && entry.message.includes(message),
    );
    assert.ok(finding, JSON.stringify(result.diagnostics));
    assert.equal(finding.severity, "error");
    assert.deepEqual(
      { start: finding.start, end: finding.end },
      {
        start: content.indexOf(operand),
        end: content.indexOf(operand) + operand.length,
      },
    );
  });
}

test("PICTURE removal diagnostics locate the computed operand", () => {
  const model = setup();
  const source = "v20=253; draw.pic(v20); return;";
  const added = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Picture", [
      { key: "logic:1", content: source },
      { key: "picture:253", content: "end\n" },
    ]),
    profileId: "2.936",
    policy: {},
  });
  assert.equal(added.status, "ready");
  model.apply(added.application);
  const removed = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Remove picture", [
      { key: "picture:253", content: null },
    ]),
    profileId: "2.936",
    policy: {},
  });
  const finding = removed.diagnostics.find(
    (entry) => entry.document === "logic:1" && entry.code === "removal-use",
  )!;
  assert.ok(finding);
  assert.equal(source.slice(finding.start, finding.end), "v20");
});

test("source diagnostics use the compiler's canonical WORDS dictionary", () => {
  const model = setup();
  const result = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Words", [
      { key: "words", content: '[["LOOK",100]]' },
      { key: "logic:1", content: 'if (said("look")) { return; } return;' },
    ]),
    profileId: "2.936",
    policy: {},
  });
  assert.equal(result.status, "ready", JSON.stringify(result.diagnostics));
});

test("project Problems retain system-name shadow warnings at the authored use", () => {
  const model = setup();
  const source = "current_room=1; return;";
  const result = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Names", [
      { key: "bindings", content: '{"current_room":{"kind":"variable","num":20}}' },
      { key: "logic:1", content: source },
    ]),
    profileId: "2.936",
    policy: {},
  });
  const warning = result.diagnostics.find(
    (entry) => entry.document === "logic:1" && entry.message.includes("shadows built-in"),
  )!;
  assert.ok(warning, JSON.stringify(result.diagnostics));
  assert.equal(warning.severity, "warning");
  assert.equal(source.slice(warning.start, warning.end), "current_room");
});

test("computed room jumps require a scoped review; literal uses and plans still refuse", () => {
  const model = setup();
  const add = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Room", [
      { key: "logic:0", content: "return;" },
      { key: "logic:99", content: 'get.num("Room",v20);new.room.v(v20);return;' },
      { key: "logic:254", content: "return;" },
      { key: "tests", content: '{"format":"monotio.agi.tests.v1","tests":[]}' },
      { key: "references", content: "[]" },
    ]),
    profileId: "2.936",
    policy: {},
  });
  assert.equal(add.status, "ready");
  model.apply(add.application);
  const proposal = model.propose(model.capture(), "Remove", [{ key: "logic:254", content: null }]);
  const blocked = prepareProjectEdit({ model, proposal, profileId: "2.936", policy: {} });
  assert.equal(blocked.status, "diagnostics");
  assert.ok(
    blocked.diagnostics.some((d) => d.code === "computed-room-jump" && d.document === "logic:99"),
  );
  const jump = blocked.diagnostics.find(
    (d) => d.code === "computed-room-jump" && d.document === "logic:99",
  )!;
  assert.equal('get.num("Room",v20);new.room.v(v20);return;'.slice(jump.start, jump.end), "v20");
  const approved = prepareProjectEdit({
    model,
    proposal,
    profileId: "2.936",
    policy: { reviewedComputedRoomJumps: ["logic:254"] },
  });
  assert.equal(approved.status, "ready");
  assert.equal(
    prepareProjectEdit({
      model,
      proposal,
      profileId: "2.936",
      policy: { reviewedComputedRoomJumps: ["logic:253"] },
    }).status,
    "diagnostics",
  );
  for (const [key, content] of [
    ["logic:99", "new.room(254);return;"],
    ["logic:99", "call.v(v20);return;"],
    ["bindings", '{"garden":{"kind":"logic","num":254}}'],
    [
      "world",
      '{"rooms":{"254":{"title":"Garden","description":"","exits":{}}},"facts":{},"quests":{}}',
    ],
  ]) {
    const hard = model.propose(model.capture(), "Remove", [
      { key: "logic:254", content: null },
      { key: key!, content: content! },
    ]);
    const refused = prepareProjectEdit({
      model,
      proposal: hard,
      profileId: "2.936",
      policy: { reviewedComputedRoomJumps: ["logic:254"] },
    });
    assert.equal(refused.status, "diagnostics");
    assert.ok(refused.diagnostics.some((d) => d.severity === "error"));
  }
});
test("a remapped binding preserves an open draft's original room reference", () => {
  const model = setup();
  const add = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Rooms", [
      { key: "logic:0", content: "return;" },
      { key: "logic:1", content: "return;" },
      { key: "logic:254", content: "return;" },
      { key: "bindings", content: '{"garden":{"kind":"logic","num":254}}' },
      { key: "tests", content: '{"format":"monotio.agi.tests.v1","tests":[]}' },
      { key: "references", content: "[]" },
    ]),
    profileId: "2.936",
    policy: {},
  });
  assert.equal(add.status, "ready");
  model.apply(add.application);
  const remove = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Remap", [
      { key: "logic:254", content: null },
      { key: "bindings", content: '{"garden":{"kind":"logic","num":1}}' },
    ]),
    drafts: [{ key: "logic:99", content: "new.room(garden);return;" }],
    profileId: "2.936",
    policy: { reviewedComputedRoomJumps: ["logic:254"] },
  });
  assert.equal(remove.status, "diagnostics");
  assert.ok(
    remove.diagnostics.some((d) => d.document === "logic:99" && /logic:254/.test(d.message)),
  );
  const draft = remove.diagnostics.find((d) => d.document === "logic:99")!;
  assert.equal("new.room(garden);return;".slice(draft.start, draft.end), "garden");
});

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

test("future rooms and computed dispatch stay out of Problems, with literal calls still checked", () => {
  const model = setup();
  const proposal = model.propose(model.capture(), "Room exit", [
    { key: "logic:0", content: "new.room(3); new.room.v(v0); load.pic(v50); return;" },
  ]);
  const on = prepareProjectEdit({
    model,
    proposal,
    profileId: "2.936",
    policy: { allowMissingRooms: true },
  });
  assert.equal(on.status, "ready");
  assert.deepEqual(on.diagnostics, []);
  const off = prepareProjectEdit({ model, proposal, profileId: "2.936", policy: {} });
  assert.equal(off.status, "diagnostics");
  assert.deepEqual(
    off.diagnostics.map(({ message, severity }) => ({ message, severity })),
    [{ message: "LOGIC 3 is absent.", severity: "error" }],
  );
  const call = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Shared code", [
      { key: "logic:0", content: "call(3); return;" },
    ]),
    profileId: "2.936",
    policy: { allowMissingRooms: true },
  });
  assert.equal(call.status, "diagnostics");
});

test("room removal prepares one candidate including Launch pruning and Undo restores the exact world", async () => {
  const { ProjectHistory } = await import("../src/authoring/projectHistory.ts");
  const { createContainer } = await import("../src/container/container.ts");
  const world = JSON.stringify(
    {
      rooms: {},
      facts: {},
      quests: {},
      launches: {
        "2": { selected: "cart", entries: [{ id: "cart", name: "At the cart" }] },
        "1": {
          entries: [
            { id: "path", name: "Path", cameFrom: { room: 2 }, items: { "0": 2, "1": 255 } },
          ],
        },
      },
    },
    null,
    2,
  );
  const documents = { "logic:0": "return;", "logic:1": "return;", "logic:2": "return;", world };
  const build = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const model = new ProjectModel({ documents, build, digest: sha256Hex });
  const history = new ProjectHistory(sha256Hex);
  const metadata = {
    label: "Before",
    origin: "logic" as const,
    author: "creator" as const,
    time: 1,
  };
  history.record(documents, metadata);
  const before = model.capture();
  const worldDraft = {
    ...JSON.parse(world),
    rooms: { "2": { title: "Cart", description: "", exits: {} } },
  };
  const blocked = prepareProjectEdit({
    model,
    proposal: model.propose(before, "Remove room", [{ key: "logic:2", content: null }]),
    profileId: "2.936",
    policy: {},
    drafts: [{ key: "world", content: JSON.stringify(worldDraft) }],
  });
  assert.equal(
    blocked.status,
    "diagnostics",
    "the automatic Launch edit keeps unselected room-plan drafts in the removal review",
  );
  assert.ok(
    blocked.diagnostics.some((d) => d.document === "world" && /planned room/.test(d.message)),
  );
  const plannedRoom = blocked.diagnostics.find(
    (d) => d.document === "world" && /planned room/.test(d.message),
  )!;
  assert.deepEqual(
    JSON.parse(JSON.stringify(worldDraft).slice(plannedRoom.start, plannedRoom.end)),
    worldDraft.rooms["2"],
  );
  const prepared = prepareProjectEdit({
    model,
    proposal: model.propose(before, "Remove room", [{ key: "logic:2", content: null }]),
    profileId: "2.936",
    policy: {},
  });
  assert.equal(prepared.status, "ready", JSON.stringify(prepared.diagnostics));
  assert.deepEqual(
    prepared.proposal.changes().map((c) => c.key),
    ["logic:2", "world"],
  );
  assert.equal(model.capture(), before, "preparation stays detached");
  const after = model.apply(prepared.application);
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(JSON.parse(String(after.read("world")!.content)).launches, {
    "1": { entries: [{ id: "path", name: "Path", items: { "1": 255 } }] },
  });
  assert.equal(prepared.compiled!.documents()["world"], after.read("world")!.content);
  history.record(after.documents(), { ...metadata, label: "Remove room", time: 2 });
  const action = history.undo(model)!;
  const undo = prepareProjectEdit({
    model,
    proposal: action.proposal,
    profileId: "2.936",
    policy: {},
  });
  assert.equal(undo.status, "ready");
  model.apply(undo.application);
  history.accept(action);
  assert.deepEqual(model.capture().documents(), documents);
});

test("removing a room saved as invalid source prunes its Launches before the next build", () => {
  const project = createStarterProject("blank");
  const files = Object.fromEntries(project.files());
  const documents = {
    "logic:0": "return;",
    world: JSON.stringify({ rooms: {}, facts: {}, quests: {} }),
  };
  const build = compileProjectDocuments({ files, documents, profileId: "2.936" });
  const model = new ProjectModel({ documents, build, digest: sha256Hex });
  const typing = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Unfinished room", [
      { key: "logic:2", content: "if (" },
      {
        key: "world",
        content: JSON.stringify({
          rooms: {},
          facts: {},
          quests: {},
          launches: { "2": { entries: [{ id: "cart", name: "At the cart" }] } },
        }),
      },
    ]),
    profileId: "2.936",
    policy: {},
  });
  assert.equal(typing.status, "diagnostics");
  model.apply(typing.application);
  const before = model.capture();
  const malformed = prepareProjectEdit({
    model,
    proposal: model.propose(before, "Remove", [
      { key: "logic:2", content: null },
      { key: "world", content: "{" },
    ]),
    profileId: "2.936",
    policy: {},
  });
  const removed = prepareProjectEdit({
    model,
    proposal: model.propose(before, "Remove", [{ key: "logic:2", content: null }]),
    profileId: "2.936",
    policy: {},
  });
  assert.equal(removed.status, "ready");
  assert.equal(JSON.parse(String(removed.proposal.documents()["world"])).launches, undefined);
  assert.ok(malformed.diagnostics.some((d) => d.document === "world" && d.severity === "error"));
});
