import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleLogic } from "../src/logic/assembler.ts";
import {
  mergeRoomGraph,
  scanContainerExits,
  scanStaticExits,
  serializeMapSidecar,
  validateMapSidecar,
  verifyPlanConnections,
  type RoomObservation,
} from "../src/agent/roomMap.ts";
import { roomPictureUse } from "../src/agent/roomPictures.ts";

const dict = new Map<string, number>();

function logic(source: string): Uint8Array {
  return assembleLogic(source, { dictionary: dict }).payload;
}

function entry(partial: Partial<RoomObservation>): RoomObservation {
  return {
    seq: 0,
    session: 1,
    from: null,
    to: 1,
    cause: "logic",
    cycle: 0,
    resourceSet: "0-00000000",
    scoreDelta: 0,
    gained: [],
    lost: [],
    ...partial,
  };
}

test("static scan finds literal targets, including inside conditionals", () => {
  const scan = scanStaticExits(logic("if (isset(f1)) { new.room(7); } new.room(3); return;"));
  assert.deepEqual(scan.targets, [{ to: 7 }, { to: 3 }]);
  assert.equal(scan.variableTarget, false);
});

test("a v2 guard names the exit edge — KQ1's courtyard directions", () => {
  // Room 1's logic: left edge → 2, right → 8, top → 16. The label on a
  // static edge is what lets the map place the target on the named side.
  const scan = scanStaticExits(
    logic("if(v2==4){new.room(2);} if(v2==2){new.room(8);} if(v2==1){new.room(16);} return;"),
  );
  assert.deepEqual(scan.targets, [
    { to: 2, edge: "left" },
    { to: 8, edge: "right" },
    { to: 16, edge: "top" },
  ]);
  const graph = mergeRoomGraph({
    experience: "create",
    journal: [],
    scans: new Map([[1, scan]]),
  });
  const edge = graph.edges.find((e) => e.from === 1 && e.to === 2);
  assert.equal(edge?.provenance, "static");
  assert.equal(edge?.label, "left");
});

test("guards that do not pin a single edge leave the exit unlabeled", () => {
  // An OR between two edges: either could have fired.
  const ambiguous = scanStaticExits(logic("if(v2==4 || v2==2){new.room(2);} return;"));
  assert.deepEqual(ambiguous.targets, [{ to: 2 }]);
  // The else branch runs when v2 is NOT 4 — no single edge to name.
  const elseBranch = scanStaticExits(logic("if(v2==4){new.room(2);}else{new.room(8);} return;"));
  assert.deepEqual(elseBranch.targets, [{ to: 2, edge: "left" }, { to: 8 }]);
  // A conjunct still pins the edge: v2==4 must hold for the then-block.
  const conjunct = scanStaticExits(logic("if(v2==4 && isset(f5)){new.room(2);} return;"));
  assert.deepEqual(conjunct.targets, [{ to: 2, edge: "left" }]);
});

test("a computed room target is a variable exit, never an asserted route", () => {
  const scan = scanStaticExits(logic("assignn(v10, 7); new.room.v(v10); return;"));
  assert.deepEqual(scan.targets, []);
  assert.equal(scan.variableTarget, true);
  const graph = mergeRoomGraph({
    experience: "create",
    journal: [],
    scans: new Map([[2, scan]]),
  });
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.nodes.find((n) => n.room === 2)?.variableExit, true);
});

test("a shared logic's transitions are not attributed to its number", () => {
  // Logic 9 is reached through call: its new.room runs in the caller's room.
  const logics = new Map<number, Uint8Array>([
    [1, logic("call(9); return;")],
    [9, logic("new.room(5); return;")],
  ]);
  const { scans, shared } = scanContainerExits(logics);
  assert.ok(shared.has(9));
  const graph = mergeRoomGraph({
    experience: "create",
    journal: [],
    scans,
    shared,
  });
  assert.deepEqual(graph.edges, []);
  const five = graph.nodes.find((n) => n.room === 5);
  assert.equal(five?.staticTarget, true);
  assert.equal(five?.unknownSource, true);
  // Without the call, the same logic attributes its exit to itself.
  const direct = mergeRoomGraph({
    experience: "create",
    journal: [],
    scans,
    shared: new Set(),
  });
  assert.deepEqual(direct.edges, [{ from: 9, to: 5, provenance: "static" }]);
});

