import assert from "node:assert/strict";
import { test } from "node:test";
import { gameContainer, workerHarness } from "./worker-ctx.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { enterProjectCreate } from "../src/worker/projectAdmission.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { openContainer } from "../../src/container/container.ts";
import { buildView } from "../../src/view/view.ts";
import { buildSound } from "../../src/sound/build.ts";
import { buildObjectFile } from "../../src/authoring/inventory.ts";
import { installProjectRestart } from "../src/worker/projectRestart.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { openHistoryDrive } from "../src/worker/historyDrive.ts";
import { createWorkerContext } from "../src/worker/context.ts";

test("exact return refusals name the changed resource and keep the temporary run", (t) => {
  const cached = gameContainer(
    [
      "if(equaln(v0,0)){new.room(1);}call.v(v0);return;",
      'if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();load.view(0);load.sound(0);sound(0,f60);set.scan.start();}print("Moment");return;',
      "return;",
    ],
    (c) => {
      c.putResource("picture", 1, Uint8Array.of(0xff));
      c.putResource(
        "view",
        0,
        buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
      );
      c.putResource(
        "sound",
        0,
        buildSound([{ notes: [{ duration: 1000, freqDivisor: 226, attenuation: 0 }] }]),
      );
      c.putFile("OBJECT", buildObjectFile([{ name: "key", startingRoom: 1 }]));
    },
  );
  for (const cause of ["view", "sound", "profile", "room", "object", "scan"] as const) {
    const { ctx, control } = workerHarness(openContainer(cached.files));
    t.after(() => ctx.fns.stopTimers());
    ctx.fns.tickEngine();
    enter(ctx);
    const changed = openContainer(cached.files);
    if (cause === "view" || cause === "sound")
      changed.putResources([{ kind: cause, num: 0, payload: null }]);
    if (cause === "room") changed.putResources([{ kind: "logic", num: 1, payload: null }]);
    if (cause === "object") changed.putFile("OBJECT", buildObjectFile([]));
    if (cause === "scan")
      changed.putResource("logic", 1, assembleLogic("return;", { dictionary: new Map() }).payload);
    installProjectRestart(
      ctx,
      new Engine(
        changed,
        ctx.host,
        new Map(),
        cause === "profile" ? { profile: PROFILES["2.917"] } : {},
      ),
    );
    const prior = ctx.run;
    onWorkerMessage(ctx, { type: "projectPlay", id: 20 });
    const reply = control.findLast((m) => m.type === "projectPlayed");
    assert.ok(reply?.type === "projectPlayed" && !reply.ok, cause);
    const names = {
      view: "VIEW 0 was removed",
      sound: "SOUND 0 was removed",
      profile: "interpreter profile changed",
      room: "Room 1 needs a LOGIC",
      object: "OBJECT has fewer items",
      scan: "LOGIC 1 changed after scan.start",
    };
    assert.ok(reply.reason?.includes(names[cause]), `${cause}: ${reply.reason}`);
    assert.match(reply.reason!, /Choose Restart/);
    assert.equal(ctx.run, prior, cause);
  }
});

function game() {
  return gameContainer(
    [
      "if(equaln(v0,0)){new.room(1);}call.v(v0);return;",
      'if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();print("Play moment");}increment(v80);return;',
      'set(f220);print("Death");return;',
    ],
    (c) => c.putResource("picture", 1, Uint8Array.of(0xff)),
  );
}

function enter(ctx: ReturnType<typeof workerHarness>["ctx"]) {
  ctx.boot.createAllowed = true;
  enterProjectCreate(ctx, { type: "projectCreate", id: 1, documents: writeProjectWorkspace({}) });
}

