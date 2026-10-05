import assert from "node:assert/strict";
import { test } from "node:test";

test("typing analysis waits for a pause, caps continuous typing and settles on close", async (t) => {
  const { createAnalysisSchedule } = await import("../src/studio/logic/analysisSchedule.ts");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let runs = 0;
  const analysis = createAnalysisSchedule(() => runs++);
  analysis.schedule();
  const pause = analysis.settled();
  t.mock.timers.tick(100);
  analysis.schedule();
  assert.equal(runs, 0);
  t.mock.timers.tick(119);
  assert.equal(runs, 0);
  t.mock.timers.tick(1);
  await pause;
  assert.equal(runs, 1);
  analysis.schedule();
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(100);
    analysis.schedule();
  }
  assert.equal(runs, 1);
  t.mock.timers.tick(100);
  assert.equal(runs, 2);
  analysis.schedule();
  const closing = analysis.settled();
  analysis.dispose();
  await closing;
  t.mock.timers.tick(600);
  assert.equal(runs, 2);
});
