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
  ctx.engine!.flags[201] = 1;
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
  ctx.engine!.patchResource("sound", 4, new Uint8Array([1, 2, 3]));
  ctx.fns.postFrame();
  const frames = presentation.filter((m) => m.type === "frame");
  assert.ok(frames.length >= 2, "a patch alone publishes a frame");
  const patched = frames.at(-1)!;
  assert.ok(patched.type === "frame");
  assert.equal(patched.patchGeneration, 1);
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