test("Create captures an undrawn game and returns to its exact running state", (t) => {
  const { ctx, control } = workerHarness(gameContainer(["assignn(v80,42);accept.input();return;"]));
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  const before = ctx.run.engine!.readState();
  enter(ctx);
  const grant = control.findLast((m) => m.type === "projectCreated");
  assert.ok(
    grant?.type === "projectCreated" && grant.grant,
    grant?.reason ?? "Create grant missing",
  );
  ctx.run.engine!.vars[80] = 99;
  onWorkerMessage(ctx, { type: "projectPlay", id: 2 });
  assert.ok(control.findLast((m) => m.type === "projectPlayed")?.ok);
  assert.equal(ctx.run.engine!.vars[80], 42);
  assert.deepEqual(ctx.run.engine!.readState(), before);
  assert.equal(ctx.run.engine!.autosaveImage(), null);
});

test("Create boot excludes the first later death checkpoint and pagehide flush", async (t) => {
  const { ctx, presentation, control } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(game().files),
    words: [],
    projectMode: "create",
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  ctx.run.engine!.flags[220] = 1;
  ctx.fns.tickEngine();
  assert.equal(ctx.fns.autosave(true), false);
  ctx.fns.onFlush({ type: "flush", id: 2 });
  assert.ok(control.findLast((m) => m.type === "flushed")?.temporary);
  assert.equal(presentation.filter((m) => m.type === "autosave").length, 0);
});

test("leaving Create restores the Play print continuation and RNG", (t) => {
  const { ctx, control } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  ctx.run.rng.word = 0;
  const image = ctx.run.engine!.recordingImage();
  const replay = ctx.run.engine!.captureReplayState();
  enter(ctx);
  ctx.fns.onPlayHere({
    type: "playHere",
    id: 2,
    room: 2,
    x: 0,
    y: 0,
    launch: { state: { seed: 58235 } },
  });
  assert.ok(control.findLast((m) => m.type === "playedHere")?.ok);
  onWorkerMessage(ctx, { type: "projectPlay" });
  assert.deepEqual(ctx.run.engine!.recordingImage(), image);
  assert.deepEqual(ctx.run.engine!.captureReplayState(), replay);
  assert.equal(ctx.run.rng.word, 0);
  assert.equal(ctx.run.engine!.modalKind, "print");
});

test("a paused Play moment stays paused after Create runs and returns", (t) => {
  const { ctx } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  onWorkerMessage(ctx, { type: "pause", paused: true });
  const image = ctx.run.engine!.recordingImage();
  enter(ctx);
  ctx.fns.onPlayHere({ type: "playHere", id: 2, room: 2, x: 0, y: 0, launch: {} });
  onWorkerMessage(ctx, { type: "pause", paused: false });
  onWorkerMessage(ctx, { type: "projectPlay" });
  assert.equal(ctx.run.cycle.paused, true);
  ctx.fns.stepHostTick(ctx.ports.now() + 2_000);
  assert.deepEqual(ctx.run.engine!.recordingImage(), image);
});

test("Back repeatedly restores the Create entry point, including after another Launch", (t) => {
  const { ctx, control } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  const image = ctx.run.engine!.recordingImage();
  enter(ctx);
  for (let id = 3; id < 5; id++) {
    ctx.fns.onPlayHere({ type: "playHere", id, room: 2, x: 0, y: 0, launch: {} });
    ctx.fns.onPlayHere({ type: "playHere", id: id + 10, room: 1, x: 0, y: 0, visit: "back" });
    assert.ok(control.findLast((m) => m.type === "playedHere")?.ok);
    assert.deepEqual(ctx.run.engine!.recordingImage(), image);
  }
});

test("Back and From my game adopt the captured Play pause state", (t) => {
  const { ctx } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  onWorkerMessage(ctx, { type: "pause", paused: true });
  enter(ctx);
  for (const request of [{ visit: "back" as const }, { launch: { fromMyGame: true } }]) {
    onWorkerMessage(ctx, { type: "pause", paused: false });
    ctx.fns.onPlayHere({ type: "playHere", id: 2, room: 1, x: 0, y: 0, ...request });
    assert.equal(ctx.run.cycle.paused, true);
  }
});

