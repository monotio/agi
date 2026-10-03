import assert from "node:assert/strict";
import { test } from "node:test";
import { gameContainer, workerHarness } from "./worker-ctx.ts";
import type { DebugBreakpointSpec } from "../../src/runtime/debugBreakpoints.ts";

const source = "increment(v40);\nreturn;";

test("debug attach verifies source using the request's actual symbol bindings", () => {
  const { ctx, control } = workerHarness(gameContainer(["assignn(v40, 7); return;"]));
  ctx.fns.onDebugAttach({
    type: "debugAttach",
    id: 1,
    sources: { "0": "assignn(counter, 7); return;" },
    bindings: { counter: { kind: "variable", num: 40 } },
  });
  const reply = control.find(
    (message) => message.type === "debugAttached" || message.type === "debugError",
  );
  assert.equal(reply?.type, "debugAttached");
  assert.equal(ctx.debugger.build?.logics[0]?.authored, "assignn(counter, 7); return;");
});

test("invalid watch configuration cannot reset the previous breakpoint's hit history", () => {
  const { ctx, control } = workerHarness(gameContainer([source]));
  ctx.fns.onDebugAttach({ type: "debugAttach", id: 1, sources: { "0": source } });
  const attached = control.find((message) => message.type === "debugAttached");
  assert.ok(attached?.type === "debugAttached");
  const breakpoint: DebugBreakpointSpec = {
    id: "third-pass",
    enabled: true,
    logic: 0,
    line: 1,
    mode: "statement",
    hit: { kind: "equal", count: 3 },
  };
  ctx.fns.onDebugConfigure({
    type: "debugConfigure",
    id: 2,
    epoch: attached.epoch,
    revision: 1,
    breakpoints: [breakpoint],
    watchpoints: [],
  });
  ctx.fns.tickEngine();
  assert.equal(ctx.debugger.breakpointPlan?.status()[0]?.hits, 1);
  const before = ctx.debugger.breakpointPlan?.status();
  const revision = ctx.debugger.breakpointPlan?.revision;
  ctx.fns.onDebugConfigure({
    type: "debugConfigure",
    id: 3,
    epoch: attached.epoch,
    revision: 2,
    breakpoints: [{ ...breakpoint, condition: "true" }],
    watchpoints: [{ id: "invalid-slot", enabled: true, target: { kind: "variable", index: 256 } }],
  });
  const rejected = control.find((message) => message.type === "debugError" && message.id === 3);
  assert.ok(rejected);
  assert.deepEqual(ctx.debugger.breakpointPlan?.status(), before);
  assert.equal(ctx.debugger.breakpointPlan?.revision, revision);
  assert.equal(ctx.debugger.configRevision, 1);
  ctx.fns.tickEngine();
  ctx.fns.tickEngine();
  assert.ok(
    ctx.engine?.executionStopInfo,
    "the unchanged third-hit breakpoint must stop this pass",
  );
});

test("conditional breakpoint reads logic and pc from its current executing boundary", () => {
  const { ctx, control } = workerHarness(gameContainer([source]));
  ctx.fns.onDebugAttach({ type: "debugAttach", id: 1, sources: { "0": source } });
  const attached = control.find((message) => message.type === "debugAttached");
  assert.ok(attached?.type === "debugAttached");
  ctx.fns.onDebugConfigure({
    type: "debugConfigure",
    id: 2,
    epoch: attached.epoch,
    revision: 1,
    breakpoints: [
      {
        id: "here",
        enabled: true,
        logic: 0,
        line: 1,
        mode: "statement",
        condition: "logic == 0 && pc == 0",
      },
    ],
    watchpoints: [],
  });
  ctx.fns.tickEngine();
  const stopped = control.find((message) => message.type === "debugStopped");
  assert.ok(
    stopped?.type === "debugStopped",
    "a matching location condition must stop before the instruction",
  );
  assert.equal(stopped.location?.logic, 0);
  assert.equal(stopped.location?.pc, 0);
  assert.equal(ctx.engine?.vars[40], 0);
  assert.deepEqual(stopped.reasons, [{ kind: "breakpoint", id: "here", hitCount: 1 }]);
});

