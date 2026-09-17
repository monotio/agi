import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildView } from "../src/view/view.ts";
import { Engine } from "../src/runtime/engine.ts";
import { DIRECTION_KEYS, directionForDelta } from "../src/agent/gameTestSteps.ts";
import { searchAnchors, smoothAnchors } from "../src/agent/navigationSearch.ts";
import {
  planWalk,
  walkPlanned,
  renderNavigationSnapshot,
  canWalkDirect,
  type NavigationRun,
} from "../src/agent/navigation.ts";

function world(extra = "", widths = [3]): NavigationRun {
  const game = createContainer();
  game.putResource("picture", 1, Uint8Array.of(0xff));
  game.putResource(
    "view",
    0,
    buildView({
      loops: [
        {
          cels: widths.map((width) => ({
            width,
            height: 2,
            pixels: new Array<number>(width * 2).fill(1),
          })),
        },
      ],
    }),
  );
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
if (!isset(f100)) {
 set(f100); assignn(v0,1); assignn(v10,1); load.pic(v10); draw.pic(v10); show.pic();
 load.view(0); animate.obj(0); set.view(0,0); position(0,10,100); draw(0); accept.input();
 ${extra}
}
return;`,
      { dictionary: new Map() },
    ).payload,
  );
  const keys: number[] = [];
  const engine = new Engine(
    game,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine: () => null,
      takeKeys: () => keys.splice(0),
    },
    new Map(),
  );
  for (let n = 0; n < 3; n++) engine.tick();
  return {
    engine,
    state() {
      const ego = engine.screenObjects[0]!;
      return { room: engine.vars[0]!, x: ego.x, y: ego.y };
    },
    walkTo(x, y, maxTicks = 600) {
      for (let n = 0; n < maxTicks; n++) {
        const ego = engine.screenObjects[0]!;
        const direction = directionForDelta(Math.sign(x - ego.x), Math.sign(y - ego.y));
        if (direction !== engine.vars[6]) {
          const key = direction === 0 ? DIRECTION_KEYS[engine.vars[6]!] : DIRECTION_KEYS[direction];
          if (key !== undefined) keys.push(key);
        }
        engine.tick();
        if (ego.x === x && ego.y === y && engine.vars[6] === 0) return;
      }
      throw new Error("Walk blocked");
    },
  };
}
const target = { x0: 30, x1: 30, y0: 100, y1: 100 };

test("navigation rejects malformed targets instead of searching invalid coordinates", () => {
  const run = world();
  for (const t of [
    { ...target, x0: NaN },
    { ...target, x0: 31 },
    { ...target, y1: 168 },
    { ...target, x0: 0.5 },
  ])
    assert.throws(() => planWalk(run, t), /target/i);
});

test("navigation plans around a baseline wall and executes ordinary movement without planning mutations", () => {
  const run = world();
  // Original synthetic control surface: a finite wall forces a north/south detour.
  for (let y = 95; y <= 105; y++) run.engine.surface.priority[y * 160 + 20] = 0;
  const before = run.engine.serialize();
  const plan = planWalk(run, target);
  assert.equal(plan.found, true);
  assert.ok(plan.waypoints.some((p) => p.y < 95 || p.y > 105));
  assert.deepEqual(run.engine.serialize(), before);
  walkPlanned(run, target);
  assert.deepEqual(run.state(), { room: 1, x: 30, y: 100 });
});

test("navigation rejects a gap narrower than the whole ego footprint", () => {
  const run = world();
  for (let x = 0; x < 160; x++) run.engine.surface.priority[110 * 160 + x] = 0;
  run.engine.surface.priority[110 * 160 + 20] = 4;
  run.engine.surface.priority[110 * 160 + 21] = 4;
  assert.equal(planWalk(run, { x0: 10, x1: 10, y0: 120, y1: 120 }).found, false);
  run.engine.surface.priority[110 * 160 + 22] = 4;
  assert.equal(planWalk(run, { x0: 10, x1: 10, y0: 120, y1: 120 }).found, true);
});

test("navigation honors conditional blocks and propagates driver failures", () => {
  const blocked = world();
  for (let y = 0; y < 168; y++) blocked.engine.surface.priority[y * 160 + 20] = 1;
  assert.equal(planWalk(blocked, target).found, false);
  const ignored = world("ignore.blocks(0);");
  for (let y = 0; y < 168; y++) ignored.engine.surface.priority[y * 160 + 20] = 1;
  assert.equal(planWalk(ignored, target).found, true);
  const failure = new Error("driver failed");
  ignored.walkTo = () => {
    throw failure;
  };
  assert.throws(
    () => walkPlanned(ignored, target),
    (e) => e === failure,
  );
});

test("navigation does not execute another waypoint after an unexpected room transition", () => {
  const run = world();
  for (let y = 95; y <= 105; y++) run.engine.surface.priority[y * 160 + 20] = 0;
  let calls = 0;
  run.walkTo = () => {
    calls++;
    run.engine.vars[0] = 2;
  };
  assert.throws(() => walkPlanned(run, target), /room/i);
  assert.equal(calls, 1);
});

test("navigation snapshot produces a PNG and separate JSON sidecar", () => {
  const run = world();
  const snapshot = renderNavigationSnapshot(run, target);
  assert.equal(Buffer.from(snapshot.png).readUInt32BE(16), 640);
  assert.equal(Buffer.from(snapshot.png).readUInt32BE(20), 336);
  assert.equal(JSON.parse(snapshot.json).plan.found, true);
});

test("navigation collapses direct lines of sight into a single waypoint without micro-steps", () => {
  const run = world();
  const directTarget = { x0: 50, x1: 50, y0: 125, y1: 125 };
  const plan = planWalk(run, directTarget);
  assert.equal(plan.found, true);
  assert.equal(plan.waypoints.length, 1);
  assert.deepEqual(plan.waypoints[0], { x: 50, y: 125 });
});

test("navigation respects avoidTriggers option to route around trigger lines", () => {
  const run = world();
  // Place a trigger line (control color 2) from y=95 to y=105 at x=20.
  for (let y = 95; y <= 105; y++) run.engine.surface.priority[y * 160 + 20] = 2;
  const normalPlan = planWalk(run, target);
  assert.equal(normalPlan.found, true);
  // Default allows crossing triggers in a single line-of-sight step.
  assert.equal(normalPlan.waypoints.length, 1);

  const safePlan = planWalk(run, target, { avoidTriggers: true });
  assert.equal(safePlan.found, true);
  // With avoidTriggers, it must detour around the line.
  assert.ok(safePlan.waypoints.some((p) => p.y < 95 || p.y > 105));
});

test("clearance preference survives smoothing in a nine-row corridor without adding movement", () => {
  const run = world();
  run.engine.surface.priority.fill(0);
  for (let y = 100; y <= 108; y++) run.engine.surface.priority.fill(4, y * 160, (y + 1) * 160);
  const goal = { x0: 100, x1: 100, y0: 100, y1: 100 };
  const plan = planWalk(run, goal, { desiredClearance: 5 });
  assert.equal(plan.found, true);
  assert.ok(
    plan.waypoints.some((p) => p.y === 104),
    "route must use the corridor center",
  );
  let { x, y } = plan.from;
  const clearance: number[] = [];
  for (const point of plan.waypoints) {
    while (x !== point.x || y !== point.y) {
      x += Math.sign(point.x - x);
      y += Math.sign(point.y - y);
      clearance.push(Math.min(y - 99, 109 - y));
    }
  }
  assert.equal(clearance.length, 90, "diagonal entry/exit need no extra movement updates");
  assert.ok(clearance.reduce((sum, c) => sum + c, 0) / clearance.length > 4.7);
  walkPlanned(run, goal, { desiredClearance: 5 });
  assert.deepEqual(run.state(), { room: 1, x: 100, y: 100 });
});

test("direct traces reject an unreachable shortened final step", () => {
  const valid = new Uint8Array(160 * 168).fill(1);
  assert.equal(
    canWalkDirect(
      10,
      100,
      13,
      100,
      2,
      157,
      37,
      valid,
      { width: 3, observeBlocks: true, observeObjects: true },
      { blockEnabled: false, blockLeft: 0, blockRight: 0, blockTop: 0, blockBottom: 0 },
      () => false,
      [],
    ),
    false,
  );
  const run = world("assignn(v20,2); step.size(0,v20);");
  assert.equal(planWalk(run, { x0: 13, x1: 13, y0: 100, y1: 100 }).found, false);
  const plan = planWalk(run, { x0: 14, x1: 14, y0: 100, y1: 100 });
  assert.equal(plan.found, true);
  walkPlanned(run, { x0: 14, x1: 14, y0: 100, y1: 100 });
  assert.equal(run.state().x, 14);
});

test("current-width mode keeps a one-anchor passage legal despite wider animation cels", () => {
  const run = world("stop.cycling(0);", [3, 7]);
  run.engine.surface.priority.fill(0);
  for (let y = 90; y <= 120; y++) run.engine.surface.priority.fill(4, y * 160 + 10, y * 160 + 13);
  const goal = { x0: 10, x1: 10, y0: 120, y1: 120 };
  assert.equal(planWalk(run, goal).found, false);
  const plan = planWalk(run, goal, { geometry: "current" });
  assert.equal(plan.found, true);
  assert.deepEqual(plan.waypoints, [{ x: 10, y: 120 }]);
  walkPlanned(run, goal, { geometry: "current" });
  assert.equal(run.state().y, 120);
});

test("bounded search distinguishes exhausted work from unreachable geometry", () => {
  const run = world();
  const plan = planWalk(run, target, { maxSearchNodes: 1 });
  assert.equal(plan.found, false);
  assert.equal(plan.searchStatus, "budget_exhausted");
  assert.equal(plan.cells, 1);
});

test("turn costs keep distinct arrivals at the same anchor and smoothing preserves the chosen headings", () => {
  const anchor = (x: number, y: number) => y * 160 + x;
  // Both approaches cost four moves and one turn to (14,102). Only the lower
  // approach arrives pointing east, avoiding another turn on the final two moves.
  const upper = [
    [10, 100],
    [11, 100],
    [12, 100],
    [13, 101],
    [14, 102],
    [15, 102],
    [16, 102],
  ];
  const lower = [
    [10, 100],
    [11, 101],
    [12, 102],
    [13, 102],
    [14, 102],
    [15, 102],
    [16, 102],
  ];
  const edges = new Map<number, Set<number>>();
  for (const path of [upper, lower]) {
    for (let i = 1; i < path.length; i++) {
      const from = anchor(path[i - 1]![0]!, path[i - 1]![1]!);
      const to = anchor(path[i]![0]!, path[i]![1]!);
      const destinations = edges.get(from) ?? new Set<number>();
      destinations.add(to);
      edges.set(from, destinations);
    }
  }
  const canStep = (from: number, to: number) => edges.get(from)?.has(to) ?? false;
  const clearance = new Uint16Array(160 * 168).fill(5);
  const options = { desiredClearance: 5, clearanceWeight: 1, turnCost: 5, maxSearchNodes: 100 };
  const result = searchAnchors(
    anchor(10, 100),
    { x0: 16, x1: 16, y0: 102, y1: 102 },
    1,
    clearance,
    canStep,
    options,
  );
  const smoothed = smoothAnchors(result.chain, 1, clearance, canStep, options);
  assert.equal(result.status, "found");
  assert.equal(smoothed.steps, 6);
  assert.equal(smoothed.cost, 11, "six moves plus exactly one five-unit turn");
  assert.deepEqual(smoothed.waypoints, [
    { x: 12, y: 102 },
    { x: 16, y: 102 },
  ]);
});
