import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildView } from "../src/view/view.ts";
import { Engine } from "../src/runtime/engine.ts";
import {
  NavigationController,
  NavigationError,
  type NavigationGoal,
  type NavigationOptions,
} from "../src/agent/navigationController.ts";

function world(initial = "", ongoing = "", cels = [{ width: 1, height: 1, pixels: [1] }]) {
  const game = createContainer();
  game.putResource("picture", 1, Uint8Array.of(0xff));
  game.putResource("view", 0, buildView({ loops: [{ cels }] }));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
if (!isset(f100)) {
 set(f100); assignn(v0,1); assignn(v10,1); load.pic(v10); draw.pic(v10); show.pic();
 load.view(0); animate.obj(0); set.view(0,0); position(0,10,100); draw(0); accept.input();
 ${initial}
}
${ongoing}
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
  engine.tick();
  engine.tick();
  return { engine, keys };
}
const target: NavigationGoal = { kind: "position", target: { x0: 16, x1: 16, y0: 100, y1: 100 } };
function drive(
  run: ReturnType<typeof world>,
  goal = target,
  options: NavigationOptions = {},
  every = 1,
  beforePoll?: () => void,
) {
  const controller: NavigationController = new NavigationController(run.engine, goal, options);
  let cycles = 0;
  const directions: number[] = [];
  for (let poll = 0; poll < 2000; poll++) {
    beforePoll?.();
    const decision = controller.next({ hostPolls: poll, logicCycles: cycles });
    if (decision.direction !== null) {
      directions.push(decision.direction);
      if (decision.key !== null) run.keys.push(decision.key);
    }
    if (decision.outcome) return { outcome: decision.outcome, directions, controller };
    if ((poll + 1) % every === 0) {
      run.engine.tick();
      cycles++;
    }
  }
  throw new Error("controller did not terminate");
}

test("navigation emits one ordinary heading across host polls and separates movement cadence", () => {
  const result = drive(world("assignn(v50,4); step.time(0,v50);"), target, {}, 3);
  assert.equal(result.outcome.status, "reached");
  assert.deepEqual(result.directions, [3, 0]);
  assert.equal(result.outcome.counters.movementUpdates, 6);
  assert.ok(result.outcome.counters.hostPolls > result.outcome.counters.logicCycles);
  assert.ok(result.outcome.counters.logicCycles > result.outcome.counters.movementUpdates);
});
test("navigation permits movement when parser input is disabled", () => {
  const result = drive(world("prevent.input();"));
  assert.equal(result.outcome.status, "reached");
  assert.equal(result.outcome.inputEnabled, false);
  assert.equal(result.outcome.movementControlEnabled, true);
});

test("planned region goals reach the selected interior endpoint instead of the first edge", () => {
  const result = drive(world(), {
    kind: "position",
    planned: true,
    target: { x0: 16, x1: 24, y0: 100, y1: 100 },
  });
  assert.equal(result.outcome.status, "reached");
  assert.equal(result.outcome.x, 20);
  assert.equal(result.outcome.counters.movementUpdates, 10);
});

