import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine } from "../src/runtime/engine.ts";
import { buildView } from "../src/view/view.ts";
import { MOTION_FOLLOW, MOTION_MOVE_OBJ } from "../src/runtime/screenObject.ts";
import { planWalk } from "../src/agent/navigation.ts";
import { PROFILES } from "../src/runtime/profile.ts";

// Independently authored vectors from executed original routines; see
// docs/fidelity.md, "Original complete movement and follow audit".
function game(
  extra = "",
  widths: readonly number[] = [2, 2],
  heights: readonly number[] = [1, 1],
): Engine {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `
      if (!isset(f200)) {
        set(f200); load.view(1); assignn(v60, 1);
        animate.obj(o0); set.view(o0, 1); position(o0, 20, 80); draw(o0); stop.cycling(o0);
        step.size(o0, v60); step.time(o0, v60); cycle.time(o0, v60);
        animate.obj(o1); set.view(o1, 1); position(o1, 80, 80); draw(o1); stop.cycling(o1);
        step.size(o1, v60); step.time(o1, v60); cycle.time(o1, v60);
        ${extra}
      }
      return;
    `,
      { dictionary: new Map() },
    ).payload,
  );
  container.putResource(
    "view",
    1,
    buildView({
      loops: [
        {
          cels: widths.map((width, index) => ({
            width,
            height: heights[index] ?? 1,
            pixels: Array<number>(width * (heights[index] ?? 1)).fill(index + 1),
          })),
        },
      ],
    }),
  );
  const engine = new Engine(container, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  });
  engine.tick();
  return engine;
}

test("vertical screen borders win simultaneous horizontal contact", () => {
  for (const [x, y, direction, border] of [
    [0, 37, 8, 1],
    [0, 167, 6, 3],
    [158, 37, 2, 1],
    [158, 167, 4, 3],
  ]) {
    const engine = game();
    const ego = engine.screenObjects[0]!;
    ego.x = x!;
    ego.y = y!;
    ego.newlyPositioned = false;
    engine.vars[6] = direction!;
    engine.tick();
    assert.deepEqual([ego.x, ego.y, engine.vars[2]], [x, y, border]);
  }
});

test("stopped-update actors remain solid collision candidates", () => {
  const engine = game();
  const ego = engine.screenObjects[0]!;
  const actor = engine.screenObjects[1]!;
  actor.x = 23;
  actor.earlierPartition = true;
  engine.vars[6] = 3;
  ego.newlyPositioned = false;
  engine.tick();
  assert.equal(ego.x, 20, "inclusive span contact blocks the step into a stopped actor");
});

test("all actor cels advance before any actor collision movement", () => {
  for (const [oldWidth, newWidth, expectedX] of [
    [1, 4, 29],
    [4, 1, 28],
  ] as const) {
    const engine = game("", [oldWidth, newWidth]);
    const ego = engine.screenObjects[0]!;
    const actor = engine.screenObjects[1]!;
    ego.x = 29;
    ego.newlyPositioned = false;
    actor.x = 24;
    actor.cycling = true;
    actor.cycleCount = 1;
    actor.cycleTime = 1;
    actor.newlyPositioned = false;
    engine.vars[6] = 7;
    engine.tick();
    assert.deepEqual([ego.x, ego.y, actor.width, actor.cel], [expectedX, 80, newWidth, 1]);
  }
});

test("border completion preserves a non-ego target actor's direction", () => {
  const engine = game();
  const actor = engine.screenObjects[1]!;
  actor.x = 158;
  actor.y = 80;
  actor.direction = 3;
  actor.newlyPositioned = false;
  actor.motionMode = MOTION_MOVE_OBJ;
  actor.paramBank = [200, 80, 4, 61];
  engine.tick();
  assert.deepEqual(
    [
      actor.x,
      actor.direction,
      actor.motionMode,
      actor.stepSize,
      engine.flags[61],
      engine.vars[4],
      engine.vars[5],
    ],
    [158, 3, 0, 4, 1, 1, 2],
  );
});

test("follow retry subtraction honors signed-byte overflow and keeps temporary direction", () => {
  for (const [retry, step, expected] of [
    [5, 4, 1],
    [3, 4, 0],
    [128, 1, 0],
    [127, 255, 128],
    [1, 128, 129],
    [254, 255, 0],
  ]) {
    const engine = game();
    const actor = engine.screenObjects[1]!;
    actor.motionMode = MOTION_FOLLOW;
    actor.paramBank = [1, 61, retry!, 0];
    actor.stepSize = step!;
    actor.stationary = false;
    actor.direction = 3;
    engine.tick();
    assert.equal(actor.paramBank[2], expected, `${retry} minus ${step}`);
    assert.equal(actor.direction, 3);
    assert.equal(engine.flags[61], 0);
  }
});

