import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { newProjectAdmissionState } from "../src/worker/projectAdmissionState.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { gameContainer, workerHarness } from "./worker-ctx.ts";
import { buildView } from "../../src/view/view.ts";
import { createImageHeroPreview } from "../src/worker/imageHeroPreview.ts";
test("image hero preview moves with the hero and leaves interpreter and saved frames unchanged", () => {
  const original = buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [5] }] }] });
  const { ctx } = workerHarness(
    gameContainer(
      [
        "if (!isset(f200)) { set(f200); load.view(1); animate.obj(o0); set.view(o0,1); position(o0,20,100); draw(o0); stop.cycling(o0); } return;",
      ],
      (c) => c.putResource("view", 1, original),
    ),
  );
  ctx.fns.tickEngine();
  const before = ctx.engine!.getPresentation();
  const preview = createImageHeroPreview(
    ctx.engine!,
    buildView({
      loops: [
        {
          cels: [
            { width: 1, height: 1, pixels: [4] },
            { width: 1, height: 1, pixels: [2] },
          ],
        },
      ],
    }),
    0,
  );
  const frame = ctx.engine!.getPresentation();
  preview(frame, 0);
  assert.equal(frame.visual[100 * 160 + 20], 4);
  preview(frame, 3);
  assert.equal(frame.visual[100 * 160 + 20], 2);
  assert.deepEqual(ctx.engine!.getPresentation(), before);
  assert.equal(ctx.engine!.readObjects()[0]!.view, 1);
});

test("worker image preview requires the current Create run, cancels pending loads and keeps recording pixels intact", async () => {
  const { ctx, presentation } = workerHarness(
    gameContainer(
      [
        "if (!isset(f200)) { set(f200); load.view(1); animate.obj(o0); set.view(o0,1); position(o0,20,100); draw(o0); stop.cycling(o0); } return;",
      ],
      (c) =>
        c.putResource(
          "view",
          1,
          buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [5] }] }] }),
        ),
    ),
  );
  ctx.fns.tickEngine();
  const bytes = buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [4] }] }] });
  onWorkerMessage(ctx, { type: "imageHeroPreview", runToken: "create", bytes });
  assert.equal(ctx.imageHeroPreview, undefined);
  ctx.projectAdmission = newProjectAdmissionState("create", ctx.engine!);
  onWorkerMessage(ctx, { type: "imageHeroPreview", runToken: "old", bytes });
  assert.equal(ctx.imagePreviewSerial, undefined);
  onWorkerMessage(ctx, { type: "imageHeroPreview", runToken: "create", bytes });
  onWorkerMessage(ctx, { type: "imageHeroPreview", runToken: "create", bytes: null });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ctx.imageHeroPreview, undefined);
  onWorkerMessage(ctx, { type: "imageHeroPreview", runToken: "create", bytes });
  for (let i = 0; i < 100 && !ctx.imageHeroPreview; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(ctx.imageHeroPreview);
  ctx.fns.postFrame(true);
  const shown = presentation.filter((message) => message.type === "frame").at(-1)!;
  assert.equal(shown.visual[100 * 160 + 20], 4);
  assert.equal(ctx.presentation.recentRing.take(1, 1, null)[0]!.visual[100 * 160 + 20], 5);
  assert.equal(ctx.engine!.getPresentation().visual[100 * 160 + 20], 5);
  onWorkerMessage(ctx, { type: "imageHeroPreview", runToken: "create", bytes: null });
  assert.equal(
    presentation.filter((message) => message.type === "frame").at(-1)!.visual[100 * 160 + 20],
    5,
  );
});

test("hero preview follows assigned loop numbers and shows the first marked loop in other directions", () => {
  const original = buildView({
    loops: [0, 1, 2].map(() => ({ cels: [{ width: 1, height: 1, pixels: [5] }] })),
  });
  const { ctx } = workerHarness(
    gameContainer(
      [
        "if (!isset(f200)) { set(f200); load.view(1); animate.obj(o0); set.view(o0,1); set.loop(o0,1); position(o0,20,100); draw(o0); stop.cycling(o0); } if (isset(f201)) { reset(f201); set.loop(o0,2); } return;",
      ],
      (c) => c.putResource("view", 1, original),
    ),
  );
  ctx.fns.tickEngine();
  const bytes = buildView({
    loops: [
      { cels: [{ width: 1, height: 1, pixels: [4] }] },
      { cels: [{ width: 1, height: 1, pixels: [2] }] },
    ],
  });
  const preview = createImageHeroPreview(ctx.engine!, bytes, 0, [0, 2]);
  const frame = ctx.engine!.getPresentation();
  preview(frame, 0);
  assert.equal(frame.visual[100 * 160 + 20], 4);
  ctx.engine!.flags[201] = 1;
  ctx.fns.tickEngine();
  const changed = ctx.engine!.getPresentation();
  preview(changed, 0);
  assert.equal(changed.visual[100 * 160 + 20], 2);
});
