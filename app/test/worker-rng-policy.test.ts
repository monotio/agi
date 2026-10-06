import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { randomSource } from "../../src/agent/gameTestSteps.ts";
import { parseGameTests, serializeGameTests } from "../../src/agent/gameTestFormat.ts";
import { workerHarness, gameContainer } from "./worker-ctx.ts";
import { adoptResumePoint, enterCreateRun } from "../src/worker/resumePoint.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";

test("zero and 58235 keep word and entropy cursor across exact returns, history, native restart and restore", () => {
  for (const seed of [0, 58235]) {
    const container = gameContainer(
      [
        "if(equaln(v0,0)){new.room(1);}call.v(v0);return;",
        "if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();}return;",
        "set(f16);restart.game();return;",
      ],
      (c) => c.putResource("picture", 1, Uint8Array.of(0xff)),
    );
    const { ctx } = workerHarness(container);
    ctx.fns.tickEngine();
    ctx.run.rng = { word: seed, policy: { kind: "sequence", next: seed, cursor: 3 } };
    const original = structuredClone(ctx.run.rng);
    enterCreateRun(ctx);
    const progress = ctx.run.progress;
    assert.equal(progress.mode, "create");
    if (progress.mode !== "create") throw new Error("Create has no return point.");
    for (const request of [{ visit: "back" as const }, { launch: { fromMyGame: true } }]) {
      ctx.host.randomByte!();
      ctx.fns.onPlayHere({ type: "playHere", id: 1, room: 1, x: 0, y: 0, ...request });
      assert.deepEqual(ctx.run.rng, original);
    }
    ctx.host.randomByte!();
    adoptResumePoint(ctx, progress.returnPoint, { currentFiles: false, paused: true });
    assert.deepEqual(ctx.run.rng, original);
    ctx.host.randomByte!();
    onWorkerMessage(ctx, { type: "projectPlay", id: 2 });
    assert.deepEqual(ctx.run.rng, original);
    const image = ctx.run.engine!.autosaveImage()!;
    ctx.host.randomByte!();
    const advanced = structuredClone(ctx.run.rng);
    try {
      ctx.run.engine!.execute(2);
    } catch {
      /* Native restart aborts its pass. */
    }
    assert.equal(ctx.run.engine!.flags[6], 1);
    assert.deepEqual(ctx.run.rng, advanced);
    ctx.run.engine!.restoreImage(image);
    assert.equal(ctx.run.engine!.flags[6], 0);
    assert.deepEqual(ctx.run.rng, advanced);
    ctx.fns.onPlayHere({
      type: "playHere",
      id: 3,
      room: 1,
      x: 0,
      y: 0,
      launch: { beginning: true },
    });
    assert.deepEqual(ctx.run.rng, { word: 1, policy: { kind: "external" } });
    assert.equal(ctx.host.randomByte!(), 50);
    const resumed = workerHarness(container).ctx;
    onWorkerMessage(resumed, {
      type: "boot",
      files: Object.fromEntries(container.files),
      words: [],
      restoreImage: Buffer.from(image).toString("base64"),
      restoreRng: original,
    });
    resumed.fns.stopTimers();
    assert.deepEqual(resumed.run.rng, original);
    const expected: Record<string, number[]> = { "0": [1, 50, 92, 122], "58235": [0, 0, 1, 50] };
    assert.deepEqual(
      Array.from({ length: 4 }, () => resumed.host.randomByte!()),
      expected[String(seed)],
    );
    assert.equal(resumed.run.rng.policy.kind, "sequence");
  }
});

test("deterministic game-test entropy advances while released v1 retains its sequence", () => {
  const draw = randomSource(58235);
  assert.deepEqual(Array.from({ length: 4 }, draw), [0, 0, 1, 50]);
  const legacy = randomSource(58235, 1);
  assert.deepEqual(Array.from({ length: 4 }, legacy), [0, 0, 0, 0]);
  const old = parseGameTests(
    new TextEncoder().encode(
      JSON.stringify({
        format: "monotio.agi.tests.v1",
        tests: [{ name: "old", room: 1, steps: [] }],
      }),
    ),
  );
  const migrated = parseGameTests(serializeGameTests(old.tests));
  assert.equal(migrated.format, "monotio.agi.tests.v2");
  assert.equal(migrated.tests[0]!.rngVersion, 1);
  assert.throws(() =>
    parseGameTests(new TextEncoder().encode('{"format":"monotio.agi.tests.v3","tests":[]}')),
  );
});

