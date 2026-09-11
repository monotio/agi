import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";
import { executeAuthoringTool } from "../src/agent/authoringTools.ts";
import { parseLogicResource } from "../src/logic/resource.ts";
import { compilePictureSource } from "../src/picture/source.ts";
import type { AgentSessionState } from "../src/agent/tools.ts";

/** The revision token read_logic reports — text plus compilation context. */
function logicRevision(state: AgentSessionState, num: number): string {
  return String(
    executeAgentTool(state, "read_logic", { num, offset: null, limit: null }).details?.["revision"],
  );
}

test("named binding allocation avoids compiled references and preserves stable identities", () => {
  const state = createAgentSessionState();
  executeAgentTool(state, "write_logic_source", {
    room: 0,
    source: "set(f32); assignn(v32,1); return;",
  });
  const first = executeAuthoringTool(state, "reserve_binding", {
    kind: "flag",
    name: "gate_open",
    id: null,
  })!;
  assert.equal(first.success, true);
  assert.equal(state.authoring.bindings["gate_open"]?.num, 33);
  assert.equal(
    executeAuthoringTool(state, "reserve_binding", { kind: "flag", name: "gate_open", id: null })!
      .success,
    true,
  );
  assert.equal(
    executeAuthoringTool(state, "reserve_binding", { kind: "flag", name: "gate_open", id: 34 })!
      .success,
    false,
  );
  executeAgentTool(state, "write_logic_source", { room: 1, source: "set(gate_open); return;" });
  assert.deepEqual(
    [...parseLogicResource(state.container.getResource("logic", 1)!).code],
    [12, 33, 0],
  );
});

