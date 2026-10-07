import { test } from "node:test";
import assert from "node:assert/strict";
import { gameContainer, workerHarness } from "./worker-ctx.ts";
import { buildObjectFile } from "../../src/authoring/inventory.ts";
import { buildView } from "../../src/view/view.ts";
import { prepareRoomLaunch, type RoomLaunchRequest } from "../src/worker/roomLaunch.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { enterCreateRun } from "../src/worker/resumePoint.ts";
import { buildSound } from "../../src/sound/build.ts";

test("Carry over completes the logical sound before the destination LOGIC runs", (t) => {
  const { ctx } = workerHarness(
    gameContainer(
      [
        "if(equaln(v0,0)){new.room(1);}call.v(v0);return;",
        "if(isset(f5)){load.sound(0);sound(0,f60);}return;",
        "if(isset(f60)){assignn(v80,1);}return;",
      ],
      (c) =>
        c.putResource(
          "sound",
          0,
          buildSound([{ notes: [{ duration: 1000, freqDivisor: 226, attenuation: 0 }] }]),
        ),
    ),
  );
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  ctx.fns.onPlayHere({ type: "playHere", id: 1, room: 2, x: 0, y: 0, launch: {} });
  assert.equal(ctx.run.engine!.vars[80], 1);
});

test("Launch f2 f4 v9 v19 inputs reach the first LOGIC pass after transition clears", (t) => {
  const { ctx } = workerHarness(
    gameContainer([
      "if(equaln(v0,0)){new.room(1);}call.v(v0);return;",
      "return;",
      "if(isset(f2)){assignn(v80,1);}if(isset(f4)){assignn(v81,1);}assignv(v82,v9);assignv(v83,v19);return;",
    ]),
  );
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  ctx.fns.onPlayHere({
    type: "playHere",
    id: 1,
    room: 2,
    x: 0,
    y: 0,
    launch: { state: { flags: { "2": true, "4": true }, variables: { "9": 17, "19": 65 } } },
  });
  assert.deepEqual(
    [80, 81, 82, 83].map((n) => ctx.run.engine!.vars[n]),
    [1, 1, 17, 65],
  );
});

test("From the beginning resets the RNG word to the cold boot stream", (t) => {
  const { ctx } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  ctx.fns.onPlayHere({
    type: "playHere",
    id: 1,
    room: 2,
    x: 0,
    y: 0,
    launch: { state: { seed: 1234 } },
  });
  let reads = 0;
  ctx.ports.seedWord = () => {
    reads++;
    return 0x1234;
  };
  ctx.fns.onPlayHere({ type: "playHere", id: 2, room: 1, x: 0, y: 0, launch: { beginning: true } });
  assert.equal(reads, 0);
  assert.equal(ctx.host.randomByte!(), 12);
  assert.equal(reads, 1);
});

test("Debug Launch refuses mismatched sources before replacing or executing the run", (t) => {
  const { ctx, control } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  ctx.fns.onDebugAttach({ type: "debugAttach", id: 80, sources: { "2": "return;" } });
  // Attach with mismatched sources refuses too; attach matching authority first.
  ctx.fns.onDebugAttach({ type: "debugAttach", id: 81 });
  ctx.run.debugger.sources = { "2": "assignn(v99,9);return;" };
  const engine = ctx.run.engine;
  const image = engine!.recordingImage();
  ctx.fns.onPlayHere({ type: "playHere", id: 82, room: 2, x: 0, y: 0, launch: { debug: true } });
  const reply = control.findLast((m) => m.type === "playedHere");
  assert.ok(reply?.type === "playedHere" && !reply.ok);
  assert.match(reply.reason!, /Source does not reproduce LOGIC 2/);
  assert.equal(ctx.run.engine, engine);
  assert.deepEqual(ctx.run.engine!.recordingImage(), image);
});

