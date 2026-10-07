import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareProjectRenumber } from "../src/authoring/projectRenumber.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
const profile = PROFILES["2.936"];
const input = {
  "logic:0": "new.room(2); call(2); load.logics(2); return;\n",
  "logic:2": "if (equaln(v1, 2)) { new.room(1); } return;\n",
  "logic:1": "return;\n",
  "logic:3": "new.room(hall); call(hall); return;\n",
  bindings: JSON.stringify({
    hall: { kind: "logic", num: 2 },
    greeting: { kind: "message", num: 1, logic: 2 },
  }),
  world: JSON.stringify({
    rooms: {
      "1": { title: "Garden", description: "", exits: { door: 2 } },
      "2": { title: "", description: "Hall", exits: { back: 1 } },
    },
    facts: {},
    quests: {},
    launches: {
      "2": { entries: [{ id: "door", name: "Door", cameFrom: { room: 2 }, items: { "0": 2 } }] },
    },
  }),
  tests: JSON.stringify({
    format: "monotio.agi.tests.v2",
    tests: [{ name: "Door", room: 2, steps: [{ until: { room: 2 } }], expect: { room: 2 } }],
  }),
  references: JSON.stringify([{ id: "art", kind: "room", target: 2, brief: "Room 2", images: [] }]),
};
test("a room and every typed reference move in one complete change set", () => {
  const before = structuredClone(input);
  const result = prepareProjectRenumber({ documents: input, key: "logic:2", number: 7, profile });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.computed, []);
  assert.equal(result.documents["logic:2"], undefined);
  assert.equal(result.documents["logic:7"], "if (equaln(v1, 7)) { new.room(1); } return;\n");
  assert.equal(result.documents["logic:0"], "new.room(7); call(7); load.logics(7); return;\n");
  assert.deepEqual(
    compileProjectLogic(String(result.documents["logic:0"]), {
      profile,
      dictionary: new Map(),
      bindings: {},
    }).assembly.code,
    new Uint8Array([18, 7, 22, 7, 20, 7, 0]),
  );
  assert.deepEqual(JSON.parse(String(result.documents["bindings"])), {
    hall: { kind: "logic", num: 7 },
    greeting: { kind: "message", num: 1, logic: 7 },
  });
  assert.equal(result.documents["logic:3"], input["logic:3"]);
  assert.deepEqual(
    compileProjectLogic(String(result.documents["logic:3"]), {
      profile,
      dictionary: new Map(),
      bindings: JSON.parse(String(result.documents["bindings"])),
    }).assembly.code,
    new Uint8Array([18, 7, 22, 7, 0]),
  );
  const world = JSON.parse(String(result.documents["world"]));
  assert.equal(world.rooms["2"], undefined);
  assert.equal(world.rooms["7"].title, "");
  assert.equal(world.rooms["1"].exits.door, 7);
  assert.equal(world.launches["7"].entries[0].cameFrom.room, 7);
  assert.equal(world.launches["7"].entries[0].items["0"], 7);
  const tests = JSON.parse(String(result.documents["tests"])).tests;
  assert.deepEqual(tests, [
    { name: "Door", room: 7, steps: [{ until: { room: 7 } }], expect: { room: 7 } },
  ]);
  assert.equal(JSON.parse(String(result.documents["references"]))[0].target, 7);
  assert.deepEqual(input, before);
});
test("literal operands and proven variable feeds move; unrelated values and text stay", () => {
  const documents = {
    "picture:2": "end\n",
    "view:2": new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 1, 1, 0, 0x51, 0]),
    "sound:2": new Uint8Array([8, 0, 8, 0, 8, 0, 8, 0, 255, 255]),
    "logic:1":
      '// load.view(2)\nassignn(v50, 2); load.pic(v50); draw.pic(v50);\nload.view(2); set.view(o2, 2); sound(2, f2); assignn(v60, 2);\nprint("Room 2"); return;\n',
    music: JSON.stringify({ "2": { tempo: 90 } }),
  };
  const pic = prepareProjectRenumber({ documents, key: "picture:2", number: 9, profile });
  assert.ok(pic.ok);
  assert.match(String(pic.documents["logic:1"]), /assignn\(v50, 9\)/);
  assert.match(String(pic.documents["logic:1"]), /assignn\(v60, 2\)/);
  assert.deepEqual(pic.computed, []);
  const view = prepareProjectRenumber({ documents, key: "view:2", number: 9, profile });
  assert.ok(view.ok);
  assert.match(String(view.documents["logic:1"]), /load.view\(9\); set.view\(o2, 9\)/);
  assert.match(String(view.documents["logic:1"]), /\/\/ load.view\(2\)/);
  const sound = prepareProjectRenumber({ documents, key: "sound:2", number: 9, profile });
  assert.ok(sound.ok);
  assert.match(String(sound.documents["logic:1"]), /sound\(9, f2\)/);
  assert.deepEqual(JSON.parse(String(sound.documents["music"])), { "9": { tempo: 90 } });
  const bytes = [3, 50, 2, 24, 50, 25, 50, 30, 2, 41, 2, 2, 99, 2, 2, 3, 60, 2, 101, 1, 0];
  for (const [result, operands] of [
    [pic, [2]],
    [view, [8, 11]],
    [sound, [13]],
  ] as const) {
    const expected = [...bytes];
    for (const operand of operands) expected[operand] = 9;
    assert.deepEqual(
      compileProjectLogic(String(result.documents["logic:1"]), {
        profile,
        dictionary: new Map(),
        bindings: {},
      }).assembly.code,
      new Uint8Array(expected),
    );
  }
  assert.deepEqual(view.documents["view:9"], documents["view:2"]);
  assert.deepEqual(sound.documents["sound:9"], documents["sound:2"]);
});
test("unproved computed uses list their source lines before applying", () => {
  const documents = {
    "logic:2": "return;",
    "logic:1":
      "call.v(v40);\nnew.room.v(v41);\nassignn(v50, 2); random(1, 9, v50); load.pic(v50); return;",
    "picture:2": "end",
  };
  const room = prepareProjectRenumber({ documents, key: "logic:2", number: 7, profile });
  assert.ok(room.ok);
  assert.deepEqual(
    room.computed.map(({ document, line }) => ({ document, line })),
    [
      { document: "logic:1", line: 1 },
      { document: "logic:1", line: 2 },
    ],
  );
  const pic = prepareProjectRenumber({ documents, key: "picture:2", number: 7, profile });
  assert.ok(pic.ok);
  assert.equal(pic.computed.length, 1);
  assert.match(String(pic.documents["logic:1"]), /assignn\(v50, 2\)/);
});
test("documents, reservations and references occupy targets; numbers stay in range", () => {
  for (const extra of [
    { "logic:7": "return;" },
    { bindings: JSON.stringify({ reserved: { kind: "logic", num: 7 } }) },
    { "logic:1": "new.room(7); return;" },
    {
      world: JSON.stringify({
        rooms: { "1": { title: "", description: "", exits: { door: 7 } } },
        facts: {},
        quests: {},
      }),
    },
  ]) {
    const result = prepareProjectRenumber({
      documents: { "logic:2": "return;", ...extra },
      key: "logic:2",
      number: 7,
      profile,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /already taken/);
  }
  for (const number of [-1, 0, 256, 1.5])
    assert.equal(
      prepareProjectRenumber({
        documents: { "logic:2": "return;" },
        key: "logic:2",
        number,
        profile,
      }).ok,
      false,
    );
  assert.equal(
    prepareProjectRenumber({
      documents: { "logic:0": "return;" },
      key: "logic:0",
      number: 7,
      profile,
    }).ok,
    false,
  );
});
test("a stored title is preserved, including an explicitly named Room 2", () => {
  for (const title of ["Hall", "Room 2", ""]) {
    const result = prepareProjectRenumber({
      documents: {
        "logic:2": "return;",
        world: JSON.stringify({
          rooms: { "2": { title, description: "", exits: {} } },
          facts: {},
          quests: {},
        }),
      },
      key: "logic:2",
      number: 7,
      profile,
    });
    assert.ok(result.ok);
    assert.equal(JSON.parse(String(result.documents["world"])).rooms["7"].title, title);
  }
});

test("generated titles follow a move and an explicit Room N title stays named", () => {
  const documents = {
    "logic:2": "return;",
    world: JSON.stringify({
      rooms: { "2": { title: "Room 2", titleIsDefault: true, description: "", exits: {} } },
      facts: {},
      quests: {},
    }),
  };
  const result = prepareProjectRenumber({ documents, key: "logic:2", number: 7, profile });
  assert.ok(result.ok);
  assert.equal(JSON.parse(String(result.documents["world"])).rooms["7"].title, "Room 7");
});
test("byte-only LOGIC references retain native bytes with the hand-computed changed operands", () => {
  const documents = {
    "logic:2": new Uint8Array([1, 0, 0, 0, 2, 0]),
    "logic:1": new Uint8Array([3, 0, 18, 2, 0, 0, 2, 0]),
  };
  const result = prepareProjectRenumber({ documents, key: "logic:2", number: 7, profile });
  assert.ok(result.ok);
  assert.deepEqual(result.documents["logic:1"], new Uint8Array([3, 0, 18, 7, 0, 0, 2, 0]));
  assert.deepEqual(result.documents["logic:7"], new Uint8Array([1, 0, 0, 0, 2, 0]));
});

test("recorded game tests move their saved room, cached LOGIC and replay resources", async () => {
  const { newSaveState, encodeSave, encodeHostImage, decodeHostImage, decodeSave } =
    await import("../src/runtime/persistence.ts");
  const state = newSaveState(profile);
  state.vars[0] = 2;
  state.vars[1] = 2;
  state.logicResume = [{ logic: 2, offset: 0 }];
  state.replayCapacity = 1;
  state.replayActive = 1;
  state.replay = [{ kind: 0, value: 2 }];
  const setup = Buffer.from(
    encodeHostImage(encodeSave(state, profile), [{ kind: 0, value: 2 }]),
  ).toString("base64");
  const result = prepareProjectRenumber({
    documents: {
      "logic:2": "return;",
      tests: JSON.stringify({
        format: "monotio.agi.tests.v2",
        tests: [{ name: "Saved room", room: 2, steps: [], setup: { image: setup } }],
      }),
    },
    key: "logic:2",
    number: 7,
    profile,
  });
  assert.ok(result.ok);
  const changed = JSON.parse(String(result.documents["tests"])).tests[0].setup.image;
  const host = decodeHostImage(new Uint8Array(Buffer.from(changed, "base64")));
  const moved = decodeSave(host.image, profile);
  assert.equal(moved.vars[0], 7);
  assert.equal(moved.vars[1], 7);
  assert.deepEqual(moved.logicResume, [{ logic: 7, offset: 0 }]);
  assert.deepEqual(moved.replay, [{ kind: 0, value: 7 }]);
  assert.deepEqual(host.screen, [{ kind: 0, value: 7 }]);
});

test("native inventory locations move while carried and missing items keep their meanings", async () => {
  const { buildObjectFile, readInventoryObjects } = await import("../src/authoring/inventory.ts");
  const inventory = buildObjectFile(
    [
      { name: "Key", startingRoom: 2 },
      { name: "Coin", startingRoom: 255 },
      { name: "Gone", startingRoom: 0 },
    ],
    profile,
  );
  const result = prepareProjectRenumber({
    documents: { "logic:2": "return;", inventory },
    key: "logic:2",
    number: 7,
    profile,
  });
  assert.ok(result.ok);
  assert.ok(result.documents["inventory"] instanceof Uint8Array);
  assert.deepEqual(
    readInventoryObjects(result.documents["inventory"], profile).map((item) => item.startingRoom),
    [7, 255, 0],
  );
});

test("a reviewed move still refuses a recorded test whose saved resource stays behind", async () => {
  const { newSaveState, encodeSave } = await import("../src/runtime/persistence.ts");
  const { compileProjectDocuments } = await import("../src/authoring/projectDocuments.ts");
  const { createContainer } = await import("../src/container/container.ts");
  const { ProjectModel } = await import("../src/authoring/projectModel.ts");
  const { prepareProjectEdit } = await import("../src/authoring/projectEdit.ts");
  const { sha256Hex } = await import("../src/crypto.ts");
  const state = newSaveState(profile);
  state.vars[0] = 2;
  state.logicResume = [{ logic: 2, offset: 0 }];
  const setup = { image: Buffer.from(encodeSave(state, profile)).toString("base64") };
  const tests = {
    format: "monotio.agi.tests.v2",
    tests: [{ name: "Saved room", room: 2, steps: [], setup }],
  };
  const documents = { "logic:0": "return;", "logic:2": "return;", tests: JSON.stringify(tests) };
  const build = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const model = new ProjectModel({ documents, build, digest: sha256Hex });
  tests.tests[0]!.room = 7;
  const proposal = model.propose(model.capture(), "Move", [
    { key: "logic:2", content: null },
    { key: "logic:7", content: "return;" },
    { key: "tests", content: JSON.stringify(tests) },
  ]);
  const result = prepareProjectEdit({
    model,
    proposal,
    profileId: "2.936",
    policy: { reviewedRenumbering: { key: "logic:2", number: 7 } },
  });
  assert.equal(result.status, "diagnostics");
  assert.ok(result.diagnostics.some((d) => d.document === "tests" && d.severity === "error"));
});

test("recoverable source drafts rewrite typed literal operands in unfinished calls", () => {
  const result = prepareProjectRenumber({
    documents: { "logic:2": "return;", "logic:1": "new.room(2)" },
    key: "logic:2",
    number: 7,
    profile,
  });
  assert.ok(result.ok);
  assert.equal(result.documents["logic:1"], "new.room(7)");
});

test("reviewed computed references in native drafts permit the coordinated move", async () => {
  const { compileProjectDocuments } = await import("../src/authoring/projectDocuments.ts");
  const { createContainer } = await import("../src/container/container.ts");
  const { ProjectModel } = await import("../src/authoring/projectModel.ts");
  const { prepareProjectEdit } = await import("../src/authoring/projectEdit.ts");
  const { sha256Hex } = await import("../src/crypto.ts");
  const native = new Uint8Array([3, 0, 23, 40, 0, 0, 2, 0]);
  const documents = { "logic:0": "return;", "logic:2": "return;", "logic:90": native };
  const build = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const model = new ProjectModel({ documents, build, digest: sha256Hex });
  const plan = prepareProjectRenumber({ documents, key: "logic:2", number: 7, profile });
  assert.ok(plan.ok);
  assert.deepEqual(
    plan.computed.map(({ document }) => document),
    ["logic:90"],
  );
  const result = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Move", plan.changes),
    profileId: "2.936",
    policy: { reviewedRenumbering: { key: "logic:2", number: 7 } },
    drafts: [{ key: "logic:90", content: native }],
  });
  assert.equal(result.status, "ready", JSON.stringify(result.diagnostics));
});