test("planning checks the remaining movement allowance before issuing more input", () => {
  const run = world();
  const controller = new NavigationController(
    run.engine,
    { kind: "position", planned: true, target: { x0: 20, x1: 20, y0: 100, y1: 100 } },
    { budgets: { movementUpdates: 10 } },
  );
  for (let cycle = 0; cycle < 2; cycle++) {
    const decision = controller.next({ hostPolls: cycle, logicCycles: cycle });
    if (decision.key !== null) run.keys.push(decision.key);
    run.engine.tick();
  }
  for (let y = 94; y <= 106; y++) run.engine.surface.priority[y * 160 + 15] = 0;
  const decision = controller.next({ hostPolls: 2, logicCycles: 2 });
  assert.equal(decision.outcome?.status, "budget_exhausted");
  assert.equal(decision.outcome.counters.movementUpdates, 2);
  assert.equal(decision.outcome.x, 12);
});
test("navigation reports script ownership separately from parser availability", () => {
  const result = drive(world("program.control();"));
  assert.equal(result.outcome.status, "movement_control_unavailable");
  assert.equal(result.outcome.inputEnabled, true);
  assert.equal(result.outcome.counters.hostPolls, 0);
});
test("navigation counts a wall stall in eligible updates, not slow host polls", () => {
  const run = world("assignn(v50,8); step.time(0,v50);");
  run.engine.surface.priority[100 * 160 + 11] = 0;
  const result = drive(run, target, { stallUpdates: 3 }, 2);
  assert.equal(result.outcome.status, "blocked");
  assert.equal(result.outcome.counters.movementUpdates, 3);
  assert.ok(result.outcome.counters.hostPolls > 16);
});
test("navigation stops on a new modal without automatically dismissing it", () => {
  const result = drive(world("", 'if (posn(0,12,100,20,100)) { print("Choose deliberately"); }'));
  assert.equal(result.outcome.status, "needs_input");
  assert.equal(result.outcome.x, 12);
});
test("navigation recognizes short oscillations before the movement budget", () => {
  const result = drive(
    world("assignn(v50,2); step.size(0,v50);"),
    { kind: "position", target: { x0: 13, x1: 13, y0: 100, y1: 100 } },
    { stallUpdates: 4 },
  );
  assert.equal(result.outcome.status, "blocked");
  assert.match(result.outcome.reason, /oscillat/);
  assert.ok(result.outcome.counters.movementUpdates < 12);
});
test("navigation searches an unchanged impossible model once", () => {
  const run = world();
  for (let y = 0; y < 168; y++) run.engine.surface.priority[y * 160 + 14] = 0;
  const controller: NavigationController = new NavigationController(run.engine, {
    ...target,
    planned: true,
  });
  const first = controller.next({ hostPolls: 0, logicCycles: 0 });
  assert.equal(first.outcome?.status, "unreachable_under_current_model");
  assert.equal(controller.next({ hostPolls: 10, logicCycles: 10 }).outcome?.counters.replans, 0);
});
test("navigation exposes host poll, logic cycle, movement and wall budget exhaustion distinctly", () => {
  for (const metric of ["hostPolls", "logicCycles", "movementUpdates"] as const) {
    const result = drive(world(), target, { budgets: { [metric]: 1 } });
    assert.equal(result.outcome.status, "budget_exhausted");
    assert.match(result.outcome.reason, new RegExp(metric));
  }
  let now = 0;
  const controller: NavigationController = new NavigationController(world().engine, target, {
    now: () => now,
    budgets: { wallMs: 10 },
  });
  controller.next({ hostPolls: 0, logicCycles: 0 });
  now = 10;
  assert.match(controller.next({ hostPolls: 0, logicCycles: 0 }).outcome?.reason ?? "", /wallMs/);
});
test("navigation honors cancellation and hazard predicates before another movement input", () => {
  assert.equal(drive(world(), target, { cancelled: () => true }).outcome.status, "cancelled");
  assert.equal(
    drive(world(), target, { hazard: () => "death flag" }).outcome.status,
    "hazard_detected",
  );
});
test("navigation verifies expected exits and reports unexpected room changes", () => {
  for (const expected of [2, 3]) {
    const run = world("", "if (posn(0,12,0,20,167)) { assignn(v0,2); }");
    const result = drive(run, { kind: "exit", direction: 3, room: expected });
    assert.equal(result.outcome.status, expected === 2 ? "reached" : "unexpected_transition");
    assert.equal(result.outcome.room, 2);
  }
});

test("cancelling before an input phase cancels the queued heading through ordinary keys", () => {
  const run = world();
  let cancelled = false;
  const controller: NavigationController = new NavigationController(run.engine, target, {
    cancelled: () => cancelled,
  });
  const start = controller.next({ hostPolls: 0, logicCycles: 0 });
  assert.notEqual(start.key, null);
  run.keys.push(start.key!);
  cancelled = true;
  const stop = controller.next({ hostPolls: 1, logicCycles: 0 });
  assert.equal(stop.outcome?.status, "cancelled");
  assert.equal(stop.key, start.key);
  run.keys.push(stop.key!);
  run.engine.tick();
  assert.equal(run.engine.screenObjects[0]!.x, 10);
  assert.equal(run.engine.vars[6], 0);
});

