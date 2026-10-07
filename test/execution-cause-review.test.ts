import assert from "node:assert/strict";
import { captureProjectBuild } from "../src/authoring/projectBuild.ts";
import { createDebugStepPlan } from "../src/runtime/debugStep.ts";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import type { ExecutionObservation } from "../src/runtime/executionObservation.ts";

test("a return stop identifies the responsible callee separately from its caller resume point", () => {
  const container = createContainer();
  for (const [num, source] of [
    "call(1); increment(v50); return;",
    "increment(v51); return;",
  ].entries()) {
    container.putResource("logic", num, assembleLogic(source, { dictionary: new Map() }).payload);
  }
  const host: EngineHost = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  };
  const engine = new Engine(container, host, new Map());
  const observations: ExecutionObservation[] = [];
  assert.ok(engine.setExecutionObserver, "completed operations need their responsible cause");
  engine.setExecutionObserver((observation) => {
    observations.push(observation);
    const cause = observation.cause;
    return (
      cause.type === "instruction" && cause.boundary.logic === 1 && cause.boundary.kind === "return"
    );
  });
  engine.tick();
  assert.deepEqual([engine.vars[50], engine.vars[51]], [0, 1]);
  assert.equal(engine.completedCycleSerial, 0);
  const stop = engine.executionStopInfo;
  assert.equal(stop?.cause.type, "instruction");
  assert.ok(stop && stop.cause.type === "instruction");
  const cause = stop.cause.boundary;
  assert.equal(cause.logic, 1);
  assert.equal(cause.pc, 2);
  assert.deepEqual(
    cause.frames.map((frame) => frame.logic),
    [0, 1],
  );
  assert.equal(stop.location?.logic, 0);
  assert.equal(stop.location?.pc, 2);
  assert.deepEqual(
    stop.location?.frames.map((frame) => frame.logic),
    [0],
  );
  const call = observations.find(
    (entry) =>
      entry.cause.type === "instruction" &&
      entry.cause.boundary.logic === 0 &&
      entry.cause.boundary.pc === 0,
  );
  assert.ok(call && call.cause.type === "instruction");
  assert.deepEqual(
    call.cause.boundary.frames.map((frame) => frame.logic),
    [0],
  );
  assert.equal(call.cause.boundary.frames[0]?.invocationId, cause.frames[0]?.invocationId);
  const retained = structuredClone(stop);
  engine.resumeExecution();
  engine.tick();
  assert.deepEqual([engine.vars[50], engine.vars[51]], [1, 1]);
  assert.equal(engine.completedCycleSerial, 1);
  assert.deepEqual(stop, retained, "retained stop records must not follow mutable engine frames");
});

test("predicate completion and enclosing IF resolution have increasing observation serials", () => {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic("if (v40 == 0) { increment(v41); } return;", { dictionary: new Map() }).payload,
  );
  const engine = new Engine(
    container,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine: () => null,
      takeKeys: () => [],
    },
    new Map(),
  );
  const seen: ExecutionObservation[] = [];
  engine.setExecutionObserver((observation) => {
    seen.push(observation);
  });
  engine.tick();
  assert.equal(engine.vars[41], 1);
  const predicate = seen.findIndex(
    (entry) => entry.cause.type === "instruction" && entry.cause.boundary.kind === "predicate",
  );
  const resolved = seen.findIndex(
    (entry) => entry.cause.type === "instruction" && entry.cause.boundary.kind === "if",
  );
  assert.ok(predicate >= 0 && resolved > predicate);
  assert.ok(
    seen.every((entry, i) => i === 0 || entry.sequence > seen[i - 1]!.sequence),
    `watchpoint input must be ordered: ${seen.map((entry) => entry.sequence).join(", ")}`,
  );
});

test("step into from an after-operation stop executes the highlighted next action once", () => {
  const container = createContainer();
  const source = "increment(v40); increment(v41); increment(v42); return;";
  container.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  const engine = new Engine(
    container,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine: () => null,
      takeKeys: () => [],
    },
    new Map(),
  );
  const control: { step?: ReturnType<typeof createDebugStepPlan> } = {};
  let watched = false;
  engine.setExecutionGate((boundary) => (control.step?.atBoundary(boundary) ?? null) !== null);
  engine.setExecutionObserver((observation) => {
    if (
      !watched &&
      observation.cause.type === "instruction" &&
      observation.cause.boundary.pc === 0
    ) {
      watched = true;
      return true;
    }
    return false;
  });
  engine.tick();
  assert.deepEqual([engine.vars[40], engine.vars[41], engine.vars[42]], [1, 0, 0]);
  const origin = engine.executionStopInfo?.location;
  assert.ok(origin);
  assert.equal(origin.pc, 2);
  control.step = createDebugStepPlan({
    origin,
    mode: "into",
    granularity: "instruction",
    build: captureProjectBuild({
      files: Object.fromEntries(container.files),
      profileId: "2.936",
      sources: { 0: source },
      bindings: {},
    }),
  });
  engine.resumeExecution();
  engine.tick();
  assert.deepEqual([engine.vars[40], engine.vars[41], engine.vars[42]], [1, 1, 0]);
  assert.equal(engine.executionStopInfo?.location?.pc, 4);
  assert.equal(engine.completedCycleSerial, 0);
});

test("an after-predicate stop exposes the next actual predicate encounter", () => {
  const container = createContainer();
  const source = "if (v40 == 0 && v41 == 0) { increment(v42); } return;";
  container.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  const engine = new Engine(
    container,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine: () => null,
      takeKeys: () => [],
    },
    new Map(),
  );
  const control: { step?: ReturnType<typeof createDebugStepPlan> } = {};
  let predicates = 0;
  engine.setExecutionGate((boundary) => (control.step?.atBoundary(boundary) ?? null) !== null);
  engine.setExecutionObserver((entry) => {
    if (entry.cause.type !== "instruction" || entry.cause.boundary.kind !== "predicate")
      return false;
    return ++predicates === 1;
  });
  engine.tick();
  const stop = engine.executionStopInfo;
  assert.ok(stop && stop.cause.type === "instruction");
  assert.equal(stop.cause.boundary.opcodePc, 1);
  const origin = stop.location;
  assert.ok(origin);
  // ff | equaln(v40,0) | equaln(v41,0) | ff | branch-offset | increment(v42)
  assert.equal(origin.kind, "predicate");
  assert.equal(origin.opcodePc, 4);
  control.step = createDebugStepPlan({
    origin,
    mode: "into",
    granularity: "instruction",
    build: captureProjectBuild({
      files: Object.fromEntries(container.files),
      profileId: "2.936",
      sources: { 0: source },
      bindings: {},
    }),
  });
  engine.resumeExecution();
  engine.tick();
  assert.equal(predicates, 2, "exactly the second predicate executes, not a replay of the first");
  assert.equal(engine.vars[42], 0, "the first branch action is still parked");
  assert.equal(engine.executionStopInfo?.location?.pc, 10);
});
