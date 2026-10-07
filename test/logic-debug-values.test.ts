import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogicLspServer } from "../src/logic/lspServer.ts";
import type { LspOperations } from "../src/logic/lspTypes.ts";

test("paused hover values resolve raw, local, shared and built-in slots", async () => {
  const source =
    "#define local f50\nif (isset(local)) { assignn(shared, 3); }\nif (isset(f50)) { assignn(current_room, 1); }\nreturn;";
  const server = createLogicLspServer({
    project: {
      profileId: "2.936",
      words: [],
      bindings: { shared: { kind: "variable", num: 40 } },
      documents: { "logic:1": { source } },
    },
  });
  const vars = Array<number>(256).fill(0);
  const flags = Array<number>(256).fill(0);
  vars[40] = 3;
  vars[0] = 1;
  for (const [line, character, expected] of [
    [1, 11, "= off"],
    [1, 30, "= 3"],
    [2, 11, "= off"],
    [2, 29, "= 1"],
  ] as const) {
    const params = {
      textDocument: { uri: "agi-project:///logic.1.lgc" },
      position: { line, character },
    };
    const hover = (await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "textDocument/hover",
      params: { ...params, debugState: { vars, flags, lines: [1, 2] } },
    }))!.result as LspOperations["textDocument/hover"];
    assert.ok(hover);
    assert.match(hover.contents.value.split("\n")[1]!, new RegExp(expected));
    const running = (await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/hover",
      params,
    }))!.result as LspOperations["textDocument/hover"];
    assert.ok(running);
    assert.doesNotMatch(running.contents.value, / = (?:off|on|\d+)/);
  }
  flags[50] = 1;
  const hover = (await server.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "textDocument/hover",
    params: {
      textDocument: { uri: "agi-project:///logic.1.lgc" },
      position: { line: 1, character: 11 },
      debugState: { vars, flags, lines: [1] },
    },
  }))!.result as LspOperations["textDocument/hover"];
  assert.match(hover!.contents.value, /= on/);
});

test("paused inlay values appear only on selected executed lines and preserve message hints", async () => {
  const source =
    '#define quiet f50\nassignn(v40, 3);\nif (!isset(quiet)) { assignn(current_room, 1); }\nassignn(v41, 7);\nprint(m1);\n#message 1 "Hello"\nreturn;';
  const server = createLogicLspServer({
    project: { profileId: "2.936", words: [], bindings: {}, documents: { "logic:1": { source } } },
  });
  const params = { textDocument: { uri: "agi-project:///logic.1.lgc" } };
  const request = async (extra = {}) =>
    (await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "textDocument/inlayHint",
      params: { ...params, ...extra },
    }))!.result as LspOperations["textDocument/inlayHint"];
  const vars = Array<number>(256).fill(0);
  vars[40] = 3;
  vars[0] = 1;
  const flags = Array<number>(256).fill(0);
  assert.deepEqual(await request({ debugState: { vars, flags, lines: [1, 2] } }), [
    { position: { line: 4, character: 8 }, label: ' "Hello"', paddingLeft: true },
    { position: { line: 1, character: 11 }, label: " 3", paddingLeft: true },
    { position: { line: 2, character: 16 }, label: " off", paddingLeft: true },
    { position: { line: 2, character: 41 }, label: " 1", paddingLeft: true },
  ]);
  assert.equal((await request()).length, 1);
  assert.deepEqual(
    await request({
      debugState: { vars, flags, lines: [1, 2] },
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 99 } },
    }),
    [{ position: { line: 1, character: 11 }, label: " 3", paddingLeft: true }],
  );
});
