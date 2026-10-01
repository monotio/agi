import assert from "node:assert/strict";
import { test } from "node:test";
import { captureProjectBuild } from "../src/authoring/projectBuild.ts";
import type { DebugSnapshot } from "../src/runtime/debugExpression.ts";
import {
  createDebugWatchpointPlan,
  DebugWatchpointError,
  DEBUG_WATCHPOINT_LIMITS,
  type DebugWatchCause,
  type DebugWatchOccurrence,
  type DebugWatchSpec,
  type DebugWatchTarget,
} from "../src/runtime/debugWatchpoints.ts";

/** Minimal captured build: watch targets need no sources, only an identity. */
function makeBuild(bindings: Readonly<Record<string, { readonly num: number }>> = {}) {
  return captureProjectBuild({ files: {}, profileId: "2.936", sources: {}, bindings });
}

function makePlan(
  bindings: Readonly<Record<string, { kind: "variable" | "flag" | "string"; num: number }>> = {},
  buildBindings: Readonly<Record<string, { readonly num: number }>> = {},
) {
  return createDebugWatchpointPlan({ build: makeBuild(buildBindings), bindings });
}

function snap(overrides: Partial<DebugSnapshot> = {}): DebugSnapshot {
  return Object.assign(
    {
      vars: new Array<number>(256).fill(0),
      flags: new Array<boolean>(256).fill(false),
      strings: [] as string[],
      objects: [],
      inventory: [],
      room: 0,
      logic: 0,
      pc: 0,
      cycle: 0,
    },
    overrides,
  );
}

function spec(id: string, target: DebugWatchTarget, extra: Partial<DebugWatchSpec> = {}) {
  return Object.assign({ id, enabled: true, target }, extra);
}

const variable = (index: number): DebugWatchTarget => ({ kind: "variable", index });
const flag = (index: number): DebugWatchTarget => ({ kind: "flag", index });

const action = (pc: number, logic = 0): DebugWatchCause => ({
  kind: "action",
  location: { logic, pc },
});
const phase = (kind: DebugWatchCause["kind"]): DebugWatchCause => ({ kind });
const at = (sequence: number, cause: DebugWatchCause): DebugWatchOccurrence => ({
  sequence,
  cause,
});

function watch(vars: Record<number, number> = {}, flags: Record<number, boolean> = {}) {
  return snap({
    vars: Object.assign(new Array<number>(256).fill(0), vars),
    flags: Object.assign(new Array<boolean>(256).fill(false), flags),
  });
}

test("changes after one indivisible action report old/new and the detached cause", () => {
  const plan = makePlan();
  const baseline = watch();
  const result = plan.configure(
    {
      revision: 1,
      watchpoints: [spec("v", variable(50)), spec("f", flag(10)), spec("quiet", variable(60))],
    },
    baseline,
  );
  assert.equal(result.revision, 1);
  assert.equal(result.entries.length, 3);
  const outcome = plan.observe(watch({ 50: 5 }, { 10: true }), at(1, action(4)));
  assert.equal(outcome.repeat, false);
  assert.equal(outcome.sequence, 1);
  assert.deepEqual(outcome.cause, { kind: "action", location: { logic: 0, pc: 4 } });
  assert.deepEqual(outcome.changes, [
    { id: "v", reason: "change", target: { kind: "variable", index: 50 }, old: 0, new: 5 },
    { id: "f", reason: "change", target: { kind: "flag", index: 10 }, old: false, new: true },
  ]);
});

test("a change then a change back across two operations emits two changes", () => {
  const plan = makePlan();
  plan.configure({ revision: 1, watchpoints: [spec("w", variable(50))] }, watch());
  const first = plan.observe(watch({ 50: 2 }), at(1, action(0)));
  assert.deepEqual(
    first.changes.map((change) => [change.old, change.new]),
    [[0, 2]],
  );
  const second = plan.observe(watch(), at(2, action(2)));
  assert.deepEqual(
    second.changes.map((change) => [change.old, change.new]),
    [[2, 0]],
  );
  assert.equal(plan.status()[0]!.changes, 2);
});

test("same-value observations emit nothing for either kind of slot", () => {
  const plan = makePlan();
  plan.configure(
    { revision: 1, watchpoints: [spec("v", variable(50)), spec("f", flag(3))] },
    watch({ 50: 7 }),
  );
  for (const sequence of [1, 2, 3]) {
    const outcome = plan.observe(watch({ 50: 7 }), at(sequence, phase("clock")));
    assert.equal(outcome.changes.length, 0);
  }
  assert.equal(plan.status()[0]!.changes, 0);
});