test("a changed control surface triggers one replacement search with a separate replan budget", () => {
  for (const replans of [0, 1]) {
    const run = world();
    const controller: NavigationController = new NavigationController(
      run.engine,
      { ...target, planned: true },
      { budgets: { replans } },
    );
    for (let cycle = 0; cycle < 40; cycle++) {
      if (cycle === 2) run.engine.surface.priority[100 * 160 + 14] = 0;
      const result = controller.next({ hostPolls: cycle, logicCycles: cycle });
      if (result.key !== null) run.keys.push(result.key);
      if (result.outcome) {
        assert.equal(result.outcome.status, replans === 0 ? "budget_exhausted" : "reached");
        assert.equal(result.outcome.counters.replans, replans);
        break;
      }
      run.engine.tick();
      assert.ok(cycle < 39, "route terminates");
    }
  }
});

test("waypoint goals share movement accounting and report every completed waypoint", () => {
  const result = drive(world(), {
    kind: "waypoints",
    points: [
      { x: 12, y: 100 },
      { x: 12, y: 103 },
    ],
  });
  assert.equal(result.outcome.status, "reached");
  assert.equal(result.outcome.completedWaypoints, 2);
  assert.equal(result.outcome.counters.movementUpdates, 5);
  assert.deepEqual(result.directions, [3, 5, 0]);
});

test("a cardinal exit plans around obstacles, crosses the boundary, and verifies the destination", () => {
  const run = world("", "if (equaln(v2,2)) { assignn(v0,2); }");
  for (let y = 95; y <= 105; y++) run.engine.surface.priority[y * 160 + 14] = 0;
  const result = drive(run, { kind: "exit", direction: 3, room: 2 });
  assert.equal(result.outcome.status, "reached", JSON.stringify(result.outcome));
  assert.equal(result.outcome.room, 2);
  assert.ok(result.directions.some((direction) => direction !== 3 && direction !== 0));
  assert.equal(result.controller.lastPlan?.found, true);
});

test("automatic drawing priority does not consume replacement searches on a clear vertical route", () => {
  const run = world("position(0,10,40);");
  const result = drive(run, {
    kind: "position",
    planned: true,
    target: { x0: 10, x1: 10, y0: 160, y1: 160 },
  });
  assert.equal(result.outcome.status, "reached");
  assert.equal(result.outcome.counters.replans, 0);
});

test("contributor cancellation records raw queued keys that replay from a cold boot", async () => {
  const { Speedrun } = await import("./speedrun/runner.ts");
  const run = new Speedrun("adventure-department");
  run.advance(10);
  const x = run.state().x;
  const y = run.state().y;
  const result = run.navigate(
    { kind: "position", target: { x0: x + 10, x1: x + 10, y0: y, y1: y } },
    { cancelled: () => run.ticks > 10 },
  );
  assert.equal(result.outcome.status, "cancelled");
  run.advance(20);
  assert.equal(run.state().x, x);
  assert.equal(run.actions.filter((action) => action.kind === "key").length, 2);
  const replay = new Speedrun("adventure-department");
  for (const action of run.actions) {
    if (action.kind === "key") replay.key(action.code);
    else if (action.kind === "advance") replay.advance(action.ticks);
    else assert.fail(`unexpected action ${action.kind}`);
  }
  assert.deepEqual(replay.engine.serialize(), run.engine.serialize());
});

test("distant moving objects do not spend the path replacement budget", () => {
  const run = world(
    "animate.obj(1); set.view(1,0); position(1,80,130); draw(1); assignn(v51,3); set.dir(1,v51);",
  );
  const result = drive(run, {
    kind: "position",
    planned: true,
    target: { x0: 30, x1: 30, y0: 100, y1: 100 },
  });
  assert.equal(result.outcome.status, "reached");
  assert.equal(result.outcome.counters.replans, 0);
});