test("movement rectangle checks share the autonomous-direction cadence gate", () => {
  for (const count of [0, 1, 2]) {
    const engine = game("block(20, 70, 30, 90);");
    const ego = engine.screenObjects[0]!;
    ego.direction = 3;
    ego.stepCount = count;
    ego.newlyPositioned = false;
    engine.vars[6] = 3;
    engine.tick();
    assert.equal(ego.direction, count === 1 ? 0 : 3, `countdown ${count}`);
  }
});

test("zero animation countdown disables cel advancement independently of movement", () => {
  const engine = game();
  const ego = engine.screenObjects[0]!;
  ego.cycling = true;
  ego.cycleCount = 0;
  ego.cycleTime = 3;
  ego.newlyPositioned = false;
  engine.vars[6] = 3;
  engine.tick();
  assert.deepEqual([ego.x, ego.cel, ego.cycleCount], [21, 0, 0]);
});

test("ego water and land restrictions last until an updating postlogic pass", () => {
  const engine = game();
  const ego = engine.screenObjects[0]!;
  const actor = engine.screenObjects[1]!;
  ego.earlierPartition = actor.earlierPartition = true;
  ego.waterGate = "on";
  engine.vars[2] = 4;
  engine.vars[4] = 7;
  engine.vars[5] = 3;
  engine.tick();
  assert.deepEqual(
    [engine.vars[2], engine.vars[4], engine.vars[5], ego.waterGate],
    [4, 0, 0, "on"],
  );
  actor.earlierPartition = false;
  engine.tick();
  assert.deepEqual(
    [engine.vars[2], engine.vars[4], engine.vars[5], ego.waterGate],
    [0, 0, 0, null],
  );
});

test("water and land commands independently preserve both restriction bits", () => {
  for (const commands of [
    "obj.on.water(o0); obj.on.land(o0);",
    "obj.on.land(o0); obj.on.water(o0);",
  ]) {
    const engine = game();
    engine.patchResource(
      "logic",
      1,
      assembleLogic(commands + "return;", { dictionary: new Map() }).payload,
    );
    engine.execute(1);
    assert.equal(engine.screenObjects[0]!.waterGate, "both");
    engine.restoreImage(engine.serialize());
    assert.equal(engine.screenObjects[0]!.waterGate, "both", "both bits survive the object record");
  }
});

test("combined terrain restrictions reject land and water unless priority 15 bypasses the scan", () => {
  for (const control of [3, 4]) {
    const engine = game();
    engine.patchResource(
      "logic",
      1,
      assembleLogic("obj.on.water(o0);obj.on.land(o0);return;", { dictionary: new Map() }).payload,
    );
    engine.execute(1);
    engine.surface.priority.fill(control);
    const ego = engine.screenObjects[0]!;
    const run = { engine, state: () => ({ room: 0, x: ego.x, y: ego.y }) };
    assert.equal(planWalk(run, { x0: 21, x1: 21, y0: 80, y1: 80 }).found, false);
    assert.throws(() => engine.tick(), /no acceptable position/);
    ego.fixedPriority = true;
    ego.priority = 15;
    assert.equal(planWalk(run, { x0: 21, x1: 21, y0: 80, y1: 80 }).found, true);
    assert.doesNotThrow(() => engine.tick());
  }
});

test("cel selection clips right/top overflow while leaving other in-bounds coordinates alone", () => {
  for (const [x, y, width, height, ignoreHorizon, expectedX, expectedY, suppressed] of [
    [158, 80, 4, 1, false, 156, 80, true],
    [156, 80, 4, 1, false, 156, 80, false],
    [20, 2, 2, 6, false, 20, 37, true],
    [20, 2, 2, 6, true, 20, 5, true],
    [20, 5, 2, 6, false, 20, 5, false],
    [20, 10, 2, 6, false, 20, 10, false],
    [-1, 80, 2, 1, false, -1, 80, false],
    [20, 168, 2, 1, false, 20, 168, false],
    [158, 2, 4, 6, false, 156, 37, true],
  ] as const) {
    const engine = game("", [2, width], [1, height]);
    engine.patchResource(
      "logic",
      1,
      assembleLogic("set.cel(o0,1);return;", { dictionary: new Map() }).payload,
    );
    const ego = engine.screenObjects[0]!;
    ego.x = x;
    ego.y = y;
    ego.observeHorizon = !ignoreHorizon;
    ego.newlyPositioned = false;
    engine.execute(1);
    assert.deepEqual(
      [ego.x, ego.y, ego.width, ego.height, ego.newlyPositioned],
      [expectedX, expectedY, width, height, suppressed],
    );
  }
});