test("a false filter still advances the baseline, so the next change reports the real old value", () => {
  const plan = makePlan();
  plan.configure(
    { revision: 1, watchpoints: [spec("w", variable(50), { condition: "new == 9" })] },
    watch(),
  );
  const skipped = plan.observe(watch({ 50: 5 }), at(1, action(0)));
  assert.equal(skipped.changes.length, 0, "new == 5 fails the filter");
  assert.equal(plan.status()[0]!.baseline, 5, "the baseline advanced past the filtered change");
  assert.equal(plan.status()[0]!.changes, 1, "the slot change still counted");
  const hit = plan.observe(watch({ 50: 9 }), at(2, action(2)));
  assert.deepEqual(
    hit.changes.map((change) => [change.old, change.new]),
    [[5, 9]],
  );
});

test("old and new are typed numbers for variables and booleans for flags", () => {
  const plan = makePlan();
  plan.configure(
    {
      revision: 1,
      watchpoints: [
        spec("delta", variable(51), { condition: "new == old + 2" }),
        spec("rising", flag(20), { condition: "new && !old" }),
      ],
    },
    watch(),
  );
  const one = plan.observe(watch({ 51: 2 }, { 20: true }), at(1, action(0)));
  assert.deepEqual(
    one.changes.map((change) => change.id),
    ["delta", "rising"],
  );
  const two = plan.observe(watch({ 51: 3 }, { 20: false }), at(2, action(2)));
  assert.deepEqual(
    two.changes.map((change) => change.id),
    [],
    "3 != 2 + 2 and a falling edge is filtered out, yet both baselines advanced",
  );
  const three = plan.observe(watch({ 51: 5 }, { 20: true }), at(3, action(4)));
  assert.deepEqual(
    three.changes.map((change) => [change.id, change.old, change.new]),
    [
      ["delta", 3, 5],
      ["rising", false, true],
    ],
  );
  // Filters typed against the wrong watch kind reject at configure time.
  assert.throws(
    () =>
      plan.configure(
        { revision: 2, watchpoints: [spec("bad", flag(1), { condition: "new > old" })] },
        watch(),
      ),
    DebugWatchpointError,
  );
  assert.throws(
    () =>
      plan.configure(
        { revision: 2, watchpoints: [spec("bad", variable(1), { condition: "old && new" })] },
        watch(),
      ),
    DebugWatchpointError,
  );
});

test("short-circuit guards unavailable reads; a real filter error stops once and run-disables", () => {
  const plan = makePlan();
  plan.configure(
    {
      revision: 1,
      watchpoints: [
        // objects[] is empty: object[0].x is unavailable, guarded by new == 7.
        spec("guarded", variable(50), { condition: "new == 7 && object[0].x > 0" }),
        // f99 is always false here: the zero divisor is never reached.
        spec("safe", variable(52), { condition: "f99 && 1 / v0 == 1" }),
        spec("other", variable(51)),
      ],
    },
    watch(),
  );
  const one = plan.observe(watch({ 50: 5, 51: 1, 52: 1 }), at(1, action(0)));
  assert.deepEqual(
    one.changes.map((change) => [change.id, change.reason]),
    [["other", "change"]],
    "the guarded and div-zero filters short-circuit to false without erroring",
  );
  assert.equal(plan.status()[1]!.baseline, 1, "the filtered watch still tracked the slot");
  const two = plan.observe(watch({ 50: 7, 51: 2, 52: 2 }), at(2, action(2)));
  assert.deepEqual(
    two.changes.map((change) => [change.id, change.reason, change.old, change.new]),
    [
      ["guarded", "error", 5, 7],
      ["other", "change", 1, 2],
    ],
    "one error stop per watch; unrelated watches still report in the same batch",
  );
  assert.match(two.changes[0]!.error ?? "", /out of range/);
  assert.match(plan.status()[0]!.fault ?? "", /out of range/);
  assert.equal(plan.status()[0]!.changes, 2, "the faulting change counted before the filter ran");
  const three = plan.observe(watch({ 50: 9, 51: 3, 52: 3 }), at(3, action(4)));
  assert.deepEqual(
    three.changes.map((change) => change.id),
    ["other"],
    "a faulted watch is disabled for the run: no repeated error",
  );
  assert.equal(plan.status()[0]!.baseline, 7);
});

