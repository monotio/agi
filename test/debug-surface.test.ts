import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { buildView } from "../src/view/view.ts";

const host: EngineHost = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

function game(source: string): Engine {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  container.putResource("logic", 1, assembleLogic("return;", { dictionary: new Map() }).payload);
  container.putResource(
    "view",
    1,
    buildView({
      loops: [{ cels: [{ width: 2, height: 1, pixels: [1, 1] }] }],
    }),
  );
  return new Engine(container, host);
}

test("getOwnership reports the drawn object number + 1 per pixel, background 0", () => {
  const engine = game(
    "load.view(1); animate.obj(o0); set.view(o0, 1); position(o0, 20, 100); draw(o0); stop.cycling(o0); return;",
  );
  engine.tick();
  const ownership = engine.getOwnership();
  assert.equal(ownership.length, 160 * 168);
  // drawCel places the 2x1 cel at left=x=20 on baseline row 100.
  assert.equal(ownership[100 * 160 + 20], 1, "first cel pixel owned by object 0");
  assert.equal(ownership[100 * 160 + 21], 1, "second cel pixel owned by object 0");
  assert.equal(ownership[100 * 160 + 19], 0, "neighbouring pixel stays background");
  assert.equal(ownership[0], 0);
});

test("getOwnership records the topmost object on overlapping pixels", () => {
  // Equal baselines draw in object-number order, so o1 paints over o0.
  const engine = game(
    "load.view(1); animate.obj(o0); set.view(o0, 1); position(o0, 20, 100); draw(o0); stop.cycling(o0);" +
      " animate.obj(o1); set.view(o1, 1); position(o1, 20, 100); draw(o1); stop.cycling(o1); return;",
  );
  engine.tick();
  engine.tick();
  const ownership = engine.getOwnership();
  assert.equal(ownership[100 * 160 + 20], 2);
  assert.equal(ownership[100 * 160 + 21], 2);
});

test("getOwnership reports sparse object numbers in both paint orders", () => {
  // Objects 3 and 201 keep the table from passing on index-by-accident:
  // ownership is object number + 1, never the position in a dense array.
  // A 2x2 cel on baseline y occupies rows y-1..y, so baselines 100 and 101
  // overlap on row 100; the higher baseline paints second and wins.
  const tall = (container: ReturnType<typeof createContainer>): void => {
    container.putResource(
      "view",
      2,
      buildView({ loops: [{ cels: [{ width: 2, height: 2, pixels: [1, 1, 1, 1] }] }] }),
    );
  };
  const sparse = (source: string): Engine => {
    const container = createContainer();
    container.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
    container.putResource("logic", 1, assembleLogic("return;", { dictionary: new Map() }).payload);
    tall(container);
    return new Engine(container, host);
  };

  // Equal baselines keep object-number order: o201 paints over o3.
  // ignore.objs keeps the collision check from pushing the cels apart.
  const equal = sparse(
    "load.view(2); animate.obj(o3); set.view(o3, 2); ignore.objs(o3); position(o3, 20, 100); draw(o3); stop.cycling(o3);" +
      " animate.obj(o201); set.view(o201, 2); ignore.objs(o201); position(o201, 20, 100); draw(o201); stop.cycling(o201); return;",
  );
  equal.tick();
  equal.tick();
  const shared = equal.getOwnership();
  assert.equal(shared[100 * 160 + 20], 202, "o201 owns the shared pixel");
  assert.equal(shared[99 * 160 + 22], 0, "an unpainted neighbour stays background");

  // o3's baseline below o201's reverses the paint order: o3 paints last.
  const reversed = sparse(
    "load.view(2); animate.obj(o201); set.view(o201, 2); ignore.objs(o201); position(o201, 20, 100); draw(o201); stop.cycling(o201);" +
      " animate.obj(o3); set.view(o3, 2); ignore.objs(o3); position(o3, 20, 101); draw(o3); stop.cycling(o3); return;",
  );
  reversed.tick();
  reversed.tick();
  const flip = reversed.getOwnership();
  assert.equal(flip[100 * 160 + 20], 4, "o3 paints second and owns row 100");
  assert.equal(flip[99 * 160 + 20], 202, "o201 still owns its uncovered top row");
});

test("readState reports the priority band base for overlay drawing", () => {
  const engine = game("set.pri.base(60); return;");
  engine.tick();
  assert.equal(engine.readState().priorityBase, 60);
});