test("batch reserve_binding allocates multiple IDs and returns defines", () => {
  const state = createAgentSessionState();
  const result = executeAuthoringTool(state, "reserve_binding", {
    bindings: [
      { name: "bridge_down", kind: "flag", id: null },
      { name: "chest_opened", kind: "flag", id: null },
      { name: "gold_count", kind: "variable", id: null },
      { name: "room_custom_id", kind: "variable", id: 50 },
      { name: "title_view", kind: "view", id: null },
    ],
  })!;
  assert.equal(result.success, true);
  assert.equal(state.authoring.bindings["bridge_down"]?.num, 32);
  assert.equal(state.authoring.bindings["chest_opened"]?.num, 33);
  assert.equal(state.authoring.bindings["gold_count"]?.num, 32);
  assert.equal(state.authoring.bindings["room_custom_id"]?.num, 50);
  assert.equal(state.authoring.bindings["title_view"]?.num, 1);
  assert.match(String(result.details?.["defines"]), /#define bridge_down 32/);
  assert.match(String(result.details?.["defines"]), /#define chest_opened 33/);
  assert.match(String(result.details?.["defines"]), /#define gold_count 32/);
  assert.match(String(result.details?.["defines"]), /#define room_custom_id 50/);
  assert.match(String(result.details?.["defines"]), /#define title_view 1/);
});

test("inventory merges allocate stable IDs without sending the complete table", () => {
  const state = createAgentSessionState();
  const upsert = (item: Record<string, unknown>) =>
    executeAgentTool(state, "write_inventory_objects", {
      mode: "merge",
      objects: null,
      item,
    });
  const first = upsert({
    id: null,
    name: "Brass key",
    location: "carried",
    room: null,
  })!;
  assert.equal(first.success, true);
  assert.equal(first.details?.["id"], 0);
  const second = upsert({
    id: null,
    name: "Letter",
    location: "room",
    room: 2,
  })!;
  assert.equal(second.details?.["id"], 1);
  const edit = upsert({
    id: 1,
    name: "Sealed letter",
    location: "room",
    room: 2,
  })!;
  assert.equal(edit.success, true);
  assert.deepEqual(state.sources.objects, [
    { name: "Brass key", startingRoom: 255 },
    { name: "Sealed letter", startingRoom: 2 },
  ]);
});

test("revision-checked source edits change only one matched section and reject stale copies", () => {
  const state = createAgentSessionState();
  executeAgentTool(state, "write_logic_source", {
    room: 1,
    source: 'print("Old greeting."); return;',
  });
  const revision = logicRevision(state, 1);
  const edit = executeAuthoringTool(state, "edit_resource_source", {
    kind: "logic",
    num: 1,
    expectedRevision: revision,
    edits: [{ find: "Old greeting.", replace: "Hello again." }],
  })!;
  assert.equal(edit.success, true);
  assert.deepEqual(parseLogicResource(state.container.getResource("logic", 1)!).messages, [
    "Hello again.",
  ]);
  assert.equal(
    executeAuthoringTool(state, "edit_resource_source", {
      kind: "logic",
      num: 1,
      expectedRevision: revision,
      edits: [{ find: "Hello again.", replace: "Lost." }],
    })!.success,
    false,
  );
});

test("a batch of source edits resolves on one snapshot and applies once", () => {
  const state = createAgentSessionState();
  executeAgentTool(state, "write_logic_source", {
    room: 1,
    source: 'print("aaa"); print("bbb"); return;',
  });
  const revision = logicRevision(state, 1);
  const edited = executeAuthoringTool(state, "edit_resource_source", {
    kind: "logic",
    num: 1,
    expectedRevision: revision,
    edits: [
      { find: '"aaa"', replace: '"ccc"' },
      { find: '"bbb"', replace: '"ddd"' },
    ],
  })!;
  assert.equal(edited.success, true, edited.error ?? "");
  const source = String(
    executeAgentTool(state, "read_logic", { num: 1, offset: null, limit: null }).details?.[
      "source"
    ],
  );
  assert.match(source, /"ccc".*"ddd"/, "both edits landed in one pass");

  // Overlapping occurrences of one find count: 'aa' in 'aaa' occurs twice.
  const ambiguous = executeAuthoringTool(state, "edit_resource_source", {
    kind: "logic",
    num: 1,
    expectedRevision: logicRevision(state, 1),
    edits: [{ find: "cc", replace: "zz" }],
  })!;
  assert.equal(ambiguous.success, false);
  assert.match(ambiguous.error ?? "", /matched 2 times/);
  const diagnostic = ambiguous.details?.["diagnostic"] as { editIndex?: number } | undefined;
  assert.equal(diagnostic?.editIndex, 0);

  // Two finds hitting the same snapshot range are rejected, not shifted.
  const overlapping = executeAuthoringTool(state, "edit_resource_source", {
    kind: "logic",
    num: 1,
    expectedRevision: logicRevision(state, 1),
    edits: [
      { find: '"ccc"', replace: '"xxx"' },
      { find: 'cc"', replace: "yy" },
    ],
  })!;
  assert.equal(overlapping.success, false);
  assert.match(overlapping.error ?? "", /overlap/);
  const after = String(
    executeAgentTool(state, "read_logic", { num: 1, offset: null, limit: null }).details?.[
      "source"
    ],
  );
  assert.equal(after, source, "a failed batch changes nothing");

  // Adjacent edits touching at a boundary are allowed.
  const adjacent = executeAuthoringTool(state, "edit_resource_source", {
    kind: "logic",
    num: 1,
    expectedRevision: logicRevision(state, 1),
    edits: [
      { find: '"ccc"', replace: '"1"' },
      { find: '; print("ddd")', replace: "" },
    ],
  })!;
  assert.equal(adjacent.success, true, adjacent.error ?? "");
});

test("picture edits match the authored source read_picture returns, comments and macros included", () => {
  const state = createAgentSessionState();
  const authored = [
    "# actor: ego x20 y120 width8 height24 priority11",
    "vis 4",
    "rect 20,97 27,100",
    "end",
  ];
  const written = executeAgentTool(state, "write_picture", {
    room: 3,
    source: authored.join("\n"),
  });
  assert.equal(written.success, true, written.error ?? "");
  const read = executeAgentTool(state, "read_picture", { num: 3, include: "source" });
  assert.equal(read.success, true, read.error ?? "");
  const lines = String(read.details?.["source"]).split("\n");
  assert.deepEqual(lines, authored);
  const edit = executeAuthoringTool(state, "edit_resource_source", {
    kind: "picture",
    num: 3,
    expectedRevision: read.details?.["revision"],
    edits: [{ find: lines[2]!, replace: "rect 30,97 37,100" }],
  })!;
  assert.equal(edit.success, true, edit.error ?? "");
  const expected = [authored[0]!, authored[1]!, "rect 30,97 37,100", authored[3]!].join("\n");
  assert.equal(state.sources.pictures.get(3), expected);
  assert.deepEqual(
    [...state.container.getResource("picture", 3)!],
    [...compilePictureSource(expected, { profile: state.profile }).bytes],
  );
  const after = executeAgentTool(state, "read_picture", { num: 3, include: "source" });
  assert.equal(after.details?.["source"], expected);
  assert.notEqual(after.details?.["revision"], read.details?.["revision"]);
});

test("a stored picture source that no longer matches its resource is not trusted", () => {
  const state = createAgentSessionState();
  const authored = ["vis 4", "rect 20,97 27,100", "end"].join("\n");
  assert.equal(
    executeAgentTool(state, "write_picture", { room: 3, source: authored }).success,
    true,
  );
  // An imported project can carry a source that disagrees with its compiled picture.
  state.sources.pictures.set(3, ["vis 1", "rect 0,0 5,5", "end"].join("\n"));
  const read = executeAgentTool(state, "read_picture", { num: 3, include: "source" });
  assert.equal(read.success, true, read.error ?? "");
  const shown = String(read.details?.["source"]);
  assert.doesNotMatch(shown, /rect 0,0 5,5/, "the stale text is not shown");
  assert.deepEqual(
    [...compilePictureSource(shown, { profile: state.profile }).bytes],
    [...state.container.getResource("picture", 3)!],
    "the shown source compiles to the stored resource",
  );
  const edit = executeAuthoringTool(state, "edit_resource_source", {
    kind: "picture",
    num: 3,
    expectedRevision: read.details?.["revision"],
    edits: [{ find: "rect 0,0 5,5", replace: "rect 1,1 2,2" }],
  })!;
  assert.equal(edit.success, false, "the stale text cannot be edited");
  assert.match(edit.error ?? "", /matched 0 times/);
});

test("world intent is durable and partial updates preserve other facts", () => {
  const state = createAgentSessionState();
  assert.equal(
    executeAuthoringTool(state, "update_world", {
      rooms: [],
      facts: [{ name: "key", text: "Belongs to the caretaker." }],
      quests: [],
    })!.success,
    true,
  );
  assert.equal(
    executeAuthoringTool(state, "update_world", {
      rooms: [
        { num: 1, title: "Hall", description: "A quiet hall.", exits: [{ name: "east", room: 2 }] },
      ],
      facts: [],
      quests: [],
    })!.success,
    true,
  );
  assert.equal(state.authoring.world.facts["key"], "Belongs to the caretaker.");
  assert.equal(state.authoring.world.rooms["1"]?.exits["east"], 2);
});

test("write_logic_source warns on non-diegetic (+N) score counters without deleting copy", () => {
  const state = createAgentSessionState();
  const source = 'print("Elevator (+1) to roof. (+10)"); return;';
  const res = executeAgentTool(state, "write_logic_source", {
    room: 1,
    source,
  });
  assert.equal(res.success, true);
  assert.ok(
    res.adjustments?.some((adj) => adj.includes("Warning: non-diegetic score indicator")),
    "records warning adjustment for score indicator",
  );
  assert.equal(state.sources.logics.get(1), source, "preserves authored copy intact");
});