test("picture use is a literal var binding, not a guess", () => {
  // The AGI convention: v0 is the interpreter's room variable, so room
  // logic 4's load.pic(v0) names picture 4 — but only with selfRoom set.
  const conventional = scanStaticExits(
    logic("load.pic(v0); draw.pic(v0); show.pic(); return;"),
    undefined,
    4,
  );
  assert.deepEqual(conventional.pictures, [4]);
  // Without the self-room seed v0 is unbound: the scan claims nothing.
  const unbound = scanStaticExits(logic("load.pic(v0); draw.pic(v0); return;"));
  assert.deepEqual(unbound.pictures, []);
  // …but it records that a draw happened with a number chosen at runtime.
  assert.equal(unbound.unresolvedPicture, true);
  assert.equal(conventional.unresolvedPicture, false);
  // A literal assigned var carries the binding to the call site.
  const literal = scanStaticExits(logic("assignn(v12, 7); draw.pic(v12); return;"));
  assert.deepEqual(literal.pictures, [7]);
  // A var write between binding and use clears the claim.
  const clobbered = scanStaticExits(
    logic("assignn(v12, 7); random(1, 9, v12); draw.pic(v12); return;"),
  );
  assert.deepEqual(clobbered.pictures, []);
  assert.equal(clobbered.unresolvedPicture, true);
  // assignv propagates the literal.
  const copied = scanStaticExits(
    logic("assignn(v12, 9); assignv(v13, v12); draw.pic(v13); return;"),
  );
  assert.deepEqual(copied.pictures, [9]);
});

test("room pictures come from literal draws, never the room number", () => {
  // Room 1 and room 6 both draw PIC 5; room 2 draws its own number through
  // the v0 convention; room 3 picks its picture at runtime; room 4 draws
  // nothing itself but calls a helper that might; logic 9 is that helper.
  const logics = new Map<number, Uint8Array>([
    [1, logic("assignn(v10, 5); load.pic(v10); draw.pic(v10); return;")],
    [2, logic("load.pic(v0); draw.pic(v0); return;")],
    [3, logic("random(1, 3, v10); load.pic(v10); draw.pic(v10); return;")],
    [4, logic("call(9); return;")],
    [6, logic("assignn(v11, 5); draw.pic(v11); assignn(v11, 7); overlay.pic(v11); return;")],
    [9, logic("assignn(v12, 5); draw.pic(v12); return;")],
  ]);
  const { scans, shared } = scanContainerExits(logics);
  const input = { scans, shared, pictures: new Set([2, 5, 8]) };
  assert.deepEqual(roomPictureUse(1, input), {
    built: true,
    pictures: [{ picture: 5, exists: true, sharedWith: [6] }],
    runtime: false,
  });
  assert.deepEqual(roomPictureUse(2, input).pictures, [
    { picture: 2, exists: true, sharedWith: [] },
  ]);
  assert.deepEqual(roomPictureUse(3, input), { built: true, pictures: [], runtime: true });
  assert.deepEqual(roomPictureUse(4, input), { built: true, pictures: [], runtime: true });
  // PIC 7 is drawn but missing from the resources: named, not existing.
  assert.deepEqual(roomPictureUse(6, input).pictures, [
    { picture: 5, exists: true, sharedWith: [1] },
    { picture: 7, exists: false, sharedWith: [] },
  ]);
  // A called logic's draws belong to its caller's room: no claim, runtime.
  assert.deepEqual(roomPictureUse(9, input), { built: true, pictures: [], runtime: true });
  // A room without logic is not built and draws nothing.
  assert.deepEqual(roomPictureUse(12, input), { built: false, pictures: [], runtime: false });
});

test("indirect and read-result writes clobber the var they actually write", () => {
  // rindirect(v12, v20) is vars[v12] = vars[vars[v20]] — v12 is overwritten
  // with an unknown, so the draw is unclaimed.
  assert.deepEqual(
    scanStaticExits(logic("assignn(v12, 7); rindirect(v12, v20); draw.pic(v12); return;")).pictures,
    [],
  );
  // get.room.v(v20, v12) writes its second operand — same outcome.
  assert.deepEqual(
    scanStaticExits(logic("assignn(v12, 7); get.room.v(v20, v12); draw.pic(v12); return;"))
      .pictures,
    [],
  );
  // Writes to other vars leave the binding: rindirect's read side is operand 1.
  assert.deepEqual(
    scanStaticExits(logic("assignn(v12, 7); rindirect(v20, v12); draw.pic(v12); return;")).pictures,
    [7],
  );
  // The object-query family writes operand 1 too.
  assert.deepEqual(
    scanStaticExits(logic("assignn(v12, 7); current.view(o5, v12); draw.pic(v12); return;"))
      .pictures,
    [],
  );
});

