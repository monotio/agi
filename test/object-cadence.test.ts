import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";
import { buildView } from "../src/view/view.ts";
import { decodeSave } from "../src/runtime/persistence.ts";

const host: EngineHost = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};
const setup = `load.view(1); animate.obj(o0); set.view(o0, 1); position(o0, 20, 100); draw(o0); stop.cycling(o0); ignore.objs(o0);`;

function game(source: string, profile: ProfileId = "2.936", engineHost: EngineHost = host): Engine {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(source, { dictionary: new Map(), profile: PROFILES[profile] }).payload,
  );
  container.putResource("logic", 1, assembleLogic("return;", { dictionary: new Map() }).payload);
  container.putResource(
    "view",
    1,
    buildView({
      loops: [
        {
          cels: [
            { width: 2, height: 1, pixels: [1, 1] },
            { width: 2, height: 1, pixels: [2, 2] },
            { width: 2, height: 1, pixels: [3, 3] },
          ],
        },
        { cels: [{ width: 2, height: 1, pixels: [4, 4] }] },
      ],
    }),
  );
  return new Engine(container, engineHost, undefined, { profile });
}

test("reanimating an object clears prior drawing and movement flags but preserves its data", () => {
  const engine = game(`
    load.view(1); animate.obj(o1); set.view(o1, 1); position(o1, 20, 100);
    set.priority(o1, 15); fix.loop(o1); ignore.horizon(o1);
    ignore.blocks(o1); ignore.objs(o1); obj.on.water(o1);
    assignn(v60, 7); cycle.time(o1, v60); step.time(o1, v60);
    draw(o1); stop.update(o1); stop.cycling(o1);
    unanimate.all(); animate.obj(o1); return;
  `);
  engine.execute(0);
  const o = engine.screenObjects[1]!;
  assert.equal(o.fixedPriority, false, "a reused actor must regain scenery occlusion");
  assert.equal(o.loopFixed, false, "a reused actor must turn with its movement");
  assert.equal(o.observeHorizon, true);
  assert.equal(o.observeBlocks, true);
  assert.equal(o.observeObjects, true);
  assert.equal(o.waterGate, null);
  assert.equal(o.active, false, "animate does not draw the object");
  assert.equal(o.update, true);
  assert.equal(o.cycling, true);
  assert.equal(o.earlierPartition, false);
  assert.equal(o.newlyPositioned, false);
  assert.deepEqual([o.view, o.x, o.y, o.cycleTime, o.stepTime], [1, 20, 100, 7, 7]);

  // The old priority-15 value remains data, but must no longer bypass barriers.
  engine.surface.priority.fill(4);
  engine.surface.priority[100 * 160 + 22] = 0;
  engine.patchResource(
    "logic",
    1,
    assembleLogic(
      `
    draw(o1); stop.cycling(o1); assignn(v61, 1); step.time(o1, v61);
    assignn(v62, 3); set.dir(o1, v62); return;
  `,
      { dictionary: new Map() },
    ).payload,
  );
  engine.execute(1);
  engine.patchResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  for (let i = 0; i < 4; i++) engine.tick();
  assert.equal(o.x, 20, "the actor cannot step onto the wall at x=22");

  // Repeating animate on an initialized object must preserve its settings.
  const initialized = game(`
    load.view(1); animate.obj(o1); set.view(o1, 1); position(o1, 20, 100);
    set.priority(o1, 15); fix.loop(o1); ignore.horizon(o1);
    ignore.blocks(o1); ignore.objs(o1); obj.on.water(o1);
    draw(o1); stop.cycling(o1); animate.obj(o1); return;
  `);
  initialized.execute(0);
  const kept = initialized.screenObjects[1]!;
  assert.equal(kept.fixedPriority, true);
  assert.equal(kept.loopFixed, true);
  assert.equal(kept.observeHorizon, false);
  assert.equal(kept.observeBlocks, false);
  assert.equal(kept.observeObjects, false);
  assert.equal(kept.waterGate, "on");
  assert.equal(kept.active, true);
  assert.equal(kept.cycling, false);
});

test("step.time restarts cadence and positioning suppresses exactly one due step", () => {
  const engine = game(
    `if (!isset(f200)) { set(f200); ${setup} assignn(v60, 3); step.time(o0, v60); set.dir(o0, v60); } return;`,
  );
  const positions: number[] = [];
  for (let i = 0; i < 9; i++) {
    engine.tick();
    positions.push(engine.screenObjects[0]!.x);
  }
  assert.deepEqual(positions, [20, 20, 20, 20, 20, 21, 21, 21, 22]);
});

