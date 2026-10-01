import assert from "node:assert/strict";
import { test } from "node:test";
import { captureProjectBuild } from "../src/authoring/projectBuild.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import type { ExecutionBoundary } from "../src/runtime/engine.ts";
import type { ExecutionPhaseKind } from "../src/runtime/executionObservation.ts";
import {
  compileDebugExpression,
  DebugExpressionError,
  type DebugSnapshot,
} from "../src/runtime/debugExpression.ts";
import { createDebugStepPlan } from "../src/runtime/debugStep.ts";
import {
  createDebugWatchpointPlan,
  DebugWatchpointError,
} from "../src/runtime/debugWatchpoints.ts";

const emptyBuild = captureProjectBuild({
  files: {},
  profileId: "2.936",
  sources: {},
  bindings: {},
});

function snap(overrides: Partial<DebugSnapshot> = {}): DebugSnapshot {
  return {
    vars: new Array<number>(256).fill(0),
    flags: new Array<boolean>(256).fill(false),
    strings: [],
    objects: [],
    inventory: [],
    room: 3,
    logic: 4,
    pc: 7,
    cycle: 2,
    ...overrides,
  };
}

/** A phase or idle stop's detached state: no parked LOGIC stack, no instruction location. */
function detached(overrides: Partial<DebugSnapshot> = {}): DebugSnapshot {
  return snap({ logic: null, pc: null, ...overrides });
}

function watchPlan() {
  return createDebugWatchpointPlan({ build: emptyBuild });
}

function varsAt(index: number, value: number): number[] {
  const vars = new Array<number>(256).fill(0);
  vars[index] = value;
  return vars;
}

// Assembled once so the build's source map carries a real generated-jump entry
// (pc 9, the else-skip) between the predicate dispatch (pc 1) and the call.
const STEP_SOURCE = "start: if (!isset(f1)) { call(2); } else { goto start; } return;";

function stepBuild() {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(STEP_SOURCE, { dictionary: new Map() }).payload);
  return captureProjectBuild({
    files: Object.fromEntries(container.files),
    profileId: "2.936",
    sources: { "0": STEP_SOURCE },
    bindings: {},
  });
}

function boundary(
  pc: number,
  kind: ExecutionBoundary["kind"],
  sequence: number,
  frames: ExecutionBoundary["frames"] = [{ invocationId: 1, logic: 0, pc, callsite: null }],
): ExecutionBoundary {
  return { sequence, logic: 0, pc, kind, opcodePc: pc, frames };
}

test("a null location makes logic and pc reads fail with an explicit unavailable error", () => {
  const logic = compileDebugExpression("logic");
  const pc = compileDebugExpression("pc");
  const snapshot = detached();
  for (const [compiled, name] of [
    [logic, "logic"],
    [pc, "pc"],
  ] as const) {
    assert.throws(
      () => compiled.evaluate(snapshot),
      (error) =>
        error instanceof DebugExpressionError &&
        error.message === `'${name}' is unavailable: the stop has no instruction location`,
      name,
    );
  }
  assert.throws(
    () => compileDebugExpression("pc + 1").evaluate(snapshot),
    /'pc' is unavailable/,
    "a compound read names the same unavailable location",
  );
  assert.equal(logic.evaluate(snap()), 4, "an instruction stop still reports the logic");
  assert.equal(pc.evaluate(snap()), 7, "an instruction stop still reports the pc");
});

test("ordinary slots and lazy boolean guards evaluate under null location metadata", () => {
  const snapshot = detached();
  (snapshot.vars as number[])[0] = 10;
  (snapshot.flags as boolean[])[0] = true;
  assert.equal(compileDebugExpression("v0 + room + cycle").evaluate(snapshot), 10 + 3 + 2);
  assert.equal(compileDebugExpression("f0 || logic == 0").evaluate(snapshot), true);
  assert.equal(
    compileDebugExpression("f1 && pc == 0").evaluate(snapshot),
    false,
    "false && never reaches the unavailable pc read",
  );
  assert.throws(
    () => compileDebugExpression("f0 && pc == 0").evaluate(snapshot),
    /'pc' is unavailable/,
    "a reached read still fails explicitly instead of coercing",
  );
  assert.throws(
    () => compileDebugExpression("room").evaluate(snap({ room: null as never })),
    /not a safe integer/,
    "room and cycle keep their number contract",
  );
  assert.throws(
    () => compileDebugExpression("cycle").evaluate(snap({ cycle: null as never })),
    /not a safe integer/,
  );
});

