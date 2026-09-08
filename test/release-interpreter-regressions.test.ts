import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { buildView } from "../src/view/view.ts";

function game(
  logics: readonly string[],
  instructionBudget = 10000,
  host: Partial<EngineHost> = {},
): Engine {
  const container = createContainer();
  for (const [num, source] of logics.entries())
    container.putResource("logic", num, assembleLogic(source, { dictionary: new Map() }).payload);
  container.putResource(
    "view",
    1,
    buildView({
      loops: [
        {
          cels: [
            { width: 4, height: 8, pixels: Array<number>(32).fill(1) },
            { width: 4, height: 8, pixels: Array<number>(32).fill(2) },
          ],
        },
      ],
    }),
  );
  return new Engine(
    container,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeKeys: () => [],
      takeInputLine: () => null,
      ...host,
    },
    undefined,
    { instructionBudget },
  );
}

const actors = `configure.screen(0,23,24); load.view(1);
  animate.obj(o0); set.view(o0,1); position(o0,40,103); draw(o0); stop.update(o0);
  animate.obj(o1); set.view(o1,1); ignore.objs(o1); position(o1,42,103); draw(o1); stop.update(o1);`;
const cell = (e: Engine, col: number) => e.textCells[(12 * 40 + col) * 2];

test("force.update restores overlapping stopped objects and stamps every redrawn rectangle", () => {
  const e = game([
    `${actors} display(12,10,"BC"); force.update(o0); return;`,
    `display(12,10,"DE"); force.update(o1); return;`,
  ]);
  e.execute(0);
  assert.deepEqual(
    [cell(e, 10), cell(e, 11)],
    [0, 0],
    "both objects restore their saved backgrounds",
  );
  e.execute(1);
  assert.deepEqual([cell(e, 10), cell(e, 11)], [0, 0], "the next redraw consumes newer text again");
  assert.deepEqual(
    e.screenObjects.slice(0, 2).map((o) => [o.x, o.y, o.cel, o.earlierPartition]),
    [
      [40, 103, 0, true],
      [42, 103, 0, true],
    ],
    "a force refresh advances neither movement nor cycling",
  );
});

test("force.update restores old rectangles, hides older text at new positions, and keeps it on erase", () => {
  const e = game([
    `${actors} display(12,10,"BC"); display(12,20,"XY");
    position(o0,80,103); force.update(o0); return;`,
    "erase(o0); return;",
  ]);
  e.execute(0);
  assert.deepEqual([cell(e, 10), cell(e, 11), cell(e, 20), cell(e, 21)], [0, 0, 0, 89]);
  e.execute(1);
  assert.deepEqual(
    [cell(e, 20), cell(e, 21)],
    [88, 89],
    "text older than the forced draw was saved underneath",
  );
});

test("an incidental clock read inside an unrelated runaway loop exhausts its instruction budget", () => {
  const e = game(["loop: if(equaln(v11,0)){set(f210);} if(equaln(v50,0)){goto loop;} return;"]);
  assert.throws(() => e.tick(), /instruction budget exceeded/);
});

test("a clock read in a called logic does not shield its caller's runaway loop", () => {
  const e = game(["loop: call(1); goto loop;", "if(equaln(v11,0)){set(f210);} return;"]);
  assert.throws(() => e.tick(), /instruction budget exceeded/);
});

for (const source of [
  "wait: if(lessn(v11,1)){if(equaln(v50,0)){goto wait;}} set(f201); return;",
  "wait: if(greatern(v11,0)){goto done;} goto wait; done: set(f201); return;",
  "wait: if(greatern(v11,0)){return;} goto wait;",
])
  test(`clock-controlled back edge resumes after a second: ${source}`, () => {
    const e = game(["call(1); set(f202); return;", source]);
    e.tick();
    assert.equal(e.continuationPending, true);
    assert.equal(e.flags[202], 0);
    e.advanceClock(1000);
    e.tick();
    assert.equal(e.continuationPending, false);
    assert.equal(e.flags[202], 1, "the caller resumes after the clock wait returns");
  });

test("modal waiting time is excluded from the subsequent clock-loop limit", () => {
  const e = game(['print("Wait"); loop: if(lessn(v11,1)){goto loop;} set(f201); return;']);
  e.tick();
  e.advanceClock(11 * 60 * 1000);
  e.ackPrint();
  e.tick();
  assert.equal(e.continuationPending, true);
  e.advanceClock(1000);
  e.tick();
  assert.equal(e.flags[201], 1);
});

