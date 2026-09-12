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

test("readState reports the priority band base for overlay drawing", () => {
  const engine = game("set.pri.base(60); return;");
  engine.tick();
  assert.equal(engine.readState().priorityBase, 60);
});
