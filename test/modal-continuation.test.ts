import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { buildView } from "../src/view/view.ts";

test("messages suspend nested bytecode before a room change and resume each caller once", () => {
  const container = createContainer();
  const sources = [
    `if (isset(f5)) {
      load.view(1); animate.obj(o0); set.view(o0,1); position(o0,40,100); draw(o0);
      assignn(v50,0); load.pic(v50); draw.pic(v50); show.pic();
    }
    increment(v60); call(2); increment(v61); call.v(v0); return;`,
    `if (isset(f5)) {
      load.view(1); animate.obj(o0); set.view(o0,1); position(o0,60,100); draw(o0);
      assignn(v50,0); load.pic(v50); draw.pic(v50); show.pic();
    }
    return;`,
    `if (equaln(v0,0)) { call(3); increment(v62); new.room(1); } return;`,
    `increment(v63); print("Before the journey."); increment(v64);
     print("Ready to arrive."); increment(v65); return;`,
  ];
  sources.forEach((source, number) =>
    container.putResource(
      "logic",
      number,
      assembleLogic(source, { dictionary: new Map() }).payload,
    ),
  );
  container.putResource("picture", 0, new Uint8Array([0xf0, 1, 0xf8, 0, 0, 0xff]));
  container.putResource(
    "view",
    1,
    buildView({
      loops: [{ cels: [{ width: 2, height: 2, pixels: [14, 14, 14, 14] }] }],
    }),
  );
  const prints: string[] = [];
  let inputReads = 0;
  const host: EngineHost = {
    print: (message) => {
      prints.push(message);
    },
    displayAt() {},
    statusLine() {},
    takeKeys: () => [],
    takeInputLine: () => {
      inputReads++;
      return null;
    },
  };
  const engine = new Engine(container, host);
  engine.tick();
  assert.deepEqual(prints, ["Before the journey."]);
  assert.equal(engine.vars[0], 0, "the destination must wait for both messages");
  assert.deepEqual(Array.from(engine.vars.slice(60, 66)), [1, 0, 0, 1, 0, 0]);
  assert.equal(engine.screenObjects[0]!.x, 40);
  engine.tick();
  assert.deepEqual(prints, ["Before the journey."], "waiting cannot repeat the script");

  engine.ackPrint();
  // The pass is still parked at the instruction after print — a resumable
  // boundary, so the nested call stack serializes into the image too.
  assert.ok(engine.autosaveImage());
  engine.tick();
  assert.deepEqual(prints, ["Before the journey.", "Ready to arrive."]);
  assert.deepEqual(Array.from(engine.vars.slice(60, 66)), [1, 0, 0, 1, 1, 0]);
  engine.ackPrint();
  engine.tick();
  assert.equal(engine.vars[0], 1);
  assert.deepEqual(Array.from(engine.vars.slice(60, 66)), [2, 1, 1, 1, 1, 1]);
  assert.equal(engine.screenObjects[0]!.active, true);
  assert.equal(engine.screenObjects[0]!.x, 60);
  assert.equal(engine.getFrame().visual[100 * 160 + 60], 14);
  assert.equal(engine.modalKind, null);
  assert.equal(inputReads, 1, "resuming a modal must finish the same input/logic cycle");
  assert.ok(engine.autosaveImage());
});
