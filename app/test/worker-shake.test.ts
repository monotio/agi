import assert from "node:assert/strict";
import { test } from "node:test";
import { gameContainer, workerHarness } from "./worker-ctx.ts";

// docs/fidelity.md "Original shake.screen and picture reveal": on PC EGA the display alternates
// between a copy 8 px right and 4 lines down and the normal page, four
// retraces each (66.7 ms), eight steps per unit; the pass waits meanwhile.
test("worker posts each shake.screen step and the end, and the pass resumes after it", () => {
  const { ctx, presentation } = workerHarness(
    gameContainer(["if(!isset(f200)){set(f200);shake.screen(1);increment(v100);}return;"]),
  );
  const shakes = () =>
    presentation.flatMap((m) => (m.type === "shake" ? [m.shake && [m.shake.dx, m.shake.dy]] : []));
  ctx.fns.tickEngine();
  ctx.fns.postFrame();
  assert.deepEqual(shakes(), [[8, 4]]);
  ctx.fns.stepHostTick(67);
  assert.deepEqual(shakes(), [
    [8, 4],
    [0, 0],
  ]);
  assert.equal(ctx.run.engine!.vars[100], 0, "the pass waits for the shake");
  ctx.fns.stepHostTick(534);
  assert.deepEqual(shakes().slice(-2), [[0, 0], null], "the last step ends at 533 ms");
  ctx.fns.stepHostTick(600);
  assert.equal(ctx.run.engine!.vars[100], 1);
});