test("an object entering the remaining route requires a bounded replacement search", () => {
  const run = world("animate.obj(1); set.view(1,0); position(1,80,130); draw(1);");
  const controller: NavigationController = new NavigationController(run.engine, {
    ...target,
    planned: true,
  });
  for (let cycle = 0; cycle < 40; cycle++) {
    if (cycle === 2) {
      run.engine.screenObjects[1]!.x = 14;
      run.engine.screenObjects[1]!.y = 100;
    }
    const decision = controller.next({ hostPolls: cycle, logicCycles: cycle });
    if (decision.key !== null) run.keys.push(decision.key);
    if (decision.outcome) {
      assert.equal(decision.outcome.status, "reached");
      assert.equal(decision.outcome.counters.replans, 1);
      break;
    }
    run.engine.tick();
    assert.ok(cycle < 39, "route terminates");
  }
});

test("an explicit contributor stop consumes navigation's pending stop without toggling movement back on", async () => {
  const { Speedrun } = await import("./speedrun/runner.ts");
  const run = new Speedrun("adventure-department");
  run.advance(10);
  const start = run.state();
  const reached = run.navigate({
    kind: "position",
    target: { x0: start.x + 1, x1: start.x + 1, y0: start.y, y1: start.y },
  });
  assert.equal(reached.outcome.status, "reached");
  assert.equal(run.state().x, start.x + 1);
  assert.notEqual(run.engine.vars[6], 0, "stop remains queued at the goal boundary");
  run.direction(0);
  assert.equal(run.engine.vars[6], 0, "explicit stop synchronously consumes the pending stop");
  run.advance(20);
  assert.equal(run.state().x, start.x + 1, "a duplicate stop cannot resume movement");
});

test("a contributor direction change after a queued navigation stop records replayable ordinary keys", async () => {
  const { Speedrun } = await import("./speedrun/runner.ts");
  const run = new Speedrun("adventure-department");
  run.advance(10);
  const start = run.state();
  const reached = run.navigate({
    kind: "position",
    target: { x0: start.x + 1, x1: start.x + 1, y0: start.y, y1: start.y },
  });
  assert.equal(reached.outcome.status, "reached");
  const previousCycles = run.cycles;
  run.direction("E");
  assert.ok(run.cycles > previousCycles, "pending inputs reach a cycle before returning");
  assert.equal(run.engine.vars[6], 3);
  run.advance(3); // The tutorial's walking cadence can defer the next movement pass.
  assert.equal(run.state().x, start.x + 2);
  run.direction(0);
  const replay = new Speedrun("adventure-department");
  for (const action of run.actions) {
    if (action.kind === "key") replay.key(action.code);
    else if (action.kind === "advance") replay.advance(action.ticks);
    else assert.fail(`unexpected action ${action.kind}`);
  }
  assert.deepEqual(replay.engine.serialize(), run.engine.serialize());
});

for (const edge of [
  { direction: 1, border: 1, x: 10, y: 100, axis: "y", coordinate: 37 },
  { direction: 3, border: 2, x: 10, y: 100, axis: "x", coordinate: 159 },
  { direction: 5, border: 3, x: 10, y: 100, axis: "y", coordinate: 167 },
  { direction: 7, border: 4, x: 11, y: 100, axis: "x", coordinate: 0 },
] as const) {
  test(`planned cardinal exit ${edge.direction} crosses an off-lattice boundary by normal clipping`, () => {
    const run = world(
      `position(0,${edge.x},${edge.y}); assignn(v51,2); step.size(0,v51);`,
      `if (equaln(v2,${edge.border})) { assignn(v0,2); }`,
    );
    const result = drive(run, { kind: "exit", direction: edge.direction, room: 2 });
    assert.equal(result.outcome.status, "reached");
    assert.equal(result.outcome[edge.axis], edge.coordinate);
    assert.equal(result.controller.lastPlan?.found, true);
  });
}

