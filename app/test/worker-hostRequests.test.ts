import { test } from "node:test";
import assert from "node:assert/strict";
import { gameContainer, workerHarness } from "./worker-ctx.ts";

test("a stale hostAnswer id is dropped; the matching id delivers and ticks", () => {
  const { ctx, control } = workerHarness(
    gameContainer([`#message 1 "How many?"\nget.num(1, v100);\nassignn(v101, 7);\nreturn;`]),
  );
  ctx.fns.tickEngine();
  assert.equal(ctx.engine!.awaitingHostAnswer, true);
  const request = control.find((m) => m.type === "hostRequest");
  assert.equal(request?.op, "getnum");
  assert.equal(request?.id, 1);

  ctx.fns.onHostAnswer({ type: "hostAnswer", id: 99, response: "5" });
  assert.equal(ctx.engine!.hostInteractionPending, true, "the stale answer was dropped");
  assert.equal(ctx.engine!.vars[100], 0, "nothing stored");
  assert.equal(ctx.engine!.vars[101], 0, "the pass did not resume");

  ctx.fns.onHostAnswer({ type: "hostAnswer", id: 1, response: "5" });
  assert.equal(ctx.engine!.vars[100], 5);
  assert.equal(ctx.engine!.vars[101], 7, "the matching answer resumed the pass");
  assert.equal(ctx.engine!.hostInteractionPending, false);
});

test("abandonHostRequest posts interactionCancelled with the request id", () => {
  const { ctx, control } = workerHarness(gameContainer(["return;"]));
  ctx.hostRequests.hostRequestOutstanding = { id: 7, op: "restore", authoring: false };
  ctx.fns.abandonHostRequest();
  assert.deepEqual(
    control.filter((m) => m.type === "interactionCancelled"),
    [{ type: "interactionCancelled", id: 7, op: "restore" }],
  );
  assert.equal(ctx.hostRequests.hostRequestOutstanding, null);
  ctx.fns.abandonHostRequest();
  assert.equal(
    control.filter((m) => m.type === "interactionCancelled").length,
    1,
    "a second abandon with nothing in flight posts nothing",
  );
});