test("the final validator keeps LOGIC 0 fixed and LOGIC destinations above zero", async () => {
  const { compileProjectDocuments } = await import("../src/authoring/projectDocuments.ts");
  const { createContainer } = await import("../src/container/container.ts");
  const { ProjectModel } = await import("../src/authoring/projectModel.ts");
  const { prepareProjectEdit } = await import("../src/authoring/projectEdit.ts");
  const { sha256Hex } = await import("../src/crypto.ts");
  for (const [from, to] of [
    [0, 7],
    [2, 0],
  ] as const) {
    const documents = { [`logic:${from}`]: "return;" };
    const build = compileProjectDocuments({
      files: Object.fromEntries(createContainer().files),
      documents,
      profileId: "2.936",
    });
    const model = new ProjectModel({ documents, build, digest: sha256Hex });
    const result = prepareProjectEdit({
      model,
      proposal: model.propose(model.capture(), "Move", [
        { key: `logic:${from}`, content: null },
        { key: `logic:${to}`, content: "return;" },
      ]),
      profileId: "2.936",
      policy: { reviewedRenumbering: { key: `logic:${from}`, number: to } },
    });
    assert.equal(result.status, "diagnostics");
    assert.equal(model.capture().read(`logic:${from}`)?.content, "return;");
  }
});
