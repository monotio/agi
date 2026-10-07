import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogicLspServer } from "../src/logic/lspServer.ts";
import { offsetAt, positionAt, type WorkspaceEdit } from "../src/logic/lspTypes.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";

const source =
  '#message 1 "Hello\\nthere"\nif (isset(done)) { print(m1); }\nsound(chime, done);\nassignn(count, 3);\nif (equaln(count, 3)) { reset(done); }\nreturn;';
const project = {
  profileId: "2.936" as const,
  words: [],
  bindings: {
    chime: { kind: "sound", num: 1 },
    done: { kind: "flag", num: 204 },
    count: { kind: "variable", num: 40 },
  },
  documents: { "logic:1": { source } },
};
function request(method: string, params: Record<string, unknown> = {}) {
  return createLogicLspServer({ project }).handle({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: { textDocument: { uri: "agi-project:///logic.1.lgc" }, ...params },
  });
}
test("project names describe state evidence and resource definitions open their resource", () => {
  const at = { position: positionAt(source, source.indexOf("chime")) };
  const info = request("agi/bindingInfo", at)?.result as {
    name: string;
    kind: string;
    num: number;
    uses: { role: string; key: string }[];
  };
  assert.equal(info?.name, "chime");
  assert.equal(info.kind, "sound");
  assert.equal(info.num, 1);
  assert.deepEqual(
    info.uses.map((use) => use.key),
    ["logic:1"],
  );
  const state = request("agi/bindingInfo", { position: positionAt(source, source.indexOf("done")) })
    ?.result as typeof info;
  assert.deepEqual(
    state.uses.map((use) => use.role),
    ["Read", "Changed", "Changed"],
  );
  const definition = request("textDocument/definition", at)?.result as { uri: string };
  assert.equal(definition.uri, "agi-project:///sound.1");
});
test("classic message calls have inlay text and can put text inline", () => {
  const hints = request("textDocument/inlayHint")?.result as { label: string }[];
  assert.deepEqual(
    hints?.map((hint) => hint.label),
    [' "Hello\\nthere"'],
  );
  const actions = request("textDocument/codeAction", {
    range: {
      start: positionAt(source, source.indexOf("m1")),
      end: positionAt(source, source.indexOf("m1") + 2),
    },
  })?.result as { title: string; edit: WorkspaceEdit }[];
  const action = actions.find((action) => action.title === "Put text inline");
  assert.ok(action);
  const edit = action.edit.documentChanges[0]!.edits[0]!;
  assert.equal(
    source.slice(offsetAt(source, edit.range.start), offsetAt(source, edit.range.end)),
    "m1",
  );
  assert.equal(edit.newText, '"Hello\\nthere"');
});
test("inline print offers a message declaration with escaped text", () => {
  const inline = 'print("Hi\\" there");\nreturn;';
  const server = createLogicLspServer({
    project: { ...project, documents: { "logic:1": { source: inline } } },
  });
  const response = server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "textDocument/codeAction",
    params: { textDocument: { uri: "agi-project:///logic.1.lgc" } },
  });
  const actions = response?.result as { title: string; edit: WorkspaceEdit }[];
  const action = actions.find((action) => action.title === "Move text to #message");
  assert.ok(action);
  assert.ok(
    action.edit.documentChanges[0]!.edits.some((edit) =>
      edit.newText.includes('#message 1 "Hi\\" there"'),
    ),
  );
});
test("new Starter and Boilerplate projects use inline print text", () => {
  for (const kind of ["starter", "boilerplate"] as const) {
    const project = createStarterProject(kind);
    for (const source of project.sources.logics.values()) {
      assert.doesNotMatch(source, /print\(m\d+\)/);
    }
    assert.match(project.sources.logics.get(1)!, /print\("/);
  }
});

test("both sides of a variable comparison are read", () => {
  const server = createLogicLspServer({
    project: {
      ...project,
      bindings: { ...project.bindings, other_count: { kind: "variable", num: 41 } },
      documents: { "logic:1": { source: "if (v40 == v41) { count = 1; }\nreturn;" } },
    },
  });
  const response = server.handle({ jsonrpc: "2.0", id: 1, method: "agi/bindings" });
  const infos = response?.result as { name: string; uses: { role: string }[] }[];
  assert.deepEqual(
    infos.find((info) => info.name === "other_count")?.uses.map((use) => use.role),
    ["Read"],
  );
  assert.deepEqual(
    infos.find((info) => info.name === "count")?.uses.map((use) => use.role),
    ["Read", "Changed"],
  );
});

test("name uses remain available while an unknown command is being edited", () => {
  const server = createLogicLspServer({
    project: { ...project, documents: { "logic:1": { source: "toString(count);\nreturn;" } } },
  });
  const response = server.handle({ jsonrpc: "2.0", id: 1, method: "agi/bindings" });
  assert.equal(response?.error, undefined);
  const infos = response?.result as { name: string; uses: { role: string }[] }[];
  assert.deepEqual(
    infos.find((info) => info.name === "count")?.uses.map((use) => use.role),
    ["Read"],
  );
});

test("message actions use free slots while declarations are being edited", async () => {
  const { messageCodeActions } = await import("../src/logic/messageReadability.ts");
  for (const key of ["nope", "constructor", "toString", "__proto__", "0", "256", "999999"]) {
    const draft = `#message ${key} "draft"\n#message 2 "existing"\nprint("Hello");`;
    const actions = messageCodeActions(draft, "agi-project:///logic.1.lgc", 1, 0, draft.length);
    assert.deepEqual(
      actions[0]?.edit.documentChanges[0]?.edits.map((edit) => edit.newText),
      ["m1", '#message 1 "Hello"\n'],
      key,
    );
  }
});

test("message actions use the first free slot when message 255 exists", async () => {
  const { messageCodeActions } = await import("../src/logic/messageReadability.ts");
  const source = '#message 1 "First"\n#message 255 "Last"\nprint("Hello");';
  const actions = messageCodeActions(source, "agi-project:///logic.1.lgc", 1, 0, source.length);
  assert.deepEqual(
    actions[0]?.edit.documentChanges[0]?.edits.map((edit) => edit.newText),
    ["m2", '#message 2 "Hello"\n'],
  );
});

test("state action inputs are Read while condition resources are Used", () => {
  const server = createLogicLspServer({
    project: {
      ...project,
      words: [["look", 1]],
      bindings: { ...project.bindings, look: { kind: "word", num: 1 } },
      documents: { "logic:1": { source: "assignv(v41, count);\nif (said(look)) { return; }" } },
    },
  });
  const infos = server.handle({ jsonrpc: "2.0", id: 1, method: "agi/bindings" })?.result as {
    name: string;
    uses: { role: string }[];
  }[];
  assert.deepEqual(
    infos.find((info) => info.name === "count")?.uses.map((use) => use.role),
    ["Read"],
  );
  assert.deepEqual(
    infos.find((info) => info.name === "look")?.uses.map((use) => use.role),
    ["Used"],
  );
});
