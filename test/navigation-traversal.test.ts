import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildView } from "../src/view/view.ts";
import { Engine } from "../src/runtime/engine.ts";
import {
  NavigationTraversal,
  type TraversalRequest,
  type TraversalOptions,
} from "../src/agent/navigationTraversal.ts";

function world(ongoing = "") {
  const game = createContainer();
  game.putResource("picture", 1, Uint8Array.of(0xff));
  game.putResource(
    "view",
    0,
    buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
  );
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
if (!isset(f100)) {
 set(f100); assignn(v0,1); assignn(v10,1); load.pic(v10); draw.pic(v10); show.pic();
 load.view(0); animate.obj(0); set.view(0,0); position(0,10,100); draw(0); assignn(v200,1); step.size(0,v200); step.time(0,v200); cycle.time(0,v200); accept.input();
 set.key(120,0,1);
}
if (controller(1)) { set(f110); }
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
const point = (x: number) => ({
  kind: "position" as const,
  planned: true,
  target: { x0: x, x1: x, y0: 100, y1: 100 },
});
const request: TraversalRequest = {
  approach: point(12),
  activation: {
    keys: [120],
    ready: {
      label: "standing at switch",
      test: (e) => e.screenObjects[0]!.x === 12 && e.vars[6] === 0,
    },
    changed: { label: "switch active", test: (e) => e.flags[110] !== 0 },
  },
  passage: point(16),
  landing: {
    label: "safe landing",
    test: (e) => e.screenObjects[0]!.x === 16 && e.movementControlEnabled,
  },
};
function drive(run: ReturnType<typeof world>, goal = request, options: TraversalOptions = {}) {
  const traversal = new NavigationTraversal(run.engine, goal, options);
  const inputs: number[] = [];
  const phases = new Set<string>();
  for (let cycle = 0; cycle < 100; cycle++) {
    const result = traversal.next({ hostPolls: cycle, logicCycles: cycle });
    phases.add(result.phase);
    if (result.key !== null) {
      inputs.push(result.key);
      run.keys.push(result.key);
    }
    if (result.outcome) return { ...result.outcome, inputs, phases };
    run.engine.tick();
  }
  throw new Error("traversal failed to terminate");
}

test("traversal consumes the approach stop, activates once, and plans the changed passage", () => {
  const result = drive(world());
  assert.equal(result.status, "reached");
  assert.equal(result.x, 16);
  assert.equal(result.counters.activationInputs, 1);
  assert.equal(result.counters.searches, 2);
  assert.equal(result.counters.replans, 0);
  assert.equal(result.inputs.filter((key) => key === 120).length, 1);
});

test("traversal reports unknown prompts without emitting acknowledgement keys", () => {
  const result = drive(world('if (isset(f110)) { print("Choose deliberately"); }'));
  assert.equal(result.status, "needs_input");
  assert.equal(result.x, 12);
  assert.equal(result.inputs.includes(13), false);
});

test("traversal observation waits are bounded across phases", () => {
  const result = drive(
    world(),
    {
      ...request,
      activation: {
        ...request.activation!,
        changed: { label: "absent state change", test: () => false },
      },
    },
    { budgets: { logicCycles: 12 } },
  );
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.phase, "observe");
  assert.equal(result.counters.logicCycles, 12);
  assert.equal(result.counters.searches, 1);
  assert.equal(result.counters.activationInputs, 1);
});

test("traversal accepts only its declared script transition and verifies landing control", () => {
  for (const expectedRoom of [2, 3]) {
    const result = drive(world("if (posn(0,14,100,20,100)) { assignn(v0,2); }"), {
      passage: point(16),
      expectedRoom,
      landing: {
        label: "landing",
        test: (e) => e.vars[0] === expectedRoom && e.movementControlEnabled,
      },
    });
    assert.equal(result.status, expectedRoom === 2 ? "reached" : "unexpected_transition");
    assert.equal(result.room, 2);
  }
});

test("traversal's search allowance spans approach and passage", () => {
  const result = drive(world(), request, { maxSearches: 1 });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.counters.searches, 1);
  assert.equal(result.x, 12);
});

test("cancellation before activation is consumed cancels its queued movement key", () => {
  const run = world();
  let cancelled = false;
  const traversal = new NavigationTraversal(
    run.engine,
    {
      activation: {
        keys: [0x4d00],
        ready: { label: "ready", test: () => true },
        changed: { label: "changed", test: () => false },
      },
      passage: point(16),
      landing: { label: "landing", test: () => false },
    },
    { cancelled: () => cancelled },
  );
  const first = traversal.next({ hostPolls: 0, logicCycles: 0 });
  assert.equal(first.direction, 3);
  run.keys.push(first.key!);
  cancelled = true;
  const last = traversal.next({ hostPolls: 1, logicCycles: 0 });
  assert.equal(last.outcome?.status, "cancelled");
  assert.equal(last.direction, 0);
  run.keys.push(last.key!);
  run.engine.tick();
  assert.equal(run.engine.screenObjects[0]!.x, 10);
});