test("Create return peels a changed LOGIC window and continues on current bytes", (t) => {
  const { ctx } = workerHarness(game());
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  enter(ctx);
  const changed = game();
  changed.putResource(
    "logic",
    1,
    assembleLogic("assignn(v81,9);return;", { dictionary: new Map() }).payload,
  );
  ctx.run.engine!.commitPreviewUpdate(
    ctx.run.engine!.preparePreviewUpdate({ files: changed.files }),
    { messageWaiting: true },
  );
  ctx.fns.onPlayHere({ type: "playHere", id: 2, room: 2, x: 0, y: 0, launch: {} });
  onWorkerMessage(ctx, { type: "projectPlay" });
  assert.equal(ctx.run.engine!.vars[0], 1);
  assert.equal(ctx.run.engine!.modalKind, null);
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.vars[81], 9);
});

test("Create entry refuses a pending host question before granting edits", (t) => {
  const { ctx, control } = workerHarness(gameContainer(['get.num("Number?",v80);return;']));
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  enter(ctx);
  const reply = control.findLast((m) => m.type === "projectCreated");
  assert.ok(reply?.type === "projectCreated" && !reply.grant);
  assert.match(reply.reason!, /Finish the game's question/);
});

for (const history of [false, true]) {
  test(`leaving Create refuses an active ${history ? "history" : "walkthrough"} replay before autosaving`, (t) => {
    const { ctx, control, presentation } = workerHarness(game());
    t.after(() => ctx.fns.stopTimers());
    ctx.fns.tickEngine();
    enter(ctx);
    ctx.boot.currentBootFiles = new Map(game().files);
    ctx.boot.currentDictionary = new Map();
    ctx.fns.onResetReplay({ type: "resetReplay", seed: 0, rngVersion: 2 });
    ctx.replay.historyReplay = history;
    ctx.fns.tickEngine();
    ctx.run.engine!.vars[80] = 199;
    const prior = ctx.run;
    presentation.length = 0;
    for (const restart of [false, true]) {
      onWorkerMessage(ctx, { type: "projectPlay", id: 90, restart });
      const reply = control.findLast((m) => m.type === "projectPlayed");
      assert.ok(reply?.type === "projectPlayed" && !reply.ok);
      assert.match(reply.reason!, /Leave the replay or history view first/);
      assert.equal(ctx.run, prior);
      ctx.fns.onFlush({ type: "flush", id: 91 });
      assert.equal(presentation.filter((m) => m.type === "autosave").length, 0);
    }
  });
}

test("leaving Create refuses the separate history-view drive before autosaving", (t) => {
  const { ctx, control, presentation } = workerHarness(game());
  t.after(() => {
    ctx.fns.onHistoryViewEnd();
    ctx.fns.stopTimers();
  });
  ctx.fns.tickEngine();
  enter(ctx);
  const boot = ctx.fns.historySnapshot(true)!;
  ctx.view.drive = openHistoryDrive(
    { id: "view", boot, events: [], anchors: [], marks: [], sync: [] },
    createWorkerContext,
  );
  assert.equal(ctx.view.drive.error, null);
  assert.ok(ctx.view.drive.ctx.run.engine instanceof Engine);
  ctx.view.drive.ctx.run.engine.vars[80] = 199;
  assert.equal(ctx.replay.replay, null);
  const prior = ctx.run;
  presentation.length = 0;
  onWorkerMessage(ctx, { type: "projectPlay", id: 90 });
  const reply = control.findLast((m) => m.type === "projectPlayed");
  assert.ok(reply?.type === "projectPlayed" && !reply.ok);
  assert.match(reply.reason!, /Leave the replay or history view first/);
  assert.equal(ctx.run, prior);
  ctx.fns.onFlush({ type: "flush", id: 91 });
  assert.equal(presentation.filter((m) => m.type === "autosave").length, 0);
});