test("native room entry drains worker keys, movement, lines and clicks in order", (t) => {
  const { ctx } = workerHarness(
    gameContainer([
      "if(equaln(v0,0)){new.room(1);}call.v(v0);return;",
      "if(isset(f50)){new.room(2);}return;",
      "assignv(v80,v19);return;",
    ]),
  );
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  ctx.run.engine!.flags[50] = 1;
  ctx.run.engine!.setRoomTransitionListener(() => {
    // Inputs arriving while prepareRoom is pending belong before its transition boundary.
    ctx.run.input.keyQueue.push(65);
    ctx.run.input.deferredMovement.push(0x4800);
    ctx.run.input.inputBuffer.push("old room");
    ctx.run.input.clickQueue.push([10, 10]);
  });
  ctx.fns.tickEngine();
  assert.deepEqual(ctx.run.input.keyQueue, []);
  assert.deepEqual(ctx.run.input.deferredMovement, []);
  assert.deepEqual(ctx.run.input.inputBuffer, []);
  assert.deepEqual(ctx.run.input.clickQueue, []);
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.vars[80], 0);
});

test("host reentry drains input before the destination pass", (t) => {
  const { ctx } = workerHarness(
    gameContainer([
      "if(equaln(v0,0)){new.room(1);}call.v(v0);return;",
      "return;",
      "assignv(v80,v19);return;",
    ]),
  );
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  ctx.run.input.keyQueue.push(65);
  ctx.run.engine!.reenterRoom(2);
  ctx.fns.tickEngine();
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.vars[80], 0);
});

function game() {
  return gameContainer(
    [
      "if(equaln(v0,0)){new.room(1);}assignv(v80,v1);call.v(v0);return;",
      "if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();load.view(0);animate.obj(o0);set.view(o0,0);position(o0,20,140);draw(o0);}return;",
      "if(isset(f5)){assignv(v81,v1);get.posn(o0,v82,v83);assignn(v91,0);get.room.v(v91,v84);if(isset(f50)){assignn(v85,1);}load.pic(v0);draw.pic(v0);show.pic();}return;",
      'if(isset(f5)){set(f220);print("Death");}return;',
    ],
    (c) => {
      c.putFile("OBJECT", buildObjectFile([{ name: "key", startingRoom: 0 }]));
      c.putResource("picture", 1, Uint8Array.of(0xff));
      c.putResource("picture", 2, Uint8Array.of(0xff));
      c.putResource(
        "view",
        0,
        buildView({ loops: [{ cels: [{ width: 3, height: 5, pixels: new Array(15).fill(1) }] }] }),
      );
    },
  );
}

test("Launch applies origin after reset and edge placement before LOGIC 0, with items and flags", (t) => {
  const { ctx, control } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  enterCreateRun(ctx);
  ctx.fns.onPlayHere({
    type: "playHere",
    id: 1,
    room: 2,
    x: 0,
    y: 0,
    launch: {
      state: {
        cameFrom: { room: 7, edge: 4 },
        flags: { "50": true },
        variables: { "90": 44 },
        items: { "0": 255 },
      },
    },
  });
  const reply = control.findLast((m) => m.type === "playedHere");
  assert.ok(reply?.type === "playedHere" && reply.ok, JSON.stringify(reply));
  assert.deepEqual(
    [80, 81, 82, 83, 84, 85, 90].map((n) => ctx.run.engine!.vars[n]),
    [7, 7, 157, 140, 255, 1, 44],
  );
  assert.equal(ctx.run.engine!.vars[2], 0);
  assert.equal(ctx.run.progress.mode, "create");
});

test("an invalid Launch refuses before changing the engine, history or host", (t) => {
  const { ctx, control, presentation } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  const engine = ctx.run.engine!;
  const before = engine.recordingImage();
  const count = presentation.length;
  ctx.fns.onPlayHere({
    type: "playHere",
    id: 2,
    room: 2,
    x: 0,
    y: 0,
    launch: { state: { flags: { "50": true }, items: { "2": 255 } } },
  });
  const reply = control.findLast((m) => m.type === "playedHere");
  assert.ok(reply?.type === "playedHere" && !reply.ok);
  assert.equal(ctx.run.engine, engine);
  assert.deepEqual(engine.recordingImage(), before);
  assert.equal(presentation.length, count);
});

