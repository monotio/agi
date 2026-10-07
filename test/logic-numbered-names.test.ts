import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogicLspServer, type LogicLanguageProject } from "../src/logic/lspServer.ts";
import { offsetAt, positionAt, type WorkspaceEdit } from "../src/logic/lspTypes.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { PROFILES } from "../src/runtime/profile.ts";

const source =
  'set(f36);\nreset(f36);\nif (isset(f36)) { increment(v40); }\nset.view(o3, 40);\nposition(o3, 12, 34);\ndraw(o3);\nget(i0);\nprint(m2);\ncall(7);\nsound(8, f37);\nreturn;\n#message 2 "A brass key"';
const second = 'if (isset(f36)) { assignn(v40, 2); }\nreturn;\n#message 2 "Another message"';
const uri = "agi-project:///logic.1.lgc";
const project: LogicLanguageProject = {
  profileId: "2.936",
  words: [],
  bindings: {},
  objects: ["brass key"],
  inventory: [{ name: "brass key", startingRoom: 12 }],
  documents: {
    "logic:1": { source },
    "logic:2": { source: second },
    "logic:7": { source: "return;" },
  },
};

test("standalone source names messages with its filename LOGIC owner", () => {
  const server = createLogicLspServer();
  const standalone = "file:///synthetic/logic.2.lgc";
  server.handle({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: standalone,
        version: 1,
        text: 'print(m2);\nreturn;\n#message 2 "A key"',
      },
    },
  });
  const response = server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "textDocument/rename",
    params: {
      textDocument: { uri: standalone },
      position: { line: 0, character: 7 },
      newName: "key_text",
    },
  });
  const edit = response?.result as WorkspaceEdit;
  assert.deepEqual(JSON.parse(edit.documentChanges[0]!.edits[0]!.newText), {
    key_text: { kind: "message", num: 2, logic: 2 },
  });
  const hover = server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/hover",
    params: { textDocument: { uri: standalone }, position: { line: 0, character: 7 } },
  });
  assert.match(JSON.stringify(hover?.result), /Used \(1\): LOGIC 2 line 1/);
});
function client(input = project) {
  const server = createLogicLspServer({ project: input });
  let id = 0;
  return (method: string, text: string, extra = {}) => {
    const response = server.handle({
      jsonrpc: "2.0",
      id: ++id,
      method,
      params: {
        textDocument: { uri },
        position: positionAt(source, source.indexOf(text)),
        ...extra,
      },
    });
    assert.ok(response && "result" in response, JSON.stringify(response));
    return response.result;
  };
}

test("unnamed flag hover and definitions share grouped project evidence", () => {
  const request = client();
  const hover = request("textDocument/hover", "f36") as { contents: { value: string } };
  assert.equal(
    hover.contents.value,
    "```agi\nFlag 36\n```\n\n4 uses across the game.\n\nChanged (2): LOGIC 1 lines 1, 2\n\nRead (2): LOGIC 1 line 3; LOGIC 2 line 1\n\nRename… F2",
  );
  assert.deepEqual(request("textDocument/definition", "f36"), [
    { uri, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } } },
    { uri, range: { start: { line: 1, character: 6 }, end: { line: 1, character: 9 } } },
    { uri, range: { start: { line: 2, character: 10 }, end: { line: 2, character: 13 } } },
    {
      uri: "agi-project:///logic.2.lgc",
      range: { start: { line: 0, character: 10 }, end: { line: 0, character: 13 } },
    },
  ]);
});

