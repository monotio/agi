import assert from "node:assert/strict";
import { test } from "node:test";
import { historySyncDigest } from "../../src/agent/history.ts";
import { createWorkerContext, type WorkerPorts } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type {
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
} from "../src/worker/workerProtocol.ts";
import { loadAppearance } from "../src/render/appearance.ts";
import { collectSegments, gameContainer, replayHistorySegment } from "./worker-ctx.ts";

// An Amiga boot waits for its look; load it once so the boot is synchronous.
await loadAppearance("amiga-2.202");

// docs/fidelity.md "Original picture dissolve": on SQ2's Amiga build, show.pic
// after draw.pic holds the pass for 801 ms while the picture comes in two pixels
// at a time; the worker presents the partial frames and every engine it creates
// from the recording reaches the same state.

/** Picture 1 flood-filled with colour 1, picture 2 with colour 2. */
const filled = (colour: number) => Uint8Array.of(0xf0, colour, 0xf8, 0, 0, 0xff);

function game() {
  return gameContainer(
    [
      `if (isset(f200)) { reset(f200); new.room(1); }
       if (isset(f201)) { reset(f201); new.room(2); }
       if (v0 > 0) { call.v(v0); }
       increment(v100);
       return;`,
      `if (isset(f5)) { assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic(); } return;`,
      `if (isset(f5)) { assignn(v50, 2); load.pic(v50); draw.pic(v50); show.pic(); } return;`,
    ],
    (c) => {
      c.putResource("picture", 1, filled(1));
      c.putResource("picture", 2, filled(2));
    },
  );
}

function harness() {
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  let now = 0;
  const ports: WorkerPorts = {
    control: (message) => control.push(message),
    presentation: (message) => presentation.push(message),
    now: () => now,
    seedWord: () => 0x1234,
    schedule: (fn) => fn,
    cancelSchedule() {},
  };
  const ctx = createWorkerContext(ports);
  ctx.host = createEngineHost(ctx);
  // The host commits each history batch and acknowledges it.
  let acked = 0;
  const ack = (): void => {
    for (; acked < control.length; acked++) {
      const message = control[acked]!;
      if (message.type === "historyBatch")
        onWorkerMessage(ctx, {
          type: "historyAck",
          epoch: message.epoch,
          batch: message.batch.batch,
        });
    }
  };
  const send = (msg: WorkerInbound): void => {
    onWorkerMessage(ctx, msg);
    ack();
  };
  const files = Object.fromEntries(game().files);
  send({ type: "boot", files, words: [], profile: "amiga-2.202" });
  ctx.fns.stopTimers();
  /** n host polls, 60 a second. */
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
    ack();
  };
  return { ctx, control, presentation, send, tick };
}

/** Colour-2 pixels in the last presented frame. */
function newPixels(presentation: WorkerPresentation[]): number {
  const frame = presentation.findLast((m) => m.type === "frame");
  assert.ok(frame?.type === "frame");
  return frame.visual.reduce((n, colour) => n + (colour === 2 ? 1 : 0), 0);
}

test("the worker presents the dissolve as it goes and resumes the pass after 801 ms", () => {
  const h = harness();
  h.tick(4);
  h.send({ type: "debugWrite", id: 1, flags: [[200, 1]] });
  h.tick(60);
  assert.equal(h.ctx.run.engine!.modalKind, null, "room 1's dissolve is over");
  h.send({ type: "debugWrite", id: 2, flags: [[201, 1]] });
  h.tick(2);
  assert.equal(h.ctx.run.engine!.modalKind, "dissolve");
  const passes = h.ctx.run.engine!.vars[100]!;
  const counts: number[] = [];
  for (let poll = 0; poll < 46; poll++) {
    h.tick();
    counts.push(newPixels(h.presentation));
  }
  assert.equal(h.ctx.run.engine!.vars[100], passes, "the pass waits inside show.pic");
  assert.ok(
    counts.every((n, i) => n > 0 && n < 160 * 168 && (i === 0 || n > counts[i - 1]!)),
    `each frame shows more of room 2: ${counts.join(",")}`,
  );
  h.tick(4);
  assert.equal(h.ctx.run.engine!.modalKind, null);
  assert.equal(newPixels(h.presentation), 160 * 168);
  assert.ok(h.ctx.run.engine!.vars[100]! > passes, "the pass went on");
});

test("a session recorded through dissolves replays, from its boot and every anchor, to the same state", () => {
  const h = harness();
  h.tick(4);
  h.send({ type: "debugWrite", id: 1, flags: [[200, 1]] });
  h.tick(20);
  // A key typed mid-dissolve waits for the next input phase.
  assert.equal(h.ctx.run.engine!.modalKind, "dissolve");
  h.send({ type: "key", code: 65 });
  h.tick(40);
  h.send({ type: "debugWrite", id: 2, flags: [[201, 1]] });
  h.tick(30);
  assert.equal(h.ctx.run.engine!.modalKind, "dissolve", "room 2 is still coming in");
  h.send({ type: "pause", paused: true });
  h.tick(3);
  h.send({ type: "pause", paused: false });
  h.tick(40);
  assert.equal(h.ctx.run.engine!.vars[0], 2);
  assert.equal(h.ctx.run.engine!.modalKind, null);
  h.send({ type: "flush", id: 9 });

  const segment = collectSegments(h.control)[0]!;
  const live = historySyncDigest(h.ctx.run.engine!);
  const replayed = replayHistorySegment(segment);
  assert.equal(replayed.error, null);
  assert.equal(replayed.diverged, null, "every recorded sync mark holds");
  assert.equal(historySyncDigest(replayed.ctx.run.engine!), live);
  assert.ok(
    segment.anchors.some((a) => a.replay.continuation?.modals.some((m) => m.kind === "dissolve")),
    "the pause anchored a progress entry mid-dissolve",
  );
  for (let anchor = 0; anchor < segment.anchors.length; anchor++) {
    const fromAnchor = replayHistorySegment(segment, { anchor });
    assert.equal(fromAnchor.diverged, null, `anchor ${anchor}`);
    assert.equal(historySyncDigest(fromAnchor.ctx.run.engine!), live, `anchor ${anchor}`);
  }
});
