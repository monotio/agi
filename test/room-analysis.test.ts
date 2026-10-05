import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleLogic } from "../src/logic/assembler.ts";
import {
  mergeRoomGraph,
  scanContainerExits,
  scanStaticExits,
  verifyPlanConnections,
} from "../src/agent/roomMap.ts";

function logic(source: string): Uint8Array {
  return assembleLogic(source, { dictionary: new Map() }).payload;
}
function analyze(sources: readonly [number, string][]) {
  const analysis = scanContainerExits(new Map(sources.map(([n, s]) => [n, logic(s)])), undefined, {
    main: true,
  });
  return { ...analysis, graph: mergeRoomGraph({ ...analysis, experience: "create", journal: [] }) };
}
test("variable exits join constant assignments and copy bindings", () => {
  const scan = scanStaticExits(
    logic(
      "if(isset(f1)){assignn(v60,7);}else{assignn(v60,8);}assignv(v61,v60);new.room.v(v61);return;",
    ),
  );
  assert.deepEqual(scan.targets, [{ to: 7 }, { to: 8 }]);
  assert.equal(scan.variableTarget, false);
});
test("a clobbered variable exit stays computed at runtime", () => {
  const scan = scanStaticExits(logic("assignn(v60,7);get.num(1,v60);new.room.v(v60);return;"));
  assert.deepEqual(scan.targets, []);
  assert.equal(scan.variableTarget, true);
});
test("call chains carry arguments and returned assignments into room exits", () => {
  const { graph } = analyze([
    [1, "assignn(v60,7);assignn(v62,9);call.v(v62);new.room.v(v61);return;"],
    [9, "call(10);return;"],
    [10, "assignv(v61,v60);return;"],
  ]);
  assert.deepEqual(graph.edges, [{ from: 1, to: 7, provenance: "static" }]);
});
test("called exits belong to each caller and keep the caller's edge guard", () => {
  const { graph } = analyze([
    [1, "if(v2==4){assignn(v60,7);call(9);}return;"],
    [2, "assignn(v60,8);call(9);return;"],
    [9, "new.room.v(v60);return;"],
  ]);
  assert.deepEqual(graph.edges, [
    { from: 1, to: 7, provenance: "static", label: "left" },
    { from: 2, to: 8, provenance: "static" },
  ]);
});
test("LOGIC 0's room dispatch carries the room's exit variable back to shared code", () => {
  const { graph, shared } = analyze([
    [0, "if(v0==0){new.room(1);}assignn(v76,0);call.v(v0);if(v76>0){new.room.v(v76);}return;"],
    [1, "if(isset(f5)){load.pic(v0);draw.pic(v0);}if(v2==2){assignn(v76,2);}return;"],
    [2, "if(isset(f5)){position(0,10,20);draw(0);}if(v2==4){assignn(v76,1);}return;"],
  ]);
  assert.equal(shared.has(1), false);
  assert.equal(shared.has(2), false);
  assert.deepEqual(
    graph.nodes.map((n) => n.room),
    [1, 2],
  );
  assert.deepEqual(
    graph.edges.map((e) => [e.from, e.to]),
    [
      [1, 2],
      [2, 1],
    ],
  );
});
test("picture loads, entry ego setup and incoming exits detect rooms", () => {
  const { graph } = analyze([
    [1, "assignn(v60,4);load.pic(v60);return;"],
    [2, "if(isset(f5)){position(0,10,20);draw(0);}return;"],
    [3, "new.room(5);return;"],
    [5, "return;"],
    [9, "print(1);return;"],
  ]);
  assert.deepEqual(
    graph.nodes.map((n) => n.room),
    [1, 2, 3, 5],
  );
});
test("a small destination set stored by another logic remains a static candidate", () => {
  const { graph } = analyze([
    [1, "if(isset(f5)){draw.pic(v0);}new.room.v(v60);return;"],
    [9, "assignn(v60,7);return;"],
    [10, "assignn(v60,8);return;"],
  ]);
  assert.deepEqual(
    graph.edges.map((e) => [e.from, e.to]),
    [
      [1, 7],
      [1, 8],
    ],
  );
});
test("unresolved calls and recursive helpers keep the map usable", () => {
  const { graph } = analyze([
    [1, "draw.pic(v0);call(9);call.v(v60);return;"],
    [9, "if(isset(f1)){call(9);}new.room(2);return;"],
  ]);
  assert.ok(graph.edges.some((e) => e.from === 1 && e.to === 2));
  assert.equal(graph.nodes.find((n) => n.room === 1)?.unknownCalls, true);
});

test("plan checks use the caller's variable bindings at a shared exit", () => {
  const logics = new Map([
    [1, logic("assignn(v60,7);call(9);return;")],
    [9, logic("new.room.v(v60);return;")],
  ]);
  const report = verifyPlanConnections(logics, {
    "1": { title: "", description: "", exits: { door: 7 } },
  });
  assert.deepEqual(report.verified, [{ from: 1, name: "door", to: 7 }]);
});

test("large destination sets stay computed instead of expanding every route", () => {
  const choices = Array.from(
    { length: 17 },
    (_, n) => `if(isset(f${n + 1})){assignn(v60,${n + 1});}`,
  ).join("");
  const scan = scanStaticExits(logic(`assignn(v60,0);${choices}new.room.v(v60);return;`));
  assert.equal(scan.variableTarget, true);
});

test("LOGIC 0 can dispatch rooms with literal calls", () => {
  const { graph } = analyze([
    [
      0,
      "if(v0==0){new.room(1);}assignn(v76,0);if(v0==1){call(1);}else{call(2);}if(v76>0){new.room.v(v76);}return;",
    ],
    [1, "draw.pic(v0);assignn(v76,2);return;"],
    [2, "draw.pic(v0);assignn(v76,1);return;"],
  ]);
  assert.deepEqual(
    graph.edges.map((edge) => [edge.from, edge.to]),
    [
      [1, 2],
      [2, 1],
    ],
  );
});

test("room flow reuses a completed entry summary across scans", async () => {
  const { createRoomFlow } = await import("../src/agent/roomFlow.ts");
  const flow = createRoomFlow(
    new Map([
      [1, logic("assignn(v60,7);call(9);new.room.v(v61);return;")],
      [2, logic("assignn(v60,7);call(9);new.room.v(v61);return;")],
      [9, logic("assignv(v61,v60);return;")],
    ]),
  );
  assert.deepEqual(flow.scan(1, 1).targets, [{ to: 7 }]);
  const steps = flow.work.steps;
  assert.deepEqual(flow.scan(1, 1).targets, [{ to: 7 }]);
  assert.equal(flow.work.steps, steps);
  const summaries = flow.work.summaries;
  assert.deepEqual(flow.scan(2, 2).targets, [{ to: 7 }]);
  assert.equal(flow.work.summaries, summaries + 1);
  assert.ok(flow.work.hits >= 2);
});

test("recursive entry summaries keep the caller's cutoff context", async () => {
  const { createRoomFlow } = await import("../src/agent/roomFlow.ts");
  const flow = createRoomFlow(
    new Map([
      [1, logic("call(9);new.room(2);return;")],
      [9, logic("call(1);new.room(3);return;")],
    ]),
  );
  assert.deepEqual(flow.scan(1, 1).targets, [{ to: 3 }]);
  assert.deepEqual(flow.scan(9, 9).targets, [{ to: 2 }]);
});