for (const [profile, expected] of [
  ["2.272", [1, 1, 1]],
  ["2.936", [0, 0, 1]],
] as const) {
  test(`${profile} selects direction loops at its specified cadence`, () => {
    const engine = game(
      `if (!isset(f200)) { set(f200); ${setup} assignn(v60, 3); step.time(o0, v60); assignn(v61, 7); set.dir(o0, v61); } return;`,
      profile,
    );
    const loops: number[] = [];
    for (let i = 0; i < 3; i++) {
      engine.tick();
      loops.push(engine.screenObjects[0]!.loop);
    }
    assert.deepEqual(loops, expected);
  });
}

for (const [profile, direction] of [
  ["2.272", 7],
  ["2.936", 4],
] as const) {
  test(`${profile} applies target setup timing and strict direction bands`, () => {
    const engine = game(
      `${setup} assignn(v60, 7); set.dir(o0, v60); move.obj(o0, 23, 109, 2, f60); get.dir(o0, v61); return;`,
      profile,
    );
    engine.tick();
    assert.equal(engine.vars[61], direction);
  });
}

test("target completion occurs before logic and restores the original step", () => {
  const engine = game(
    `if (!isset(f200)) { set(f200); ${setup} move.obj(o0, 24, 100, 3, f60); } if (isset(f60)) { set(f61); } return;`,
  );
  engine.tick();
  assert.equal(engine.screenObjects[0]!.stepSize, 3);
  engine.tick();
  assert.equal(engine.screenObjects[0]!.x, 23);
  engine.tick();
  assert.equal(engine.screenObjects[0]!.stepSize, 1);
  assert.equal(engine.flags[61], 1, "logic sees completion from this cycle's pre-logic update");
});

test("cycle.time advances on the decrement that reaches zero", () => {
  const engine = game(
    `if (!isset(f200)) { set(f200); ${setup} assignn(v60, 2); cycle.time(o0, v60); start.cycling(o0); } return;`,
  );
  const cels: number[] = [];
  for (let i = 0; i < 4; i++) {
    engine.tick();
    cels.push(engine.screenObjects[0]!.cel);
  }
  assert.deepEqual(cels, [0, 1, 1, 2]);
});

test("end.of.loop delays once, then completes as the last cel is reached", () => {
  const engine = game(`if (!isset(f200)) { set(f200); ${setup} end.of.loop(o0, f60); } return;`);
  const cels: number[] = [];
  for (let i = 0; i < 3; i++) {
    engine.tick();
    cels.push(engine.screenObjects[0]!.cel);
  }
  assert.deepEqual(cels, [0, 1, 2]);
  assert.equal(engine.flags[60], 1);
  assert.equal(engine.screenObjects[0]!.cycling, false);
});

test("movement rectangles stop a crossing before logic using strict membership", () => {
  const engine = game(
    `if (!isset(f200)) { set(f200); ${setup} block(20, 50, 30, 150); assignn(v60, 3); set.dir(o0, v60); return; } get.dir(o0, v61); return;`,
  );
  engine.tick();
  engine.tick();
  assert.equal(engine.vars[61], 0);
  assert.equal(engine.screenObjects[0]!.x, 20);
});

test("activation finds the first acceptable placement in the specified spiral", () => {
  const engine = game(`${setup} return;`);
  engine.surface.priority[100 * 160 + 20] = 0;
  engine.tick();
  // Requested(20,100) and left(19,100) both cover the blocked pixel.
  // Down(19,101) is the next candidate, and its two-pixel footprint is clear.
  assert.equal(engine.screenObjects[0]!.x, 19);
  assert.equal(engine.screenObjects[0]!.y, 101);
});

test("room transition clears loaded views, resets cadence/block and uses actual ego width", () => {
  const engine = game(`
    if (!isset(f200)) { set(f200); ${setup} assignn(v60, 4); step.time(o0, v60); step.size(o0, v60); cycle.time(o0, v60); block(20, 50, 30, 150); assignn(v2, 4); new.room(1); }
    return;
  `);
  engine.tick();
  const ego = engine.screenObjects[0]!;
  assert.equal(ego.x, 158);
  assert.deepEqual(
    [ego.stepSize, ego.stepTime, ego.stepCount, ego.cycleTime, ego.cycleCount],
    [1, 1, 1, 1, 1],
  );
  assert.equal(decodeSave(engine.serialize(), PROFILES["2.936"]).blockEnabled, 0);
  engine.patchResource(
    "logic",
    0,
    assembleLogic("draw(o0); return;", { dictionary: new Map() }).payload,
  );
  assert.throws(() => engine.tick(), /draw requires a selected cel/);
});