test("Launch validates its room and options before creating an entry", (t) => {
  const { ctx, presentation } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  const engine = ctx.run.engine!;
  const image = engine.recordingImage();
  const count = presentation.length;
  for (const request of [
    { room: 256, beginning: true },
    { room: 2, beginning: "yes" },
    { room: 2, debug: "yes" },
    { room: 2, state: null },
  ])
    assert.throws(() => prepareRoomLaunch(ctx, request as RoomLaunchRequest));
  assert.equal(ctx.run.engine, engine);
  assert.deepEqual(engine.recordingImage(), image);
  assert.equal(presentation.length, count);
});

test("Launch carries state within a profile and starts fresh when the profile changes", (t) => {
  const { ctx } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  const engine = ctx.run.engine!;
  const files = engine.containerFiles;
  assert.throws(
    () => prepareRoomLaunch(ctx, { room: 2 }, files, PROFILES["2.917"]),
    /From the beginning/,
  );
  const fresh = prepareRoomLaunch(ctx, { room: 2, beginning: true }, files, PROFILES["2.917"]);
  assert.equal(fresh.engine.profile.id, "2.917");
  assert.equal(fresh.engine.vars[0], 0);
  assert.equal(ctx.run.engine, engine);
});

test("Create entry checkpoints Play once before temporary play", (t) => {
  const { ctx, presentation, control } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  enterCreateRun(ctx);
  assert.equal(presentation.filter((m) => m.type === "autosave").length, 1);
  assert.equal(ctx.run.progress.mode, "create");
  assert.equal(ctx.fns.autosave(true), false);
  ctx.fns.onFlush({ type: "flush", id: 60 });
  const reply = control.findLast((m) => m.type === "flushed");
  assert.ok(reply?.type === "flushed" && reply.temporary && !reply.taken);
});

test("same Launch seed repeats a random sequence including zero-state reseeds", (t) => {
  const { ctx } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  let external = 99;
  ctx.ports.seedWord = () => ++external;
  const run = () => {
    ctx.fns.onPlayHere({
      type: "playHere",
      id: 3,
      room: 2,
      x: 0,
      y: 0,
      launch: { state: { seed: 58235 } },
    });
    return Array.from({ length: 8 }, () => ctx.host!.randomByte!());
  };
  assert.deepEqual(run(), run());
  assert.equal(external, 99, "Create's reseed lane uses the Launch seed");
});

test("Debug Launch stops before its first LOGIC 0 instruction and carries edit authority", (t) => {
  const { ctx, control } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  ctx.fns.onDebugAttach({ type: "debugAttach", id: 4 });
  ctx.fns.onPlayHere({
    type: "playHere",
    id: 5,
    room: 2,
    x: 0,
    y: 0,
    launch: { debug: true, state: { cameFrom: { room: 7 } } },
  });
  const stop = control.findLast((m) => m.type === "debugStopped");
  assert.ok(stop?.type === "debugStopped");
  assert.equal(stop.location?.logic, 0);
  assert.equal(stop.location?.pc, 0);
  assert.equal(ctx.run.engine!.vars[80], 0, "the entry pass has not executed");
  assert.equal(ctx.run.debugger.engine, ctx.run.engine);
});

