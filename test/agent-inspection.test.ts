import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";

test("source inspection pages exact editable text with a revision and total lines", () => {
  const state = createAgentSessionState();
  executeAgentTool(state, "write_logic_source", {
    room: 1,
    source: "set(f42);\nnew.room(2);\nreturn;",
  });
  const full = executeAgentTool(state, "read_logic", { num: 1 });
  assert.equal(typeof full.details?.["revision"], "string");
  const page = executeAgentTool(state, "read_logic", { num: 1, offset: 1, limit: 1 });
  assert.equal((page.details?.["source"] as string).split("\n").length, 1);
  assert.ok(Number(page.details?.["totalLines"]) > 1);
  assert.deepEqual(full.details?.["dependencies"], { rooms: [2], flags: [42], variables: [] });
});

test("picture inspection can request only the image; vocabulary supports exact search and paging", () => {
  const state = createAgentSessionState();
  executeAgentTool(state, "write_picture", { room: 0, source: "vis 1\nfill 0,0\nend" });
  const image = executeAgentTool(state, "read_picture", { num: 0, include: "image" });
  assert.equal(image.success, true);
  assert.equal(image.details?.["source"], undefined);
  assert.equal(image.images?.length, 1);
  const source = executeAgentTool(state, "read_picture", {
    num: 0,
    include: "source",
    offset: 0,
    limit: 1,
  });
  assert.equal(source.images, undefined);
  executeAgentTool(state, "write_words", { words: ["key", "keyboard", "look/examine"] });
  const words = executeAgentTool(state, "read_words", { exact: "key", offset: 0, limit: 1 });
  assert.deepEqual((words.details?.["groups"] as { words: string[] }[])[0]?.words, ["key"]);
  const page = executeAgentTool(state, "read_words", { offset: 1, limit: 1 });
  assert.equal((page.details?.["groups"] as unknown[]).length, 1);
  assert.equal(page.details?.["offset"], 1);
});

test("live inspection filters state and object tables without losing requested zero values", async () => {
  const { executeAgentToolAsync } = await import("../src/agent/tools.ts");
  const state = createAgentSessionState();
  const deps = {
    engine: {
      state: async () => ({ room: 1, vars: [0, 5, 0], flags: [false, true, false] }),
      objects: async () => [{ num: 0 }, { num: 1 }],
    },
  };
  const result = await executeAgentToolAsync(
    state,
    "read_live",
    {
      state: { variables: [0, 2], flags: [0], compact: true },
      objects: null,
      frames: null,
    },
    deps,
  );
  const stateSection = result.details?.["state"] as Record<string, unknown>;
  assert.deepEqual(stateSection["vars"], { 0: 0, 2: 0 });
  assert.deepEqual(stateSection["flags"], { 0: false });
  const objects = await executeAgentToolAsync(
    state,
    "read_live",
    { state: null, objects: { ids: [1] }, frames: null },
    deps,
  );
  const objectsSection = objects.details?.["objects"] as Record<string, unknown>;
  assert.deepEqual(objectsSection["objects"], [{ num: 1 }]);
});

test("explicit synonym groups preserve multiword parser phrases without silently changing words", () => {
  const state = createAgentSessionState();
  const result = executeAgentTool(state, "write_words", {
    words: [],
    groups: [
      ["take", "pick up"],
      ["look", "examine"],
    ],
  });
  assert.equal(result.success, true, result.error ?? "");
  assert.equal(state.sources.words.has("pick up"), true);
  assert.equal(state.sources.words.get("pick up"), state.sources.words.get("take"));
  assert.equal(state.sources.words.has("pickup"), false);
  const before = [...state.sources.words];
  const bad = executeAgentTool(state, "write_words", { words: ["café"], groups: null });
  assert.equal(bad.success, false);
  assert.deepEqual([...state.sources.words], before);
});

test("world inspection summarizes large authoring history and reads a selected full entry", () => {
  const state = createAgentSessionState();
  for (let i = 0; i < 100; i++) state.authoring.world.facts[`fact_${i}`] = "x".repeat(4000);
  const summary = executeAgentTool(state, "inspect_world_bible", { filter: "all" });
  assert.ok(JSON.stringify(summary).length < 12000);
  const fact = executeAgentTool(state, "inspect_world_bible", {
    filter: "intent",
    section: "facts",
    name: "fact_90",
  });
  assert.equal(fact.success, true, fact.error ?? "");
  assert.equal((fact.details?.["entries"] as Record<string, unknown>)["fact_90"], "x".repeat(4000));
});
