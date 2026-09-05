import assert from "node:assert/strict";
import { test } from "node:test";
import { openContainer } from "../src/container/container.ts";
import { createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";
import { parseView, selectViewCel } from "../src/view/view.ts";
import { PROFILES } from "../src/runtime/profile.ts";

function session(version: string) {
  return createAgentSessionState(
    openContainer(new Map([["AGIDATA.OVL", Uint8Array.from(version, (c) => c.charCodeAt(0))]])),
  );
}

test("remixing 2.230 writes packed sprite loops that mirror when selected", () => {
  const state = session("2.230");
  const result = executeAgentTool(state, "write_view", {
    num: 5,
    spec: { loops: [{ cels: [{ width: 3, height: 1, pixels: [1, 2, 0] }] }, { mirrorLoop: 0 }] },
  });
  assert.equal(result.success, true, result.error ?? "tool failed");
  const payload = state.container.getResource("view", 5)!;
  const offset = payload[5]! | (payload[6]! << 8);
  assert.equal(payload[offset], 0xc1);
  const view = parseView(payload, PROFILES["2.230"]);
  assert.deepEqual([...selectViewCel(view, 1, 0)!.pixels], [0, 2, 1]);
});

test("remixing early profiles writes plain OBJECT metadata", () => {
  for (const version of ["2.089", "2.230", "2.272"]) {
    const state = session(version);
    const result = executeAgentTool(state, "write_inventory_objects", {
      objects: [{ name: "key", startingRoom: 7 }],
    });
    assert.equal(result.success, true, result.error ?? "tool failed");
    assert.deepEqual([...state.getFiles().get("OBJECT")!], [3, 0, 255, 3, 0, 7, 107, 101, 121, 0]);
  }
});

test("v3 picture feedback measures the actual profile's two-pixel radius-one brush", () => {
  const state = session("3.002.149");
  const result = executeAgentTool(state, "write_picture", {
    room: 1,
    source: "vis 3\npen 1\nplot 10,20",
  });
  assert.equal(result.success, true, result.error ?? "tool failed");
  assert.equal(result.details?.["fillCoverage"], 2 / (160 * 168));
});

test("remix logic compiler and reader use the imported profile's action vocabulary", () => {
  const state = session("3.002.149");
  const written = executeAgentTool(state, "write_logic_source", {
    room: 7,
    source: "allow.menu(1); release.key(); return;",
  });
  assert.equal(written.success, true, written.error ?? "tool failed");
  state.sources.logics.clear();
  const read = executeAgentTool(state, "read_logic", { num: 7 });
  assert.equal(read.success, true, read.error ?? "tool failed");
  assert.match(read.message ?? "", /allow.menu/);
  assert.doesNotMatch(read.message ?? "", /\/\/ !!/);
  const early = session("2.230");
  const quit = executeAgentTool(early, "write_logic_source", {
    room: 7,
    source: "quit(); return;",
  });
  assert.equal(quit.success, true, quit.error ?? "tool failed");
  const unavailable = executeAgentTool(early, "write_logic_source", {
    room: 7,
    source: "release.key();",
  });
  assert.equal(unavailable.success, false);
});

test("inventory remix preserves the imported drawable-object capacity", () => {
  const container = openContainer(
    new Map([
      ["AGIDATA.OVL", Uint8Array.from("2.230", (c) => c.charCodeAt(0))],
      ["OBJECT", Uint8Array.of(0, 0, 20)],
    ]),
  );
  const state = createAgentSessionState(container);
  const result = executeAgentTool(state, "write_inventory_objects", {
    objects: [{ name: "key", startingRoom: 7 }],
  });
  assert.equal(result.success, true, result.error ?? "tool failed");
  assert.equal(state.getFiles().get("OBJECT")![2], 20);
});

test("remix vocabulary keeps old IDs and allocates distinct new synonym groups", () => {
  const state = session("2.936");
  state.sources.words.set("look", 100);
  state.sources.words.set("door", 101);
  const result = executeAgentTool(state, "write_words", {
    words: ["look/examine", "portal", "coin/money"],
  });
  assert.equal(result.success, true, result.error ?? "tool failed");
  assert.equal(state.sources.words.get("examine"), 100);
  const portal = state.sources.words.get("portal")!;
  const coin = state.sources.words.get("coin")!;
  assert.ok(portal > 101);
  assert.ok(coin > 101);
  assert.notEqual(portal, coin);
  assert.equal(state.sources.words.get("money"), coin);
  executeAgentTool(state, "write_words", { words: ["window"] });
  assert.notEqual(state.sources.words.get("window"), portal);
  assert.notEqual(state.sources.words.get("window"), coin);
});

test("conflicting existing synonyms fail without partial vocabulary changes", () => {
  const state = session("2.936");
  state.sources.words.set("look", 100);
  state.sources.words.set("door", 101);
  const result = executeAgentTool(state, "write_words", { words: ["coin", "look/door"] });
  assert.equal(result.success, false);
  assert.deepEqual(
    [...state.sources.words],
    [
      ["look", 100],
      ["door", 101],
    ],
  );
});
