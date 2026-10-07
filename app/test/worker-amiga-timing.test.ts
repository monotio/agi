import { openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { progressEntries } from "../src/saves/gameProgress.ts";
import { readProgressEntries } from "../src/saves/gameProgressImport.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { replayHistorySegment } from "./worker-ctx.ts";
import { createWorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { validateHistoryBoot, type HistorySegment } from "../../src/agent/history.ts";
import type { WorkerControl } from "../src/worker/workerProtocol.ts";

test("PAL session records timing, replays, resets and resumes with PAL", () => {
  const container = openContainer(new Map([["DIR", Uint8Array.of(8, 0, 8, 0, 8, 0, 8, 0)]]), {
    profile: "amiga-2.310",
  });
  container.putResource(
    "logic",
    0,
    assembleLogic(
      "if (isset(f5)) { assignn(v50,1); load.pic(v50); draw.pic(v50); show.pic(); } return;",
      { dictionary: new Map() },
    ).payload,
  );
  container.putResource("picture", 1, Uint8Array.of(0xff));
  const control: WorkerControl[] = [];
  let now = 0;
  const ctx = createWorkerContext({
    control: (m) => control.push(m),
    presentation() {},
    now: () => now,
  });
  ctx.host = createEngineHost(ctx);
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(container.files),
    words: [],
    profile: "amiga-2.310",
    amigaRegion: "pal",
  });
  ctx.fns.stopTimers();
  assert.equal(ctx.run.clocks.sound.advance(19), 0);
  assert.equal(ctx.run.clocks.sound.advance(20), 1);
  assert.equal(ctx.run.clocks.sound.advance(1000), 49);
  ctx.run.clocks.sound.reset(0);
  const opened = control.find((m) => m.type === "historyBatch" && m.batch.boot);
  assert.ok(opened?.type === "historyBatch" && opened.batch.boot);
  const boot = validateHistoryBoot(JSON.parse(JSON.stringify(opened.batch.boot)));
  assert.equal(boot.amigaRegion, "pal");
  assert.throws(() => validateHistoryBoot({ ...boot, amigaRegion: "unknown" }), /region/i);
  const segment: HistorySegment = {
    id: opened.batch.segment,
    boot,
    anchors: [],
    events: [],
    marks: [],
    sync: [],
  };
  const drive = replayHistorySegment(segment);
  assert.equal(drive.ctx.run.engine!.timing.soundHz, 50);
  for (let i = 1; i <= 60; i++) {
    now = i * 20;
    ctx.fns.hostTick();
  }
  assert.equal(ctx.run.engine!.vars[11], 1);
  const entries = progressEntries({
    saves: { "1": ctx.run.engine!.serialize() },
    autosave: null,
    amigaRegions: { "1": "pal" },
  });
  const archive = new Map(
    entries.map((e) => [
      e.name,
      typeof e.data === "string" ? new TextEncoder().encode(e.data) : e.data,
    ]),
  );
  const progress = readProgressEntries(
    archive,
    "",
    Object.fromEntries(container.files),
    "amiga-2.310",
  );
  assert.deepEqual(progress?.amigaRegions, { "1": "pal" });
  const image = ctx.run.engine!.autosaveImage();
  assert.ok(image);
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(container.files),
    words: [],
    profile: "amiga-2.310",
    amigaRegion: "ntsc",
    restoreImage: Buffer.from(image).toString("base64"),
  });
  ctx.fns.stopTimers();
  assert.equal(ctx.run.engine!.timing.soundHz, 50, "saved timing wins over the preference");
  const retained = ctx.fns.historySnapshot();
  assert.ok(retained);
  onWorkerMessage(ctx, { type: "historyViewRestore", id: 3, boot: retained, from: null });
  assert.equal(ctx.run.engine!.timing.soundHz, 50);
  onWorkerMessage(ctx, { type: "resetReplay", seed: 7 });
  assert.equal(ctx.run.engine!.timing.soundHz, 50);
});

test("a numbered PAL save restores the region and both session clocks", () => {
  const container = openContainer(new Map([["DIR", Uint8Array.of(8, 0, 8, 0, 8, 0, 8, 0)]]), {
    profile: "amiga-2.310",
  });
  container.putResource(
    "logic",
    0,
    assembleLogic(
      "if (isset(f5)) { assignn(v50,1); load.pic(v50); draw.pic(v50); show.pic(); } if (isset(f208)) { reset(f208); restore.game(); } return;",
      { dictionary: new Map() },
    ).payload,
  );
  container.putResource("picture", 1, Uint8Array.of(0xff));
  const control: WorkerControl[] = [];
  const ctx = createWorkerContext({
    control: (m) => control.push(m),
    presentation() {},
    now: () => 0,
  });
  ctx.host = createEngineHost(ctx);
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(container.files),
    words: [],
    profile: "amiga-2.310",
  });
  ctx.fns.stopTimers();
  ctx.fns.tickEngine();
  const image = ctx.run.engine!.serialize();
  ctx.run.engine!.flags[208] = 1;
  ctx.fns.tickEngine();
  const list = control.findLast((m) => m.type === "hostRequest" && m.op === "saveList");
  assert.ok(list?.type === "hostRequest");
  onWorkerMessage(ctx, {
    type: "hostAnswer",
    generation: ctx.run.generation,
    id: list.id,
    response: JSON.stringify([
      { slot: 1, image: Buffer.from(image.subarray(0, 40)).toString("base64") },
    ]),
  });
  onWorkerMessage(ctx, { type: "key", code: 13 });
  ctx.fns.tickEngine();
  const restore = control.findLast((m) => m.type === "hostRequest" && m.op === "restore");
  assert.ok(restore?.type === "hostRequest");
  onWorkerMessage(ctx, {
    type: "hostAnswer",
    generation: ctx.run.generation,
    id: restore.id,
    response: JSON.stringify({ image: Buffer.from(image).toString("base64"), amigaRegion: "pal" }),
  });
  assert.equal(ctx.run.engine!.timing.soundHz, 50);
  assert.equal(ctx.run.clocks.sound.hz, 50);
  assert.equal(ctx.run.clocks.cycle.incrementMs, 60);
});