test("2.411 restart accepts confirmation even though f16 never bypasses it", () => {
  let waits = 0;
  const engine = game(
    "assignn(v100, 42); set(f16); restart.game(); assignn(v100, 99); return;",
    "2.411",
    {
      ...host,
      waitKey: () => {
        waits++;
        return 13;
      },
    },
  );
  engine.tick();
  assert.equal(waits, 1);
  assert.equal(engine.flags[6], 1);
  assert.equal(engine.vars[100], 0);
});

test("quit confirmation can cancel and continue after the action", () => {
  const engine = game("quit(0); assignn(v100, 42); return;", "2.936", {
    ...host,
    waitKey: () => 27,
  });
  engine.tick();
  assert.equal(engine.vars[100], 42);
});

test("immediate quit notifies the host once and stops execution", () => {
  let quits = 0;
  const engine = game("quit(1); assignn(v100, 42); return;", "2.936", {
    ...host,
    quit: () => {
      quits++;
    },
  });
  engine.tick();
  engine.tick();
  assert.equal(quits, 1);
  assert.equal(engine.vars[100], 0);
});

test("wander permits stationary direction and rejects countdowns below six", () => {
  const words = [0, 5, 6];
  let calls = 0;
  const engine = game(`if (!isset(f200)) { set(f200); ${setup} wander(o0); } return;`, "2.936", {
    ...host,
    randomWord: () => {
      calls++;
      return words.shift() ?? 6;
    },
  });
  engine.tick();
  engine.tick();
  assert.equal(calls, 3);
  assert.equal(engine.screenObjects[0]!.direction, 0);
});

test("follow completion uses strict per-axis bands rather than Manhattan distance", () => {
  const engine = game(`if (!isset(f200)) { set(f200); ${setup}
    animate.obj(o1); set.view(o1, 1); ignore.objs(o1); position(o1, 18, 98); draw(o1); stop.cycling(o1); follow.ego(o1, 3, f60);
  } return;`);
  engine.tick();
  engine.tick();
  assert.equal(engine.flags[60], 1);
  assert.equal(engine.screenObjects[1]!.motionMode, 0);
});

test("a stationary follower retries with a nonzero direction and a saved delay", () => {
  const words = [0, 1, 0, 2];
  let calls = 0;
  const engine = game(
    `if (!isset(f200)) { set(f200); ${setup}
    animate.obj(o1); set.view(o1, 1); ignore.objs(o1); position(o1, 10, 100); draw(o1); stop.cycling(o1); follow.ego(o1, 1, f60);
  } return;`,
    "2.936",
    {
      ...host,
      randomWord: () => {
        calls++;
        return words.shift() ?? 2;
      },
    },
  );
  engine.surface.priority[100 * 160 + 12] = 0;
  engine.tick();
  engine.tick();
  engine.tick();
  assert.equal(calls, 4);
  assert.equal(engine.screenObjects[1]!.direction, 1);
  assert.equal(engine.screenObjects[1]!.follow?.retryDelay, 2);
  engine.restoreImage(engine.serialize());
  assert.equal(engine.screenObjects[1]!.follow?.retryDelay, 2);
});

for (const [profile, lines] of [
  ["2.411", 3],
  ["2.936", 4],
] as const) {
  test(`${profile} heap diagnostic has the specified line count`, () => {
    const output: string[] = [];
    const engine = game("show.mem(); return;", profile, {
      ...host,
      logText: (line) => {
        output.push(...line.split("\n"));
      },
    });
    engine.tick();
    assert.equal(output.length, lines);
    assert.equal(
      output.some((line) => line.startsWith("rm.0, etc.")),
      lines === 4,
    );
  });
}

test("set.scan.start resumes at the following opcode on the next cycle", () => {
  const engine = game("increment(v60); set.scan.start(); increment(v61); return;");
  engine.tick();
  engine.tick();
  assert.equal(engine.vars[60], 1);
  assert.equal(engine.vars[61], 2);
});

test("reposition.to places the object and suppresses its next due movement", () => {
  const engine = game(`if (!isset(f200)) { set(f200); ${setup} return; }
    assignn(v60, 3); set.dir(o0, v60); reposition.to(o0, 50, 20); return;
  `);
  engine.tick();
  engine.tick();
  assert.equal(engine.screenObjects[0]!.x, 50);
  assert.equal(engine.screenObjects[0]!.y, 37, "placement obeys the default horizon");
});

