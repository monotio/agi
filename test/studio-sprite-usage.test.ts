import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTutorial } from "../games/adventure-department/game.ts";
import { openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { scanViewUsage, viewUsage } from "../src/studio/sprite/spriteUsage.ts";

function tutorialLogics(): Map<number, Uint8Array> {
  const container = openContainer(new Map(Object.entries(buildTutorial().files)));
  const logics = new Map<number, Uint8Array>();
  for (let num = 0; num < 256; num++) {
    const payload = container.getResource("logic", num);
    if (payload) logics.set(num, payload);
  }
  return logics;
}

describe("sprite usage", () => {
  it("finds the tutorial rooms that use each view", () => {
    const index = scanViewUsage(tutorialLogics());
    // Logics 1-3 are the gallery, sprite lab and archive; logic 0 dispatches.
    assert.deepEqual(viewUsage(index, 0), { rooms: [1, 2, 3], logics: [1, 2, 3], dynamic: false });
    for (const view of [1, 2, 4])
      assert.deepEqual(viewUsage(index, view), { rooms: [2], logics: [2], dynamic: false });
    for (const view of [3, 5])
      assert.deepEqual(viewUsage(index, view), { rooms: [3], logics: [3], dynamic: false });
    assert.deepEqual(viewUsage(index, 6), { rooms: [], logics: [], dynamic: false });
  });

  it("follows literal calls, reads add.to.pic and show.obj, and flags variable forms", () => {
    const logic = (source: string) => assembleLogic(source, { dictionary: new Map() }).payload;
    const index = scanViewUsage(
      new Map([
        [0, logic("load.view(9); return;")],
        [1, logic("call(50); return;")],
        [2, logic("show.obj(8); set.view.v(o1, v3); return;")],
        [50, logic("add.to.pic(7, 0, 0, 50, 50, 4, 4); return;")],
      ]),
    );
    assert.deepEqual(viewUsage(index, 7), { rooms: [1], logics: [50], dynamic: true });
    assert.deepEqual(viewUsage(index, 8), { rooms: [2], logics: [2], dynamic: true });
    // Logic 0 runs in every room; it is reported as a logic, not a room.
    assert.deepEqual(viewUsage(index, 9), { rooms: [], logics: [0], dynamic: true });
    assert.deepEqual(index.dynamicLogics, [2]);
  });
});