for (const [text, kind, num, name] of [
  ["f36", "flag", 36, "gate_open"],
  ["v40", "variable", 40, "gate_count"],
  ["o3", "object", 3, "gate"],
  ["i0", "inventory", 0, "brass_key"],
  ["m2", "message", 2, "key_hint"],
  ["40);\nposition", "view", 40, "gate_view"],
  ["7);", "logic", 7, "gate_logic"],
  ["8,", "sound", 8, "gate_sound"],
] as const) {
  test(`numbered ${kind} has hover, a destination, references and byte-preserving binding edits`, () => {
    const request = client();
    const prepared = request("textDocument/prepareRename", text) as { placeholder: string };
    assert.equal(prepared.placeholder, "");
    const hover = JSON.stringify(request("textDocument/hover", text));
    assert.match(hover, /Rename… F2/);
    const heading = {
      flag: "Flag",
      variable: "Variable",
      object: "Object",
      inventory: "Item",
      message: "Message",
      view: "VIEW",
      logic: "LOGIC",
      sound: "SOUND",
    }[kind];
    assert.match(hover, new RegExp(`${heading} ${num}`));
    if (kind === "message") assert.match(hover, /A brass key/);
    if (kind === "inventory") {
      assert.match(hover, /brass key/);
      assert.match(hover, /Starting room: 12/);
    }
    const range = (line: number, start: number, end: number) => ({
      start: { line, character: start },
      end: { line, character: end },
    });
    const destinations = {
      flag: [
        { uri, range: range(0, 4, 7) },
        { uri, range: range(1, 6, 9) },
        { uri, range: range(2, 10, 13) },
        { uri: "agi-project:///logic.2.lgc", range: range(0, 10, 13) },
      ],
      variable: [
        { uri, range: range(2, 28, 31) },
        { uri: "agi-project:///logic.2.lgc", range: range(0, 26, 29) },
      ],
      object: [
        { uri, range: range(3, 9, 11) },
        { uri, range: range(4, 9, 11) },
        { uri, range: range(5, 5, 7) },
      ],
      inventory: { uri: "agi-project:///OBJECT.json", range: range(2, 4, 23) },
      message: { uri, range: range(11, 9, 10) },
      view: { uri: "agi-project:///view.40", range: range(0, 0, 0) },
      logic: { uri: "agi-project:///logic.7.lgc", range: range(0, 0, 0) },
      sound: { uri: "agi-project:///sound.8", range: range(0, 0, 0) },
    };
    assert.deepEqual(request("textDocument/definition", text), destinations[kind]);
    const references = request("textDocument/references", text, {
      context: { includeDeclaration: false },
    }) as unknown[];
    assert.ok(references.length > 0);
    const edit = request("textDocument/rename", text, { newName: name }) as WorkspaceEdit;
    assert.deepEqual(edit.documentChanges[0], {
      textDocument: { uri: "agi-project:///bindings.json", version: null },
      edits: [
        {
          range: range(0, 0, 2),
          newText:
            JSON.stringify(
              { [name]: { kind, num, ...(kind === "message" ? { logic: 1 } : {}) } },
              null,
              2,
            ) + "\n",
        },
      ],
    });
    const changed: Record<string, string> = {
      [uri]: source,
      "agi-project:///logic.2.lgc": second,
      "agi-project:///logic.7.lgc": "return;",
      "agi-project:///bindings.json": "{}",
    };
    for (const change of edit.documentChanges) {
      let code = changed[change.textDocument.uri]!;
      for (const entry of [...change.edits].sort(
        (a, b) => offsetAt(code, b.range.start) - offsetAt(code, a.range.start),
      )) {
        code =
          code.slice(0, offsetAt(code, entry.range.start)) +
          entry.newText +
          code.slice(offsetAt(code, entry.range.end));
      }
      changed[change.textDocument.uri] = code;
    }
    const bindings = JSON.parse(changed["agi-project:///bindings.json"]!);
    assert.deepEqual(bindings[name], { kind, num, ...(kind === "message" ? { logic: 1 } : {}) });
    for (const [document, before] of [
      [uri, source],
      ["agi-project:///logic.2.lgc", second],
    ] as const) {
      const context = { profile: PROFILES["2.936"], dictionary: new Map<string, number>() };
      assert.deepEqual(
        compileProjectLogic(changed[document]!, { ...context, bindings }).assembly.payload,
        compileProjectLogic(before, { ...context, bindings: {} }).assembly.payload,
      );
    }
    if (kind === "flag") assert.match(changed["agi-project:///logic.2.lgc"]!, /isset\(gate_open\)/);
    if (kind === "object") {
      assert.match(hover, /View \(1\).*line 4/);
      assert.match(hover, /Positioned \(1\).*line 5/);
      assert.match(hover, /Drawn \(1\).*line 6/);
    }
  });
}