test("Launch and v2 walkthrough wander progress at seed 58235 under a subprocess watchdog", () => {
  for (const entry of ["launch", "replay"] as const) {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `
      import { workerHarness, gameContainer } from './app/test/worker-ctx.ts';
      import { buildView } from './src/view/view.ts';
      const game = gameContainer(['if(equaln(v0,0)){new.room(1);}call.v(v0);return;', 'if(isset(f5)){load.view(0);animate.obj(o0);set.view(o0,0);position(o0,80,120);draw(o0);wander(o0);}return;'], c => c.putResource('view',0,buildView({loops:[{cels:[{width:1,height:1,pixels:[1]}]}]})));
      const {ctx}=workerHarness(game);
      ctx.boot.currentBootFiles=game.files; ctx.boot.currentDictionary=new Map();
      if ('${entry}' === 'launch') ctx.fns.onPlayHere({type:'playHere',id:1,room:1,x:0,y:0,launch:{state:{seed:58235}}});
      else {ctx.fns.onResetReplay({type:'resetReplay',seed:58235,rngVersion:2});ctx.replay.replay.tick=58235;ctx.fns.tickEngine();}
      const ego=ctx.run.engine.screenObjects[0];
      ego.stationary=true; ego.paramBank[0]=6;
      ctx.run.rng.word=58235;
      ctx.fns.tickEngine(); ctx.fns.stopTimers();
    `,
      ],
      { cwd: new URL("../..", import.meta.url), timeout: 3000, encoding: "utf8" },
    );
    assert.equal(result.error, undefined, `${entry}: ${result.error?.message}`);
    assert.equal(result.status, 0, result.stderr);
  }
});

for (const mode of ["play", "create"] as const) {
  test(`a seeded ${mode} Launch owns reseeds ${mode === "play" ? "until the next room change" : "across room changes"}`, (t) => {
    const container = gameContainer(
      [
        "if(equaln(v0,0)){new.room(1);}call.v(v0);return;",
        "if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();}if(isset(f220)){new.room(2);}return;",
        "random(0,255,v80);return;",
      ],
      (c) => c.putResource("picture", 1, Uint8Array.of(0xff)),
    );
    const { ctx } = workerHarness(container);
    t.after(() => ctx.fns.stopTimers());
    ctx.fns.armJournal();
    ctx.fns.tickEngine();
    if (mode === "create") enterCreateRun(ctx);
    let entropyReads = 0;
    ctx.ports.seedWord = () => {
      entropyReads++;
      return 42;
    };
    ctx.fns.onPlayHere({
      type: "playHere",
      id: 1,
      room: 1,
      x: 0,
      y: 0,
      launch: { state: { seed: 0 } },
    });
    assert.equal(ctx.run.rng.policy.kind, "sequence");
    ctx.run.engine!.flags[220] = 1;
    ctx.run.rng.word = 0;
    ctx.fns.tickEngine();
    assert.equal(ctx.run.engine!.vars[0], 2);
    assert.equal(ctx.run.engine!.vars[80], mode === "play" ? 199 : 1);
    assert.equal(entropyReads, mode === "play" ? 1 : 0);
    assert.equal(ctx.run.rng.policy.kind, mode === "play" ? "external" : "sequence");
  });
}

test("a Play Launch's room-scoped entropy returns to external after historical adoption", (t) => {
  const container = gameContainer(
    [
      "if(equaln(v0,0)){new.room(1);}call.v(v0);return;",
      "if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();}if(isset(f220)){new.room(2);}return;",
      "return;",
    ],
    (c) => c.putResource("picture", 1, Uint8Array.of(0xff)),
  );
  const { ctx } = workerHarness(container);
  t.after(() => ctx.fns.stopTimers());
  ctx.fns.tickEngine();
  ctx.fns.onPlayHere({
    type: "playHere",
    id: 1,
    room: 1,
    x: 0,
    y: 0,
    launch: { state: { seed: 0 } },
  });
  const boot = ctx.fns.historySnapshot(true)!;
  const { ctx: scratch } = workerHarness(container);
  t.after(() => scratch.fns.stopTimers());
  scratch.replay.replay = { tick: 0, revision: 0 };
  scratch.replay.historyReplay = true;
  adoptResumePoint(scratch, boot, { currentFiles: false, paused: false });
  scratch.run.engine!.flags[220] = 1;
  scratch.fns.tickEngine();
  assert.equal(scratch.run.engine!.vars[0], 2);
  assert.equal(scratch.run.rng.policy.kind, "external");
});
