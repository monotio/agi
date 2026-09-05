import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";
import { openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { parseLogicResource } from "../src/logic/resource.ts";
import { buildView } from "../src/view/view.ts";
import { splitToolResult } from "../src/agent/toolTransport.ts";

test("authoring converts smart punctuation once while preserving explicit message bytes", () => {
  const state = createAgentSessionState();
  const source = String.raw`// Leave this comment — and "quoted text" alone.
#message 1 "She said “hello”—it’s open… 1–2.\x97\"\\"
print(1); return;`;
  const result = executeAgentTool(state, "write_logic_source", { room: 1, source });
  assert.equal(result.success, true, result.error ?? "logic compiles");
  assert.deepEqual(parseLogicResource(state.container.getResource("logic", 1)!).messages, [
    'She said "hello"--it\'s open... 1-2.\x97"\\',
  ]);
  assert.ok(result.adjustments?.length);
  assert.ok(
    state.sources.logics.get(1)?.startsWith('// Leave this comment — and "quoted text" alone.'),
  );
  assert.throws(() => assembleLogic(source, { dictionary: new Map() }), /not a single byte/);
  executeAgentTool(state, "write_logic_source", { room: 1, source: "return;" });
  const before = state.container.getResource("logic", 1)!.slice();
  const invalid = executeAgentTool(state, "write_logic_source", {
    room: 1,
    source: 'print("A dragon 🐉"); return;',
  });
  assert.equal(invalid.success, false);
  assert.deepEqual(state.container.getResource("logic", 1), before);
});

test("world inspection reads compiled resources and inventory after reopening a cartridge", () => {
  const original = createAgentSessionState();
  executeAgentTool(original, "write_words", { words: ["key", "brass"] });
  executeAgentTool(original, "write_logic_source", { room: 7, source: "return;" });
  executeAgentTool(original, "write_inventory_objects", {
    objects: [{ name: "Brass key", startingRoom: 7 }],
  });
  original.container.putResource(
    "view",
    9,
    buildView({ loops: [{ cels: [{ width: 2, height: 1, pixels: [4, 15] }] }] }),
  );
  const restored = createAgentSessionState(openContainer(original.getFiles()));
  assert.equal(restored.sources.logics.size, 0);
  const result = executeAgentTool(restored, "inspect_world_bible", { filter: null });
  assert.equal(result.details?.["wordCount"], original.sources.words.size);
  assert.deepEqual(result.details?.["rooms"], [7]);
  assert.deepEqual(result.details?.["views"], [9]);
  assert.deepEqual(result.details?.["objects"], ["Brass key"]);
  assert.deepEqual(result.details?.["inventory"], [{ name: "Brass key", startingRoom: 7 }]);
  const filtered = executeAgentTool(restored, "inspect_world_bible", { filter: "objects" });
  assert.equal(filtered.details?.["rooms"], undefined);
  assert.deepEqual(filtered.details?.["inventory"], result.details?.["inventory"]);
});

test("read_view shows compiled sprites without sending pixel arrays in model text", () => {
  const state = createAgentSessionState();
  state.container.putResource(
    "view",
    9,
    buildView({ loops: [{ cels: [{ width: 2, height: 1, pixels: [4, 15] }] }] }),
  );
  const result = executeAgentTool(state, "read_view", { num: 9 });
  assert.equal(result.success, true, result.error ?? "view can be inspected");
  assert.equal(result.images?.length, 1);
  assert.ok(result.images![0]!.caption.includes("L0 C0"));
  assert.ok(splitToolResult(result).text.length < 2000);
  assert.equal(executeAgentTool(state, "read_view", { num: 10 }).success, false);
});

test("read_picture returns the stored rendering alongside its editable source", () => {
  const state = createAgentSessionState();
  executeAgentTool(state, "write_picture", { room: 1, source: "vis 1\nfill 0,0\nend" });
  const result = executeAgentTool(state, "read_picture", { num: 1 });
  assert.equal(result.success, true);
  assert.equal(result.images?.length, 1);
  assert.ok(result.details?.["source"]);
  assert.ok(!splitToolResult(result).text.includes('"png"'));
});
