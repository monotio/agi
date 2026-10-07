import assert from "node:assert/strict";
import { test } from "node:test";
import { createProjectLogicLanguageSnapshot } from "../src/authoring/projectLanguage.ts";
import { commandReference } from "../src/logic/commandReference.ts";
import { createLogicLspServer } from "../src/logic/lspServer.ts";
import { PROFILES } from "../src/runtime/profile.ts";

const bindings = {
  alien: { kind: "flag", num: 16 },
  picture_number: { kind: "variable", num: 40 },
  chime_sound: { kind: "sound", num: 1 },
  missing_sound: { kind: "sound", num: 9 },
  alien_view: { kind: "view", num: 2 },
  first_room: { kind: "logic", num: 1 },
  brass_key: { kind: "inventory", num: 0 },
  greeting: { kind: "message", num: 2, logic: 1 },
  other_greeting: { kind: "message", num: 3, logic: 2 },
  open_menu: { kind: "controller", num: 4 },
};
const resources = ["sound:3", "view:2", "logic:2", "picture:8", "sound:1", "logic:1"];
function snapshot(source: string) {
  return createProjectLogicLanguageSnapshot({
    source,
    profile: PROFILES["2.936"],
    dictionary: new Map([["look", 10]]),
    objects: ["brass key"],
    bindings,
    resources,
    logic: 1,
  });
}
function complete(source: string) {
  return snapshot(source).completeAt(source.length);
}

test("sound operands offer existing SOUNDs in number order, never flags or absent resources", () => {
  for (const source of ["sound(", "load.sound("]) {
    assert.deepEqual(
      complete(source).map(({ label, text }) => ({ label, text })),
      [
        { label: "chime_sound · SOUND 1", text: "chime_sound" },
        { label: "SOUND 3", text: "3" },
      ],
    );
    assert.equal(snapshot(source).signatureAt(source.length)?.activeParameter, 0);
  }
  assert.equal(snapshot("sound(").signatureAt(6)?.label, "sound(resource, flag)");
  assert.deepEqual(
    complete("sound(ch").map((entry) => entry.text),
    ["chime_sound"],
  );
});

test("VIEW and LOGIC operands offer only existing resources of their family", () => {
  for (const source of ["load.view(", "discard.view(", "set.view(o0, ", "add.to.pic(", "show.obj("])
    assert.deepEqual(
      complete(source).map((entry) => entry.text),
      ["alien_view"],
    );
  for (const source of ["call(", "load.logics(", "new.room(", "trace.info("])
    assert.deepEqual(
      complete(source).map((entry) => entry.text),
      ["first_room", "2"],
    );
});

test("variable-selected pictures, resources and items offer variables, never literal resources", () => {
  for (const source of [
    "load.pic(",
    "draw.pic(",
    "discard.pic(",
    "overlay.pic(",
    "load.view.v(",
    "set.view.v(o0, ",
    "call.v(",
    "load.logics.v(",
    "new.room.v(",
    "get.v(",
    "put.v(",
  ]) {
    const options = complete(source);
    assert.ok(
      options.some((entry) => entry.text === "picture_number"),
      source,
    );
    assert.ok(
      options.every((entry) => entry.detail.startsWith("Variable ")),
      source,
    );
  }
  assert.deepEqual(complete("show.pri.screen("), []);
});

test("flags, inventory, messages, controllers and words stay in their operand positions", () => {
  const flags = complete("sound(1, ");
  assert.ok(flags.some((entry) => entry.text === "alien"));
  assert.ok(flags.every((entry) => entry.detail.startsWith("Flag ")));
  for (const source of ["get(", "drop(", "put(", "if (has(", "if (obj.in.room("])
    assert.deepEqual(
      complete(source).map((entry) => entry.text),
      ["brass_key"],
    );
  const source = '#message 2 "Hello"\n#message 5 "Goodbye"\nprint(';
  assert.deepEqual(
    complete(source).map((entry) => entry.text),
    ["greeting", "m5"],
  );
  assert.deepEqual(
    complete("if (controller(").map((entry) => entry.text),
    ["open_menu"],
  );
  assert.deepEqual(
    complete("if (said(").map((entry) => entry.text),
    ['"look"'],
  );
});

test("local typed definitions are filtered, untyped numeric aliases match existing resources", () => {
  const source = "#define done f20\n#define art v41\n#define chime 1\nsound(";
  assert.deepEqual(
    complete(source).map((entry) => entry.text),
    ["chime", "3"],
  );
  const flags = complete("#define done f20\n#define art v41\nset(");
  assert.ok(flags.some((entry) => entry.text === "done"));
  assert.ok(!flags.some((entry) => entry.text === "art"));
});

test("resource completion replaces numeric prefixes without consuming the closing delimiter", () => {
  const source = "sound(3, f16);";
  const option = snapshot(source).completeAt(7)[0]!;
  assert.equal(option.text, "3");
  assert.equal(option.start, 6);
  assert.equal(option.end, 7);
});

test("every resource operand has family metadata across every interpreter profile", () => {
  for (const profile of Object.values(PROFILES))
    for (const command of commandReference(profile))
      command.operands.forEach((kind, index) => {
        if (kind === "resource") {
          assert.equal(command.resourceOperand?.operand, index, `${profile.id}: ${command.name}`);
          assert.ok(["logic", "picture", "view", "sound"].includes(command.resourceOperand!.kind));
        }
      });
  const picture = commandReference(PROFILES["2.936"]).find((entry) => entry.name === "load.pic")!;
  assert.deepEqual(picture.resourceOperand, { kind: "picture", operand: 0, variable: true });
});

test("LSP supplies project resources and removes deleted resources from completion", () => {
  const project = {
    profileId: "2.936" as const,
    words: [],
    bindings,
    resources: Object.fromEntries(resources.map((key) => [key, { uri: `agi-resource:///${key}` }])),
    documents: { "logic:1": { source: "sound(" } },
  };
  const server = createLogicLspServer({ project });
  const request = () =>
    server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "textDocument/completion",
      params: {
        textDocument: { uri: "agi-project:///logic.1.lgc" },
        position: { line: 0, character: 6 },
      },
    })?.result;
  assert.match(JSON.stringify(request()), /chime_sound · SOUND 1/);
  server.setProject({ ...project, resources: {} });
  assert.deepEqual(request(), []);
});

test("a local numeric definition shadows a differently typed project binding for completion", () => {
  const source = "#define alien 1\nsound(";
  assert.deepEqual(
    complete(source).map((entry) => entry.text),
    ["alien", "3"],
  );
});

test("profile-specific sound discard and view variable forms retain their operand families", () => {
  for (const profile of Object.values(PROFILES)) {
    const commands = commandReference(profile);
    const discard = commands.find((command) => command.name === "discard.sound");
    assert.equal(
      discard?.resourceOperand?.kind,
      profile.extraActions === "iigs" ? "sound" : undefined,
    );
    const view = commands.find((command) => command.name === "discard.view.v");
    if (view) assert.deepEqual(view.resourceOperand, { kind: "view", operand: 0, variable: true });
  }
});

test("message completion uses the project LOGIC owner with a custom editor URI", () => {
  const source = '#message 2 "Hello"\nprint(';
  const uri = "inmemory://custom-editor/scene";
  const server = createLogicLspServer({
    project: {
      profileId: "2.936",
      words: [],
      bindings,
      documents: { "logic:1": { source, uri } },
    },
  });
  const response = server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "textDocument/completion",
    params: { textDocument: { uri }, position: { line: 1, character: 6 } },
  });
  assert.match(JSON.stringify(response?.result), /"newText":"greeting"/);
});
