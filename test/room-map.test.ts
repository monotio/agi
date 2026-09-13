import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleLogic } from "../src/logic/assembler.ts";
import {
  mergeRoomGraph,
  scanContainerExits,
  scanStaticExits,
  serializeMapSidecar,
  validateMapSidecar,
  type RoomObservation,
} from "../src/agent/roomMap.ts";

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
  const graph = mergeRoomGraph({ journal: [], scans: new Map([[1, scan]]) });
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
  const graph = mergeRoomGraph({ journal: [], scans, shared });
  assert.deepEqual(graph.edges, []);
  const five = graph.nodes.find((n) => n.room === 5);
  assert.equal(five?.staticTarget, true);
  assert.equal(five?.unknownSource, true);
  // Without the call, the same logic attributes its exit to itself.
  const direct = mergeRoomGraph({ journal: [], scans, shared: new Set() });
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
  // A literal assigned var carries the binding to the call site.
  const literal = scanStaticExits(logic("assignn(v12, 7); draw.pic(v12); return;"));
  assert.deepEqual(literal.pictures, [7]);
  // A var write between binding and use clears the claim.
  const clobbered = scanStaticExits(
    logic("assignn(v12, 7); random(1, 9, v12); draw.pic(v12); return;"),
  );
  assert.deepEqual(clobbered.pictures, []);
  // assignv propagates the literal.
  const copied = scanStaticExits(
    logic("assignn(v12, 9); assignv(v13, v12); draw.pic(v13); return;"),
  );
  assert.deepEqual(copied.pictures, [9]);
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
    journal,
    plan: { "1": { title: "First", description: "", exits: { door: 2, back: 2 } } },
    scans: new Map([
      [
        1,
        {
          targets: [{ to: 2 }],
          variableTarget: false,
          pictures: [],
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
  const graph = mergeRoomGraph({ journal: [], scans, shared });
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
