import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { buildView } from "../src/view/view.ts";
import { decodeSave } from "../src/runtime/persistence.ts";
import { PROFILES } from "../src/runtime/profile.ts";

/** The object-0 coupling selector as the save image records it: 1 = player control. */
function coupling(engine: Engine): number {
  return decodeSave(engine.serialize(), PROFILES["2.936"]).directionCoupling;
}

/**
 * Object-0 direction coupling around targeted motion, as the shipped 2.936
 * and 3.002.x interpreters do it (their move.obj and wander handlers write
 * program control for object 0; their motion-stop routine restores player
 * control and clears v6). The spec's movement chapter does not mention it.
 */
class Host implements EngineHost {
  keys: number[] = [];
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
}

const KEY_UP = 0x4800;
const setup = `load.view(1); animate.obj(o0); set.view(o0, 1); ignore.horizon(o0); ignore.blocks(o0); ignore.objs(o0); position(o0, 20, 100); draw(o0); stop.cycling(o0);`;

function game(source: string): { engine: Engine; host: Host } {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  container.putResource(
    "view",
    1,
    buildView({ loops: [{ cels: [{ width: 2, height: 1, pixels: [1, 1] }] }] }),
  );
  const host = new Host();
  return { engine: new Engine(container, host, undefined), host };
}

test("move.obj on ego takes program control until arrival, then hands control back", () => {
  const { engine, host } = game(`
    if (!isset(f200)) { set(f200); ${setup} return; }
    if (!isset(f201)) { set(f201); move.obj(o0, 20, 97, 1, f202); }
    return;
  `);
  engine.tick();
  engine.tick(); // move.obj starts: direction up, one step per cycle
  const ego = engine.screenObjects[0]!;
  assert.equal(ego.y, 99);
  assert.equal(coupling(engine), 0, "the scripted walk runs under program control");
  // An arrow key during the scripted walk is ignored: v6 mirrors the object.
  host.keys.push(0x4d00); // right
  engine.tick();
  assert.deepEqual(
    [ego.x, ego.y, engine.vars[6]],
    [20, 98, 1],
    "still walking up under program control",
  );
  engine.tick();
  assert.deepEqual(
    [ego.x, ego.y, engine.flags[202]],
    [20, 97, 0],
    "arrived; completion is detected next cycle",
  );
  engine.tick();
  assert.deepEqual([engine.flags[202], engine.vars[6]], [1, 0], "completion flag set, v6 cleared");
  assert.equal(coupling(engine), 1, "player control restored");
  // Player control is back: an arrow key now moves ego.
  host.keys.push(KEY_UP);
  engine.tick();
  assert.deepEqual([ego.x, ego.y], [20, 96], "the key moved ego");
});

test("a zero-distance move.obj on ego is a control hand-back", () => {
  const { engine, host } = game(`
    if (!isset(f200)) { set(f200); ${setup} program.control(); return; }
    if (!isset(f201)) { set(f201); move.obj(o0, 20, 100, 0, f202); }
    return;
  `);
  engine.tick();
  host.keys.push(KEY_UP);
  engine.tick();
  const ego = engine.screenObjects[0]!;
  assert.deepEqual([ego.y, engine.vars[6]], [100, 0], "program control ignores the key");
  engine.tick(); // the zero-distance move completes on its first motion update
  assert.equal(engine.flags[202], 1);
  host.keys.push(KEY_UP);
  engine.tick();
  assert.equal(ego.y, 99, "player control restored by the completed move");
});

test("wander on ego selects program control", () => {
  const { engine, host } = game(`
    if (!isset(f200)) { set(f200); ${setup} return; }
    if (!isset(f201)) { set(f201); wander(o0); }
    return;
  `);
  engine.tick();
  engine.tick();
  host.keys.push(KEY_UP);
  engine.tick();
  assert.equal(
    engine.vars[6],
    engine.screenObjects[0]!.direction,
    "v6 follows the wandering object",
  );
  assert.equal(coupling(engine), 0, "wander on ego selects program control");
});
