import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateProjectIds } from "../src/authoring/resourceAllocation.ts";
import { createAgentSessionState, type AgentSessionState } from "../src/agent/agentState.ts";
import { executeAgentTool } from "../src/agent/tools.ts";
import { executeAuthoringTool } from "../src/agent/authoringTools.ts";
import {
  ENTRY_BYTES,
  INITIAL_DIRECTORY_ENTRIES,
  openContainer,
} from "../src/container/container.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { detectProfile } from "../src/runtime/profile.ts";

/** The structural context the agent session already holds. */
function contextOf(state: AgentSessionState) {
  return {
    container: state.container,
    profile: state.profile,
    dictionary: state.sources.words,
    bindings: state.authoring.bindings,
  };
}

function filesSnapshot(state: AgentSessionState): string {
  return JSON.stringify([...state.container.files].map(([name, bytes]) => [name, [...bytes]]));
}

test("allocation starts above the system slots and skips operands logic uses", () => {
  const state = createAgentSessionState();
  assert.equal(
    executeAgentTool(state, "write_logic_source", {
      room: 0,
      source: "set(f32); assignn(v32,1); return;",
    }).success,
    true,
  );
  const context = contextOf(state);
  assert.deepEqual(allocateProjectIds(context, "flag"), [33]);
  assert.deepEqual(allocateProjectIds(context, "variable"), [33]);
  // Flags and variables 0..31 are interpreter-owned; nothing offers them.
  assert.deepEqual(allocateProjectIds(context, "flag", 3), [33, 34, 35]);
  // Resources number from 1 even while slot 0 is absent.
  assert.deepEqual(allocateProjectIds(context, "picture"), [1]);
});

test("allocation is a pure read: nothing mutates and a repeat call sees the same world", () => {
  const state = createAgentSessionState();
  const context = contextOf(state);
  const filesBefore = filesSnapshot(state);
  const bindingsBefore = JSON.stringify(state.authoring.bindings);
  assert.deepEqual(allocateProjectIds(context, "flag", 2), [32, 33]);
  // A batch reserves inside its own list only; no phantom reservation remains.
  assert.deepEqual(allocateProjectIds(context, "flag", 2), [32, 33]);
  assert.equal(JSON.stringify(state.authoring.bindings), bindingsBefore);
  assert.equal(filesSnapshot(state), filesBefore);
});

test("bound names hold their ids, scoped to their own kind", () => {
  const state = createAgentSessionState();
  state.authoring.bindings["gate_open"] = { kind: "flag", num: 32 };
  state.authoring.bindings["score_copy"] = { kind: "variable", num: 32 };
  state.authoring.bindings["title_pic"] = { kind: "picture", num: 1 };
  const context = contextOf(state);
  assert.deepEqual(allocateProjectIds(context, "flag"), [33]);
  // A variable binding does not hold flag 33, nor flag 32 the variable's.
  assert.deepEqual(allocateProjectIds(context, "variable"), [33]);
  assert.deepEqual(allocateProjectIds(context, "picture"), [2]);
});

test("batch allocation reserves within its list and rejects exhaustion atomically", () => {
  const state = createAgentSessionState();
  const context = contextOf(state);
  assert.deepEqual(allocateProjectIds(context, "sound", 3), [1, 2, 3]);
  // State ids run 32..255 (224 slots) and resources 1..255 (255 slots).
  assert.throws(() => allocateProjectIds(context, "flag", 225), /No free flag IDs remain/);
  assert.throws(() => allocateProjectIds(context, "sound", 256), /No free sound IDs remain/);
  state.authoring.bindings["only_flag"] = { kind: "flag", num: 33 };
  const ids = allocateProjectIds(context, "flag", 223);
  assert.equal(ids.length, 223);
  assert.deepEqual(
    [...ids].sort((a, b) => a - b),
    [...ids],
    "ids come back ascending",
  );
  assert.ok(!ids.includes(33));
  assert.throws(() => allocateProjectIds(context, "flag", 224), /No free flag IDs remain/);
});

test("count must be a positive integer no larger than 256", () => {
  const context = contextOf(createAgentSessionState());
  for (const count of [0, -1, 1.5, Number.NaN, 257])
    assert.throws(() => allocateProjectIds(context, "flag", count), /1\.\.256/);
});

