import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { captureProjectBuild } from "../src/authoring/projectBuild.ts";
import { Engine, type ExecutionBoundary } from "../src/runtime/engine.ts";
import { createDebugStepPlan } from "../src/runtime/debugStep.ts";

function game(sources: readonly string[]) {
  const container = createContainer();
  const dictionary = new Map<string, number>();
  sources.forEach((source, num) =>
    container.putResource("logic", num, assembleLogic(source, { dictionary }).payload),
  );
  const build = captureProjectBuild({
    files: Object.fromEntries(container.files),
    profileId: "2.936",
    sources: Object.fromEntries(sources.map((source, num) => [num, source])),
    bindings: {},
  });
  const engine = new Engine(
    container,
    { print() {}, displayAt() {}, statusLine() {}, takeInputLine: () => null, takeKeys: () => [] },
    dictionary,
  );
  let plan: ReturnType<typeof createDebugStepPlan> | undefined;
  let reason: string | null = null;
  engine.setExecutionGate((boundary) => {
    if (!plan) return true;
    reason = plan.atBoundary(boundary);
    return reason !== null;
  });
  engine.tick();
  function step(
    mode: "into" | "over" | "out" | "cycle",
    granularity: "statement" | "instruction" = "statement",
  ) {
    const origin = engine.executionStop!;
    plan = createDebugStepPlan({ origin, mode, granularity, build });
    engine.resumeExecution();
    do {
      engine.tick();
    } while (engine.executionYieldPending);
    if (!engine.executionStop) reason = plan.atCycleEnd();
    return { boundary: engine.executionStop, reason };
  }
  return { engine, step, build };
}

test("step over follows invocation identity through nested calls and stops before the caller's next statement", () => {
  const { engine, step } = game([
    "call(1); increment(v51); return;",
    "call(2); increment(v50); return;",
    "increment(v50); return;",
  ]);
  const result = step("over");
  assert.equal(result.boundary?.logic, 0);
  assert.equal(result.boundary?.pc, 2);
  assert.equal(result.reason, "step");
  assert.equal(engine.vars[50], 2);
  assert.equal(engine.vars[51], 0);
});

test("step into enters a called logic and step out resumes its actual caller", () => {
  const { engine, step } = game(["call(1); increment(v51); return;", "increment(v50); return;"]);
  assert.equal(step("into").boundary?.logic, 1);
  const caller = step("out");
  assert.equal(caller.boundary?.logic, 0);
  assert.equal(caller.boundary?.pc, 2);
  assert.equal(engine.vars[50], 1);
  assert.equal(engine.vars[51], 0);
});

test("statement stepping skips predicate dispatch and generated branch jumps; instruction stepping exposes predicates", () => {
  const statement = game([
    "if (equaln(v50, 0)) { increment(v50); } else { increment(v51); } increment(v52); return;",
  ]);
  const body = statement.step("into");
  assert.equal(body.boundary?.kind, "action");
  assert.equal(statement.engine.vars[50], 0);
  const next = statement.step("into");
  assert.equal(next.boundary?.kind, "action");
  assert.equal(statement.engine.vars[50], 1);
  assert.equal(statement.engine.vars[51], 0);
  assert.equal(statement.engine.vars[52], 0);
  const instruction = game(["if (equaln(v50, 0)) { increment(v50); } return;"]);
  assert.equal(instruction.step("into", "instruction").boundary?.kind, "predicate");
});

test("a one-instruction loop is a new occurrence at the same PC", () => {
  const { engine, step } = game(["again: goto again;"]);
  const first = engine.executionStop!;
  const next = step("into").boundary!;
  assert.equal(next.pc, first.pc);
  assert.ok(next.sequence > first.sequence);
});

test("top-level step out and next cycle finish the existing partial cycle once", () => {
  for (const mode of ["out", "cycle"] as const) {
    const { engine, step } = game(["increment(v50); increment(v50); return;"]);
    const result = step(mode);
    assert.equal(result.boundary, null);
    assert.equal(result.reason, "cycle-end");
    assert.equal(engine.vars[50], 2);
  }
});

test("nonlocal unwind terminates a step plan and a reported occurrence is ignored only once", () => {
  const { engine, build } = game(["return;"]);
  const origin = engine.executionStop!;
  const plan = createDebugStepPlan({ origin, mode: "out", granularity: "statement", build });
  assert.equal(plan.atBoundary(origin), null);
  const unwound: ExecutionBoundary = {
    ...origin,
    sequence: origin.sequence + 1,
    frames: [{ ...origin.frames[0]!, invocationId: origin.frames[0]!.invocationId + 1 }],
  };
  assert.equal(plan.atBoundary(unwound), "unwind");
  assert.equal(plan.atBoundary(unwound), null);
  assert.equal(plan.atCycleEnd(), null);
});

test("step over survives recursive entries into the same logic", () => {
  const { engine, step } = game([
    "assignn(v50, 2); call(1); increment(v52); return;",
    "if (greatern(v50, 0)) { decrement(v50); call(1); } increment(v51); return;",
  ]);
  assert.equal(step("into").boundary?.pc, 3);
  assert.equal(step("into").boundary?.logic, 1);
  step("into"); // Evaluate the IF, stop before decrement.
  step("into"); // Decrement once, stop before the recursive call.
  assert.equal(engine.vars[50], 1);
  const originInvocation = engine.executionStop!.frames.at(-1)!.invocationId;
  const result = step("over");
  assert.equal(result.boundary?.logic, 1);
  assert.equal(result.boundary?.frames.at(-1)?.invocationId, originInvocation);
  assert.equal(engine.vars[50], 0);
  assert.equal(engine.vars[51], 2);
  assert.equal(engine.vars[52], 0);
});
