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
  assert.deepEqual(scan.targets, [7, 3]);
  assert.equal(scan.variableTarget, false);
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
    scans: new Map([[1, { targets: [2], variableTarget: false }]]),
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

test("disconnected nodes and resource/picture mismatch are separate facts", () => {
  const graph = mergeRoomGraph({
    journal: [entry({ seq: 0, to: 1, cause: "boot" })],
    scans: new Map(),
    resources: { logic: new Set([1, 8]), picture: new Set([9]) },
  });
  const one = graph.nodes.find((n) => n.room === 1)!;
  const eight = graph.nodes.find((n) => n.room === 8)!;
  const nine = graph.nodes.find((n) => n.room === 9)!;
  assert.equal(one.authored, true);
  assert.equal(eight.authored, true);
  assert.equal(eight.observed, false, "a resource alone is not a visit");
  assert.equal(nine.picture, true);
  assert.equal(nine.authored, false);
});

test("sidecar round-trips and rejects malformed or oversized data", () => {
  const journal = [
    entry({ seq: 0, to: 1, cause: "boot" }),
    entry({ seq: 1, from: 1, to: 2, cause: "edge", edge: "right", scoreDelta: 3, gained: [4] }),
  ];
  const sidecar = {
    journal,
    layout: { "1": { x: 40, y: 80 } },
    notes: { "1": "start here" },
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