test("an automatically selected wider cel suppresses only the next due movement after clipping", () => {
  const engine = game("", [2, 4]);
  const ego = engine.screenObjects[0]!;
  ego.x = 158;
  ego.newlyPositioned = false;
  ego.cycling = true;
  ego.cycleCount = 1;
  ego.cycleTime = 3;
  engine.vars[6] = 7;
  engine.tick();
  assert.deepEqual([ego.x, ego.cel, ego.newlyPositioned, engine.vars[2]], [156, 1, false, 0]);
  engine.tick();
  assert.equal(ego.x, 155);
});

test("host history retains a parked out-of-bounds position while authentic restore executes cel clipping", () => {
  const engine = game("", [4, 4]);
  engine.patchResource(
    "logic",
    1,
    assembleLogic('position(o0,158,80);print("Wait.");return;', { dictionary: new Map() }).payload,
  );
  engine.execute(1);
  assert.equal(engine.modalKind, "print");
  const history = engine.autosaveImage();
  assert.ok(history);
  const authentic = engine.serialize();
  engine.restoreImage(history);
  assert.equal(engine.screenObjects[0]!.x, 158, "history preserves the pre-movement pose");
  assert.equal(engine.modalKind, "print");
  engine.restoreImage(authentic);
  assert.equal(engine.screenObjects[0]!.x, 156, "authentic reconstruction invokes cel clipping");
});

test("the previous position is committed after the pass, so a corner pass is not a crossing", () => {
  // docs/fidelity.md, "Original previous-position commit". Widths are 2, so
  // spans touch inclusively when mover.x <= ego.x + 2.
  const engine = game();
  const ego = engine.screenObjects[0]!;
  const actor = engine.screenObjects[1]!;
  ego.x = ego.prevX = 90;
  ego.y = ego.prevY = 143;
  actor.x = actor.prevX = 95;
  actor.y = actor.prevY = 141;
  actor.direction = 6; // south-west, one pixel per pass
  actor.newlyPositioned = false;
  ego.newlyPositioned = false;
  const trail: [number, number][] = [];
  for (let pass = 0; pass < 4; pass++) {
    engine.tick();
    trail.push([actor.x, actor.y]);
  }
  // (92,144) touches ego's span with a lower baseline, but the mover's committed
  // previous y is 143, not below ego's 143: no crossing, so it keeps going.
  assert.deepEqual(trail, [
    [94, 142],
    [93, 143],
    [92, 144],
    [91, 145],
  ]);

  // Control: straight down onto the same baseline is still a collision.
  actor.x = actor.prevX = 90;
  actor.y = actor.prevY = 141;
  actor.direction = 5;
  engine.tick();
  engine.tick();
  assert.deepEqual([actor.x, actor.y], [90, 142], "equal baselines block");
});

test("position leaves the newly-positioned bit alone; reposition sets it", () => {
  // docs/fidelity.md, "Original position handlers". Under 3.002.086 the
  // movement routine reports border 4 whenever the proposed x is zero. A
  // placement pass proposes the current position, so an object placed at x=0
  // and sent east reports the border only if that pass ran: reposition
  // schedules one, position does not. Other profiles still schedule it as a
  // recorded deviation, so this vector is 3.002.086-only.
  const source = (place: string) =>
    `if (!isset(f200)) { set(f200); load.view(1); animate.obj(o0); set.view(o0, 1); ignore.horizon(o0);
      position(o0, 40, 100); draw(o0); stop.cycling(o0); }
     if (equaln(v100, 1)) { assignn(v100, 2); ${place} move.obj(o0, 20, 100, 1, f50); }
     return;`;
  for (const [place, edge, x] of [
    ["position(o0, 0, 100);", 0, 1],
    ["reposition.to(o0, 0, 100);", 4, 0],
  ] as const) {
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(source(place), { dictionary: new Map() }).payload,
    );
    container.putResource(
      "view",
      1,
      buildView({ loops: [{ cels: [{ width: 2, height: 1, pixels: [1, 1] }] }] }),
    );
    const engine = new Engine(
      container,
      {
        print() {},
        displayAt() {},
        statusLine() {},
        takeInputLine: () => null,
        takeKeys: () => [],
      },
      undefined,
      { profile: PROFILES["3.002.086"] },
    );
    engine.tick();
    engine.vars[100] = 1;
    engine.tick();
    assert.equal(engine.vars[2], edge, `${place} border report`);
    assert.equal(engine.screenObjects[0]!.x, x, `${place} first step`);
  }
});
