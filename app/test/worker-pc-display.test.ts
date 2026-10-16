import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../../src/runtime/engine.ts";
import { validateHistoryBoot, type HistorySegment } from "../../src/agent/history.ts";
import { buildView } from "../../src/view/view.ts";
import type { PcDisplay } from "../../src/runtime/display.ts";
import {
  collectSegments,
  gameContainer,
  replayHistorySegment,
  workerHarness,
} from "./worker-ctx.ts";
import { createWorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type {
  BootMessage,
  WorkerControl,
  WorkerPresentation,
} from "../src/worker/workerProtocol.ts";

// Player-visible rule: the screen the player picked (EGA or CGA) is the
// session's hardware. It holds through room launches, restarts and replays,
// and history reproduces the run on the same screen. A new start, including a
// resumed autosave, takes the current choice (docs/fidelity.md "PC fonts and
// display adapters").

function game() {
  return gameContainer(
    [
      `if (!isset(f200)) { set(f200); assignn(v1, 1); load.pic(v1); draw.pic(v1); show.pic();
         load.view(0); add.to.pic(0, 0, 0, 10, 100, 15, 4); }
       if (equaln(v0, 0)) { new.room(1); }
       return;`,
      "return;",
      "return;",
    ],
    (c) => {
      c.putResource("picture", 1, Uint8Array.of(0xff));
      c.putResource(
        "view",
        0,
        buildView({ loops: [{ cels: [{ width: 2, height: 1, pixels: [2, 2] }] }] }),
      );
    },
  );
}

function boot(extra: Partial<BootMessage> = {}) {
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  const ctx = createWorkerContext({
    control: (m) => control.push(m),
    presentation: (m) => presentation.push(m),
    now: () => 0,
  });
  ctx.host = createEngineHost(ctx);
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(game().files),
    words: [],
    profile: "2.936",
    ...extra,
  });
  ctx.fns.stopTimers();
  ctx.fns.tickEngine();
  ctx.fns.tickEngine();
  ctx.fns.postFrame();
  return { ctx, control, presentation };
}

const frames = (presentation: WorkerPresentation[]) =>
  presentation.filter(
    (m): m is Extract<WorkerPresentation, { type: "frame" }> => m.type === "frame",
  );

function segmentOf(control: WorkerControl[]): HistorySegment {
  const segment = collectSegments(control)[0]!;
  return { ...segment, boot: validateHistoryBoot(JSON.parse(JSON.stringify(segment.boot))) };
}

test("a CGA boot runs CGA, puts the display and cel provenance on frames and records it", () => {
  const { ctx, control, presentation } = boot({ pcDisplay: "cga-rgb" });
  assert.equal(ctx.run.engine!.pcDisplay, "cga-rgb");
  assert.equal(ctx.run.engine!.vars[26], 1);
  const frame = frames(presentation).at(-1)!;
  assert.equal(frame.display, "cga-rgb");
  assert.ok(frame.cel);
  assert.deepEqual([frame.cel[100 * 160 + 10], frame.cel[100 * 160 + 12]], [1, 0]);
  const segment = segmentOf(control);
  assert.equal(segment.boot.pcDisplay, "cga-rgb");
  const replay = replayHistorySegment(segment);
  assert.equal(replay.error, null);
  assert.equal(replay.diverged, null);
  assert.equal(replay.ctx.run.engine!.pcDisplay, "cga-rgb");
  assert.equal(replay.ctx.run.engine!.vars[26], 1);
});

test("a boot without a display, or on a build without verified CGA, runs EGA", () => {
  for (const extra of [{}, { profile: "2.089" as const, pcDisplay: "cga-rgb" as const }]) {
    const { ctx, control, presentation } = boot(extra);
    assert.equal(ctx.run.engine!.pcDisplay, "ega");
    const frame = frames(presentation).at(-1)!;
    assert.equal(frame.display, undefined);
    assert.equal(frame.cel, undefined);
    assert.equal(segmentOf(control).boot.pcDisplay, undefined);
  }
});

test("a resumed autosave starts on the current choice and keeps the saved v26", () => {
  for (const [saved, now] of [
    ["cga-rgb", "ega"],
    ["ega", "cga-rgb"],
  ] as [PcDisplay, PcDisplay][]) {
    const first = boot({ pcDisplay: saved });
    const image = first.ctx.run.engine!.autosaveImage();
    assert.ok(image);
    const resumed = boot({
      pcDisplay: now,
      restoreImage: Buffer.from(image).toString("base64"),
    });
    assert.equal(resumed.ctx.run.engine!.pcDisplay, now);
    assert.equal(resumed.ctx.run.engine!.vars[26], saved === "cga-rgb" ? 1 : 3);
    assert.equal(segmentOf(resumed.control).boot.pcDisplay, now === "cga-rgb" ? now : undefined);
  }
});

test("a replay reset keeps the session's display", () => {
  const { ctx } = boot({ pcDisplay: "cga-rgb" });
  onWorkerMessage(ctx, { type: "resetReplay", seed: 7 });
  ctx.fns.stopTimers();
  assert.equal(ctx.run.engine!.pcDisplay, "cga-rgb");
  assert.equal(ctx.run.engine!.vars[26], 1);
});

test("Play here and From the beginning keep the session's display", (t) => {
  for (const beginning of [false, true]) {
    const { ctx } = workerHarness(game());
    t.after(() => ctx.fns.stopTimers());
    ctx.run.engine = new Engine(game(), ctx.host, new Map(), {
      profile: "2.936",
      pcDisplay: "cga-rgb",
    });
    ctx.fns.tickEngine();
    ctx.fns.onPlayHere({
      type: "playHere",
      id: 1,
      room: 2,
      x: 0,
      y: 0,
      launch: beginning ? { beginning: true } : {},
    });
    assert.equal(ctx.run.engine!.pcDisplay, "cga-rgb", beginning ? "beginning" : "carry");
    assert.equal(ctx.run.engine!.vars[26], 1);
  }
});
