import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine } from "../src/runtime/engine.ts";
import { buildView } from "../src/view/view.ts";
import { placeEgo, playHereProblem } from "../src/runtime/playHere.ts";

/** Room 1: a control-0 line across y=100, horizon 36, ego 3x5 at (80,120) walking east. */
function room(extra = "") {
  const container = createContainer();
  container.putResource("picture", 1, Uint8Array.of(0xf2, 0, 0xf6, 0, 100, 159, 100, 0xff));
  container.putResource(
    "view",
    0,
    buildView({ loops: [{ cels: [{ width: 3, height: 5, pixels: new Array(15).fill(1) }] }] }),
  );
  for (const [num, source] of [
    [0, "if(equaln(v0,0)){new.room(1);}call.v(v0);return;"],
    [
      1,
      `if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();load.view(0);animate.obj(o0);set.view(o0,0);position(o0,80,120);${extra}draw(o0);accept.input();assignn(v6,3);}return;`,
    ],
  ] as const)
    container.putResource("logic", num, assembleLogic(source, { dictionary: new Map() }).payload);
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

test("placeEgo stands ego on an accepted spot and stops it", () => {
  const engine = room();
  const ego = engine.screenObjects[0]!;
  assert.equal(engine.vars[6], 3);
  assert.equal(placeEgo(engine, 30, 140), "ok");
  assert.deepEqual(
    [ego.x, ego.y, ego.prevX, ego.prevY, ego.direction, engine.vars[6]],
    [30, 140, 30, 140, 0, 0],
  );
});

test("placeEgo refuses what the engine refuses and leaves ego alone", () => {
  const engine = room();
  const ego = engine.screenObjects[0]!;
  // x 28..30 covers the line at y=100; the horizon is 36; x+3 must fit in 160.
  for (const [x, y, verdict] of [
    [28, 100, "barrier"],
    [30, 36, "horizon"],
    [158, 140, "bounds"],
  ] as const) {
    assert.equal(placeEgo(engine, x, y), verdict);
    assert.deepEqual([ego.x, ego.y], [80, 120]);
  }
  // Fixed priority 15 skips the control scan.
  assert.equal(placeEgo(room("set.priority(o0,15);"), 28, 100), "ok");
});

test("playHereProblem checks the target's shape", () => {
  assert.equal(playHereProblem({ room: 2, x: 159, y: 167 }), null);
  assert.match(playHereProblem({ room: 0, x: 0, y: 0 }) ?? "", /room/);
  assert.match(playHereProblem({ room: 2, x: 1.5, y: 0 }) ?? "", /x must/);
  assert.match(playHereProblem({ room: 2, x: 0, y: 168 }) ?? "", /y must/);
});