test("system slots have names in hover, completion and the shared Game state inventory", () => {
  const request = client({
    ...project,
    documents: { "logic:1": { source: "set(f5); assignn(v1, 3); return;" } },
  });
  const system = request("agi/bindings", "") as { name: string; kind: string; num: number }[];
  assert.equal(system.filter((entry) => entry.kind === "flag" && entry.num <= 15).length, 16);
  assert.equal(system.filter((entry) => entry.kind === "variable" && entry.num <= 26).length, 27);
  assert.ok(
    system.some((entry) => entry.kind === "flag" && entry.num === 5 && entry.name === "new_room"),
  );
  const server = createLogicLspServer({
    project: { ...project, documents: { "logic:1": { source: "set(new_" } } },
  });
  const reply = server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "textDocument/completion",
    params: { textDocument: { uri }, position: { line: 0, character: 8 } },
  });
  assert.deepEqual(reply?.result, [
    {
      label: "new_room",
      detail: "Flag 5 · built-in",
      sortText: "00000",
      textEdit: {
        range: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } },
        newText: "new_room",
      },
    },
  ]);
  const renamed = request("agi/renameBinding", "", {
    name: "new_room",
    newName: "entered_room",
  }) as WorkspaceEdit;
  assert.match(renamed.documentChanges[0]!.edits[0]!.newText, /"entered_room"/);
});

test("PICTURE names retain their resource identity in numeric assignment operands", () => {
  const server = createLogicLspServer({
    project: {
      ...project,
      bindings: { room_art: { kind: "picture", num: 12 } },
      documents: { "logic:1": { source: "assignn(v40, room_art); draw.pic(v40); return;" } },
    },
  });
  const params = { textDocument: { uri }, position: { line: 0, character: 14 } };
  const hover = server.handle({ jsonrpc: "2.0", id: 1, method: "textDocument/hover", params });
  assert.match(JSON.stringify(hover?.result), /room_art · PICTURE 12/);
  const target = server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/definition",
    params,
  });
  assert.deepEqual(target?.result, {
    uri: "agi-project:///picture.12",
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  });
  const edit = server.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "textDocument/rename",
    params: { ...params, newName: "room_picture" },
  });
  assert.ok(edit?.result);
  assert.match(JSON.stringify(edit?.result), /room_picture/);
});

test("number naming validates input after prepare and preserves binding metadata on rename", () => {
  const request = client({
    ...project,
    bindings: { gate_open: { kind: "flag", num: 36 } },
    bindingDocument: {
      uri: "agi-project:///bindings.json",
      source: '{"gate_open":{"kind":"flag","num":36,"evidence":[]}}',
    },
  });
  const edit = request("textDocument/rename", "f36", { newName: "gate_unlocked" }) as WorkspaceEdit;
  assert.match(edit.documentChanges[0]!.edits[0]!.newText, /"evidence": \[\]/);
  assert.doesNotMatch(edit.documentChanges[0]!.edits[0]!.newText, /gate_open/);
  const server = createLogicLspServer({ project });
  const params = { textDocument: { uri }, position: { line: 0, character: 5 } };
  assert.ok(
    server.handle({ jsonrpc: "2.0", id: 1, method: "textDocument/prepareRename", params })?.result,
  );
  const invalid = server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/rename",
    params: { ...params, newName: "two words" },
  });
  assert.match(invalid?.error?.message ?? "", /Start the name/);
  const system = server.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "textDocument/rename",
    params: { ...params, newName: "new_room" },
  });
  assert.match(system?.error?.message ?? "", /belongs to Flag 5/);
  assert.deepEqual(
    server.handle({ jsonrpc: "2.0", id: 4, method: "agi/compile", params })?.result,
    client()("agi/compile", ""),
  );
});