test("watch filters keep working on null-metadata snapshots and a reached location read faults once", () => {
  const plan = watchPlan();
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
        {
          id: "where",
          enabled: true,
          target: { kind: "variable", index: 1 },
          condition: "pc == 0",
        },
      ],
    },
    detached(),
  );
  const vars = varsAt(1, 1);
  vars[0] = 5;
  const outcome = plan.observe(detached({ vars }), { sequence: 1, cause: { kind: "sound" } });
  assert.deepEqual(outcome.cause, { kind: "sound" }, "the phase cause reports verbatim");
  assert.deepEqual(
    outcome.changes.map((change) => [change.id, change.reason]),
    [
      ["counter", "change"],
      ["where", "error"],
    ],
  );
  assert.match(outcome.changes[1]!.error ?? "", /'pc' is unavailable/);
  assert.match(plan.status()[1]!.fault ?? "", /instruction location/);
  const settled = plan.observe(detached({ vars: varsAt(1, 2) }), {
    sequence: 2,
    cause: { kind: "cycle-entry" },
  });
  assert.deepEqual(
    settled.changes.map((change) => change.id),
    [],
    "a faulted watch stays run-disabled; the quiet slot changes nothing",
  );
});

test("a guarded location read on a watch condition short-circuits without faulting", () => {
  const plan = watchPlan();
  plan.configure(
    {
      revision: 1,
      watchpoints: [
        {
          id: "guarded",
          enabled: true,
          target: { kind: "variable", index: 0 },
          condition: "f0 && logic == 0",
        },
      ],
    },
    detached(),
  );
  const outcome = plan.observe(detached({ vars: varsAt(0, 1) }), {
    sequence: 1,
    cause: { kind: "pre-logic" },
  });
  assert.deepEqual(
    outcome.changes.map((change) => change.reason),
    [],
    "f0 is false, so the unavailable logic read is never reached",
  );
  assert.equal(plan.status()[0]!.fault, null);
  assert.equal(plan.status()[0]!.changes, 1, "the real slot change still counted");
});

test("every engine phase kind is admitted as a watch cause without an instruction location", () => {
  const plan = watchPlan();
  plan.configure(
    {
      revision: 1,
      watchpoints: [{ id: "w", enabled: true, target: { kind: "variable", index: 0 } }],
    },
    snap(),
  );
  const phases: readonly ExecutionPhaseKind[] = [
    "cycle-entry",
    "input",
    "pre-logic",
    "host-answer",
    "room",
    "reset",
    "cycle-tail",
    "motion",
    "cycle-end",
    "clock",
    "sound",
  ];
  phases.forEach((kind, i) => {
    const outcome = plan.observe(snap({ vars: varsAt(0, i + 1) }), {
      sequence: i + 1,
      cause: { kind },
    });
    assert.equal(outcome.cause?.kind, kind);
    assert.equal(outcome.changes.length, 1, kind);
  });
  const located = plan.observe(snap({ vars: varsAt(0, 20) }), {
    sequence: 100,
    cause: { kind: "input", location: { logic: 2, pc: 4 }, invocationId: 3 },
  });
  assert.deepEqual(
    located.cause,
    { kind: "input", location: { logic: 2, pc: 4 }, invocationId: 3 },
    "a phase may carry an optional location; it is detached and never inferred",
  );
});

test("action and predicate keep the responsible-location requirement and its validation", () => {
  const plan = watchPlan();
  plan.configure({ revision: 1, watchpoints: [] }, snap());
  const bad: unknown[] = [
    { kind: "action" },
    { kind: "predicate" },
    { kind: "action", location: { logic: 0 } },
    { kind: "action", location: { logic: 256, pc: 0 } },
    { kind: "action", location: { logic: 0, pc: -1 } },
    { kind: "action", location: { logic: 0, pc: 1.5 } },
    { kind: "sound", location: 5 },
    { kind: "cycle-end", location: { logic: 0, pc: "x" } },
    { kind: "bogus" },
  ];
  for (const cause of bad) {
    assert.throws(
      () => plan.observe(snap(), { sequence: 50, cause } as never),
      DebugWatchpointError,
      JSON.stringify(cause),
    );
  }
  const ok = plan.observe(snap(), {
    sequence: 50,
    cause: { kind: "action", location: { logic: 0, pc: 0 } },
  });
  assert.equal(ok.repeat, false, "rejected causes never consume the sequence");
  assert.equal(ok.cause?.kind, "action");
});

