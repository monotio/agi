import { test } from "node:test";
import assert from "node:assert/strict";
import { gameContainer } from "./worker-ctx.ts";
import { createWorkerContext, type WorkerPorts } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { replayHistorySegment } from "../src/worker/replay.ts";
import {
  validateHistoryBoot,
  type HistoryBoot,
  type HistorySegment,
} from "../../src/agent/history.ts";
import type { WorkerControl, WorkerInbound, WorkerPresentation } from "../src/workerProtocol.ts";

test("worker boot with a profile override reports the chosen profile and detection kind", () => {
  const container = gameContainer(["assignn(v0, 1); accept.input(); return;"]);
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  const ports: WorkerPorts = {
    control: (msg) => control.push(msg),
    presentation: (msg) => presentation.push(msg),
    now: () => 0,
    seedWord: () => 0x1234,
    schedule: (fn, ms) => ({ fn, ms }),
    cancelSchedule: () => {},
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);

  onWorkerMessage(ctx, {
    type: "boot",
    profile: "2.411",
    files: Object.fromEntries(container.files),
    words: [],
  });
  ctx.fns.stopTimers();

  const booted = control.find((msg) => msg.type === "booted");
  assert.ok(booted, "booted message received");
  assert.equal(booted.profile, "2.411");
  assert.equal(booted.kind, "default");
});

test("worker boot without override reports detected profile and kind", () => {
  const container = gameContainer(["assignn(v0, 1); accept.input(); return;"]);
  const files = Object.fromEntries(container.files);
  files["AGIDATA.OVL"] = new TextEncoder().encode("Adventure Game Interpreter\nVersion 2.917\n");

  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  const ports: WorkerPorts = {
    control: (msg) => control.push(msg),
    presentation: (msg) => presentation.push(msg),
    now: () => 0,
    seedWord: () => 0x1234,
    schedule: (fn, ms) => ({ fn, ms }),
    cancelSchedule: () => {},
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);

  onWorkerMessage(ctx, {
    type: "boot",
    files,
    words: [],
  });
  ctx.fns.stopTimers();

  const booted = control.find((msg) => msg.type === "booted");
  assert.ok(booted, "booted message received");
  assert.equal(booted.profile, "2.917");
  assert.equal(booted.kind, "binary");
});

test("worker boot with an invalid profile surfaces as error message", () => {
  const container = gameContainer(["assignn(v0, 1); accept.input(); return;"]);
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  const ports: WorkerPorts = {
    control: (msg) => control.push(msg),
    presentation: (msg) => presentation.push(msg),
    now: () => 0,
    seedWord: () => 0x1234,
    schedule: (fn, ms) => ({ fn, ms }),
    cancelSchedule: () => {},
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);

  onWorkerMessage(ctx, {
    type: "boot",
    profile: "unknown-999" as never,
    files: Object.fromEntries(container.files),
    words: [],
  });

  const err = control.find((msg) => msg.type === "error");
  assert.ok(err, "error message received");
});

const PICTURE = new Uint8Array([0xf0, 0x01, 0xf6, 10, 10, 60, 10, 60, 40, 10, 40, 10, 10, 0xff]);

/**
 * A booted override session with the history recorder acked by a fake host:
 * the room draws a picture so its boundaries are resumable. The container
 * alone detects as 2.936, so every rebuilt engine that drops the override
 * shows up as that profile.
 */
function overrideSession() {
  const container = gameContainer(
    [`if (isset(f5)) { assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic(); } return;`],
    (c) => c.putResource("picture", 1, PICTURE),
  );
  const control: WorkerControl[] = [];
  let now = 0;
  const ctx = createWorkerContext({
    control: (msg) => control.push(msg),
    presentation: () => {},
    now: () => now,
  });
  ctx.host = createEngineHost(ctx);
  let acked = 0;
  const send = (msg: WorkerInbound): void => {
    onWorkerMessage(ctx, msg);
    while (acked < control.length) {
      const m = control[acked++]!;
      if (m.type === "historyBatch")
        onWorkerMessage(ctx, { type: "historyAck", epoch: m.epoch, batch: m.batch.batch });
    }
  };
  send({
    type: "boot",
    profile: "2.411",
    files: Object.fromEntries(container.files),
    words: [],
  });
  ctx.fns.stopTimers();
  const tick = (n: number): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  return { ctx, control, send, tick };
}

test("replay resets and seeks rebuild the engine under the boot override", () => {
  const { ctx, send, tick } = overrideSession();
  assert.equal(ctx.engine!.profile.id, "2.411");
  tick(4);
  send({ type: "resetReplay", seed: 7 });
  assert.equal(ctx.engine!.profile.id, "2.411", "a reset keeps the override");
  send({ type: "replayRestore", id: 1, tick: 0 });
  assert.equal(ctx.engine!.profile.id, "2.411", "a seek keeps the override");
});

test("the recorded boot carries the override and replays and adoptions use it", () => {
  const { ctx, control, send, tick } = overrideSession();
  tick(4);
  const opened = control.find(
    (m): m is Extract<WorkerControl, { type: "historyBatch" }> =>
      m.type === "historyBatch" && m.batch.boot !== undefined,
  );
  assert.ok(opened?.batch.boot);
  const boot: HistoryBoot = opened.batch.boot;
  assert.equal(boot.profile, "2.411", "the segment boot records the override");
  // The batch that opens the stored tape names the running profile itself:
  // it can reach the page before the booted message does.
  assert.equal(opened.profile, "2.411", "the opening batch names the running profile");
  assert.equal(validateHistoryBoot(JSON.parse(JSON.stringify(boot))).profile, "2.411");
  assert.throws(() => validateHistoryBoot({ ...boot, profile: "9.999" }), /profile/);

  const segment: HistorySegment = {
    id: opened.batch.segment,
    boot,
    anchors: [],
    events: [],
    marks: [],
    sync: [],
  };
  assert.equal(replayHistorySegment(segment).ctx.engine!.profile.id, "2.411");

  send({ type: "pause", paused: true });
  send({ type: "historyRetain", id: 2 });
  const retained = control.find(
    (m): m is Extract<WorkerControl, { type: "historyRetained" }> =>
      m.type === "historyRetained" && m.id === 2,
  );
  assert.ok(retained?.boot, "the parked session is resumable");
  assert.equal(retained.boot.profile, "2.411", "a mid-play snapshot records the override");
  send({ type: "historyViewRestore", id: 3, boot: retained.boot, from: retained.from });
  const restored = control.find(
    (m): m is Extract<WorkerControl, { type: "historyViewRestored" }> =>
      m.type === "historyViewRestored" && m.id === 3,
  );
  assert.ok(restored?.ok, JSON.stringify(restored));
  assert.equal(ctx.engine!.profile.id, "2.411", "the adopted engine runs the recorded override");
});