test("footprint scan: trigger latches on any cell, water follows the final cell", () => {
  // Ego is a two-cell-wide actor at (20,100); logic 0 idles, so every tick's
  // due movement pass re-scans the baseline in place and rewrites f0/f3.
  const engine = game(`if (!isset(f200)) { set(f200); ${setup} } return;`);
  engine.tick();
  const cells = (left: number, right: number): void => {
    engine.surface.priority.fill(4);
    engine.surface.priority[100 * 160 + 20] = left;
    engine.surface.priority[100 * 160 + 21] = right;
    engine.tick();
  };
  cells(2, 4);
  assert.deepEqual([engine.flags[3], engine.flags[0]], [1, 0], "trigger under the left cell only");
  cells(4, 2);
  assert.deepEqual([engine.flags[3], engine.flags[0]], [1, 0], "trigger under the right cell only");
  cells(2, 3);
  assert.deepEqual([engine.flags[3], engine.flags[0]], [1, 1], "trigger then water: both");
  cells(3, 4);
  assert.deepEqual([engine.flags[3], engine.flags[0]], [0, 0], "water only under the left cell");
  cells(4, 3);
  assert.deepEqual([engine.flags[3], engine.flags[0]], [0, 1], "water under the final cell");
  cells(4, 4);
  assert.deepEqual([engine.flags[3], engine.flags[0]], [0, 0]);
});

test("reposition runs placement, refreshes f3 and suppresses the next due step", () => {
  // Cells (22,100) and (23,100) are barriers; the requested (22,100) is
  // rejected, the spiral's first candidate left (21,100) still covers 22, and
  // the second, down (21,101), is clear.
  const engine = game(`if (!isset(f200)) { set(f200); ${setup} return; }
    if (!isset(f201)) {
      set(f201); assignn(v60, 2); assignn(v61, 0); reposition(o0, v60, v61);
      assignn(v62, 3); set.dir(o0, v62);
    }
    return;
  `);
  engine.tick();
  engine.surface.priority[100 * 160 + 22] = 0;
  engine.surface.priority[100 * 160 + 23] = 0;
  engine.surface.priority[101 * 160 + 21] = 2;
  engine.tick();
  const ego = engine.screenObjects[0]!;
  assert.deepEqual([ego.x, ego.y], [21, 101], "placement spiral: left 1 rejected, down 1 accepted");
  assert.equal(engine.flags[3], 1, "placement scanned the trigger under the new baseline");
  assert.equal(engine.vars[6], 3, "the requested direction survives the reposition");
  engine.tick();
  assert.deepEqual([ego.x, ego.y], [22, 101], "one due step was suppressed, then movement resumes");
});

test("reposition rides a trigger line to an exact cell (observed 3.002.102 demo geometry)", () => {
  // A control-2 line descends one row per four cells from (0,112); its row-128
  // run is x 63..66. The script steps ego one cell right every pass and one
  // cell down whenever f3 is clear, until ego stands on exactly (67,128). The
  // 16-cell-wide actor's latched trigger arrives; a final-cell trigger crosses
  // row 128 at x 49..52 and walks off the bottom of the screen instead.
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
        set(f200); load.view(1); animate.obj(o0); set.view(o0, 1); ignore.horizon(o0);
        ignore.objs(o0); ignore.blocks(o0); position(o0, 0, 111); draw(o0); stop.cycling(o0);
        return;
      }
      if (posn(o0, 67, 128, 67, 128)) { set(f201); return; }
      if (isset(f3)) { assignn(v61, 0); } else { assignn(v61, 1); }
      assignn(v60, 1); reposition(o0, v60, v61); return;`,
      { dictionary: new Map() },
    ).payload,
  );
  container.putResource(
    "view",
    1,
    buildView({ loops: [{ cels: [{ width: 16, height: 1, pixels: Array(16).fill(1) }] }] }),
  );
  const engine = new Engine(container, host);
  engine.tick();
  for (let row = 112; row <= 141; row++) {
    for (let x = (row - 112) * 4 - 1; x <= (row - 112) * 4 + 2; x++) {
      if (x >= 0 && x < 160) engine.surface.priority[row * 160 + x] = 2;
    }
  }
  const ego = engine.screenObjects[0]!;
  let arrived = false;
  for (let i = 0; i < 200 && !arrived; i++) {
    engine.tick();
    arrived = engine.flags[201] === 1;
  }
  assert.equal(arrived, true, `ego ended at (${ego.x},${ego.y}) without reaching (67,128)`);
});

test("object position conditions use the selected cel width", () => {
  const engine = game(`${setup}
    if (obj.in.box(o0, 20, 100, 21, 100)) { set(f60); }
    if (center.posn(o0, 21, 100, 21, 100)) { set(f61); }
    if (right.posn(o0, 21, 100, 21, 100)) { set(f62); }
    return;
  `);
  engine.tick();
  assert.deepEqual(Array.from(engine.flags.slice(60, 63)), [1, 1, 1]);
});
