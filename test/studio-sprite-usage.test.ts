import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTutorial } from "../games/adventure-department/game.ts";
import { openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { roomBakesView, scanViewUsage, viewUsage } from "../src/agent/viewUsage.ts";

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

  it("says which rooms bake a view into their picture, so a Keep re-enters only those", () => {
    const logic = (source: string) => assembleLogic(source, { dictionary: new Map() }).payload;
    const index = scanViewUsage(
      new Map([
        [0, logic("return;")],
        [1, logic("call(50); set.view(o1, 3); return;")],
        [2, logic("add.to.pic.v(v1, v2, v3, v4, v5, v6, v7); return;")],
        [3, logic("set.view(o1, 7); return;")],
        [50, logic("add.to.pic(7, 0, 0, 50, 50, 4, 4); return;")],
      ]),
    );
    // Room 1 bakes view 7 through logic 50; its animated view 3 updates live.
    assert.equal(roomBakesView(index, 1, 7), true);
    assert.equal(roomBakesView(index, 1, 3), false);
    // A variable add.to.pic may bake any view.
    assert.equal(roomBakesView(index, 2, 3), true);
    assert.equal(roomBakesView(index, 3, 7), false);
    assert.deepEqual(index.dynamicBakers, [2]);
  });

  it("reads the tutorial: no room bakes the apprentice", () => {
    const index = scanViewUsage(tutorialLogics());
    for (const room of [1, 2, 3]) assert.equal(roomBakesView(index, room, 0), false);
  });
});
