import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authoredPictureSource,
  createAgentSessionState,
  executeAgentTool,
} from "../src/agent/tools.ts";
import { executeAuthoringTool } from "../src/agent/authoringTools.ts";
import { parsePictureDocument } from "../src/studio/pictureDocument.ts";
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

test("a source edit on an annotated write_scene picture keeps its Studio items and stays trusted", () => {
  const state = createAgentSessionState();
  const written = executeAgentTool(state, "write_scene", {
    room: 7,
    backgroundColor: 1,
    shapes: [
      {
        kind: "rect",
        color: 5,
        priority: null,
        filled: true,
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 3,
        points: null,
        name: "Oak tree",
      },
    ],
  });
  assert.equal(written.success, true, written.error ?? "");
  const read = executeAgentTool(state, "read_picture", { num: 7, include: "source" });
  assert.equal(read.success, true, read.error ?? "");
  assert.match(String(read.details?.["source"]), /# @item oak-tree "Oak tree" art/);
  const edit = executeAuthoringTool(state, "edit_resource_source", {
    kind: "picture",
    num: 7,
    expectedRevision: read.details?.["revision"],
    edits: [{ find: "line 1,3 3,3", replace: "line 1,3 4,3" }],
  })!;
  assert.equal(edit.success, true, edit.error ?? "");
  const trusted = authoredPictureSource(state, 7);
  assert.ok(trusted !== undefined, "the edited annotated source still compiles to its resource");
  assert.match(trusted, /# @item oak-tree "Oak tree" art/);
  assert.match(trusted, /line 1,3 4,3/);
  const parsed = parsePictureDocument(trusted);
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(
    parsed.document.items.map((item) => item.id),
    ["background", "oak-tree"],
  );
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

test("a source revision covers what its text depends on, not unrelated vocabulary or bindings", () => {
  // Every Genesis benchmark lane paid a repair turn here: it read logic 0,
  // registered more words, then edited with the revision it had read.
  const state = createAgentSessionState();
  assert.equal(
    executeAgentTool(state, "write_words", { words: ["look"], groups: null }).success,
    true,
  );
  assert.equal(
    executeAuthoringTool(state, "reserve_binding", { kind: "flag", name: "gate_open", id: null })!
      .success,
    true,
  );
  const written = executeAgentTool(state, "write_logic_source", {
    room: 1,
    // Message text is not vocabulary: registering "save" later must not
    // stale this source, which only prints it (as the template's menu does).
    source: 'if (said("look")) { set(gate_open); print("Save"); } return;',
  });
  assert.equal(written.success, true, written.error ?? "");
  const revision = logicRevision(state, 1);

  // Words and bindings the source does not use leave the revision alone.
  assert.equal(
    executeAgentTool(state, "write_words", {
      words: ["look", "lantern", "moat", "read", "save", "notice"],
      groups: null,
    }).success,
    true,
  );
  assert.equal(
    executeAuthoringTool(state, "reserve_binding", { kind: "flag", name: "lamp_lit", id: null })!
      .success,
    true,
  );
  assert.equal(logicRevision(state, 1), revision);
  const edit = executeAuthoringTool(state, "edit_resource_source", {
    kind: "logic",
    num: 1,
    expectedRevision: revision,
    edits: [{ find: "set(gate_open);", replace: "set(gate_open); set(lamp_lit);" }],
  })!;
  assert.equal(edit.success, true, edit.error ?? "");

  // The edit moved the text, so the old revision is stale now.
  const stale = executeAuthoringTool(state, "edit_resource_source", {
    kind: "logic",
    num: 1,
    expectedRevision: revision,
    edits: [{ find: "set(lamp_lit);", replace: "" }],
  })!;
  assert.equal(stale.success, false);
  assert.match(stale.error ?? "", /Source revision changed/);
});

test("assembler errors point at the line the agent wrote, with or without named bindings", () => {
  // The named-binding #define prelude once shifted every reported line: by
  // one with no bindings at all, and by one more per binding.
  const source = "assignn(v40, 1);\nassignn(v41, 300);\nreturn;";
  const state = createAgentSessionState();
  const bare = executeAgentTool(state, "write_logic_source", { room: 1, source });
  assert.match(bare.error ?? "", /AssemblerError: 2:\d+: byte value out of range/);
  for (const name of ["gate_open", "lamp_lit"])
    executeAuthoringTool(state, "reserve_binding", { kind: "flag", name, id: null });
  const bound = executeAgentTool(state, "write_logic_source", { room: 1, source });
  assert.match(bound.error ?? "", /AssemblerError: 2:\d+: byte value out of range/);
});

test("a room's name is its title, and other unknown fields list the ones accepted", () => {
  // Opus named plan rooms `name` in every Genesis benchmark run.
  const state = createAgentSessionState();
  const named = executeAgentTool(state, "update_world", {
    rooms: [{ num: 2, name: "Hall", description: "The great hall.", exits: [] }],
    facts: [],
    quests: [],
  });
  assert.equal(named.success, true, named.error ?? "");
  assert.equal(state.authoring.world.rooms["2"]?.title, "Hall");
  // It also left a stray `name` ("", "x", "unused" or a shorter title) beside
  // a room's real title in every run; the title stands.
  const stray = executeAgentTool(state, "update_world", {
    rooms: [
      { num: 4, title: "The Great Hall", name: "x", description: "", exits: [] },
      { name: "", num: 5, title: "Main Street", description: "", exits: [] },
    ],
    facts: [],
    quests: [],
  });
  assert.equal(stray.success, true, stray.error ?? "");
  assert.equal(state.authoring.world.rooms["4"]?.title, "The Great Hall");
  assert.equal(state.authoring.world.rooms["5"]?.title, "Main Street");
  const labelled = executeAgentTool(state, "update_world", {
    rooms: [{ num: 3, title: "Moat", label: "moat", description: "", exits: [] }],
    facts: [],
    quests: [],
  });
  assert.equal(labelled.success, false);
  assert.match(
    labelled.error ?? "",
    /rooms\[0\]\.label is not a known field \(fields: [^)]*\btitle\b/,
  );
});

test("write_words declares ignored words the parser drops before matching", () => {
  // Opus tried to register "a/an/the/to…" as group 0 twice in the benchmark.
  const state = createAgentSessionState();
  const written = executeAgentTool(state, "write_words", {
    words: ["look", "notice"],
    groups: null,
    ignored: ["a", "the", "at"],
  });
  assert.equal(written.success, true, written.error ?? "");
  assert.equal(state.sources.words.get("the"), 0);
  // An ignored word cannot join a synonym group, and a real word keeps its id.
  const grouped = executeAgentTool(state, "write_words", {
    words: ["the/notice"],
    groups: null,
    ignored: null,
  });
  assert.equal(grouped.success, false);
  assert.match(grouped.error ?? "", /'the' is an ignored word/);
  const moved = executeAgentTool(state, "write_words", {
    words: [],
    groups: null,
    ignored: ["look"],
  });
  assert.equal(moved.success, false);
  assert.match(moved.error ?? "", /'look' is already a word/);
  // A stored test may now phrase its command naturally.
  assert.equal(
    executeAgentTool(state, "write_logic_source", {
      room: 1,
      source: 'if (said("look", "notice")) { print("It reads: help wanted."); } return;',
    }).success,
    true,
  );
});
