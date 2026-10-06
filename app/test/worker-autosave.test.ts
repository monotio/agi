import { test } from "node:test";
import assert from "node:assert/strict";

test("autosave reload continues the host RNG word and reseed cursor", (t) => {
  const container = gameContainer(["load.pic(v0);draw.pic(v0);show.pic();return;"], (c) =>
    c.putResource("picture", 0, Uint8Array.of(0xff)),
  );
  const { ctx, presentation } = workerHarness(container);
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  ctx.run.rng = { word: 0, policy: { kind: "sequence", next: 58235, cursor: 3 } };
  ctx.host.randomByte!();
  ctx.fns.autosave(true);
  const save = presentation.findLast((m) => m.type === "autosave");
  assert.ok(save?.type === "autosave");
  const expected = [ctx.host.randomByte!(), ctx.host.randomByte!()];
  const resumed = workerHarness(container).ctx;
  t.after(() => resumed.fns.stopTimers());
  onWorkerMessage(resumed, {
    type: "boot",
    files: Object.fromEntries(container.files),
    words: [],
    restoreImage: save.image,
    ...(save.rng ? { restoreRng: save.rng } : {}),
  });
  assert.deepEqual([resumed.host.randomByte!(), resumed.host.randomByte!()], expected);
  assert.deepEqual(resumed.run.rng, ctx.run.rng);
});
import { assembleLogic } from "../../src/logic/assembler.ts";
import { gameContainer, workerHarness } from "./worker-ctx.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { bytesToBase64 } from "../src/project/bytes.ts";

// Blue box outline (10,10)-(60,40), filled — the same fixture bytes
// test/autosave.test.ts uses.
const PICTURE_1 = new Uint8Array([
  0xf0, 0x01, 0xf6, 10, 10, 60, 10, 60, 40, 10, 40, 10, 10, 0xf8, 30, 20, 0xf1, 0xf2, 0x05, 0xf6, 0,
  150, 159, 150, 0xf3, 0xff,
]);

const VIEW_0 = new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 1, 1, 0, 0x51, 0]);

test("a restored room window starts both clocks and its answering key resumes cycling", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const container = gameContainer(
    [
      "if(!isset(f200)){set(f200);new.room(2);}call.v(v0);increment(v100);return;",
      "return;",
      'if(isset(f5)){assignn(v50,2);load.pic(v50);draw.pic(v50);show.pic();print("Room two");}return;',
    ],
    (game) => game.putResource("picture", 2, PICTURE_1),
  );
  const { ctx, control, presentation } = workerHarness(container);
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.modalKind, "print");
  const image = ctx.run.engine!.autosaveImage();
  assert.ok(image);
  let now = 0;
  ctx.ports.now = () => now;
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(container.files),
    words: [],
    restoreImage: bytesToBase64(image),
  });
  t.after(() => ctx.fns.stopTimers());
  assert.ok(control.some((message) => message.type === "restored" && message.ok));
  assert.notEqual(ctx.run.cycle.timer, null);
  assert.notEqual(ctx.run.cycle.soundTimer, null);
  now = 250;
  t.mock.timers.tick(250);
  assert.ok(
    presentation.some(
      (message) => message.type === "cycle" && message.room === 2 && message.cycle === 0,
    ),
  );
  assert.equal(ctx.run.engine!.modalKind, "print");
  onWorkerMessage(ctx, { type: "key", code: 13 });
  now += 250;
  t.mock.timers.tick(250);
  assert.equal(ctx.run.engine!.modalKind, null);
  assert.equal(ctx.run.engine!.vars[0], 2);
  assert.ok(ctx.run.engine!.vars[100]! > 0);
  assert.ok(ctx.run.cycle.cycleCount > 0);
});

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
  assert.ok(ctx.run.engine!.autosaveImage(), "room 1 has drawn, so the boundary is snapshottable");

  ctx.run.autosave.lastAutosaveCycle = ctx.run.cycle.cycleCount;
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
  ctx.run.autosave.autosaveFiles = true;
  ctx.run.autosave.lastPatchGeneration = ctx.run.engine!.patchGeneration;

  ctx.run.cycle.cycleCount++;
  assert.equal(ctx.fns.autosave(false), true);
  const first = presentation.find((m) => m.type === "autosave");
  assert.ok(first);
  assert.equal("files" in first, false, "no resource snapshot without a patch");

  ctx.run.engine!.patchResources([
    { kind: "logic", num: 9, payload: assembleLogic("return;", { dictionary: new Map() }).payload },
  ]);
  ctx.run.cycle.cycleCount++;
  assert.equal(ctx.fns.autosave(false), true);
  const posted = presentation.filter((m) => m.type === "autosave");
  assert.equal(posted.length, 2);
  assert.ok("files" in posted[1]! && posted[1].files !== undefined, "the patch travelled");
});

