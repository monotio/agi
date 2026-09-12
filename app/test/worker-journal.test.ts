import { test } from "node:test";
import assert from "node:assert/strict";
import { gameContainer, workerHarness } from "./worker-ctx.ts";
import type { WorkerControl } from "../src/workerProtocol.ts";

// Blue box — the same fixture bytes test/autosave uses.
const PICTURE_1 = new Uint8Array([
  0xf0, 0x01, 0xf6, 10, 10, 60, 10, 60, 40, 10, 40, 10, 10, 0xf8, 30, 20, 0xf1, 0xf2, 0x05, 0xf6, 0,
  150, 159, 150, 0xf3, 0xff,
]);

// OBJECT metadata: two world items, "key" and "coin", neither carried.
const OBJECT_FILE = new Uint8Array([
  6, 0, 10, 6, 0, 0, 10, 0, 0, 107, 101, 121, 0, 99, 111, 105, 110, 0,
]);

/**
 * logic 0 drives four scripted transitions, one per flag:
 *  f200: edge exit bottom to room 2 with a score gain and a picked-up item
 *  f201: a get.num suspension whose resumed pass new.rooms to room 3
 *  f202: restart.game, which the next new.room reports as "restart"
 * Each room logic draws a picture so the boundary is snapshottable.
 */
function journalGame() {
  return gameContainer(
    [
      `if (isset(f6)) { reset(f6); new.room(1); }
       if (isset(f200)) { reset(f200); assignn(v3, 5); get(0); assignn(v2, 3); new.room(2); }
       if (isset(f201)) { reset(f201); get.num("n?", v10); new.room(3); }
       if (isset(f202)) { reset(f202); set(f16); restart.game(); }
       if (v0 > 0) { call.v(v0); }
       return;`,
      `if (isset(f5)) { assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic(); } return;`,
      `if (isset(f5)) { assignn(v50, 2); load.pic(v50); draw.pic(v50); show.pic(); } return;`,
      `if (isset(f5)) { assignn(v50, 3); load.pic(v50); draw.pic(v50); show.pic(); } return;`,
    ],
    (c) => {
      c.putResource("picture", 1, PICTURE_1);
      c.putResource("picture", 2, PICTURE_1);
      c.putResource("picture", 3, PICTURE_1);
      c.putFile("OBJECT", OBJECT_FILE);
    },
  );
}

function transitions(control: WorkerControl[]) {
  return control.filter((m) => m.type === "roomTransition");
}

test("boot records the starting room, then an edge exit carries its deltas", () => {
  const { ctx, control, presentation } = workerHarness(journalGame());
  ctx.fns.armJournal();

  ctx.fns.tickEngine();
  ctx.fns.finishCycle();
  const boot = transitions(control);
  assert.equal(boot.length, 1, "the first boundary records the starting room");
  assert.deepEqual(
    { from: boot[0]!.from, to: boot[0]!.to, cause: boot[0]!.cause },
    { from: null, to: 0, cause: "boot" },
  );

  ctx.engine!.flags[200] = 1;
  ctx.fns.tickEngine();
  ctx.fns.finishCycle();
  const all = transitions(control);
  assert.equal(all.length, 2, "one observation for the edge exit, none extra");
  const edge = all[1]!;
  assert.equal(edge.cause, "edge");
  assert.equal(edge.edge, "bottom", "v2=3 maps to the bottom edge");
  assert.equal(edge.from, 0);
  assert.equal(edge.to, 2);
  assert.equal(edge.scoreDelta, 5, "assignn(v3,5) lands in the entry");
  assert.deepEqual(edge.gained, [0], "get(i0) reports the picked-up item");
  assert.deepEqual(edge.lost, []);
  assert.equal(edge.seq, 2);

  // The entry shares its landing frame's identity — the map binds thumbnails
  // by (patchGeneration, cycle), never by arrival order.
  ctx.fns.postFrame();
  const frame = presentation.filter((m) => m.type === "frame").at(-1)!;
  assert.ok(frame.type === "frame");
  assert.equal(frame.cycle, edge.cycle, "the entry stamps the landing frame's cycle");
  assert.equal(frame.patchGeneration, edge.patchGeneration);
});