test("identical republication keeps a fault; correction or disable/re-enable clears and reseeds", () => {
  const plan = makePlan();
  const broken = spec("w", variable(50), { condition: "1 / v0 == 0" });
  plan.configure({ revision: 1, watchpoints: [broken] }, watch());
  plan.observe(watch({ 50: 4 }), at(1, action(0)));
  assert.match(plan.status()[0]!.fault ?? "", /division by zero/);

  // Same signature: fault and baseline survive republication.
  plan.configure({ revision: 2, watchpoints: [{ ...broken }] }, watch({ 50: 4 }));
  assert.match(plan.status()[0]!.fault ?? "", /division/);

  // Corrected expression: fault clears, baseline reseeds at the admitted snapshot.
  plan.configure(
    { revision: 3, watchpoints: [spec("w", variable(50), { condition: "new > old" })] },
    watch({ 50: 4 }),
  );
  assert.equal(plan.status()[0]!.fault, null);
  assert.equal(plan.status()[0]!.baseline, 4);
  const grown = plan.observe(watch({ 50: 6 }), at(2, action(2)));
  assert.deepEqual(
    grown.changes.map((change) => [change.id, change.reason, change.old, change.new]),
    [["w", "change", 4, 6]],
  );

  // Explicitly breaking the filter again, then disabling and re-enabling also clears it.
  plan.configure(
    { revision: 4, watchpoints: [spec("w", variable(50), { condition: "1 / v0 == 0" })] },
    watch({ 50: 6 }),
  );
  plan.observe(watch({ 50: 8 }), at(3, action(4)));
  assert.match(plan.status()[0]!.fault ?? "", /division/);
  plan.configure(
    { revision: 5, watchpoints: [spec("w", variable(50), { enabled: false })] },
    watch({ 50: 8 }),
  );
  assert.equal(plan.status()[0]!.fault, null, "a spec change is a new entry");
  plan.configure(
    { revision: 6, watchpoints: [spec("w", variable(50), { condition: "1 / v0 == 0" })] },
    watch({ 50: 8 }),
  );
  assert.equal(plan.status()[0]!.fault, null);
  assert.equal(plan.status()[0]!.changes, 0, "a changed spec resets its run state");
});

test("invalid configurations publish nothing and leave the run state untouched", () => {
  const plan = makePlan();
  plan.configure({ revision: 1, watchpoints: [spec("keep", variable(50))] }, watch({ 50: 3 }));
  plan.observe(watch({ 50: 9 }), at(1, action(0)));
  const bad: unknown[] = [
    { id: "", enabled: true, target: variable(1) },
    { id: "x".repeat(DEBUG_WATCHPOINT_LIMITS.idLength + 1), enabled: true, target: variable(1) },
    { id: 7, enabled: true, target: variable(1) },
    { id: "e", enabled: 1, target: variable(1) },
    { id: "k", enabled: true, target: { kind: "string", index: 1 } },
    { id: "i", enabled: true, target: { kind: "variable", index: 256 } },
    { id: "i", enabled: true, target: { kind: "variable", index: -1 } },
    { id: "i", enabled: true, target: { kind: "variable", index: 1.5 } },
    { id: "i", enabled: true, target: { kind: "flag", index: "3" } },
    { id: "i", enabled: true },
    { id: "c", enabled: true, target: variable(1), condition: "v1 + 1" },
    { id: "c", enabled: true, target: variable(1), condition: "v1 ==" },
    { id: "c", enabled: true, target: variable(1), condition: "nonsense == 1" },
    { id: "c", enabled: true, target: variable(1), condition: 5 },
    {
      id: "c",
      enabled: true,
      target: variable(1),
      condition: "v1 == ".padEnd(DEBUG_WATCHPOINT_LIMITS.conditionLength + 1, " "),
    },
    "entry-not-object",
  ];
  for (const entry of bad) {
    assert.throws(
      () =>
        plan.configure(
          { revision: 2, watchpoints: [spec("keep", variable(50)), entry as never] },
          watch({ 50: 9 }),
        ),
      DebugWatchpointError,
      JSON.stringify(entry),
    );
    assert.equal(plan.revision, 1, "nothing published");
    assert.equal(plan.status().length, 1);
    assert.equal(plan.status()[0]!.changes, 1, "run state untouched");
  }
  assert.throws(
    () =>
      plan.configure(
        { revision: 2, watchpoints: [spec("a", variable(1)), spec("a", variable(2))] },
        watch(),
      ),
    DebugWatchpointError,
    "duplicate ids",
  );
  assert.throws(
    () => plan.configure({ revision: 2, watchpoints: {} as never }, watch()),
    DebugWatchpointError,
  );
  assert.throws(() => plan.configure(null as never, watch()), DebugWatchpointError);
  const tooMany = Array.from({ length: DEBUG_WATCHPOINT_LIMITS.watchpoints + 1 }, (_, i) =>
    spec(`w${i}`, variable(i % 256)),
  );
  assert.throws(
    () => plan.configure({ revision: 2, watchpoints: tooMany }, watch()),
    DebugWatchpointError,
  );
  assert.equal(plan.revision, 1);
});