test("aliased and damaged directory slots stay occupied", () => {
  const directory = new Uint8Array(INITIAL_DIRECTORY_ENTRIES * ENTRY_BYTES).fill(0xff);
  const point = (num: number, volume: number, offset: number) => {
    directory[num * ENTRY_BYTES] = (volume << 4) | (offset >> 16);
    directory[num * ENTRY_BYTES + 1] = (offset >> 8) & 0xff;
    directory[num * ENTRY_BYTES + 2] = offset & 0xff;
  };
  const record = Uint8Array.of(0x12, 0x34, 0, 1, 0, 0xaa);
  // Views 5 and 6 alias one record; 7 points out of bounds, 8 at a missing VOL.
  point(5, 0, 0);
  point(6, 0, 0);
  point(7, 0, 0x0100);
  point(8, 3, 0);
  const container = openContainer(
    new Map([
      ["VIEWDIR", directory],
      ["VOL.0", record],
    ]),
  );
  const context = {
    container,
    profile: detectProfile(container.files),
    dictionary: new Map<string, number>(),
    bindings: {},
  };
  assert.throws(() => container.getResource("view", 7), /corrupt container/);
  assert.throws(() => container.getResource("view", 8), /corrupt container/);
  assert.deepEqual(allocateProjectIds(context, "view", 6), [1, 2, 3, 4, 9, 10]);
  // The damaged entries are still there and still unloadable afterwards.
  assert.throws(() => container.getResource("view", 8), /corrupt container/);
});

test("indirect or undecodable state access refuses automatic flag and variable ids", () => {
  const state = createAgentSessionState();
  assert.equal(
    executeAgentTool(state, "write_logic_source", { room: 3, source: "set.v(v40); return;" })
      .success,
    true,
  );
  const context = contextOf(state);
  for (const kind of ["flag", "variable"] as const)
    assert.throws(
      () => allocateProjectIds(context, kind),
      new RegExp(`Logic 3 has indirect or undecodable state access.*free ${kind}`),
    );

  // Bytecode the disassembler cannot reconstruct carries a // !! warning
  // comment; it refuses the same way rather than trusting a partial scan.
  const undecodable = createAgentSessionState();
  undecodable.container.putResource("logic", 9, buildLogicResource(Uint8Array.of(0xf0, 0x00), []));
  assert.throws(
    () => allocateProjectIds(contextOf(undecodable), "flag"),
    /Logic 9 has indirect or undecodable state access/,
  );
});

test("message text naming f32 or v32 is not an operand", () => {
  const state = createAgentSessionState();
  assert.equal(
    executeAgentTool(state, "write_logic_source", {
      room: 1,
      source: 'set(f41); assignn(v42,1); print("f32 v33 f34 v35"); return;',
    }).success,
    true,
  );
  const context = contextOf(state);
  // Only the real operands f41/v42 are held; the quoted lookalikes are free.
  assert.deepEqual(allocateProjectIds(context, "flag"), [32]);
  assert.deepEqual(allocateProjectIds(context, "variable"), [32]);
});

test("reserve_binding allocates through the same scan, batch order and refusal included", () => {
  const state = createAgentSessionState();
  assert.equal(
    executeAgentTool(state, "write_logic_source", {
      room: 0,
      source: "set(f32); assignn(v32,1); return;",
    }).success,
    true,
  );
  const result = executeAuthoringTool(state, "reserve_binding", {
    bindings: [
      { name: "gate_open", kind: "flag", id: null },
      { name: "lamp_lit", kind: "flag", id: null },
      { name: "gold_count", kind: "variable", id: null },
    ],
  })!;
  assert.equal(result.success, true);
  // Each item sees the ids the earlier batch entries just bound.
  assert.equal(state.authoring.bindings["gate_open"]?.num, 33);
  assert.equal(state.authoring.bindings["lamp_lit"]?.num, 34);
  assert.equal(state.authoring.bindings["gold_count"]?.num, 33);

  assert.equal(
    executeAgentTool(state, "write_logic_source", { room: 4, source: "set.v(v40); return;" })
      .success,
    true,
  );
  const refused = executeAuthoringTool(state, "reserve_binding", {
    kind: "flag",
    name: "attic_open",
    id: null,
  })!;
  assert.equal(refused.success, false);
  assert.match(String(refused.error), /indirect or undecodable state access/);
  assert.equal(state.authoring.bindings["attic_open"], undefined);
});
