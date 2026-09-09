import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildView } from "../src/view/view.ts";
import { Engine } from "../src/runtime/engine.ts";
import { DIRECTION_KEYS, directionForDelta } from "../src/agent/gameTestSteps.ts";
import {
  planWalk,
  walkPlanned,
  renderLive,
  type NavigationRun,
} from "../scripts/walkthrough-navigation.ts";

function world(extra = ""): NavigationRun {
  const game = createContainer();
  game.putResource("picture", 1, Uint8Array.of(0xff));
  game.putResource(
    "view",
    0,
    buildView({ loops: [{ cels: [{ width: 3, height: 2, pixels: [1, 1, 1, 1, 1, 1] }] }] }),
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

test("navigation image has a separate JSON sidecar and rejects ambiguous output paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "agi-navigation-"));
  try {
    const run = world();
    assert.throws(() => renderLive(run, target, join(dir, "map")), /png/i);
    const file = join(dir, "map.png");
    renderLive(run, target, file);
    const bytes = readFileSync(file);
    assert.equal(bytes.readUInt32BE(16), 640);
    assert.equal(bytes.readUInt32BE(20), 336);
    assert.equal(JSON.parse(readFileSync(join(dir, "map.json"), "utf8")).plan.found, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