test("the baseline snapshot must be complete byte/boolean state before anything is admitted", () => {
  const plan = makePlan();
  const malformed: unknown[] = [
    {},
    { flags: [] },
    { vars: [0] },
    { vars: "nope", flags: [] },
    { vars: [300], flags: [] },
    { vars: [-1], flags: [] },
    { vars: [1.5], flags: [] },
    { vars: [Number.NaN], flags: [] },
    { vars: ["5"], flags: [] },
    { vars: [0], flags: [1] },
    { vars: [0], flags: ["true"] },
    Object.defineProperty({}, "vars", { get: () => [0], enumerable: true }),
  ];
  for (const snapshot of malformed) {
    assert.throws(
      () =>
        plan.configure(
          { revision: 1, watchpoints: [spec("w", variable(0))] },
          snapshot as DebugSnapshot,
        ),
      DebugWatchpointError,
      JSON.stringify(snapshot),
    );
    assert.equal(plan.revision, 0);
  }
  // A watched slot outside the array is absent, never silently zero.
  const short = snap({ vars: [1, 2, 3], flags: [true] });
  assert.throws(
    () => plan.configure({ revision: 1, watchpoints: [spec("w", variable(50))] }, short),
    DebugWatchpointError,
  );
  plan.configure({ revision: 1, watchpoints: [spec("w", variable(0))] }, short);
  assert.equal(plan.status()[0]!.baseline, 1);
  // The same rule guards every observation, atomically.
  assert.throws(
    () => plan.observe(snap({ vars: [999], flags: [false] }), at(1, phase("clock"))),
    DebugWatchpointError,
  );
  assert.throws(
    () => plan.observe(snap({ vars: [], flags: [false] }), at(1, phase("clock"))),
    DebugWatchpointError,
    "a watched slot absent from the observation is an error, not a zero",
  );
  const ok = plan.observe(snap({ vars: [5], flags: [false] }), at(1, phase("clock")));
  assert.deepEqual(
    ok.changes.map((change) => [change.old, change.new]),
    [[1, 5]],
  );
});

test("configuration revisions grow monotonically and stale sequences are rejected", () => {
  const plan = makePlan();
  plan.configure({ revision: 4, watchpoints: [spec("w", variable(50))] }, watch());
  for (const revision of [4, 3, 0, -2, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => plan.configure({ revision, watchpoints: [] }, watch()),
      DebugWatchpointError,
      String(revision),
    );
  }
  assert.equal(plan.revision, 4);
  for (const sequence of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => plan.observe(watch(), at(sequence, phase("clock"))), DebugWatchpointError);
  }
  plan.observe(watch({ 50: 1 }), at(5, phase("clock")));
  assert.throws(
    () => plan.observe(watch({ 50: 2 }), at(4, phase("clock"))),
    DebugWatchpointError,
    "an out-of-order occurrence cannot be deduplicated",
  );
  const repeat = plan.observe(watch({ 50: 3 }), at(5, phase("input")));
  assert.equal(repeat.repeat, true, "an exact sequence duplicate is idempotent");
  assert.equal(repeat.changes.length, 0);
  assert.equal(plan.status()[0]!.changes, 1, "the duplicate did not recount");
  assert.equal(plan.status()[0]!.baseline, 1, "the duplicate did not advance the baseline");
});

test("a malformed observation changes nothing: the same sequence is still admissible", () => {
  const plan = makePlan();
  plan.configure({ revision: 1, watchpoints: [spec("w", variable(50))] }, watch());
  const bad = snap();
  (bad.vars as number[])[50] = 400;
  assert.throws(() => plan.observe(bad, at(2, action(0))), DebugWatchpointError);
  const retried = plan.observe(watch({ 50: 8 }), at(2, action(0)));
  assert.equal(retried.repeat, false);
  assert.deepEqual(
    retried.changes.map((change) => [change.old, change.new]),
    [[0, 8]],
  );
});