test("navigation resamples wall budget and cancellation after synchronous planning before input", () => {
  const run = world();
  let readings = 0;
  const timed = new NavigationController(
    run.engine,
    { ...target, planned: true },
    {
      now: () => (++readings >= 3 ? 10 : 0),
      budgets: { wallMs: 5 },
    },
  ).next({ hostPolls: 0, logicCycles: 0 });
  assert.equal(timed.outcome?.status, "budget_exhausted");
  assert.equal(timed.outcome.counters.wallMs, 10);
  assert.equal(timed.key, null);
  let cancelled = 0;
  const stopped = new NavigationController(
    run.engine,
    { ...target, planned: true },
    {
      cancelled: () => ++cancelled >= 2,
    },
  ).next({ hostPolls: 0, logicCycles: 0 });
  assert.equal(stopped.outcome?.status, "cancelled");
  assert.equal(stopped.key, null);
});

test("animation inside an unchanged conservative footprint does not spend replans", () => {
  const run = world("", "", [
    { width: 1, height: 1, pixels: [1] },
    { width: 3, height: 2, pixels: [1, 1, 1, 1, 1, 1] },
  ]);
  const result = drive(run, {
    kind: "position",
    planned: true,
    target: { x0: 40, x1: 40, y0: 100, y1: 100 },
  });
  assert.equal(result.outcome.status, "reached");
  assert.equal(result.outcome.counters.replans, 0);
});

test("planned exits select an approach whose clipped terminal footprint is legal", () => {
  for (const wide of [false, true]) {
    const run = world(
      "assignn(v51,2); step.size(0,v51); stop.cycling(0);",
      "if (equaln(v2,2)) { assignn(v0,2); }",
      wide
        ? [
            { width: 1, height: 1, pixels: [1] },
            { width: 5, height: 1, pixels: [1, 1, 1, 1, 1] },
          ]
        : undefined,
    );
    for (let y = 0; y < 168; y++) if (y !== 100) run.engine.surface.priority[y * 160 + 159] = 0;
    const result = drive(run, { kind: "exit", direction: 3, room: 2 });
    assert.equal(result.outcome.status, "reached");
    assert.equal(result.outcome.x, 159);
    assert.equal(result.outcome.y, 100);
  }
});

test("synchronous contributor stop acknowledgement fits both action and global poll budgets", async () => {
  const { Speedrun } = await import("./speedrun/runner.ts");
  for (const global of [false, true]) {
    const run = new Speedrun("adventure-department", 1, global ? { maxTicks: 12 } : {});
    run.advance(10);
    const { x, y } = run.state();
    assert.throws(
      () => run.walkTo(x + 1, y, global ? 3000 : 2),
      (error: unknown) =>
        error instanceof NavigationError &&
        error.outcome.status === "budget_exhausted" &&
        error.outcome.counters.hostPolls === 2,
    );
    assert.equal(run.ticks, 12);
  }
});

test("a changing ceiling bound retains safe traces and rejects newly impossible targets", () => {
  const cels = [
    { width: 1, height: 32, pixels: Array<number>(32).fill(1) },
    { width: 1, height: 33, pixels: Array<number>(33).fill(1) },
  ];
  const far = drive(world("ignore.horizon(0);", "", cels), {
    kind: "position",
    planned: true,
    target: { x0: 10, x1: 10, y0: 150, y1: 150 },
  });
  assert.equal(far.outcome.status, "reached");
  assert.equal(far.outcome.counters.replans, 0);
  const near = world(
    "ignore.horizon(0); stop.cycling(0);",
    "if (equaln(v51,1)) { set.cel(0,1); }",
    cels,
  );
  const controller = new NavigationController(near.engine, {
    kind: "position",
    planned: true,
    target: { x0: 10, x1: 10, y0: 31, y1: 31 },
  });
  const first = controller.next({ hostPolls: 0, logicCycles: 0 });
  assert.equal(first.outcome, null);
  near.keys.push(first.key!);
  near.engine.vars[51] = 1;
  near.engine.tick();
  const changed = controller.next({ hostPolls: 1, logicCycles: 1 });
  assert.equal(changed.outcome?.status, "unreachable_under_current_model");
  assert.equal(changed.outcome.counters.replans, 1);
});

