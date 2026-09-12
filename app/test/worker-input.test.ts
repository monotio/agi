import { test } from "node:test";
import assert from "node:assert/strict";
import { OperationRecorder } from "../../src/agent/recordedReplay.ts";
import { gameContainer, workerHarness } from "./worker-ctx.ts";

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
  assert.equal(ctx.engine!.awaitingKey, true, "the have.key wait parked the pass");
  assert.deepEqual(
    presentation.filter((m) => m.type === "waitingForKey").map((m) => m.waiting),
    [true],
  );

  ctx.recording.recording = {
    tape: new OperationRecorder(),
    events: [],
    printed: [],
    tainted: null,
    usedGetnum: false,
  };
  ctx.fns.onKey({ type: "key", code: 0x62 });

  assert.equal(ctx.engine!.vars[100], 0x62, "the delivered key reached the IF once");
  assert.equal(ctx.engine!.vars[101], 7, "execution continued past the resumed IF");
  const hostCalls = ctx.recording.recording!.tape.operations.flatMap((op) =>
    op[0] === "tick" || op[0] === "release" ? op[1] : [],
  );
  assert.deepEqual(
    hostCalls.filter((call) => call[0] === "waitKey"),
    [["waitKey", 0x62]],
    "one waitKey host call recorded",
  );
  assert.deepEqual(
    ctx.recording.recording!.events.filter((e) => e.kind === "key"),
    [{ cycle: 0, kind: "key", code: 0x62 }],
  );
  assert.deepEqual(
    presentation.filter((m) => m.type === "waitingForKey").map((m) => m.waiting),
    [true, false],
    "waitingForKey cleared on delivery",
  );
});
