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
  validateWalk,
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
 load.view(0); animate.obj(0); set.view(0,0); position(0,10,100); draw(0); assignn(v200,1); step.size(0,v200); step.time(0,v200); cycle.time(0,v200); accept.input();
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

test("region arrival prefers its reachable center without requiring an exact center", () => {
  const run = world("", [1]);
  const region = { x0: 30, x1: 38, y0: 100, y1: 108 };
  const centered = planWalk(run, region);
  assert.deepEqual(centered.reached, { x: 34, y: 104 });
  assert.equal(centered.steps, 24);
  run.engine.surface.priority[104 * 160 + 34] = 0;
  const obstructed = planWalk(run, region, { clearanceWeight: 0 });
  assert.equal(obstructed.found, true);
  assert.equal(
    Math.max(Math.abs(obstructed.reached.x - 34), Math.abs(obstructed.reached.y - 104)),
    1,
  );
});

test("movement bounds preserve a costly short arrival when a cheaper detour exhausts the allowance", () => {
  const at = (x: number, y: number) => y * 160 + x;
  const short = [
    at(10, 100),
    at(11, 100),
    at(12, 100),
    at(13, 100),
    at(14, 100),
    at(14, 99),
    at(15, 98),
    at(16, 99),
    at(16, 100),
  ];
  const long = [
    at(10, 100),
    at(10, 101),
    at(11, 102),
    at(12, 102),
    at(13, 102),
    at(14, 101),
    at(14, 100),
    at(14, 99),
    at(15, 98),
    at(16, 99),
    at(16, 100),
  ];
  // At the shared (14,100) anchor, both arrivals fit the two-step lower
  // bound. The actual final bend needs four moves, so only the costly
  // four-move arrival can finish within eight moves.
  const edges = new Map<number, Set<number>>();
  for (const path of [short, long])
    for (let i = 1; i < path.length; i++) {
      const next = edges.get(path[i - 1]!) ?? new Set<number>();
      next.add(path[i]!);
      edges.set(path[i - 1]!, next);
    }
  const clearance = new Uint16Array(160 * 168).fill(4);
  for (const anchor of short.slice(1, 4)) clearance[anchor] = 1;
  const canStep = (from: number, to: number) => edges.get(from)?.has(to) ?? false;
  const options = { desiredClearance: 4, clearanceWeight: 1, turnCost: 0, maxSearchNodes: 100 };
  const goal = { x0: 16, x1: 16, y0: 100, y1: 100 };
  assert.deepEqual(searchAnchors(short[0]!, goal, 1, clearance, canStep, options).chain, long);
  const bounded = searchAnchors(short[0]!, goal, 1, clearance, canStep, {
    ...options,
    maxSteps: 8,
  });
  assert.equal(bounded.status, "found");
  assert.deepEqual(bounded.chain, short);
  assert.equal(
    smoothAnchors(bounded.chain, 1, clearance, canStep, { ...options, maxSteps: 8 }).steps,
    8,
  );
  assert.equal(
    searchAnchors(short[0]!, goal, 1, clearance, canStep, { ...options, maxSteps: 7 }).status,
    "movement_budget_exhausted",
  );
});

test("movement limits use full steps, admit zero-step success, and constrain region selection", () => {
  const run = world("assignn(v20,2); step.size(0,v20);", [1]);
  const goal = { x0: 16, x1: 16, y0: 100, y1: 100 };
  assert.equal(planWalk(run, goal, { maxSteps: 2 }).searchStatus, "movement_budget_exhausted");
  assert.equal(planWalk(run, goal, { maxSteps: 3 }).steps, 3);
  assert.equal(planWalk(run, { x0: 10, x1: 14, y0: 100, y1: 104 }, { maxSteps: 0 }).steps, 0);
  const bounded = planWalk(run, { x0: 30, x1: 38, y0: 100, y1: 108 }, { maxSteps: 10 });
  assert.equal(bounded.found, true);
  assert.equal(bounded.steps, 10);
  assert.equal(bounded.reached.x, 30);
  assert.equal(
    planWalk(run, goal, { maxSteps: 3, maxSearchNodes: 1 }).searchStatus,
    "budget_exhausted",
  );
  for (const maxSteps of [-1, 0.5, Infinity])
    assert.throws(() => planWalk(run, goal, { maxSteps }), /options/);
});

