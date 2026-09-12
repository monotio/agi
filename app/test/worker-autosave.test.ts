import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { gameContainer, workerHarness } from "./worker-ctx.ts";

// Blue box outline (10,10)-(60,40), filled — the same fixture bytes
// test/autosave.test.ts uses.
const PICTURE_1 = new Uint8Array([
  0xf0, 0x01, 0xf6, 10, 10, 60, 10, 60, 40, 10, 40, 10, 10, 0xf8, 30, 20, 0xf1, 0xf2, 0x05, 0xf6, 0,
  150, 159, 150, 0xf3, 0xff,
]);

const VIEW_0 = new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 1, 1, 0, 0x51, 0]);

function drawnGame() {
  return gameContainer(
    [
      `if (!isset(f200)) { set(f200); assignn(v0, 1); new.room.v(v0); } call.v(v0); return;`,
      `if (isset(f5)) { assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic(); accept.input(); } return;`,
    ],
    (c) => {
      c.putResource("picture", 1, PICTURE_1);
      c.putResource("view", 0, VIEW_0);
    },
  );
}

test("autosave(false) skips when the cycle has not advanced", () => {
  const { ctx, presentation } = workerHarness(drawnGame());
  ctx.fns.tickEngine();
  assert.ok(ctx.engine!.autosaveImage(), "room 1 has drawn, so the boundary is snapshottable");

  ctx.autosave.lastAutosaveCycle = ctx.cycle.cycleCount;
  assert.equal(ctx.fns.autosave(false), false);
  assert.equal(
    presentation.filter((m) => m.type === "autosave").length,
    0,
    "no snapshot posts for an unchanged cycle",
  );
});

test("the autosave message carries files only when patchGeneration changed", () => {
  const { ctx, presentation } = workerHarness(drawnGame());
  ctx.fns.tickEngine();
  ctx.autosave.autosaveFiles = true;
  ctx.autosave.lastPatchGeneration = ctx.engine!.patchGeneration;

  ctx.cycle.cycleCount++;
  assert.equal(ctx.fns.autosave(false), true);
  const first = presentation.find((m) => m.type === "autosave");
  assert.ok(first);
  assert.equal("files" in first, false, "no resource snapshot without a patch");

  ctx.engine!.patchResource(
    "logic",
    9,
    assembleLogic("return;", { dictionary: new Map() }).payload,
  );
  ctx.cycle.cycleCount++;
  assert.equal(ctx.fns.autosave(false), true);
  const posted = presentation.filter((m) => m.type === "autosave");
  assert.equal(posted.length, 2);
  assert.ok("files" in posted[1]! && posted[1].files !== undefined, "the patch travelled");
});
