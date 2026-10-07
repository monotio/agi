import assert from "node:assert/strict";
import { test } from "node:test";
import { captureProjectBuild } from "../src/authoring/projectBuild.ts";
import type { DebugSnapshot } from "../src/runtime/debugExpression.ts";
import { createDebugWatchpointPlan } from "../src/runtime/debugWatchpoints.ts";

function snapshot(vars: number[]): DebugSnapshot {
  return {
    vars,
    flags: [],
    strings: [],
    objects: [],
    inventory: [],
    room: 0,
    logic: 0,
    pc: 0,
    cycle: 0,
  };
}

for (const malformed of ["accessor", "inherited"] as const) {
  test(`a watchpoint rejects ${malformed} slot data without invoking it or admitting its sequence`, () => {
    const build = captureProjectBuild({ files: {}, profileId: "2.936", sources: {}, bindings: {} });
    const plan = createDebugWatchpointPlan({ build });
    plan.configure(
      {
        revision: 1,
        watchpoints: [
          { id: "first", enabled: true, target: { kind: "variable", index: 0 } },
          { id: "second", enabled: true, target: { kind: "variable", index: 1 } },
        ],
      },
      snapshot([0, 0]),
    );
    let reads = 0;
    const vars = [1, 2];
    if (malformed === "accessor") {
      Object.defineProperty(vars, "1", {
        get() {
          reads++;
          return 2;
        },
      });
    } else {
      Reflect.deleteProperty(vars, "1");
      const prototype = Object.create(Array.prototype) as object;
      Object.defineProperty(prototype, "1", { value: 2 });
      Object.setPrototypeOf(vars, prototype);
    }
    const occurrence = { sequence: 1, cause: { kind: "input" as const } };
    assert.throws(
      () => plan.observe(snapshot(vars), occurrence),
      /snapshot|own|data|absent|slot|value/i,
    );
    assert.equal(reads, 0, "a detached snapshot is data, not executable getters");
    assert.deepEqual(
      plan.status().map((entry) => [entry.baseline, entry.changes]),
      [
        [0, 0],
        [0, 0],
      ],
    );
    const retry = plan.observe(snapshot([1, 2]), occurrence);
    assert.equal(retry.repeat, false, "rejected input must not consume the occurrence");
    assert.deepEqual(
      retry.changes.map((change) => [change.id, change.old, change.new]),
      [
        ["first", 0, 1],
        ["second", 0, 2],
      ],
    );
  });
}