test("agent evidence keeps named ownership while numbered hover includes local aliases", () => {
  const server = createLogicLspServer({
    project: {
      ...project,
      bindings: { gate_open: { kind: "flag", num: 36 } },
      documents: {
        "logic:1": {
          source: "#define latch 36\nset(latch); reset(f36); if (isset(gate_open)) { return; }",
        },
      },
    },
  });
  const infos = server.handle({ jsonrpc: "2.0", id: 1, method: "agi/bindings" })?.result as {
    name: string;
    uses: { role: string }[];
  }[];
  assert.deepEqual(
    infos.find((info) => info.name === "gate_open")?.uses.map((use) => use.role),
    ["Changed", "Read"],
  );
  const hover = server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 1, character: 18 } },
  });
  assert.match(JSON.stringify(hover?.result), /Changed \(2\)/);
  assert.doesNotMatch(JSON.stringify(hover?.result), /Reset \(/);
});

for (const operand of ["f36", "gate_open"]) {
  test(`renaming ${operand} keeps every owned constant reference compilable`, () => {
    const docs = {
      "logic:1": { source: `set(${operand}); return;` },
      "logic:2": { source: "position(o0, gate_open, 12); return;" },
    };
    const bindings = { gate_open: { kind: "flag", num: 36 } };
    const server = createLogicLspServer({ project: { ...project, bindings, documents: docs } });
    const edit = server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "textDocument/rename",
      params: { textDocument: { uri }, position: { line: 0, character: 5 }, newName: "gate_ready" },
    })?.result as WorkspaceEdit;
    assert.equal(edit.documentChanges.length, 3);
    assert.deepEqual(edit.documentChanges[2]!.edits, [
      {
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 22 } },
        newText: "gate_ready",
      },
    ]);
    const nextBindings = JSON.parse(edit.documentChanges[0]!.edits[0]!.newText) as typeof bindings;
    for (const [key, doc] of Object.entries(docs)) {
      const change = edit.documentChanges.find(
        (change) => change.textDocument.uri === `agi-project:///logic.${key.slice(6)}.lgc`,
      )!;
      let source = doc.source;
      for (const entry of [...change.edits].reverse())
        source =
          source.slice(0, offsetAt(source, entry.range.start)) +
          entry.newText +
          source.slice(offsetAt(source, entry.range.end));
      assert.deepEqual(
        compileProjectLogic(source, {
          profile: PROFILES["2.936"],
          dictionary: new Map(),
          bindings: nextBindings,
        }).assembly.payload,
        compileProjectLogic(doc.source, {
          profile: PROFILES["2.936"],
          dictionary: new Map(),
          bindings,
        }).assembly.payload,
      );
    }
  });
}

test("renaming a binding from another operand kind preserves its declared kind", () => {
  const server = createLogicLspServer({
    project: {
      ...project,
      bindings: { gate_open: { kind: "flag", num: 36 } },
      bindingDocument: {
        uri: "agi-project:///bindings.json",
        source: '{"gate_open":{"kind":"flag","num":36}}',
      },
      documents: { "logic:1": { source: "assignn(gate_open, 1); return;" } },
    },
  });
  const edit = server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "textDocument/rename",
    params: { textDocument: { uri }, position: { line: 0, character: 9 }, newName: "gate_ready" },
  })?.result as WorkspaceEdit;
  const change = edit.documentChanges.find((change) =>
    change.textDocument.uri.endsWith("bindings.json"),
  )!;
  let source = '{"gate_open":{"kind":"flag","num":36}}';
  for (const entry of [...change.edits].reverse())
    source =
      source.slice(0, offsetAt(source, entry.range.start)) +
      entry.newText +
      source.slice(offsetAt(source, entry.range.end));
  assert.deepEqual(JSON.parse(source), { gate_ready: { kind: "flag", num: 36 } });
});