test("a transition resumed by a host answer records exactly one entry", () => {
  const { ctx, control } = workerHarness(journalGame());
  ctx.fns.armJournal();
  ctx.fns.tickEngine();
  ctx.fns.finishCycle();

  ctx.engine!.flags[201] = 1;
  ctx.fns.tickEngine(); // suspends on get.num mid-logic
  assert.equal(ctx.engine!.hostInteractionPending, true, "the pass parked on the prompt");
  const request = control.find((m) => m.type === "hostRequest");
  assert.ok(request && request.type === "hostRequest");

  const before = transitions(control).length;
  ctx.fns.onHostAnswer({ type: "hostAnswer", id: request.id, response: "7" });
  const all = transitions(control);
  assert.equal(all.length, before + 1, "the resumed new.room emits once");
  const resumed = all.at(-1)!;
  assert.equal(resumed.cause, "logic", "no edge code, no pending cause — plain new.room");
  assert.equal(resumed.to, 3);
  ctx.fns.noteTransition();
  assert.equal(transitions(control).length, before + 1, "the boundary check adds nothing");
});

test("restart, reenter, restore and a v0 jump are labelled, never walkable", () => {
  const { ctx, control } = workerHarness(journalGame());
  ctx.fns.armJournal();
  ctx.fns.tickEngine();
  ctx.fns.finishCycle();

  // Move to a drawn room first so the restore step has a snapshot.
  ctx.engine!.flags[200] = 1;
  ctx.fns.tickEngine();
  ctx.fns.finishCycle();
  const image = ctx.engine!.autosaveImage();
  assert.ok(image, "a drawn room snapshots for the restore step");

  // Authoring re-entry: same room, cause "reenter", not an edge.
  ctx.fns.onReenter({ type: "reenter" });
  const reenter = transitions(control).at(-1)!;
  assert.equal(reenter.cause, "reenter");
  assert.equal(reenter.from, 2);
  assert.equal(reenter.to, 2);
  assert.equal("edge" in reenter, false);

  // Restart: f6 drives the game's own new.room(1); the engine marks it.
  ctx.engine!.flags[202] = 1;
  ctx.fns.tickEngine(); // restart.game aborts the pass, arms f6 + restartPending
  ctx.fns.finishCycle();
  ctx.fns.tickEngine(); // logic 0 sees f6 and new.rooms to 1
  ctx.fns.finishCycle();
  const restart = transitions(control).at(-1)!;
  assert.equal(restart.cause, "restart");
  assert.equal(restart.to, 1);
  assert.equal("edge" in restart, false);

  // Restore: the delivered image moves v0 without a new.room.
  ctx.fns.markRestore();
  try {
    ctx.engine!.restoreImage(image);
  } catch {
    // ContinuationAbort unwinds like the live host path.
  }
  ctx.fns.noteTransition();
  const restored = transitions(control).at(-1)!;
  assert.equal(restored.cause, "restore");
  assert.equal(restored.to, 2, "the image was captured in room 2");
  assert.equal("edge" in restored, false);

  // Debug jump: a direct v0 write is jump-shaped, not a walk.
  ctx.fns.onDebugWrite({ type: "debugWrite", id: 1, vars: [[0, 3]] });
  const jump = transitions(control).at(-1)!;
  assert.equal(jump.cause, "jump");
  assert.equal(jump.to, 3);
  assert.equal("edge" in jump, false);
});

test("replay sessions leave no journal trace and the baseline survives exit", () => {
  const { ctx, control } = workerHarness(journalGame());
  ctx.fns.armJournal();
  ctx.fns.tickEngine();
  ctx.fns.noteTransition();
  const liveEntries = transitions(control).length;

  ctx.replay.replay = { tick: 0 } as never;
  ctx.engine!.flags[200] = 1;
  ctx.fns.tickEngine();
  ctx.fns.finishCycle();
  assert.equal(transitions(control).length, liveEntries, "scratch replay emits nothing");

  ctx.replay.replay = null;
  ctx.fns.rebaselineJournal();
  assert.equal(ctx.journal.lastRoom, 2, "the journal continues from the room replay left");
});
