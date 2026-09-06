import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";
import { executeAuthoringTool } from "../src/agent/authoringTools.ts";
import { resourceRevision } from "../src/agent/authoringState.ts";
import { parseLogicResource } from "../src/logic/resource.ts";
import { compilePictureSource } from "../src/picture/source.ts";

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

test("inventory edits allocate stable IDs without sending the complete table", () => {
  const state = createAgentSessionState();
  const first = executeAuthoringTool(state, "upsert_inventory_item", {
    id: null,
    name: "Brass key",
    location: "carried",
    room: null,
  })!;
  assert.equal(first.success, true);
  assert.equal(first.details?.["id"], 0);
  const second = executeAuthoringTool(state, "upsert_inventory_item", {
    id: null,
    name: "Letter",
    location: "room",
    room: 2,
  })!;
  assert.equal(second.details?.["id"], 1);
  const edit = executeAuthoringTool(state, "upsert_inventory_item", {
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
  const revision = resourceRevision(state.container.getResource("logic", 1));
  const edit = executeAuthoringTool(state, "edit_resource_source", {
    kind: "logic",
    num: 1,
    expectedRevision: revision,
    find: "Old greeting.",
    replace: "Hello again.",
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
      find: "Hello again.",
      replace: "Lost.",
    })!.success,
    false,
  );
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
    find: lines[2]!,
    replace: "rect 30,97 37,100",
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
    find: "rect 0,0 5,5",
    replace: "rect 1,1 2,2",
  })!;
  assert.equal(edit.success, false, "the stale text cannot be edited");
  assert.match(edit.error ?? "", /find must match/);
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
