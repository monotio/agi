import assert from "node:assert/strict";
import { test } from "node:test";
import { gameContainer, workerHarness, replayHistorySegment } from "./worker-ctx.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { autosaveKey, writeAutosave } from "../src/saves/gameProgress.ts";
import { writeGameSave, readGameSaves } from "../src/saves/gameSaves.ts";
import { projectProgressTarget } from "../src/project/progressTarget.ts";
import { testProjectId, testRevision } from "./identity.ts";
import { bytesToBase64, base64ToBytes } from "../src/project/bytes.ts";
import { decodeSave } from "../../src/runtime/persistence.ts";
import type { HistorySegment } from "../../src/agent/history.ts";

for (const opening of ["cold", "checkpoint"] as const) {
  test(`Create ${opening} keeps death, save.game, restore and takeover out of physical progress`, async (t) => {
    const game = gameContainer(
      [
        'if(!isset(f200)){set(f200);set.game.id("DEMO");new.room(1);}call.v(v0);if(isset(f208)){reset(f208);save.game();}if(isset(f209)){reset(f209);restore.game();}return;',
        "if(isset(f5)){load.pic(v0);draw.pic(v0);show.pic();}return;",
      ],
      (c) => c.putResource("picture", 1, Uint8Array.of(0xff)),
    );
    const h = workerHarness(game);
    t.after(() => h.ctx.fns.stopTimers());
    const { ctx, control } = h;
    let now = 0;
    ctx.ports.now = () => now;
    const tick = () => {
      now += 100;
      ctx.fns.hostTick();
    };
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const target = projectProgressTarget(
      testProjectId("create-slots"),
      testRevision("create-slots"),
      "initial",
    )!;
    ctx.fns.tickEngine();
    const original = bytesToBase64(ctx.run.engine!.serialize());
    assert.ok(writeGameSave(storage, target, 1, original));
    if (opening === "checkpoint")
      writeAutosave(storage, target, {
        format: "monotio.agi.autosave",
        version: 1,
        image: bytesToBase64(ctx.run.engine!.autosaveImage()!),
        cycle: 1,
        room: 1,
        savedAt: 0,
        game: { installed: false, identity: target.identity },
      });
    const physical = [...values];
    const scheduled: (() => void)[] = [];
    ctx.ports.schedule = (fn, ms) => {
      if (ms === 0) scheduled.push(fn);
      return fn;
    };
    ctx.ports.cancelSchedule = (fn) => {
      const at = scheduled.indexOf(fn as () => void);
      if (at >= 0) scheduled.splice(at, 1);
    };
    ctx.ports.presentation = (msg) => {
      if (msg.type === "autosave")
        writeAutosave(storage, target, {
          format: "monotio.agi.autosave",
          version: 1,
          image: msg.image,
          cycle: msg.cycle,
          room: msg.room,
          savedAt: 1,
          game: { installed: false, identity: target.identity },
        });
    };
    onWorkerMessage(ctx, {
      type: "boot",
      files: Object.fromEntries(game.files),
      words: [],
      projectMode: "create",
      ...(opening === "checkpoint"
        ? {
            restoreImage: values.get(autosaveKey(target.locator))
              ? (JSON.parse(values.get(autosaveKey(target.locator))!).image as string)
              : "",
          }
        : {}),
    });
    await ctx.projectLoader.loading;
    ctx.fns.stopTimers();
    tick();
    onWorkerMessage(ctx, {
      type: "debugWrite",
      id: 40,
      flags: [
        [220, 1],
        [208, 1],
      ],
      vars: [[80, 99]],
    });
    tick();
    scheduled.shift()!(); // scratch directory listing
    onWorkerMessage(ctx, { type: "key", code: 13 });
    const description = control.findLast(
      (m) => m.type === "hostRequest" && m.op === "saveDescription",
    );
    assert.ok(description?.type === "hostRequest");
    onWorkerMessage(ctx, {
      type: "hostAnswer",
      id: description.id,
      response: '{"value":"Create death"}',
    });
    onWorkerMessage(ctx, { type: "key", code: 13 });
    scheduled.shift()!(); // scratch write
    assert.equal(
      decodeSave(base64ToBytes(ctx.run.scratchSlots["1"]!.image), ctx.run.engine!.profile).vars[80],
      99,
    );
    onWorkerMessage(ctx, { type: "debugWrite", id: 41, flags: [[209, 1]], vars: [[80, 7]] });
    tick();
    scheduled.shift()!(); // scratch restore listing
    onWorkerMessage(ctx, { type: "key", code: 13 });
    scheduled.shift()!(); // scratch read
    assert.equal(ctx.run.engine!.vars[80], 99);
    assert.equal(ctx.run.engine!.flags[220], 1);
    ctx.fns.onResetReplay({ type: "resetReplay", seed: 58235, rngVersion: 2 });
    ctx.fns.tickEngine();
    ctx.run.engine!.flags[220] = 1;
    ctx.fns.onExitReplay();
    ctx.fns.stopTimers();
    ctx.fns.onFlush({ type: "flush", id: 30 });
    assert.ok(
      values.size === physical.length &&
        physical.every(([key, bytes]) => values.get(key) === bytes),
      "Create changed physical progress or slot bytes",
    );
    assert.deepEqual(readGameSaves(storage, target), { "1": original });
    assert.equal(
      control.some(
        (m) => m.type === "hostRequest" && ["saveList", "saveWrite", "restore"].includes(m.op),
      ),
      false,
    );
    // The private slot answers are still recorded external inputs for history replay.
    const batches = [...ctx.history.sent, ...ctx.history.queue.map((entry) => entry.batch)];
    const first = batches.find((batch) => batch.boot);
    assert.ok(first?.boot);
    const segment: HistorySegment = {
      id: first.segment,
      boot: first.boot,
      events: batches
        .filter((batch) => batch.segment === first.segment)
        .flatMap((batch) => batch.events),
      anchors: [],
      marks: [],
      sync: [],
      clock: batches
        .filter((batch) => batch.segment === first.segment)
        .flatMap((batch) => batch.clock ?? []),
    };
    const replay = replayHistorySegment(segment);
    assert.equal(replay.error, null);
    assert.equal(replay.diverged, null);
    onWorkerMessage(ctx, { type: "projectPlay", id: 31 });
    assert.ok(control.findLast((m) => m.type === "projectPlayed")?.ok);
    assert.equal(ctx.run.engine!.flags[220], 0);
    assert.equal(ctx.run.engine!.vars[80], 0);
    assert.equal(Object.keys(ctx.run.scratchSlots).length, 0);
  });
}