test("new watches seed at the admitted snapshot; unchanged watches never reseed", () => {
  const plan = makePlan();
  plan.configure(
    {
      revision: 1,
      watchpoints: [spec("w", variable(50)), spec("off", variable(70), { enabled: false })],
    },
    watch(),
  );
  // Seeded at 0; the operation changed it to 7, reported against the seed.
  const first = plan.observe(watch({ 50: 7, 70: 9 }), at(1, action(0)));
  assert.deepEqual(
    first.changes.map((change) => [change.id, change.old, change.new]),
    [["w", 0, 7]],
    "a disabled watch compares nothing",
  );
  // Adding a watch seeds it from this admitted snapshot (v60 = 3), while the
  // unchanged watch keeps its baseline 7 even though the snapshot says 50.
  // The disabled watch reseeds to 9 only because its spec changed.
  plan.configure(
    {
      revision: 2,
      watchpoints: [spec("w", variable(50)), spec("w2", variable(60)), spec("off", variable(70))],
    },
    watch({ 50: 50, 60: 3, 70: 9 }),
  );
  assert.equal(plan.status()[0]!.baseline, 7, "unchanged spec kept its observed baseline");
  assert.equal(plan.status()[1]!.baseline, 3, "new watch seeded at the admitted snapshot");
  const quiet = plan.observe(watch({ 50: 50, 60: 3, 70: 9 }), at(2, phase("clock")));
  assert.deepEqual(
    quiet.changes.map((change) => [change.id, change.old, change.new]),
    [["w", 7, 50]],
    "the unchanged watch reports against its true baseline instead of swallowing the change",
  );
  const later = plan.observe(watch({ 50: 50, 60: 4, 70: 2 }), at(3, phase("cycle-tail")));
  assert.deepEqual(
    later.changes.map((change) => [change.id, change.old, change.new]),
    [
      ["w2", 3, 4],
      ["off", 9, 2],
    ],
  );
});

test("every supplied phase cause kind is accepted; causes are validated, never inferred", () => {
  const plan = makePlan();
  plan.configure({ revision: 1, watchpoints: [spec("w", variable(50))] }, watch());
  const kinds: DebugWatchCause["kind"][] = [
    "action",
    "predicate",
    "clock",
    "input",
    "host-answer",
    "motion",
    "cycle-tail",
    "room",
    "reset",
  ];
  kinds.forEach((kind, i) => {
    const cause: DebugWatchCause =
      kind === "action" || kind === "predicate"
        ? { kind, location: { logic: 2, pc: i }, invocationId: 9 }
        : kind === "room"
          ? { kind, location: { logic: 0, pc: i } }
          : { kind };
    const outcome = plan.observe(watch({ 50: i + 1 }), at(i + 1, cause));
    assert.equal(outcome.changes.length, 1, kind);
    assert.equal(outcome.cause?.kind, kind);
  });
  const badCauses: unknown[] = [
    null,
    5,
    {},
    { kind: "bogus" },
    { kind: "action" },
    { kind: "predicate", location: { logic: 0 } },
    { kind: "action", location: { logic: 256, pc: 0 } },
    { kind: "action", location: { logic: 0, pc: -1 } },
    { kind: "action", location: { logic: 0, pc: 1.5 } },
    { kind: "clock", location: 5 },
    { kind: "clock", location: { logic: 0, pc: 0 }, invocationId: -1 },
    { kind: "reset", invocationId: 1.5 },
  ];
  for (const cause of badCauses) {
    assert.throws(
      () => plan.observe(watch(), { sequence: 100, cause } as never),
      DebugWatchpointError,
      JSON.stringify(cause),
    );
  }
});

test("two watches on one slot keep distinct filters and advance together", () => {
  const plan = makePlan();
  plan.configure(
    {
      revision: 1,
      watchpoints: [
        spec("all", variable(50)),
        spec("big", variable(50), { condition: "new > 10" }),
      ],
    },
    watch(),
  );
  const small = plan.observe(watch({ 50: 5 }), at(1, action(0)));
  assert.deepEqual(
    small.changes.map((change) => change.id),
    ["all"],
  );
  const grown = plan.observe(watch({ 50: 20 }), at(2, action(2)));
  assert.deepEqual(
    grown.changes.map((change) => [change.id, change.old, change.new]),
    [
      ["all", 5, 20],
      ["big", 5, 20],
    ],
  );
  const shrunk = plan.observe(watch({ 50: 8 }), at(3, action(4)));
  assert.deepEqual(
    shrunk.changes.map((change) => change.id),
    ["all"],
    "the filtered watch saw the change and tracked it",
  );
  const again = plan.observe(watch({ 50: 15 }), at(4, action(6)));
  assert.deepEqual(
    again.changes.map((change) => [change.id, change.old, change.new]),
    [
      ["all", 8, 15],
      ["big", 8, 15],
    ],
  );
});

