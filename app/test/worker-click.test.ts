/**
 * Pointer clicks: admitted only on click-to-walk profiles and only while the
 * interpreter could consume them — an open modal, a parked key wait or a
 * suspended host answer owns the screen — recorded as history causes, then
 * drained by the engine's input phase (test/click-move.test.ts owns the
 * movement semantics).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OperationRecorder } from "../../src/agent/recordedReplay.ts";
import type { ProfileId } from "../../src/runtime/profile.ts";
import type { HistoryBatch, HistoryBoot, HistorySegment } from "../../src/agent/history.ts";
import { gameContainer } from "./worker-ctx.ts";
import { createWorkerContext, type WorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { replayHistorySegment } from "../src/worker/replay.ts";
import type { WorkerControl, WorkerInbound } from "../src/workerProtocol.ts";

/** 1 loop, 1 cel: a solid width x height block of color 5. */
function solidView(width: number, height: number): Uint8Array {
  const rows = Array.from({ length: height }, () => [0x50 | width, 0]).flat();
  return new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, width, height, 0, ...rows]);
}

/** The click-move test's ego setup: a 4-wide block at (20, 100), step 1. */
const EGO_SETUP = `
  if (!isset(f200)) {
    set(f200);
    load.pic(v250); draw.pic(v250); show.pic();
    animate.obj(o0); load.view(0); set.view(o0, 0); position(o0, 20, 100);
    assignn(v251, 1); step.size(o0, v251); step.time(o0, v251); draw(o0);
  }
  return;
`;

function clickSession(profile: ProfileId, logic = EGO_SETUP) {
  const container = gameContainer([logic], (c) => {
    c.putResource("picture", 0, Uint8Array.of(0xff));
    c.putResource("view", 0, solidView(4, 10));
  });
  const control: WorkerControl[] = [];
  let now = 0;
  const ctx: WorkerContext = createWorkerContext({
    control: (message) => control.push(message),
    presentation: () => {},
    now: () => now,
  });
  ctx.host = createEngineHost(ctx);
  const send = (msg: WorkerInbound): void => onWorkerMessage(ctx, msg);
  send({ type: "boot", profile, files: Object.fromEntries(container.files), words: [] });
  ctx.fns.stopTimers();
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  const clickCauses = () =>
    ctx.history.open.events.filter((e) => e.cause.kind === "click").map((e) => e.cause);
  return { ctx, control, send, tick, clickCauses };
}

test("a click message records the cause and the engine walks ego to it", () => {
  const { ctx, send, tick, clickCauses } = clickSession("amiga-2.316");
  tick(2);
  const ego = ctx.engine!.screenObjects[0]!;
  assert.equal(ego.x, 20);

  ctx.recording.recording = {
    tape: new OperationRecorder(),
    events: [],
    printed: [],
    tainted: null,
  };
  send({ type: "click", x: 161, y: 108 });
  assert.deepEqual(clickCauses(), [{ kind: "click", x: 161, y: 108 }]);
  assert.deepEqual(ctx.input.clickQueue, [[161, 108]], "queued for the next input phase");

  tick(1);
  assert.equal(ego.motionMode, 4, "the click starts click-move");
  assert.deepEqual(ctx.input.clickQueue, [], "the input phase drained it");
  // The batch records only when non-empty; the click-free ticks carry none.
  const clickCalls = ctx.recording.recording!.tape.operations.flatMap((op) =>
    op[0] === "tick" || op[0] === "release" ? op[1].filter((c) => c[0] === "clicks") : [],
  );
  assert.deepEqual(clickCalls, [["clicks", [[161, 108]]]]);
  // Clicks are stream-only history — never a stored game-test UI event.
  assert.equal(ctx.recording.recording!.events.length, 0);

  tick(80);
  assert.equal(ego.x, 78);
  assert.equal(ego.y, 100);
  assert.equal(ego.motionMode, 0, "arrival ends click-move");
});

test("a click under an open modal is dropped, not queued or recorded", () => {
  const { ctx, send, tick, clickCauses } = clickSession(
    "amiga-2.316",
    `if (!isset(f201)) { set(f201); print("Hello"); } return;`,
  );
  tick(1);
  assert.notEqual(ctx.engine!.modalKind, null, "the print window is open");
  send({ type: "click", x: 161, y: 108 });
  assert.deepEqual(ctx.input.clickQueue, []);
  assert.deepEqual(clickCauses(), []);
});

test("a click on a PC profile is dropped, not queued or recorded", () => {
  const { ctx, send, tick, clickCauses } = clickSession("2.936");
  tick(2);
  send({ type: "click", x: 161, y: 108 });
  assert.deepEqual(ctx.input.clickQueue, []);
  assert.deepEqual(clickCauses(), []);
  tick(3);
  assert.equal(ctx.engine!.screenObjects[0]!.x, 20, "ego never moved");
});

test("a queued click rides the retained boot and lands on the restored session", () => {
  const { ctx, control, send, tick } = clickSession("amiga-2.316");
  tick(2);
  send({ type: "click", x: 161, y: 108 });
  send({ type: "pause", paused: true });
  send({ type: "historyRetain", id: 1 });
  const retained = control.find(
    (m): m is Extract<WorkerControl, { type: "historyRetained" }> =>
      m.type === "historyRetained" && m.id === 1,
  );
  assert.ok(retained?.boot, "the parked session is resumable");
  assert.deepEqual(
    retained.boot.clickQueue,
    [[161, 108]],
    "the snapshot carries the undrained click",
  );

  send({ type: "historyViewRestore", id: 2, boot: retained.boot, from: retained.from });
  const restored = control.find(
    (m): m is Extract<WorkerControl, { type: "historyViewRestored" }> =>
      m.type === "historyViewRestored" && m.id === 2,
  );
  assert.ok(restored?.ok, JSON.stringify(restored));
  assert.deepEqual(ctx.input.clickQueue, [[161, 108]], "the adopted session keeps it");

  send({ type: "pause", paused: false });
  tick(1);
  assert.equal(ctx.engine!.screenObjects[0]!.motionMode, 4, "the restored click walks ego");
});

test("a recorded click replays through the history drive", () => {
  const { ctx, control, send, tick } = clickSession("amiga-2.316");
  tick(2);
  send({ type: "click", x: 161, y: 108 });
  tick(80);
  assert.equal(ctx.engine!.screenObjects[0]!.x, 78, "the live walk completed");
  send({ type: "pause", paused: true });

  let boot: HistoryBoot | undefined;
  const segment: HistorySegment = {
    id: "s",
    boot: undefined as unknown as HistoryBoot,
    anchors: [],
    events: [],
    marks: [],
    sync: [],
  };
  for (const message of control) {
    if (message.type !== "historyBatch") continue;
    const batch: HistoryBatch = message.batch;
    if (batch.boot !== undefined) boot = batch.boot;
    segment.events.push(...batch.events);
    segment.marks.push(...batch.marks);
    segment.sync.push(...batch.sync);
    if (batch.clock !== undefined) (segment.clock ??= []).push(...batch.clock);
    if (batch.anchor !== undefined) segment.anchors.push(batch.anchor);
    if (batch.end !== undefined) segment.end = batch.end;
  }
  assert.ok(boot);
  segment.boot = boot;

  const outcome = replayHistorySegment(segment);
  assert.equal(outcome.error, null);
  assert.equal(outcome.diverged, null, "every sync mark held");
  assert.equal(outcome.ctx.engine!.screenObjects[0]!.x, 78, "the replayed click walked ego");
});
