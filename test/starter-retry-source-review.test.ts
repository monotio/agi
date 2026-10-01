import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentSessionState } from "../src/agent/agentState.ts";
import { installBoilerplateSeed } from "../src/agent/baseTemplate.ts";
import { executeAgentTool } from "../src/agent/tools.ts";

test("Genesis retry preserves a valid authored logic comment with unchanged native bytes", () => {
  const state = createAgentSessionState();
  installBoilerplateSeed(state);
  const files = state.getFiles();
  const source = `${state.sources.logics.get(1)!}\n// A learner's story note to retain.\n`;
  const edited = executeAgentTool(state, "write_logic", { room: 1, source });
  assert.equal(edited.success, true);
  assert.deepEqual(state.getFiles(), files, "the comment keeps every native byte identical");
  assert.equal(state.sources.logics.get(1), source);
  assert.throws(() => installBoilerplateSeed(state), /authored work/);
  assert.equal(state.sources.logics.get(1), source, "refusal preserves the real edited source");
  assert.deepEqual(state.getFiles(), files);
});

test("Genesis retry preserves a valid authored picture comment with unchanged native bytes", () => {
  const state = createAgentSessionState();
  installBoilerplateSeed(state);
  const files = state.getFiles();
  const source = `${state.sources.pictures.get(1)!}\n# My plan for the clearing.\n`;
  const edited = executeAgentTool(state, "write_picture", { room: 1, source });
  assert.equal(edited.success, true);
  assert.deepEqual(state.getFiles(), files, "the comment keeps every native byte identical");
  assert.equal(state.sources.pictures.get(1), source);
  assert.throws(() => installBoilerplateSeed(state), /authored work/);
  assert.equal(state.sources.pictures.get(1), source, "refusal preserves the real edited source");
  assert.deepEqual(state.getFiles(), files);
});
