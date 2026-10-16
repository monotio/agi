import { test } from "node:test";
import assert from "node:assert/strict";
import { gameContainer, workerHarness } from "./worker-ctx.ts";

const VIEW_0 = new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 1, 1, 0, 0x51, 0]);

// One object drawn once; f201 retargets its fixed priority without touching
// any visual or text byte — the composed priority surface alone differs.
// (Baseline y=100 already computes to band 9, so 5 is a real change.)
function priorityGame() {
  return gameContainer(
    [
      `if (!isset(f200)) { set(f200); load.view(1); animate.obj(o0); set.view(o0, 1); position(o0, 20, 100); draw(o0); stop.cycling(o0); }
       if (isset(f201)) { reset(f201); set.priority(o0, 5); }
       return;`,
    ],
    (c) => c.putResource("view", 1, VIEW_0),
  );
}

function frameCount(presentation: { type: string }[]): number {
  return presentation.filter((m) => m.type === "frame").length;
}

test("a priority-only change publishes a frame while diagnostics are off", () => {
  const { ctx, presentation } = workerHarness(priorityGame());
  ctx.fns.tickEngine();
  ctx.fns.postFrame();
  const first = frameCount(presentation);
  assert.ok(first > 0, "the initial frame posts");

  // Same visual and text bytes; only the composed priority surface differs.
  ctx.run.engine!.flags[201] = 1;
  ctx.fns.tickEngine();
  ctx.fns.postFrame();
  assert.equal(
    frameCount(presentation),
    first + 1,
    "set.priority publishes even though visual/text bytes are unchanged",
  );

  // A genuinely identical next frame may deduplicate again.
  ctx.fns.tickEngine();
  ctx.fns.postFrame();
  assert.equal(frameCount(presentation), first + 1);
});

test("a resource patch republishes the frame carrying its own revision", () => {
  const { ctx, presentation } = workerHarness(priorityGame());
  ctx.fns.tickEngine();
  ctx.fns.postFrame();
  const first = presentation.filter((m) => m.type === "frame").at(-1)!;
  assert.ok(first.type === "frame");
  assert.equal(first.patchGeneration, 0, "the frame reports its capture revision");

  // A sound patch changes no visual, text, priority, or object byte — only
  // the container revision. The frame still ships so the inspector's latched
  // observations can pin the revision they describe.
  ctx.run.engine!.patchResources([{ kind: "sound", num: 4, payload: new Uint8Array([1, 2, 3]) }]);
  ctx.fns.postFrame();
  const frames = presentation.filter((m) => m.type === "frame");
  assert.ok(frames.length >= 2, "a patch alone publishes a frame");
  const patched = frames.at(-1)!;
  assert.ok(patched.type === "frame");
  assert.equal(patched.patchGeneration, 1);
});

test("show.obj publishes the preview mask and dismissal clears it", () => {
  const { ctx, presentation } = workerHarness(
    gameContainer([`if (!isset(f200)) { set(f200); load.view(1); show.obj(1); } return;`], (c) =>
      c.putResource("view", 1, VIEW_0),
    ),
  );
  ctx.fns.tickEngine();
  ctx.fns.postFrame();
  const open = presentation.filter((m) => m.type === "frame").at(-1)!;
  assert.ok(open.type === "frame");
  assert.equal(open.modal, "showObj");
  assert.ok(open.preview instanceof Uint8Array, "the mask rides the frame while open");
  assert.ok(
    open.preview.some((v) => v === 1),
    "the cel wrote marked pixels",
  );

  ctx.run.engine!.ackPrint();
  ctx.fns.postFrame();
  const closed = presentation.filter((m) => m.type === "frame").at(-1)!;
  assert.ok(closed.type === "frame");
  assert.equal(closed.preview, undefined, "dismissal ships a mask-free frame");

  // The opcode parked mid-logic; the next tick resumes it to `return`, and
  // the tick after that runs logic 0 fresh — reopening republishes the mask.
  ctx.run.engine!.flags[200] = 0;
  ctx.fns.tickEngine();
  ctx.fns.tickEngine();
  ctx.fns.postFrame();
  const reopened = presentation.filter((m) => m.type === "frame").at(-1)!;
  assert.ok(reopened.type === "frame" && reopened.preview instanceof Uint8Array);
});

