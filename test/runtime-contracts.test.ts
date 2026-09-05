import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildView } from "../src/view/view.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";

function game(source: string, host: Partial<EngineHost> = {}) {
  const c = createContainer();
  c.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  c.putResource(
    "view",
    0,
    buildView({
      loops: [
        {
          cels: [
            { width: 1, height: 1, pixels: [1] },
            { width: 1, height: 1, pixels: [2] },
          ],
        },
      ],
    }),
  );
  return new Engine(c, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeKeys: () => [],
    takeInputLine: () => null,
    ...host,
  });
}

test("alternate text mode skips post-logic movement and animation until graphics resumes", () => {
  const e = game(
    "if(!isset(f200)){set(f200);load.view(0);animate.obj(o0);set.view(o0,0);position(o0,80,120);draw(o0);assignn(v6,3);text.screen();}return;",
  );
  e.tick();
  const o = e.screenObjects[0]!;
  assert.equal(o.cel, 0);
  for (let i = 0; i < 10; i++) e.tick();
  assert.equal(o.x, 80);
  assert.equal(o.cel, 0);
  e.patchResource(
    "logic",
    0,
    assembleLogic("graphics();return;", { dictionary: new Map() }).payload,
  );
  e.tick();
  assert.equal(o.cel, 1);
});

test("random actions consume the injected random source, including inclusive endpoints", () => {
  const values = [0, 10, 65535];
  const e = game("random(5,15,v200);random(5,15,v201);random(0,255,v202);return;", {
    randomWord: () => values.shift()!,
  });
  e.tick();
  assert.deepEqual(Array.from(e.vars.slice(200, 203)), [5, 15, 255]);
  assert.equal(values.length, 0);
});

test("platform variables describe the EGA display and selected sound hardware at boot and restart", () => {
  for (const device of [0, 1]) {
    const e = game("set(f16);restart.game();return;", { soundDevice: () => device });
    assert.equal(e.vars[20], 0);
    assert.equal(e.vars[22], device === 0 ? 1 : 3);
    assert.equal(e.vars[26], 3);
    e.tick();
    assert.equal(e.vars[22], device === 0 ? 1 : 3);
    assert.equal(e.vars[26], 3);
  }
});

test("f1 reports complete ego occlusion without requiring the host to request a frame", () => {
  const e = game(
    "if(!isset(f200)){set(f200);load.view(0);animate.obj(o0);set.view(o0,0);position(o0,80,120);draw(o0);stop.cycling(o0);}return;",
  );
  e.surface.priority.fill(15);
  e.tick();
  assert.equal(e.flags[1], 1);
  e.surface.priority.fill(4);
  e.tick();
  assert.equal(e.flags[1], 0);
  // Matching background colour is not occlusion: the nontransparent pixel still draws.
  e.surface.visual.fill(1);
  e.tick();
  assert.equal(e.flags[1], 0);
  e.surface.priority.fill(15);
  const flags = e.flags.slice();
  e.getFrame();
  assert.deepEqual(e.flags, flags, "frame inspection has no game-state side effects");
  e.tick();
  assert.equal(e.flags[1], 1);
  e.surface.priority.fill(4);
  e.patchResource(
    "logic",
    0,
    assembleLogic(
      "animate.obj(o1);set.view(o1,0);ignore.objs(o1);position(o1,80,120);draw(o1);stop.cycling(o1);return;",
      { dictionary: new Map() },
    ).payload,
  );
  e.tick();
  assert.equal(e.flags[1], 1, "a later opaque sprite can cover ego completely");
  e.patchResource(
    "logic",
    0,
    assembleLogic("erase(o1);return;", { dictionary: new Map() }).payload,
  );
  e.tick();
  assert.equal(e.flags[1], 0, "erasing the covering sprite reveals ego");
});