test("wide conservative exit approaches validate current-width water gates through the final edge", () => {
  const run = world("stop.cycling(0); obj.on.land(0);", "if (equaln(v2,2)) { assignn(v0,2); }", [
    { width: 1, height: 1, pixels: [1] },
    { width: 3, height: 1, pixels: [1, 1, 1] },
  ]);
  for (let y = 0; y < 168; y++) if (y !== 100) run.engine.surface.priority[y * 160 + 159] = 3;
  // Supply the declared restriction at each planning boundary. The original
  // interpreter clears ego's one-pass water gate after an updating pass.
  const result = drive(run, { kind: "exit", direction: 3, room: 2 }, {}, 1, () => {
    run.engine.screenObjects[0]!.waterGate = "off";
  });
  assert.equal(result.outcome.status, "reached");
  assert.equal(result.outcome.x, 159);
  assert.equal(result.outcome.y, 100);
});

test("an exit starting inside its approach band follows the detour to a legal crossing", () => {
  const run = world(
    "position(0,158,100); assignn(v51,2); step.size(0,v51);",
    "if (equaln(v2,2)) { assignn(v0,2); }",
  );
  for (let y = 0; y < 168; y++) if (y !== 102) run.engine.surface.priority[y * 160 + 159] = 0;
  const result = drive(run, { kind: "exit", direction: 3, room: 2 });
  assert.equal(result.outcome.status, "reached");
  assert.equal(result.outcome.x, 159);
  assert.equal(result.outcome.y, 102);
});

test("changing water scan width retains safe traces without spending replans", () => {
  const run = world("obj.on.land(0);", "", [
    { width: 1, height: 1, pixels: [1] },
    { width: 3, height: 1, pixels: [1, 1, 1] },
  ]);
  const result = drive(
    run,
    {
      kind: "position",
      planned: true,
      target: { x0: 40, x1: 40, y0: 100, y1: 100 },
    },
    {},
    1,
    () => {
      run.engine.screenObjects[0]!.waterGate = "off";
    },
  );
  assert.equal(result.outcome.status, "reached");
  assert.equal(result.outcome.counters.replans, 0);
});

test("an exit inside the approach band rejects an insufficient terminal allowance before input", () => {
  for (const options of [{ budgets: { movementUpdates: 1 } }, { planOptions: { maxSteps: 0 } }]) {
    const run = world("position(0,153,100); stop.cycling(0);", "", [
      { width: 1, height: 1, pixels: [1] },
      { width: 7, height: 1, pixels: [1, 1, 1, 1, 1, 1, 1] },
    ]);
    const controller = new NavigationController(
      run.engine,
      { kind: "exit", direction: 3, room: 2 },
      options,
    );
    const result = controller.next({ hostPolls: 0, logicCycles: 0 });
    assert.equal(result.outcome?.status, "budget_exhausted");
    assert.equal(result.key, null);
    assert.equal(result.outcome?.counters.movementUpdates, 0);
  }
});

test("a changing water scan width invalidates a target that becomes entirely water", () => {
  const run = world("stop.cycling(0); obj.on.land(0);", "if (equaln(v51,1)) { set.cel(0,1); }", [
    { width: 2, height: 1, pixels: [1, 1] },
    { width: 1, height: 1, pixels: [1] },
  ]);
  run.engine.surface.priority[100 * 160 + 16] = 3;
  run.engine.screenObjects[0]!.waterGate = "off";
  const controller = new NavigationController(run.engine, { ...target, planned: true });
  const first = controller.next({ hostPolls: 0, logicCycles: 0 });
  assert.equal(first.outcome, null);
  run.keys.push(first.key!);
  run.engine.vars[51] = 1;
  run.engine.tick();
  run.engine.screenObjects[0]!.waterGate = "off";
  const changed = controller.next({ hostPolls: 1, logicCycles: 1 });
  assert.equal(changed.outcome?.status, "unreachable_under_current_model");
  assert.equal(changed.outcome.counters.replans, 1);
});