test("observed, planned and static exits between the same pair all survive", () => {
  const journal = [
    entry({ seq: 0, from: null, to: 1, cause: "boot" }),
    entry({ seq: 1, from: 1, to: 2, cause: "edge", edge: "right" }),
    entry({ seq: 2, from: 1, to: 2, cause: "edge", edge: "right" }),
    entry({ seq: 3, from: 2, to: 2, cause: "logic" }), // self-loop
    entry({ seq: 4, from: 2, to: 1, cause: "restore" }), // never a walkable exit
    entry({ seq: 5, from: 2, to: 1, cause: "edge", edge: "left" }),
  ];
  const graph = mergeRoomGraph({
    experience: "create",
    journal,
    plan: { "1": { title: "First", description: "", exits: { door: 2, back: 2 } } },
    scans: new Map([
      [
        1,
        {
          targets: [{ to: 2 }],
          variableTarget: false,
          pictures: [],
          unresolvedPicture: false,
          calls: [],
          unresolvedCall: false,
        },
      ],
    ]),
    shared: new Set(),
  });
  // Two planned exits to room 2 keep their labels; the observed edge counts
  // its traversals; the static candidate is its own edge; the self-loop and
  // the restore are separated correctly.
  assert.deepEqual(
    graph.edges.filter((e) => e.provenance === "planned").map((e) => e.label),
    ["door", "back"],
  );
  const walked = graph.edges.filter((e) => e.provenance === "observed");
  assert.deepEqual(walked, [
    { from: 1, to: 2, provenance: "observed", label: "right", count: 2 },
    { from: 2, to: 2, provenance: "observed", count: 1 },
    { from: 2, to: 1, provenance: "observed", label: "left", count: 1 },
  ]);
  assert.deepEqual(
    graph.edges.filter((e) => e.provenance === "static"),
    [{ from: 1, to: 2, provenance: "static" }],
  );
  const two = graph.nodes.find((n) => n.room === 2);
  assert.equal(two?.visits, 3);
  assert.equal(two?.title, undefined);
});

test("a node exists with no observations, plan entry or resource", () => {
  const graph = mergeRoomGraph({
    experience: "create",
    journal: [],
    plan: { "4": { title: "Empty", description: "", exits: {} } },
  });
  const four = graph.nodes.find((n) => n.room === 4)!;
  assert.equal(four.observed, false);
  assert.equal(four.planned, true);
  assert.equal(four.authored, false);
  assert.equal(four.picture, false);
});

test("a resource alone is not room evidence — it annotates established nodes", () => {
  const graph = mergeRoomGraph({
    experience: "create",
    journal: [entry({ seq: 0, to: 1, cause: "boot" })],
    scans: new Map(),
    resources: { logic: new Set([1, 42]), picture: new Set([99]) },
  });
  const one = graph.nodes.find((n) => n.room === 1)!;
  assert.equal(one.authored, true, "logic 1 annotates the visited room");
  // Logic 42 and picture 99 exist but nothing establishes them as rooms.
  assert.equal(
    graph.nodes.find((n) => n.room === 42),
    undefined,
  );
  assert.equal(
    graph.nodes.find((n) => n.room === 99),
    undefined,
  );
  assert.deepEqual(
    graph.nodes.map((n) => n.room),
    [1],
  );
});

test("a debug jump is journal fact, never a traversable edge", () => {
  const graph = mergeRoomGraph({
    experience: "create",
    journal: [
      entry({ seq: 0, to: 1, cause: "boot" }),
      entry({ seq: 1, from: 1, to: 8, cause: "jump" }),
      entry({ seq: 2, from: 8, to: 3, cause: "edge", edge: "left" }),
    ],
  });
  // The jump keeps both rooms observed but adds no edge.
  assert.ok(graph.nodes.find((n) => n.room === 8)?.observed);
  assert.equal(
    graph.edges.find((e) => e.from === 1 && e.to === 8),
    undefined,
  );
  assert.deepEqual(graph.edges, [
    { from: 8, to: 3, provenance: "observed", label: "left", count: 1 },
  ]);
});

