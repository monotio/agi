import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogicLspServer, type LogicLanguageProject } from "../src/logic/lspServer.ts";
import { offsetAt, type LspOperations } from "../src/logic/lspTypes.ts";

const uri = "agi-project:///logic.1.lgc";
function setup(source: string, extra: Partial<LogicLanguageProject> = {}) {
  const project: LogicLanguageProject = {
    profileId: "2.936",
    words: [],
    bindings: {},
    ...extra,
    documents: { ...extra.documents, "logic:1": { source, version: 7 } },
  };
  const server = createLogicLspServer({ project });
  const request = (method: string) =>
    server.handle({ jsonrpc: "2.0", id: 1, method, params: { textDocument: { uri } } })!.result;
  return {
    server,
    project,
    request,
    actions: () => request("textDocument/codeAction") as LspOperations["textDocument/codeAction"],
  };
}

test("unknown sound callback creates a project flag before the file constant action", () => {
  const source = "sound(s0, scary_sound_off); return;";
  const { actions, request, server, project } = setup(source, {
    bindings: { taken: { kind: "flag", num: 16 } },
    documents: {
      "logic:2": {
        source: "#define done 18\nset(17); reset(done); reset(scary_sound_off); return;",
      },
    },
    bindingDocument: {
      uri: "agi-project:///bindings.json",
      source: '{"taken":{"kind":"flag","num":16,"note":"keep"}}',
    },
  });
  assert.match(
    JSON.stringify(request("textDocument/diagnostic")),
    /No flag is named scary_sound_off\./,
  );
  const fixes = actions();
  assert.deepEqual(
    fixes.map((fix) => fix.title),
    ["Create flag scary_sound_off (Flag 19)", "Define as a constant in this file…"],
  );
  const change = fixes[0]!.edit.documentChanges[0]!;
  assert.deepEqual(change.textDocument, { uri: "agi-project:///bindings.json", version: null });
  assert.equal(change.edits.length, 1);
  const declarations = JSON.parse(change.edits[0]!.newText);
  assert.deepEqual(declarations, {
    taken: { kind: "flag", num: 16, note: "keep" },
    scary_sound_off: { kind: "flag", num: 19 },
  });
  assert.equal(
    offsetAt(project.bindingDocument!.source, change.edits[0]!.range.end),
    project.bindingDocument!.source.length,
  );
  assert.equal(fixes[0]!.edit.documentChanges.length, 1);
  assert.equal(
    fixes[1]!.edit.documentChanges[0]!.edits[0]!.newText,
    "#define scary_sound_off 19\n",
  );
  server.setProject({
    ...project,
    bindings: declarations,
    bindingDocument: { uri: change.textDocument.uri, source: change.edits[0]!.newText },
  });
  assert.deepEqual((request("textDocument/diagnostic") as { items: unknown[] }).items, []);
  const renamed = server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/rename",
    params: {
      textDocument: { uri },
      position: { line: 0, character: 10 },
      newName: "sound_finished",
    },
  })!.result as LspOperations["textDocument/rename"];
  assert.deepEqual(renamed!.documentChanges.map((edit) => edit.textDocument.uri).sort(), [
    "agi-project:///bindings.json",
    uri,
    "agi-project:///logic.2.lgc",
  ]);
  assert.equal(
    renamed!.documentChanges.find((edit) => edit.textDocument.uri === "agi-project:///logic.2.lgc")!
      .edits[0]!.newText,
    "sound_finished",
  );
});

test("unknown variable uses the lowest free variable including a newer open draft", () => {
  const { server, actions, request } = setup("assignn(count, 3); return;", {
    bindings: { taken: { kind: "variable", num: 28 } },
    documents: { "logic:2": { source: "return;" } },
  });
  server.handle({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "agi-project:///logic.2.lgc",
        languageId: "agi-logic",
        version: 9,
        text: "#define used v27\nincrement(used); increment(v30); return;",
      },
    },
  });
  assert.match(JSON.stringify(request("textDocument/diagnostic")), /No variable is named count\./);
  assert.deepEqual(
    actions().map((fix) => fix.title),
    ["Create variable count (Variable 29)", "Define as a constant in this file…"],
  );
  assert.deepEqual(JSON.parse(actions()[0]!.edit.documentChanges[0]!.edits[0]!.newText).count, {
    kind: "variable",
    num: 29,
  });
});

test("unknown object, resource and scalar names offer only a file constant", () => {
  for (const source of [
    "draw(actor); return;",
    "load.sound(chime); return;",
    "assignn(v30, amount); return;",
  ]) {
    const { actions, request } = setup(source);
    assert.match(JSON.stringify(request("textDocument/diagnostic")), /Nothing is named /);
    assert.deepEqual(
      actions().map((fix) => fix.title),
      ["Define as a constant in this file…"],
    );
  }
});

test("full flag space never falls back to a reserved flag", () => {
  const bindings = Object.fromEntries(
    Array.from({ length: 240 }, (_, i) => [`flag_${i}`, { kind: "flag", num: i + 16 }]),
  );
  assert.deepEqual(setup("set(missing); return;", { bindings }).actions(), []);
});

test("project creation respects binding names and definitions in other LOGICs", () => {
  const { actions } = setup("set(local_name); return;", {
    documents: { "logic:2": { source: "#define local_name 40\nreturn;" } },
  });
  assert.deepEqual(
    actions().map((fix) => fix.title),
    ["Define as a constant in this file…"],
  );
});

test("invalid binding drafts cannot be replaced by a quick fix", () => {
  for (const source of ["{", "[]", "null"]) {
    const { actions } = setup("set(missing); return;", {
      bindingDocument: { uri: "agi-project:///bindings.json", source },
    });
    assert.deepEqual(
      actions().map((fix) => fix.title),
      ["Define as a constant in this file…"],
    );
  }
});