test("caller inputs, causes, snapshots and results stay detached and frozen", () => {
  const plan = makePlan();
  const target = variable(50);
  const inputSpec = spec("w", target, { condition: "v1 == 0" });
  const config = { revision: 1, watchpoints: [inputSpec] };
  const baseline = watch({ 1: 0 });
  plan.configure(config, baseline);
  (inputSpec as { id: string }).id = "hijack";
  (target as { index: number }).index = 99;
  (config.watchpoints as unknown[]).length = 0;
  assert.equal(plan.status().length, 1);
  assert.equal(plan.status()[0]!.id, "w");
  assert.deepEqual(plan.status()[0]!.spec.target, { kind: "variable", index: 50 });

  const state = watch({ 50: 4, 1: 0 });
  const cause = action(0);
  const outcome = plan.observe(state, at(1, cause));
  assert.equal(outcome.changes.length, 1, "the caller edits could not retarget the watch");
  (cause.location as { pc: number }).pc = 77;
  (state.vars as number[])[50] = 200;
  (state.vars as number[])[1] = 9;
  assert.equal(outcome.cause?.location?.pc, 0, "the admitted cause is detached");
  assert.equal(plan.status()[0]!.baseline, 4);
  assert.equal(Object.hasOwn(state, "old"), false, "the caller snapshot is never extended");
  assert.equal(Object.hasOwn(state, "new"), false);
  for (const value of [outcome, outcome.changes, outcome.changes[0], outcome.cause]) {
    assert.ok(Object.isFrozen(value), "results are immutable");
  }
  for (const value of [plan.status(), plan.status()[0], plan.status()[0]!.spec]) {
    assert.ok(Object.isFrozen(value), "status is immutable");
  }
  assert.notEqual(plan.status(), plan.status(), "each status call hands out a fresh copy");
});

test("named bindings are deeply detached: later caller edits cannot retarget this run", () => {
  const planBindings = { lives: { kind: "variable" as const, num: 5 } };
  const plan = createDebugWatchpointPlan({
    build: makeBuild({ lives: { num: 5 } }),
    bindings: planBindings,
  });
  (planBindings.lives as { num: number }).num = 6;
  plan.configure(
    { revision: 1, watchpoints: [spec("w", variable(50), { condition: "lives == 3" })] },
    watch({ 5: 3, 6: 0 }),
  );
  const hit = plan.observe(watch({ 50: 1, 5: 3 }), at(1, action(0)));
  assert.equal(hit.changes.length, 1, "the filter still reads v5, not the mutated v6");
  const missed = plan.observe(watch({ 50: 2, 5: 0, 6: 3 }), at(2, action(2)));
  assert.equal(missed.changes.length, 0);
});

test("a new plan is a new run with a fresh baseline", () => {
  const build = makeBuild();
  const first = createDebugWatchpointPlan({ build });
  first.configure({ revision: 1, watchpoints: [spec("w", variable(50))] }, watch());
  first.observe(watch({ 50: 8 }), at(1, action(0)));
  assert.equal(first.status()[0]!.changes, 1);
  const second = createDebugWatchpointPlan({ build });
  second.configure({ revision: 1, watchpoints: [spec("w", variable(50))] }, watch({ 50: 8 }));
  assert.equal(second.status()[0]!.changes, 0);
  assert.equal(second.status()[0]!.baseline, 8);
  const same = second.observe(watch({ 50: 8 }), at(1, action(0)));
  assert.equal(same.changes.length, 0, "the fresh run seeds its own baseline");
});

test("observations before any configuration still validate and dedup", () => {
  const plan = makePlan();
  const empty = plan.observe(watch(), at(1, phase("reset")));
  assert.equal(empty.repeat, false);
  assert.equal(empty.changes.length, 0);
  assert.throws(() => plan.observe(watch(), at(0, phase("reset"))), DebugWatchpointError);
  const repeat = plan.observe(watch(), at(1, phase("reset")));
  assert.equal(repeat.repeat, true);
});