test("call.v resolves through a literal binding; unresolved calls stay unknown", () => {
  const logics = new Map<number, Uint8Array>([
    [0, logic("assignn(v20, 42); call.v(v20); return;")],
    [42, logic("new.room(7); return;")],
    [3, logic("call.v(v21); return;")],
  ]);
  const { scans, shared } = scanContainerExits(logics);
  // The resolved call marks 42 as shared: its new.room runs in the caller's room.
  assert.ok(shared.has(42));
  assert.equal(scans.get(3)?.unresolvedCall, true);
  const graph = mergeRoomGraph({
    experience: "create",
    journal: [],
    scans,
    shared,
  });
  assert.equal(graph.nodes.find((n) => n.room === 7)?.unknownSource, true);
  assert.equal(graph.nodes.find((n) => n.room === 3)?.unknownCalls, true);
  assert.deepEqual(graph.edges, []);
});

test("picture inference is conservative across calls, branches and loads", () => {
  // A call between binding and use can rewrite the var — no claim.
  const called = scanStaticExits(
    logic("assignn(v12, 7); call(42); draw.pic(v12); return;"),
    undefined,
    4,
  );
  assert.deepEqual(called.pictures, []);
  // A divergent branch leaves the binding ambiguous at the join.
  const branched = scanStaticExits(
    logic("assignn(v12, 7); if (isset(f1)) { assignn(v12, 9); } draw.pic(v12); return;"),
    undefined,
    4,
  );
  assert.deepEqual(branched.pictures, []);
  // Loading and discarding a picture renders nothing — not evidence.
  const loaded = scanStaticExits(
    logic("assignn(v12, 7); load.pic(v12); discard.pic(v12); return;"),
    undefined,
    4,
  );
  assert.deepEqual(loaded.pictures, []);
  // An untouched binding across a branch that writes another var still holds.
  const clean = scanStaticExits(
    logic("assignn(v12, 7); if (isset(f1)) { assignn(v5, 1); } draw.pic(v12); return;"),
    undefined,
    4,
  );
  assert.deepEqual(clean.pictures, [7]);
});

test("the discovery aggregate preserves evicted journal facts", () => {
  const graph = mergeRoomGraph({
    experience: "create",
    // The journal evicted everything — the aggregate still reports the facts.
    journal: [],
    discovered: {
      rooms: { "1": 4, "8": 2 },
      edges: [{ from: 1, to: 8, label: "right", count: 3 }],
    },
  });
  assert.equal(graph.nodes.find((n) => n.room === 1)?.visits, 4);
  assert.deepEqual(graph.edges, [
    { from: 1, to: 8, provenance: "observed", label: "right", count: 3 },
  ]);
  // Journal entries the aggregate already counts merge by max, never sum.
  const merged = mergeRoomGraph({
    experience: "create",
    journal: [
      entry({ seq: 0, to: 1, cause: "boot" }),
      entry({ seq: 1, from: 1, to: 8, cause: "edge", edge: "right" }),
      entry({ seq: 2, from: 1, to: 8, cause: "edge", edge: "right" }),
    ],
    discovered: {
      rooms: { "1": 4, "8": 2 },
      edges: [{ from: 1, to: 8, label: "right", count: 3 }],
    },
  });
  assert.equal(merged.edges.find((e) => e.from === 1 && e.to === 8)?.count, 3);
});

test("coverage marks the rooms its evidence names, never a transition", () => {
  const graph = mergeRoomGraph({
    experience: "create",
    journal: [
      entry({ seq: 0, to: 1, cause: "boot" }),
      entry({ seq: 1, from: 1, to: 3, cause: "edge", edge: "right" }),
    ],
    coverage: {
      playtested: new Set([1, 3]),
      referenced: new Set([1, 5]),
    },
  });
  const one = graph.nodes.find((n) => n.room === 1)!;
  assert.equal(one.playtested, true);
  assert.equal(one.referenced, true);
  assert.equal(graph.nodes.find((n) => n.room === 3)?.playtested, true);
  // Coverage never invents a node: 5 has no other evidence.
  assert.equal(
    graph.nodes.find((n) => n.room === 5),
    undefined,
  );
  // Neither artifact records transitions — no edge flag exists to set.
  const edge = graph.edges.find((e) => e.from === 1 && e.to === 3)!;
  assert.equal(Object.hasOwn(edge, "tested"), false);
});