test("a forced flush's autosave survives a seek in flight", () => {
  const { ctx, presentation } = workerHarness(drawnGame());
  ctx.fns.tickEngine();
  assert.ok(ctx.run.engine!.autosaveImage(), "room 1 has drawn, so the boundary is snapshottable");

  // A pagehide flush lands mid-seek: the transient stream is suppressed but
  // the snapshot must still post, or the last position is lost on reload.
  ctx.replay.isSeeking = true;
  ctx.fns.postFrame();
  ctx.fns.onFlush({ type: "flush", id: 1 });
  assert.equal(
    presentation.filter((m) => m.type === "frame").length,
    0,
    "frames stay suppressed while seeking",
  );
  assert.equal(
    presentation.filter((m) => m.type === "autosave").length,
    1,
    "the forced autosave is not dropped",
  );
});

test("a game that quits leaves no autosave of its ended interpreter", () => {
  const { ctx, presentation } = workerHarness(
    gameContainer(
      [
        `if (!isset(f200)) { set(f200); assignn(v0, 1); new.room.v(v0); } if (isset(f201)) { quit(1); } call.v(v0); return;`,
        `if (isset(f5)) { assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic(); } return;`,
      ],
      (c) => c.putResource("picture", 1, PICTURE_1),
    ),
  );
  ctx.fns.tickEngine();
  ctx.run.engine!.flags[201] = 1;
  ctx.fns.tickEngine();
  assert.ok(
    presentation.some((m) => m.type === "quit"),
    "the quit reaches the page",
  );
  ctx.run.cycle.cycleCount++;
  assert.equal(ctx.fns.autosave(true), false, "an ended game cannot be resumed");
  assert.equal(presentation.filter((m) => m.type === "autosave").length, 0);
});

test("an all-black screen autosaves without a card preview", () => {
  // Visual colour 0, then a fill from the corner: the whole picture is black.
  const black = Uint8Array.of(0xf0, 0x00, 0xf8, 0, 0, 0xff);
  const { ctx, presentation } = workerHarness(
    gameContainer(
      [
        `if (!isset(f200)) { set(f200); assignn(v0, 1); new.room.v(v0); } call.v(v0); return;`,
        `if (isset(f5)) { assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic(); } return;`,
      ],
      (c) => c.putResource("picture", 1, black),
    ),
  );
  ctx.fns.tickEngine();
  ctx.run.cycle.cycleCount++;
  assert.equal(ctx.fns.autosave(true), true, "the position itself is still saved");
  const posted = presentation.find((m) => m.type === "autosave");
  assert.ok(posted);
  assert.equal("preview" in posted, false, "a black frame is no picture of the game");

  const { ctx: drawn, presentation: drawnPresentation } = workerHarness(drawnGame());
  drawn.fns.tickEngine();
  drawn.run.cycle.cycleCount++;
  drawn.fns.autosave(true);
  const shown = drawnPresentation.find((m) => m.type === "autosave");
  assert.ok(shown && "preview" in shown, "a drawn room keeps its preview");
});

test("a quit replayed from a recording plays to its end instead of sending the player Home", () => {
  const { ctx, presentation } = workerHarness(
    gameContainer([`if (isset(f201)) { quit(1); } return;`]),
  );
  // Walkthroughs and the history timeline run the worker in replay mode.
  ctx.replay.replay = { tick: 0, revision: 0 };
  ctx.run.rng.word = 1;
  ctx.run.engine!.flags[201] = 1;
  ctx.run.engine!.tick();
  assert.equal(ctx.run.engine!.readLeanState().terminated, true);
  assert.equal(presentation.filter((m) => m.type === "quit").length, 0);
});