test("a null-origin cycle step ignores boundaries and finishes once at the next real cycle end", () => {
  const plan = createDebugStepPlan({
    origin: null,
    mode: "cycle",
    granularity: "statement",
    build: stepBuild(),
  });
  assert.equal(plan.atBoundary(boundary(7, "action", 1)), null, "cycle never stops mid-pass");
  assert.equal(plan.atBoundary(boundary(1, "predicate", 2)), null);
  assert.equal(plan.atCycleEnd(), "cycle-end");
  assert.equal(plan.atCycleEnd(), null, "a completed plan stops only once");
  assert.equal(plan.atBoundary(boundary(7, "action", 3)), null);
});

test("a null-origin step into stops at the first eligible boundary under statement filtering", () => {
  const plan = createDebugStepPlan({
    origin: null,
    mode: "into",
    granularity: "statement",
    build: stepBuild(),
  });
  assert.equal(
    plan.atBoundary(boundary(9, "goto", 1)),
    null,
    "the generated else-jump is filtered",
  );
  assert.equal(
    plan.atBoundary(boundary(1, "predicate", 2)),
    null,
    "predicate dispatch is filtered",
  );
  assert.equal(plan.atBoundary(boundary(7, "action", 3)), "step");
  assert.equal(plan.atBoundary(boundary(12, "goto", 4)), null, "a completed plan stops only once");
  assert.equal(plan.atCycleEnd(), null);
});

test("a null-origin step into at instruction granularity takes the first boundary, else the cycle end", () => {
  const build = stepBuild();
  const instruction = createDebugStepPlan({
    origin: null,
    mode: "into",
    granularity: "instruction",
    build,
  });
  assert.equal(instruction.atBoundary(boundary(1, "predicate", 1)), "step");
  const quiet = createDebugStepPlan({
    origin: null,
    mode: "into",
    granularity: "instruction",
    build,
  });
  assert.equal(quiet.atCycleEnd(), "cycle-end", "with no instruction boundary the cycle end wins");
  assert.equal(quiet.atCycleEnd(), null);
});

test("null-origin over and out are refused at plan creation; into and cycle are accepted", () => {
  const build = stepBuild();
  for (const mode of ["over", "out"] as const) {
    assert.throws(
      () => createDebugStepPlan({ origin: null, mode, granularity: "statement", build }),
      /stopped invocation/,
      mode,
    );
  }
  for (const mode of ["into", "cycle"] as const) {
    createDebugStepPlan({ origin: null, mode, granularity: "statement", build });
  }
});

test("non-null origins keep invocation stepping, ordering and unwind semantics", () => {
  const build = stepBuild();
  const origin = boundary(0, "if", 5, [
    { invocationId: 1, logic: 0, pc: 0, callsite: null },
    { invocationId: 4, logic: 0, pc: 0, callsite: 7 },
  ]);
  const deeper = boundary(7, "action", 6, [
    { invocationId: 1, logic: 0, pc: 0, callsite: null },
    { invocationId: 4, logic: 0, pc: 0, callsite: 7 },
    { invocationId: 9, logic: 2, pc: 7, callsite: 0 },
  ]);
  const sameTop = boundary(12, "goto", 7, [
    { invocationId: 1, logic: 0, pc: 0, callsite: null },
    { invocationId: 4, logic: 0, pc: 9, callsite: 7 },
  ]);
  const over = createDebugStepPlan({ origin, mode: "over", granularity: "statement", build });
  assert.equal(over.atBoundary(deeper), null, "over waits inside the origin's own callees");
  assert.equal(over.atBoundary(sameTop), "step");

  const out = createDebugStepPlan({ origin, mode: "out", granularity: "statement", build });
  assert.equal(out.atBoundary(sameTop), null, "out waits while the origin invocation is present");
  const orphan = createDebugStepPlan({ origin, mode: "out", granularity: "statement", build });
  assert.equal(
    orphan.atBoundary(
      boundary(0, "return", 8, [{ invocationId: 8, logic: 1, pc: 0, callsite: null }]),
    ),
    "unwind",
    "no origin or ancestor frame unwinds the plan",
  );

  const into = createDebugStepPlan({ origin, mode: "into", granularity: "statement", build });
  assert.equal(
    into.atBoundary(boundary(7, "action", 5)),
    null,
    "a boundary at the origin sequence is ignored",
  );
  assert.equal(into.atBoundary(boundary(7, "action", 6)), "step");
});