test("conditional watch reads the LOGIC location of the completed mutation", () => {
  const { ctx, control } = workerHarness(gameContainer([source]));
  ctx.fns.onDebugAttach({ type: "debugAttach", id: 1, sources: { "0": source } });
  const attached = control.find((message) => message.type === "debugAttached");
  assert.ok(attached?.type === "debugAttached");
  ctx.fns.onDebugConfigure({
    type: "debugConfigure",
    id: 2,
    epoch: attached.epoch,
    revision: 1,
    breakpoints: [],
    watchpoints: [
      {
        id: "here",
        enabled: true,
        target: { kind: "variable", index: 40 },
        condition: "logic == 0 && pc == 0",
      },
    ],
  });
  ctx.fns.tickEngine();
  const stopped = control.find((message) => message.type === "debugStopped");
  assert.ok(
    stopped?.type === "debugStopped",
    "a matching mutation condition must stop after the instruction",
  );
  assert.equal(ctx.engine?.vars[40], 1);
  assert.equal(stopped.cause.type, "instruction");
  const reason = stopped.reasons[0];
  assert.ok(reason?.kind === "watch");
  assert.deepEqual(reason.changes, [
    {
      id: "here",
      reason: "change",
      target: { kind: "variable", index: 40 },
      old: 0,
      new: 1,
    },
  ]);
});

test("room variable cannot be assigned by an advanced debugger value transaction", () => {
  const { ctx, control } = workerHarness(gameContainer([source]));
  ctx.fns.onDebugAttach({ type: "debugAttach", id: 1, sources: { "0": source } });
  const attached = control.find((message) => message.type === "debugAttached");
  assert.ok(attached?.type === "debugAttached");
  ctx.fns.onDebugPause({ type: "debugPause", id: 2, epoch: attached.epoch });
  const stopped = control.find((message) => message.type === "debugStopped");
  assert.ok(stopped?.type === "debugStopped");
  const beforeVars = [...ctx.engine!.vars];
  const beforeFlags = [...ctx.engine!.flags];
  ctx.fns.onDebugSetValues({
    type: "debugSetValues",
    id: 3,
    epoch: attached.epoch,
    stopId: stopped.stopId,
    vars: [
      [40, 7],
      [0, 9],
    ],
    flags: [[90, 1]],
  });
  const rejection = control.find((message) => message.type === "debugError" && message.id === 3);
  assert.ok(
    rejection?.type === "debugError",
    "room navigation needs a new semantic room launch, not raw v0 assignment",
  );
  assert.equal(rejection.code, "invalidRequest");
  assert.deepEqual([...ctx.engine!.vars], beforeVars);
  assert.deepEqual([...ctx.engine!.flags], beforeFlags);
  assert.equal(ctx.debugger.stopId, stopped.stopId);
  assert.equal(ctx.debugger.modified, false);
});

test("published stopped snapshot keeps its actual instruction location for evaluation", () => {
  const { ctx, control } = workerHarness(gameContainer([source]));
  ctx.fns.onDebugAttach({ type: "debugAttach", id: 1, sources: { "0": source } });
  const attached = control.find((message) => message.type === "debugAttached");
  assert.ok(attached?.type === "debugAttached");
  ctx.fns.onDebugConfigure({
    type: "debugConfigure",
    id: 2,
    epoch: attached.epoch,
    revision: 1,
    breakpoints: [{ id: "at-entry", enabled: true, logic: 0, line: 1, mode: "statement" }],
    watchpoints: [],
  });
  ctx.fns.tickEngine();
  const stopped = control.find((message) => message.type === "debugStopped");
  assert.ok(stopped?.type === "debugStopped");
  ctx.fns.onDebugEvaluate({
    type: "debugEvaluate",
    id: 3,
    epoch: attached.epoch,
    stopId: stopped.stopId,
    expression: "logic == 0 && pc == 0",
  });
  const evaluation = control.find(
    (message) => message.type === "debugEvaluation" && message.id === 3,
  );
  assert.ok(evaluation?.type === "debugEvaluation");
  assert.equal(evaluation.ok, true, evaluation.error ?? "Expected a successful evaluation.");
  assert.equal(evaluation.value, true);
  assert.equal(ctx.debugger.snapshot?.objects.length, ctx.engine!.screenObjects.length);
});
