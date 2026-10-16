import { test } from "node:test";
import assert from "node:assert/strict";
import { OperationRecorder } from "../../src/agent/recordedReplay.ts";
import { gameContainer, workerHarness } from "./worker-ctx.ts";
import { buildView } from "../../src/view/view.ts";
import { createGamepadPollState, stepGamepadPoll } from "../src/play/useGameKeys.ts";

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

test("stepGamepadPoll maps analog stick, D-pad, center stop, and platform button words", () => {
  const state = createGamepadPollState();
  const dirs: number[] = [];
  const keys: number[] = [];
  const opts = (profileId: string, modal: "print" | null = null, holdToMove = false) => ({
    profileId,
    modal,
    holdToMove,
    sendDirection: (d: number) => dirs.push(d),
    sendKey: (k: number) => keys.push(k),
  });

  // Push stick Southeast (+0.8, +0.8) -> direction 4; hold -> no duplicate; release -> 0xf500 stop.
  stepGamepadPoll({ axes: [0.8, 0.8], buttons: [] }, state, 100, opts("2.936"));
  stepGamepadPoll({ axes: [0.8, 0.8], buttons: [] }, state, 150, opts("2.936"));
  stepGamepadPoll({ axes: [0, 0], buttons: [] }, state, 200, opts("2.936"));
  assert.deepEqual(dirs, [4]);
  assert.deepEqual(keys, [0xf500]);

  // PC/Amiga Button 1 single + double release -> 0x0101 then 0x0301; Button 2 -> 0x0201 then 0x0401.
  keys.length = 0;
  stepGamepadPoll(
    { axes: [0, 0], buttons: [{ pressed: true }, { pressed: false }] },
    state,
    300,
    opts("amiga-2.316"),
  );
  stepGamepadPoll(
    { axes: [0, 0], buttons: [{ pressed: false }, { pressed: false }] },
    state,
    350,
    opts("amiga-2.316"),
  );
  stepGamepadPoll(
    { axes: [0, 0], buttons: [{ pressed: true }, { pressed: false }] },
    state,
    450,
    opts("amiga-2.316"),
  );
  stepGamepadPoll(
    { axes: [0, 0], buttons: [{ pressed: false }, { pressed: false }] },
    state,
    500,
    opts("amiga-2.316"),
  );
  stepGamepadPoll(
    { axes: [0, 0], buttons: [{ pressed: false }, { pressed: true }] },
    state,
    1000,
    opts("amiga-2.316"),
  );
  stepGamepadPoll(
    { axes: [0, 0], buttons: [{ pressed: false }, { pressed: false }] },
    state,
    1050,
    opts("amiga-2.316"),
  );
  stepGamepadPoll(
    { axes: [0, 0], buttons: [{ pressed: false }, { pressed: true }] },
    state,
    1150,
    opts("amiga-2.316"),
  );
  stepGamepadPoll(
    { axes: [0, 0], buttons: [{ pressed: false }, { pressed: false }] },
    state,
    1200,
    opts("amiga-2.316"),
  );
  assert.deepEqual(keys, [0x0101, 0x0301, 0x0201, 0x0401]);

  // IIgs 1.014: no double-click promotion; modal open maps both buttons to Enter (0x0d).
  keys.length = 0;
  stepGamepadPoll(
    { axes: [0, 0], buttons: [{ pressed: true }, { pressed: false }] },
    state,
    2000,
    opts("iigs-1.014"),
  );
  stepGamepadPoll(
    { axes: [0, 0], buttons: [{ pressed: false }, { pressed: false }] },
    state,
    2050,
    opts("iigs-1.014"),
  );
  stepGamepadPoll(
    { axes: [0, 0], buttons: [{ pressed: true }, { pressed: false }] },
    state,
    2100,
    opts("iigs-1.014"),
  );
  stepGamepadPoll(
    { axes: [0, 0], buttons: [{ pressed: false }, { pressed: false }] },
    state,
    2150,
    opts("iigs-1.014"),
  );
  stepGamepadPoll(
    { axes: [0, 0], buttons: [{ pressed: false }, { pressed: true }] },
    state,
    2200,
    opts("iigs-1.014", "print"),
  );
  stepGamepadPoll(
    { axes: [0, 0], buttons: [{ pressed: false }, { pressed: false }] },
    state,
    2250,
    opts("iigs-1.014", "print"),
  );
  assert.deepEqual(keys, [0x0101, 0x0101, 0x0d]);
});