test("sidecar round-trips and rejects malformed or oversized data", () => {
  const journal = [
    entry({ seq: 0, to: 1, cause: "boot" }),
    entry({ seq: 1, from: 1, to: 2, cause: "edge", edge: "right", scoreDelta: 3, gained: [4] }),
  ];
  const sidecar = {
    journal,
    discovered: {
      rooms: { "1": 1, "2": 1 },
      edges: [{ from: 1, to: 2, label: "right", count: 1 }],
    },
    layout: { "1": { x: 40, y: 80 } },
    notes: { "1": "start here" },
    edgeNotes: {},
  };
  const parsed = validateMapSidecar(JSON.parse(JSON.stringify(serializeMapSidecar(sidecar))));
  assert.equal(parsed.journal.length, 2);
  assert.deepEqual(parsed.journal[1]!.gained, [4]);
  assert.deepEqual(parsed.layout["1"], { x: 40, y: 80 });

  const bad = (patch: Record<string, unknown>) =>
    JSON.parse(JSON.stringify({ format: "monotio.agi.map", version: 1, ...patch }));
  assert.throws(() => validateMapSidecar(bad({ journal: [entry({ to: 999 })] })), /room number/);
  assert.throws(() => validateMapSidecar(bad({ journal: [entry({}), entry({})] })), /Duplicate/);
  assert.throws(() => validateMapSidecar(bad({ layout: { "1": { x: NaN, y: 0 } } })), /position/);
  assert.throws(
    () =>
      validateMapSidecar({
        format: "monotio.agi.map",
        version: 2,
        journal: [],
      }),
    /version/,
  );
  // A missing sidecar is an empty map — the caller checks before validating.
});

// ---- experience policy --------------------------------
//
// Classic play shows discovered places and observed crossings only; the
// creator view adds plan intent and technical status on top of the same
// facts. Nothing below rewrites the facts — the filter withholds disclosure.

test("the play experience shows discovered places and observed crossings only", () => {
  const journal = [
    entry({ seq: 0, to: 1, cause: "boot" }),
    entry({ seq: 1, from: 1, to: 2, cause: "edge", edge: "right" }),
  ];
  const input = {
    journal,
    plan: {
      "1": { title: "The Clearing", description: "", exits: { east: 2 } },
      "2": { title: "The Hall", description: "", exits: { north: 9 } },
      "9": { title: "The Vault", description: "The prize waits inside.", exits: {} },
    },
    scans: new Map([
      [
        2,
        {
          targets: [{ to: 9 }],
          variableTarget: false,
          pictures: [],
          unresolvedPicture: false,
          calls: [],
          unresolvedCall: false,
        },
      ],
    ]),
    shared: new Set<number>(),
    resources: { logic: new Set([1, 2, 9]), picture: new Set([1, 2, 9]) },
    coverage: { playtested: new Set([1, 9]), referenced: new Set([3]) },
  };
  // The creator map carries everything: the unvisited vault, its planned
  // route and its compiled-but-uncrossed transition.
  const create = mergeRoomGraph({ ...input, experience: "create" });
  assert.ok(create.nodes.find((n) => n.room === 9)?.planned);
  assert.ok(create.edges.some((e) => e.provenance === "planned" && e.to === 9));
  assert.ok(create.edges.some((e) => e.provenance === "static" && e.to === 9));
  assert.ok(create.nodes.find((n) => n.room === 9)?.playtested);

  const play = mergeRoomGraph({ ...input, experience: "play" });
  assert.deepEqual(
    play.nodes.map((n) => n.room),
    [1, 2],
    "only visited rooms appear",
  );
  assert.deepEqual(play.edges, [
    { from: 1, to: 2, provenance: "observed", label: "right", count: 1 },
  ]);
  const one = play.nodes.find((n) => n.room === 1)!;
  assert.equal(one.title, "The Clearing", "a visited room keeps its plan title");
  for (const flag of [
    "planned",
    "authored",
    "picture",
    "staticTarget",
    "variableExit",
    "unknownSource",
    "unknownCalls",
    "referenced",
    "playtested",
  ] as const)
    assert.equal(one[flag], false, `play mode withholds the '${flag}' status`);
  // A plan title for an unvisited room reveals nothing: room 9 is absent.
  assert.equal(
    play.nodes.find((n) => n.room === 9),
    undefined,
  );
});