test("repeated death Launches stay outside saved progress, including flush", (t) => {
  const { ctx, control, presentation } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  enterCreateRun(ctx);
  assert.equal(ctx.fns.autosave(true), false);
  const baseline = presentation.find((m) => m.type === "autosave");
  assert.ok(baseline?.type === "autosave");
  for (let id = 10; id < 12; id++) {
    ctx.fns.onPlayHere({
      type: "playHere",
      id,
      room: 3,
      x: 0,
      y: 0,
      launch: { state: { flags: { "220": false } } },
    });
    assert.equal(ctx.run.engine!.modalKind, "print");
    assert.equal(ctx.run.engine!.flags[220], 1);
    assert.ok(control.findLast((m) => m.type === "playedHere")?.ok);
    assert.equal(ctx.fns.autosave(true), false);
    ctx.fns.onFlush({ type: "flush", id: id + 20 });
    const flush = control.findLast((m) => m.type === "flushed");
    assert.ok(flush?.type === "flushed" && !flush.taken);
  }
  for (const save of presentation.filter((m) => m.type === "autosave")) {
    assert.equal(save.room, 1);
    assert.equal(save.image, baseline.image);
  }
});

test("Restart abandons a waiting message after a keep-playing update", (t) => {
  const { ctx, control, presentation } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  ctx.fns.onPlayHere({ type: "playHere", id: 30, room: 3, x: 0, y: 0, launch: {} });
  const edited = game();
  edited.putResource(
    "logic",
    3,
    assembleLogic('if(isset(f5)){print("Changed death");}return;', { dictionary: new Map() })
      .payload,
  );
  const result = ctx.run.engine!.commitPreviewUpdate(
    ctx.run.engine!.preparePreviewUpdate({ files: edited.files }),
    { messageWaiting: true },
  );
  assert.equal(result.status, "committed");
  assert.equal(ctx.run.engine!.recordingImage(), null);
  ctx.fns.onPlayHere({ type: "playHere", id: 31, room: 3, x: 0, y: 0, launch: {} });
  const reply = control.findLast((m) => m.type === "playedHere");
  assert.ok(reply?.type === "playedHere" && reply.ok, JSON.stringify(reply));
  const print = presentation.findLast((m) => m.type === "print");
  assert.ok(print?.type === "print" && print.text === "Changed death");
});

test("Update and launch retains carried items and starts appended items at their OBJECT location", (t) => {
  const { ctx } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  ctx.run.engine!.setItemLocation(0, 255);
  const files = new Map(ctx.run.engine!.containerFiles);
  files.set(
    "OBJECT",
    buildObjectFile([
      { name: "key", startingRoom: 0 },
      { name: "map", startingRoom: 8 },
    ]),
  );
  const entry = prepareRoomLaunch(ctx, { room: 2 }, files);
  assert.deepEqual(
    entry.engine.readState().inventory.map((item) => item.room),
    [255, 8],
  );
});

test("Debug Launch stops at the first instruction when LOGIC 0 has set.scan.start", (t) => {
  const { ctx, control } = workerHarness(
    gameContainer(["assignn(v99,1);set.scan.start();increment(v80);return;", "return;", "return;"]),
  );
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  ctx.fns.tickEngine();
  const before = ctx.run.engine!.vars[80];
  ctx.fns.onDebugAttach({ type: "debugAttach", id: 50 });
  ctx.fns.onPlayHere({ type: "playHere", id: 51, room: 2, x: 0, y: 0, launch: { debug: true } });
  const stop = control.findLast((m) => m.type === "debugStopped");
  assert.ok(stop?.type === "debugStopped");
  assert.equal(stop.location?.logic, 0);
  assert.equal(stop.location?.pc, 4);
  assert.equal(ctx.run.engine!.vars[80], before);
});

test("a Launch while playing keeps saving progress", (t) => {
  const { ctx, control } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  ctx.fns.onPlayHere({ type: "playHere", id: 40, room: 2, x: 0, y: 0, launch: { state: {} } });
  assert.ok(control.findLast((m) => m.type === "playedHere")?.ok);
  assert.equal(ctx.fns.autosave(true), true, "Play progress keeps saving after a Launch");
  ctx.fns.onFlush({ type: "flush", id: 41 });
  const flush = control.findLast((m) => m.type === "flushed");
  assert.ok(flush?.type === "flushed" && flush.taken);
});