test("frame buffers post as transfers while the worker keeps its own copies", () => {
  const { ctx, presentation, transfers } = workerHarness(priorityGame());
  ctx.fns.onDebug({ type: "debug", channels: { ownership: true } });
  ctx.fns.tickEngine();
  ctx.fns.postFrame();
  const idx = presentation.findLastIndex((m) => m.type === "frame");
  const frame = presentation[idx]!;
  assert.ok(frame.type === "frame");
  const transfer = transfers[idx]!;
  assert.ok(transfer !== undefined && transfer.length > 0, "the frame posts a transfer list");
  // Every posted buffer leaves the worker: each ships inside the transfer list.
  for (const buf of [frame.visual, frame.priority, frame.text, frame.ownership]) {
    assert.ok(buf instanceof Uint8Array || buf instanceof Uint16Array);
    assert.ok(
      transfer.includes(buf.buffer),
      "posted buffers must be transferred, not copied or retained",
    );
  }
  // The sameness copies the worker keeps for the next comparison are its own:
  // they must not alias the buffers that were just transferred away.
  assert.notEqual(ctx.run.presentation.lastVisual!.buffer, frame.visual.buffer);
  assert.notEqual(ctx.run.presentation.lastText!.buffer, frame.text.buffer);
});

test("arming then disarming a channel ships a frame for each transition", () => {
  const { ctx, presentation } = workerHarness(priorityGame());
  ctx.fns.tickEngine();
  ctx.fns.postFrame();
  const base = frameCount(presentation);

  ctx.fns.onDebug({ type: "debug", channels: { ownership: true } });
  assert.ok(frameCount(presentation) > base, "arming ownership ships a frame carrying the payload");
  const armed = presentation.filter((m) => m.type === "frame").at(-1)!;
  assert.ok(armed.type === "frame" && armed.ownership instanceof Uint16Array);

  ctx.fns.onDebug({ type: "debug", channels: { ownership: false } });
  const disarmed = presentation.filter((m) => m.type === "frame").at(-1)!;
  assert.ok(
    disarmed.type === "frame" && disarmed.ownership === undefined,
    "disarming publishes a frame without the payload so the host can clear it",
  );
});

test("profile appearances stay local to the worker while autosaves and inspections retain each game's pixels", async (t) => {
  const { iigsFontFixture } = await import("./iigsFontFixture.ts");
  const { onWorkerMessage } = await import("../src/worker/dispatch.ts");
  const { inspectGame } = await import("../src/library/gameInspection.ts");
  const { previewPixels } = await import("./previewPixels.ts");
  const { ctx, presentation, control } = workerHarness(gameContainer(["return;"]));
  t.after(() => ctx.fns.stopTimers());
  const container = gameContainer(
    [
      'if (!isset(f200)) { set(f200); load.pic(v0); draw.pic(v0); show.pic(); set.text.attribute(1,2); display(3,2,"A"); } return;',
    ],
    (c) => c.putResource("picture", 0, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff)),
  );
  const baseFiles = Object.fromEntries(container.files);
  for (const [profile, supplied, blue, green, firstGlyphX] of [
    ["2.936", false, 170, 170, 18],
    ["amiga-2.202", false, 255, 136, 19],
    ["iigs-1.014", true, 255, 136, 17],
    ["iigs-1.014", false, 255, 136, 18],
    ["2.936", false, 170, 170, 18],
  ] as const) {
    const files = { ...baseFiles, ...(supplied ? { AGIFONT: iigsFontFixture() } : {}) };
    const ready = new Promise<void>((resolve) => {
      const post = ctx.ports.control;
      ctx.ports.control = (message, transfer) => {
        post(message, transfer);
        if (message.type === "booted") {
          ctx.ports.control = post;
          resolve();
        }
      };
    });
    onWorkerMessage(ctx, { type: "boot", profile, files, words: [] });
    await ready;
    ctx.fns.stopTimers();
    assert.equal(control.at(-1)?.type === "error", false);
    ctx.fns.tickEngine();
    ctx.fns.postFrame();
    const frame = presentation.filter((message) => message.type === "frame").at(-1)!;
    assert.ok(frame);
    assert.equal(
      Object.hasOwn(frame, "appearance"),
      false,
      "font and palette never ride frame messages",
    );
    ctx.fns.autosave(true);
    const save = presentation.findLast((message) => message.type === "autosave");
    assert.ok(save?.type === "autosave" && save.preview, `${profile} has an autosave thumbnail`);
    const thumb = previewPixels(save.preview);
    const opening = await inspectGame({ files, words: [], profile });
    for (const [name, rgba, stride] of [
      ["autosave", thumb.rgb, 3],
      ["inspection", opening.rgba, 4],
    ] as const) {
      const pixel = (x: number, y: number) => [
        ...rgba.subarray((y * 320 + x) * stride, (y * 320 + x) * stride + 3),
      ];
      assert.deepEqual(pixel(0, 8), [0, 0, blue], `${profile} ${name} picture`);
      assert.deepEqual(pixel(16, 24), [0, green, 0], `${profile} ${name} glyph background`);
      assert.deepEqual(pixel(firstGlyphX, 24), [0, 0, blue], `${profile} ${name} glyph foreground`);
    }
  }
});