test("a declared transition stops movement before waiting for landing readiness", () => {
  const run = world("if (posn(0,12,100,20,100)) { assignn(v0,2); }");
  const traversal = new NavigationTraversal(run.engine, {
    passage: point(16),
    expectedRoom: 2,
    landing: { label: "delayed landing", test: () => false },
  });
  for (let cycle = 0; cycle < 10; cycle++) {
    const result = traversal.next({ hostPolls: cycle, logicCycles: cycle });
    if (run.engine.vars[0] === 2) {
      assert.equal(result.phase, "landing");
      assert.equal(result.direction, 0);
      assert.notEqual(result.key, null);
      run.keys.push(result.key!);
      run.engine.tick();
      assert.equal(run.engine.vars[6], 0);
      return;
    }
    if (result.key !== null) run.keys.push(result.key);
    run.engine.tick();
  }
  assert.fail("declared transition did not occur");
});

test("a passage's expected room does not authorize a premature approach transition", () => {
  const result = drive(world("if (posn(0,11,100,20,100)) { assignn(v0,2); }"), {
    ...request,
    expectedRoom: 2,
  });
  assert.equal(result.status, "unexpected_transition");
  assert.equal(result.phase, "approach");
});

test("activation readiness is checked once before its declared key sequence", () => {
  const run = world();
  const result = drive(run, {
    ...request,
    activation: {
      keys: [120, 121],
      ready: { label: "switch not active", test: (e) => e.flags[110] === 0 },
      changed: request.activation!.changed,
    },
  });
  assert.equal(result.status, "reached");
  assert.equal(result.counters.activationInputs, 2);
});

test("a grounded approach state change starts the next phase before the old coordinate goal", () => {
  const result = drive(world("if (posn(0,12,100,20,100)) { set(f111); }"), {
    ...request,
    approach: point(16),
    approachComplete: { label: "mounted passage", test: (e) => e.flags[111] !== 0 },
    activation: {
      ...request.activation!,
      ready: {
        label: "stopped after mount",
        test: (e) => e.screenObjects[0]!.x === 13 && e.vars[6] === 0,
      },
    },
  });
  assert.equal(result.status, "reached");
  assert.equal(result.counters.activationInputs, 1);
});

test("unplanned traversal phases consume no search allowance", () => {
  const result = drive(
    world(),
    {
      passage: { ...point(12), planned: false },
      landing: { label: "landing", test: (e) => e.screenObjects[0]!.x === 12 },
    },
    { maxSearches: 0 },
  );
  assert.equal(result.status, "reached");
  assert.equal(result.counters.searches, 0);
});

test("landing stops a script-owned heading when player movement becomes available", () => {
  const run = world(
    "if (posn(0,12,100,20,100) && equaln(v0,1)) { assignn(v0,2); program.control(); assignn(v50,4); } if (equaln(v0,2)) { decrement(v50); if (equaln(v50,0)) { player.control(); } }",
  );
  const traversal = new NavigationTraversal(
    run.engine,
    { passage: point(16), expectedRoom: 2, landing: { label: "not ready", test: () => false } },
    { budgets: { logicCycles: 12 } },
  );
  let stopped = false;
  for (let cycle = 0; cycle < 12; cycle++) {
    const decision = traversal.next({ hostPolls: cycle, logicCycles: cycle });
    if (decision.key !== null) run.keys.push(decision.key);
    if (
      decision.phase === "landing" &&
      decision.direction === 0 &&
      run.engine.movementControlEnabled
    )
      stopped = true;
    run.engine.tick();
  }
  assert.equal(stopped, true);
  assert.equal(run.engine.vars[6], 0);
});

test("a declared room transition cannot skip a passage in the starting room", () => {
  assert.throws(
    () =>
      new NavigationTraversal(world().engine, {
        passage: point(16),
        expectedRoom: 1,
        landing: { label: "ready", test: () => true },
      }),
    /different.*room/,
  );
});

test("landing settling cannot extend the host budget", () => {
  const result = drive(
    world("if (posn(0,12,100,20,100)) { assignn(v0,2); }"),
    { passage: point(16), expectedRoom: 2, landing: { label: "not ready", test: () => false } },
    { budgets: { hostPolls: 3 } },
  );
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.counters.hostPolls, 3);
});

test("landing rejects a return to the starting room after its declared transition", () => {
  const result = drive(
    world(
      "if (posn(0,12,100,20,100) && equaln(v0,1)) { assignn(v0,2); } if (equaln(v0,2)) { increment(v50); if (equaln(v50,2)) { assignn(v0,1); set(f111); } }",
    ),
    {
      passage: point(16),
      expectedRoom: 2,
      landing: { label: "landing ready", test: (e) => e.flags[111] !== 0 },
    },
  );
  assert.equal(result.status, "unexpected_transition");
});

test("an already reached planned passage consumes no search allowance", () => {
  const result = drive(
    world(),
    {
      passage: point(10),
      landing: { label: "already there", test: (e) => e.screenObjects[0]!.x === 10 },
    },
    { maxSearches: 0 },
  );
  assert.equal(result.status, "reached");
  assert.equal(result.counters.searches, 0);
});