test("the play experience keeps durable discovery without journal detail", () => {
  const play = mergeRoomGraph({
    journal: [],
    discovered: {
      rooms: { "1": 4, "8": 2 },
      edges: [{ from: 1, to: 8, label: "right", count: 3 }],
    },
    plan: { "9": { title: "Hidden", description: "", exits: { in: 1 } } },
    experience: "play",
  });
  assert.deepEqual(
    play.nodes.map((n) => n.room),
    [1, 8],
  );
  assert.equal(play.nodes.find((n) => n.room === 1)?.visits, 4);
  assert.deepEqual(play.edges, [
    { from: 1, to: 8, provenance: "observed", label: "right", count: 3 },
  ]);
});

// ---- declared exits vs compiled transitions ---------------------------------

test("verifyPlanConnections verifies reachable exits and reports the rest", () => {
  const logics = new Map<number, Uint8Array>([
    // Direct literal transition.
    [1, logic("if (v2 == 2) { new.room(2); } return;")],
    // Room 2 reaches its exit through a shared door logic.
    [2, logic("if (v2 == 2) { call(40); } return;")],
    // Room 3 declares an exit its logic never implements.
    [3, logic("new.room(5); return;")],
    // Room 5's transition is computed — undecidable, never guessed.
    [5, logic("assignn(v9, 6); new.room.v(v9); return;")],
    [40, logic("new.room(7); return;")],
  ]);
  const plan = {
    "1": { title: "", description: "", exits: { east: 2 } },
    "2": { title: "", description: "", exits: { portal: 7 } },
    "3": { title: "", description: "", exits: { door: 6 } },
    "5": { title: "", description: "", exits: { chute: 6 } },
    // Room 8 is declared but not built — intent, not a defect.
    "8": { title: "", description: "", exits: { out: 1 } },
  };
  const report = verifyPlanConnections(logics, plan);
  assert.deepEqual(report.verified, [
    { from: 1, name: "east", to: 2 },
    { from: 2, name: "portal", to: 7 },
  ]);
  assert.deepEqual(report.missing, [{ from: 3, name: "door", to: 6 }]);
  assert.deepEqual(report.pending, [{ from: 8, name: "out", to: 1 }]);
  assert.equal(report.unverifiable.length, 1);
  assert.equal(report.unverifiable[0]!.from, 5);
});

test("verifyPlanConnections checks a declared direction against the compiled edge", () => {
  // Room 1's logic exits left to room 2 — the v2 guard names the edge.
  const logics = new Map<number, Uint8Array>([
    [1, logic("if(v2==4){new.room(2);} if(v2==2){new.room(3);} return;")],
  ]);
  const plan = {
    // The compiled 1->2 transition leaves the left edge, not the declared east.
    "1": { title: "", description: "", exits: { east: 2, right: 3, portal: 3 } },
  };
  const report = verifyPlanConnections(logics, plan);
  assert.deepEqual(report.mismatched, [
    { from: 1, name: "east", to: 2, declared: "right", compiled: "left" },
  ]);
  // "right" agrees with the compiled edge; "portal" is a name, not a
  // direction claim, so its edge is unchecked — both verify.
  assert.deepEqual(report.verified, [
    { from: 1, name: "right", to: 3 },
    { from: 1, name: "portal", to: 3 },
  ]);
  assert.deepEqual(report.missing, []);
});

test("verifyPlanConnections does not let a shared logic answer for its caller", () => {
  // The door logic carries new.room(7); room 2 never calls it.
  const logics = new Map<number, Uint8Array>([
    [2, logic("return;")],
    [40, logic("new.room(7); return;")],
  ]);
  const plan = { "2": { title: "", description: "", exits: { portal: 7 } } };
  const report = verifyPlanConnections(logics, plan);
  assert.deepEqual(report.missing, [{ from: 2, name: "portal", to: 7 }]);
});
