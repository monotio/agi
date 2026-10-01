import assert from "node:assert/strict";
import { test } from "node:test";
import { captureProjectBuild } from "../src/authoring/projectBuild.ts";
import { createDebugStepPlan } from "../src/runtime/debugStep.ts";
import { createDebugWatchpointPlan } from "../src/runtime/debugWatchpoints.ts";

const build = captureProjectBuild({ files: {}, profileId: "2.936", sources: {}, bindings: {} });

for (const kind of ["sound", "cycle-entry", "pre-logic", "cycle-end"] as const) {
  test(`a ${kind} watch reports its actual phase without a fabricated instruction`, () => {
    const plan = createDebugWatchpointPlan({ build });
    const snapshot = {
      vars: [0],
      flags: [],
      strings: [],
      objects: [],
      inventory: [],
      room: 1,
      logic: null,
      pc: null,
      cycle: 0,
    };
    plan.configure(
      {
        revision: 1,
        watchpoints: [
          {
            id: "counter",
            enabled: true,
            target: { kind: "variable", index: 0 },
            condition: "new > old",
          },
        ],
      },
      snapshot,
    );
    const outcome = plan.observe(
      { ...snapshot, vars: [1] },
      {
        sequence: 1,
        cause: { kind },
      },
    );
    assert.deepEqual(outcome.cause, { kind });
    assert.deepEqual(
      outcome.changes.map(({ old, new: value }) => [old, value]),
      [[0, 1]],
    );
  });
}

test("next-cycle stepping from an idle phase needs no fabricated invocation", () => {
  const plan = createDebugStepPlan({
    origin: null,
    mode: "cycle",
    granularity: "statement",
    build,
  });
  assert.equal(plan.atCycleEnd(), "cycle-end");
  assert.equal(plan.atCycleEnd(), null, "a completed plan stops only once");
});