test("exit allowance includes every conservative-width approach and clipped crossing update", () => {
  const run = world("stop.cycling(0); assignn(v20,2); step.size(0,v20);", [1, 7]);
  const approach = { x0: 152, x1: 153, y0: 100, y1: 100 };
  // 71 full moves reach x152. Current width one then needs x154,x156,x158,
  // followed by the clipped x159 proposal that sets the east border flag.
  const enough = planWalk(run, approach, { exitDirection: 3, maxSteps: 75 });
  assert.equal(enough.found, true);
  assert.equal(enough.steps, 71);
  assert.equal(enough.terminalSteps, 4);
  assert.equal(
    planWalk(run, approach, { exitDirection: 3, maxSteps: 74 }).searchStatus,
    "movement_budget_exhausted",
  );
});

test("declared anchor exclusions survive smoothing and live trace validation", () => {
  const run = world("", [1]);
  const avoidRegions = [{ x0: 19, x1: 21, y0: 95, y1: 105 }];
  const plan = planWalk(run, target, { avoidRegions, clearanceWeight: 0 });
  assert.equal(plan.found, true);
  assert.ok(plan.waypoints.some((point) => point.y < 95 || point.y > 105));
  assert.equal(validateWalk(run, [{ x: 30, y: 100 }], { avoidRegions }), false);
  assert.equal(validateWalk(run, plan.waypoints, { avoidRegions }), true);
  assert.equal(
    planWalk(run, target, { avoidRegions: [{ x0: 20, x1: 20, y0: 0, y1: 167 }] }).searchStatus,
    "unreachable",
  );
});

test("anchor exclusions reject malformed or excessive rectangles", () => {
  const run = world();
  assert.throws(() => planWalk(run, target, { avoidRegions: [{ ...target, x1: 160 }] }), /target/i);
  assert.throws(
    () => planWalk(run, target, { avoidRegions: new Array(65).fill(target) }),
    /options/i,
  );
});

test("anchor exclusions check each full native update and the clipped exit endpoint", () => {
  const run = world("assignn(v20,2); step.size(0,v20);", [1]);
  const points = [{ x: 14, y: 100 }];
  assert.equal(
    validateWalk(run, points, { avoidRegions: [{ x0: 12, x1: 12, y0: 100, y1: 100 }] }),
    false,
  );
  assert.equal(
    validateWalk(run, points, { avoidRegions: [{ x0: 11, x1: 11, y0: 100, y1: 100 }] }),
    true,
  );
  assert.equal(
    validateWalk(run, points, { avoidRegions: [{ x0: 10, x1: 10, y0: 100, y1: 100 }] }),
    true,
  );
  assert.equal(
    validateWalk(run, [...points, { x: 10, y: 100 }], {
      avoidRegions: [{ x0: 10, x1: 10, y0: 100, y1: 100 }],
    }),
    false,
  );
  const east = { x0: 158, x1: 159, y0: 100, y1: 100 };
  assert.equal(
    planWalk(run, east, {
      exitDirection: 3,
      avoidRegions: [{ x0: 159, x1: 159, y0: 100, y1: 100 }],
    }).found,
    false,
  );
});

test("a relaxed optimum that exceeds the movement allowance falls back within the same search budget", () => {
  const at = (x: number, y: number) => y * 160 + x;
  const short = [at(10, 100), at(11, 100), at(12, 100), at(13, 100), at(14, 100)];
  const long = [at(10, 100)];
  for (let y = 99; y >= 65; y--) long.push(at(10, y));
  for (let x = 11; x <= 14; x++) long.push(at(x, 65));
  for (let y = 66; y <= 100; y++) long.push(at(14, y));
  const edges = new Map<number, Set<number>>();
  for (const path of [short, long])
    for (let i = 1; i < path.length; i++) {
      const next = edges.get(path[i - 1]!) ?? new Set<number>();
      next.add(path[i]!);
      edges.set(path[i - 1]!, next);
    }
  const canStep = (from: number, to: number) => edges.get(from)?.has(to) ?? false;
  const clearance = new Uint16Array(160 * 168).fill(4);
  for (const point of short.slice(1, 4)) clearance[point] = 1;
  const options = { desiredClearance: 4, clearanceWeight: 100, turnCost: 0, maxSearchNodes: 1000 };
  const goal = { x0: 14, x1: 14, y0: 100, y1: 100 };
  const relaxed = searchAnchors(short[0]!, goal, 1, clearance, canStep, options);
  assert.deepEqual(relaxed.chain, long);
  const bounded = searchAnchors(short[0]!, goal, 1, clearance, canStep, {
    ...options,
    maxSteps: 40,
  });
  assert.deepEqual(bounded.chain, short);
  const cap = relaxed.cells + 1;
  const exhausted = searchAnchors(short[0]!, goal, 1, clearance, canStep, {
    ...options,
    maxSteps: 40,
    maxSearchNodes: cap,
  });
  assert.equal(exhausted.status, "budget_exhausted");
  assert.equal(exhausted.cells, cap);
});
