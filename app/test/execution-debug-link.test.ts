import assert from "node:assert/strict";
import { test } from "node:test";
import { createExecutionDebugLink } from "../src/engine/executionDebugLink.ts";
import type { WorkerQueryFn, WorkerControl } from "../src/worker/workerProtocol.ts";

const stopped = { type: "debugStopped", epoch: 1, stopId: 1 } as Extract<
  WorkerControl,
  { type: "debugStopped" }
>;
test("live edits wait through steps and wake on continue or detach", async () => {
  const link = createExecutionDebugLink((async () => ({})) as WorkerQueryFn);
  assert.equal(link.waitForContinue(), undefined);
  link.handle(stopped);
  let admitted = false;
  const edit = link.waitForContinue()!.then(() => {
    admitted = true;
  });
  await link.query("debugResume", { epoch: 1, stopId: 1, action: "over" });
  await Promise.resolve();
  assert.equal(admitted, false);
  link.handle({ ...stopped, stopId: 2 });
  await link.query("debugResume", { epoch: 1, stopId: 2, action: "continue" });
  await edit;
  assert.equal(admitted, true);
  link.handle(stopped);
  const pending = link.waitForContinue();
  link.handle({ type: "debugDetached", epoch: 1, buildId: "build", reason: "requested" });
  await pending;
  assert.equal(link.stopped.value, null);
});
test("a new stop during continue keeps edits queued; a failed resume keeps its stop", async () => {
  let failure = false;
  const link = createExecutionDebugLink((async () => {
    if (failure) throw new Error("stale stop");
    link.handle({ ...stopped, stopId: 2 });
    return {};
  }) as WorkerQueryFn);
  link.handle(stopped);
  await link.query("debugResume", { epoch: 1, stopId: 1, action: "continue" });
  assert.equal(link.stopped.value?.stopId, 2);
  failure = true;
  await assert.rejects(link.query("debugResume", { epoch: 1, stopId: 2, action: "continue" }));
  assert.equal(link.stopped.value?.stopId, 2);
  link.reset();
});
