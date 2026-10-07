import { test } from "node:test";
import assert from "node:assert/strict";
import { OperationRecorder } from "../../src/agent/recordedReplay.ts";
import { gameContainer, workerHarness } from "./worker-ctx.ts";
import { buildView } from "../../src/view/view.ts";

test("a parked have.key plus a key message delivers exactly one key", () => {
  const { ctx, presentation } = workerHarness(
    gameContainer([
      `
      wait: if (!have.key()) { goto wait; }
      assignv(v100,v19);
      assignn(v101, 7);
      return;
      `,
    ]),
  );
  ctx.fns.tickEngine();
  assert.equal(ctx.run.engine!.awaitingKey, true, "the have.key wait parked the pass");
  assert.deepEqual(
    presentation.filter((m) => m.type === "waitingForKey").map((m) => m.waiting),
    [true],
  );

  ctx.run.recording.recording = {
    tape: new OperationRecorder(),
    events: [],
    printed: [],
    tainted: null,
  };
  ctx.fns.onKey({ type: "key", code: 0x62 });

  assert.equal(ctx.run.engine!.vars[100], 0x62, "the delivered key reached the IF once");
  assert.equal(ctx.run.engine!.vars[101], 7, "execution continued past the resumed IF");
  const hostCalls = ctx.run.recording.recording!.tape.operations.flatMap((op) =>
    op[0] === "tick" || op[0] === "release" ? op[1] : [],
  );
  assert.deepEqual(
    hostCalls.filter((call) => call[0] === "waitKey"),
    [["waitKey", 0x62]],
    "one waitKey host call recorded",
  );
  assert.deepEqual(
    ctx.run.recording.recording!.events.filter((e) => e.kind === "key"),
    [{ cycle: 0, kind: "key", code: 0x62 }],
  );
  assert.deepEqual(
    presentation.filter((m) => m.type === "waitingForKey").map((m) => m.waiting),
    [true, false],
    "waitingForKey cleared on delivery",
  );
});

test("toggle release keeps northeast direction when the horizon clips its vertical step", () => {
  const { ctx } = workerHarness(
    gameContainer(
      [
        `if (!isset(f200)) {
          set(f200); load.view(0); animate.obj(0); set.view(0,0);
          position(0,38,46); draw(0); assignn(v99,1); step.size(0,v99);
        } return;`,
      ],
      (game) =>
        game.putResource(
          "view",
          0,
          buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
        ),
    ),
  );
  ctx.fns.tickEngine();
  ctx.fns.onDirection({ type: "direction", dir: 2 });
  for (let i = 0; i < 10; i++) ctx.fns.tickEngine();
  const ego = ctx.run.engine!.screenObjects[0]!;
  assert.deepEqual([ego.x, ego.y], [48, 37]);
  const before = { x: ego.x, y: ego.y };
  ctx.fns.onDirection({ type: "direction", dir: 0, releaseEligible: false });
  for (let i = 0; i < 10; i++) ctx.fns.tickEngine();
  // CI's pixel-delta oracle reported [1, 0] even though direction 2 survived.
  assert.deepEqual([Math.sign(ego.x - before.x), Math.sign(ego.y - before.y)], [1, 0]);
  assert.equal(ego.direction, 2);
  assert.equal(ctx.run.engine!.vars[6], 2);
});