for (const source of [
  "loop: if(lessn(v11,1)||equaln(v50,0)){goto loop;} return;",
  "loop: if(greatern(v11,0)&&equaln(v50,1)){return;} goto loop;",
  "loop: assignn(v11,0); if(lessn(v11,1)){goto loop;} return;",
  "assignn(v50,11); loop: lindirectn(v50,0); if(lessn(v11,1)){goto loop;} return;",
  "loop: random(0,0,v11); if(lessn(v11,1)){goto loop;} return;",
  "loop: get.posn(o0,v11,v50); if(lessn(v11,1)){goto loop;} return;",
  "loop: assignn(v11,0); if(lessn(v12,1)){goto loop;} return;",
  "outer: assignn(v50,3); inner: assignn(v11,0); decrement(v50); if(greatern(v50,0)){goto inner;} if(lessn(v11,1)){goto outer;} return;",
])
  test(`clock cannot shield a loop whose exit is fixed by non-clock state or writes: ${source}`, () => {
    const e = game([source]);
    assert.throws(() => e.tick(), /instruction budget exceeded/);
  });

test("a clock reset in called logic does not shield the caller's clock loop", () => {
  const e = game([
    "loop: call(1); if(lessn(v11,1)){goto loop;} return;",
    "assignn(v11,0); return;",
  ]);
  assert.throws(() => e.tick(), /instruction budget exceeded/);
});

for (const source of [
  "loop: if(!isset(f200)){set(f200);assignn(v11,0);} if(lessn(v11,1)&&equaln(v50,0)){goto loop;} set(f201);return;",
  "loop: assignn(v14,0); if(lessn(v11,1)){goto loop;} set(f201);return;",
  "loop: if(greatern(v11,0)&&equaln(v50,0)){set(f201);return;} goto loop;",
])
  test(`clock waits still progress with bounded initialization and true non-clock terms: ${source}`, () => {
    const e = game([source]);
    e.tick();
    assert.equal(e.continuationPending, true);
    e.advanceClock(1000);
    e.tick();
    assert.equal(e.continuationPending, false);
    assert.equal(e.flags[201], 1);
  });

test("a compound minutes-and-seconds wait exits on the advancing host clock", () => {
  const e = game(["loop: if(lessn(v12,1)||lessn(v11,1)){goto loop;} set(f201);return;"]);
  e.tick();
  assert.equal(e.continuationPending, true);
  e.advanceClock(61000);
  e.tick();
  assert.equal(e.continuationPending, false);
  assert.equal(e.flags[201], 1);
});

test("clock analysis never polls a short-circuited have.key", () => {
  let polls = 0;
  const e = game(["loop: if(greatern(v11,0)&&have.key()){return;} goto loop;"], 10000, {
    takeKeys: () => {
      polls++;
      return [];
    },
  });
  assert.throws(() => e.tick(), /instruction budget exceeded/);
  assert.equal(polls, 1, "only the ordinary cycle input poll ran");
});

test("clock analysis reuses each executed have.key outcome exactly once", () => {
  let polls = 0;
  const e = game(
    [
      "loop: addn(v50,1); if(equaln(v50,0)){increment(v51);} if(have.key()||lessn(v11,1)){goto loop;} return;",
    ],
    20000,
    {
      takeKeys: () => {
        polls++;
        return [];
      },
    },
  );
  e.tick();
  assert.equal(e.continuationPending, true);
  const iterations = e.vars[51]! * 256 + e.vars[50]!;
  assert.equal(
    polls,
    1 + iterations,
    "one ordinary cycle poll plus one have.key per loop iteration",
  );
});

for (const source of [
  "loop: if(equalv(v11,v11)){goto loop;}return;",
  "loop: if(lessn(v11,1)||greatern(v11,0)){goto loop;}return;",
  "loop: if(equaln(v11,255)){return;}goto loop;",
  "loop: if(greatern(v11,10)&&lessn(v11,5)){return;}goto loop;",
])
  test(`coherent future clock states cannot escape this loop: ${source}`, () => {
    const e = game([source]);
    assert.throws(() => e.tick(), /instruction budget exceeded/);
  });
