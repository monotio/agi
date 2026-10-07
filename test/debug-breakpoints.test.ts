import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import type { GameContainer } from "../src/types.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { captureProjectBuild } from "../src/authoring/projectBuild.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { Engine, type ExecutionBoundary } from "../src/runtime/engine.ts";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import type { DebugSnapshot } from "../src/runtime/debugExpression.ts";
import {
  createDebugBreakpointPlan,
  DebugBreakpointError,
  DEBUG_BREAKPOINT_LIMITS,
  type DebugBoundaryOutcome,
  type DebugBreakpointSpec,
} from "../src/runtime/debugBreakpoints.ts";

const HOST = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

interface Fixture {
  readonly build: ReturnType<typeof captureProjectBuild>;
  readonly container: GameContainer;
  readonly engine: Engine;
}

/**
 * A build whose LOGIC payloads come from the real compiler pipeline plus an
 * engine running the same container. `raw` logics are hand-authored bytes
 * with no source, so the build keeps them bytecode-only.
 */
function fixture(
  sources: readonly string[],
  options: {
    readonly bindings?: Record<string, { readonly num: number }>;
    readonly raw?: Readonly<Record<number, Uint8Array>>;
  } = {},
): Fixture {
  const container = createContainer();
  const dictionary = new Map<string, number>();
  const bindings = options.bindings ?? {};
  sources.forEach((source, num) =>
    container.putResource(
      "logic",
      num,
      compileProjectLogic(source, { profile: DEFAULT_V2_PROFILE, dictionary, bindings }).assembly
        .payload,
    ),
  );
  for (const [num, payload] of Object.entries(options.raw ?? {})) {
    container.putResource("logic", Number(num), payload);
  }
  const build = captureProjectBuild({
    files: Object.fromEntries(container.files),
    profileId: "2.936",
    sources: Object.fromEntries(sources.map((source, num) => [String(num), source])),
    bindings,
  });
  const engine = new Engine(container, HOST, dictionary);
  return { build, container, engine };
}

function snapshotOf(engine: Engine, boundary: ExecutionBoundary): DebugSnapshot {
  return {
    vars: Array.from(engine.vars),
    flags: Array.from(engine.flags, (flag) => flag !== 0),
    strings: engine.strings.slice(),
    objects: [],
    inventory: [],
    room: engine.vars[0]!,
    logic: boundary.logic,
    pc: boundary.pc,
    cycle: 0,
  };
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

function boundary(sequence: number, overrides: Partial<ExecutionBoundary> = {}): ExecutionBoundary {
  const pc = overrides.pc ?? 0;
  const logic = overrides.logic ?? 0;
  return Object.assign(
    {
      sequence,
      logic,
      pc,
      kind: "action" as const,
      opcodePc: pc,
      frames: [{ invocationId: 1, logic, pc, callsite: null }],
    },
    overrides,
  );
}

function spec(
  id: string,
  line: number,
  extra: Partial<DebugBreakpointSpec> = {},
): DebugBreakpointSpec {
  return Object.assign({ id, enabled: true, logic: 0, line, mode: "statement" as const }, extra);
}

function bindingOf(plan: ReturnType<typeof createDebugBreakpointPlan>, id: string) {
  const entry = plan.status().find((status) => status.id === id);
  assert.ok(entry, `breakpoint '${id}' is configured`);
  return entry.binding;
}

test("a statement breakpoint binds to the exact authored line/column and hand-computed PC", () => {
  // assignn(v50, 1) is 0x03 0x32 0x01 at pc 0..2; return is 0x00 at pc 3.
  const { build } = fixture(["assignn(v50, 1);\nreturn;"]);
  const plan = createDebugBreakpointPlan({ build });
  const result = plan.configure({ revision: 1, breakpoints: [spec("a", 1), spec("b", 2)] });
  assert.equal(result.revision, 1);
  const a = result.entries.find((entry) => entry.id === "a")!.binding;
  assert.deepEqual(a.bound ? a : null, {
    bound: true,
    logic: 0,
    line: 1,
    column: 1,
    kind: "action",
    statementId: 0,
    pcs: [0],
    locations: [{ kind: "action", pc: 0, endPc: 3 }],
  });
  const b = result.entries.find((entry) => entry.id === "b")!.binding;
  assert.deepEqual(b.bound ? { pcs: b.pcs, kind: b.kind } : null, {
    pcs: [3],
    kind: "return",
  });
});

test("a line-only breakpoint on an IF binds its opening and stops before the condition list", () => {
  // if: 0xff @0, equaln @1..3, 0xff @4, s16 @5..6, increment(v51) @7, increment(v52) @9, return @11.
  const { engine, build } = fixture(["if (v50 == 1) { increment(v51); } increment(v52); return;"]);
  const plan = createDebugBreakpointPlan({ build });
  plan.configure({ revision: 1, breakpoints: [spec("if-line", 1)] });
  engine.vars[50] = 1;
  const seen: ExecutionBoundary[] = [];
  engine.setExecutionGate((b) => {
    seen.push(b);
    return plan.atBoundary(b, snapshotOf(engine, b)).stops.length > 0;
  });
  engine.tick();
  const stopped = engine.executionStop!;
  assert.equal(stopped.kind, "if");
  assert.equal(stopped.pc, 0);
  assert.equal(seen.length, 1, "the stop is the first boundary, before any predicate");
  assert.equal(engine.vars[51], 0, "the condition body has not run yet");
  engine.resumeExecution();
  engine.tick();
  assert.equal(engine.vars[51], 1);
  assert.equal(engine.vars[52], 1);
  const predicateBoundaries = seen.filter((b) => b.kind === "predicate");
  assert.ok(predicateBoundaries.length > 0, "predicate boundaries were still reported");
});

test("comment, blank, directive and label-only lines stay unbound with explicit reasons", () => {
  const { build } = fixture(['#message 1 "hi"\n// note\n\nloop:\nreturn;'], {
    raw: { 1: buildLogicResource(new Uint8Array([0x00]), []) },
  });
  const plan = createDebugBreakpointPlan({ build });
  plan.configure({
    revision: 1,
    breakpoints: [
      spec("directive", 1),
      spec("comment", 2),
      spec("blank", 3),
      spec("label", 4),
      spec("stmt", 5),
      spec("past-end", 6),
      spec("unknown", 1, { logic: 7 }),
      spec("native", 1, { logic: 1 }),
    ],
  });
  const reason = (id: string) => {
    const binding = bindingOf(plan, id);
    return binding.bound ? "bound" : binding.reason;
  };
  assert.equal(reason("directive"), "non-executable-line");
  assert.equal(reason("comment"), "non-executable-line");
  assert.equal(reason("blank"), "non-executable-line");
  assert.equal(reason("label"), "non-executable-line");
  assert.equal(reason("past-end"), "line-out-of-range");
  assert.equal(reason("unknown"), "unknown-logic");
  assert.equal(reason("native"), "no-source");
  const stmt = bindingOf(plan, "stmt");
  assert.deepEqual(stmt.bound ? stmt.pcs : null, [0]);
});

test("binding-prefix offsets, CRLF and UTF-16 columns resolve to authored positions", () => {
  // The binding prelude (#define lives 5\n) shifts every map offset by 14;
  // authoredStart must be subtracted before line/column math. The emoji in
  // the comment is two UTF-16 units, and \r is a column character.
  const { build } = fixture(["// 😀 prelude shift\r\n  lives = 1;\r\nreturn;"], {
    bindings: { lives: { num: 5 } },
  });
  const plan = createDebugBreakpointPlan({ build });
  plan.configure({
    revision: 1,
    breakpoints: [
      spec("comment", 1),
      spec("assign", 2, { column: 3 }),
      spec("ret", 3, { column: 1 }),
    ],
  });
  assert.equal(bindingOf(plan, "comment").bound, false);
  const assign = bindingOf(plan, "assign");
  assert.deepEqual(
    assign.bound ? { line: assign.line, column: assign.column, pcs: assign.pcs } : null,
    { line: 2, column: 3, pcs: [0] },
  );
  const ret = bindingOf(plan, "ret");
  assert.deepEqual(ret.bound ? { line: ret.line, pcs: ret.pcs } : null, { line: 3, pcs: [3] });
});

test("a column chooses consistently among several statements on one line", () => {
  // increment(v50); spans cols 1-15 (pc 0), increment(v51); cols 17-31 (pc 2),
  // return; cols 33-39 (pc 4).
  const { build } = fixture(["increment(v50); increment(v51); return;"]);
  const plan = createDebugBreakpointPlan({ build });
  plan.configure({
    revision: 1,
    breakpoints: [
      spec("line", 1),
      spec("second", 1, { column: 17 }),
      spec("mid-second", 1, { column: 25 }),
      spec("gap", 1, { column: 16 }),
      spec("ret", 1, { column: 32 }),
      spec("past", 1, { column: 40 }),
    ],
  });
  const pcs = (id: string) => {
    const binding = bindingOf(plan, id);
    return binding.bound ? { pcs: [...binding.pcs], column: binding.column } : binding.reason;
  };
  assert.deepEqual(pcs("line"), { pcs: [0], column: 1 });
  assert.deepEqual(pcs("second"), { pcs: [2], column: 17 });
  assert.deepEqual(pcs("mid-second"), { pcs: [2], column: 17 });
  assert.deepEqual(pcs("gap"), { pcs: [2], column: 17 });
  assert.deepEqual(pcs("ret"), { pcs: [4], column: 33 });
  assert.equal(pcs("past"), "no-statement-at-position");
});

test("predicate mode binds every lowered occurrence and only evaluated ones report", () => {
  // (v50 == 1 && v51 == 1) || f2 lowers to CNF (v50 || f2) && (v51 || f2);
  // the single source f2 is emitted in both OR groups, at pc 5 and pc 12.
  const source = "if ((v50 == 1 && v51 == 1) || f2) { increment(v53); } return;";
  const column = source.indexOf("f2") + 1;
  const run = (v50: number, v51: number) => {
    const { engine, build } = fixture([source]);
    const plan = createDebugBreakpointPlan({ build });
    plan.configure({
      revision: 1,
      breakpoints: [spec("p", 1, { column, mode: "predicate" })],
    });
    const binding = bindingOf(plan, "p");
    assert.deepEqual(binding.bound ? binding.pcs : null, [5, 12]);
    engine.vars[50] = v50;
    engine.vars[51] = v51;
    const reported: ExecutionBoundary[] = [];
    engine.setExecutionGate((b) => {
      reported.push(b);
      return plan.atBoundary(b, snapshotOf(engine, b)).stops.length > 0;
    });
    engine.tick();
    while (engine.executionStop) {
      engine.resumeExecution();
      engine.tick();
    }
    return { reported, status: plan.status()[0]!, vars: engine.vars };
  };
  const skipped = run(1, 1);
  assert.equal(skipped.status.hits, 0, "both f2 occurrences were short-circuit-skipped");
  assert.equal(skipped.vars[53], 1);
  assert.deepEqual(
    skipped.reported.map((b) => b.pc),
    [0, 2, 9, 18, 20],
  );
  const evaluated = run(0, 1);
  assert.equal(evaluated.status.hits, 1, "only the first f2 occurrence was evaluated");
  assert.equal(evaluated.vars[53], 0, "the failed first group skips the body");
  assert.deepEqual(
    evaluated.reported.map((b) => b.pc),
    [0, 2, 5, 20],
  );
});

test("a negated predicate boundary carries the NOT prefix PC of its map entry", () => {
  // if (!f2): 0xff @0, 0xfd NOT @1, isset f2 @2..3; the entry pc is 1.
  const { engine, build } = fixture(["if (!f2) { increment(v50); } return;"]);
  const plan = createDebugBreakpointPlan({ build });
  const column = "if (!f2) { increment(v50); } return;".indexOf("f2") + 1;
  plan.configure({
    revision: 1,
    breakpoints: [spec("neg", 1, { column, mode: "predicate" })],
  });
  const binding = bindingOf(plan, "neg");
  assert.deepEqual(binding.bound ? binding.pcs : null, [1]);
  const reported: ExecutionBoundary[] = [];
  engine.setExecutionGate((b) => {
    reported.push(b);
    return plan.atBoundary(b, snapshotOf(engine, b)).stops.length > 0;
  });
  engine.tick();
  const stopped = engine.executionStop!;
  assert.equal(stopped.kind, "predicate");
  assert.equal(stopped.pc, 1, "boundary pc is the NOT byte, matching the map entry");
  assert.equal(stopped.opcodePc, 2);
});

test("the plan keeps its frozen build identity and newer source cannot retarget it", () => {
  const files = fixture(["return;"]);
  const newer = fixture(["// edited comment\nreturn;"]);
  assert.notEqual(files.build.identity.buildId, newer.build.identity.buildId);
  const plan = createDebugBreakpointPlan({ build: files.build });
  plan.configure({ revision: 1, breakpoints: [spec("a", 1)] });
  const bound = bindingOf(plan, "a");
  assert.deepEqual(bound.bound ? { line: bound.line, pcs: bound.pcs } : null, {
    line: 1,
    pcs: [0],
  });
  assert.equal(plan.identity.buildId, files.build.identity.buildId);
  // On the newer build the same spec is a comment line and binds on line 2.
  const moved = createDebugBreakpointPlan({ build: newer.build });
  moved.configure({ revision: 1, breakpoints: [spec("a", 1), spec("b", 2)] });
  assert.equal(bindingOf(moved, "a").bound, false, "a comment line stays unbound");
  const b = bindingOf(moved, "b");
  assert.deepEqual(b.bound ? { line: b.line, column: b.column, kind: b.kind, pcs: b.pcs } : null, {
    line: 2,
    column: 1,
    kind: "return",
    pcs: [0],
  });
});

test("caller configuration and reported results are detached and frozen", () => {
  const { build } = fixture(["increment(v50); return;"]);
  const plan = createDebugBreakpointPlan({ build });
  const input = { revision: 1, breakpoints: [spec("a", 1, { condition: "v50 == 0" })] };
  const result = plan.configure(input);
  (input.breakpoints[0] as { line: number }).line = 99;
  assert.equal(bindingOf(plan, "a").bound, true, "caller mutation cannot rewrite the plan");
  assert.ok(Object.isFrozen(result.entries));
  const a = bindingOf(plan, "a");
  assert.ok(a.bound);
  assert.ok(Object.isFrozen(a.pcs));
  assert.ok(Object.isFrozen(a.locations));
  const outcome = plan.atBoundary(boundary(1, { pc: 0 }), snap());
  assert.ok(Object.isFrozen(outcome));
  assert.ok(Object.isFrozen(outcome.stops));
  assert.ok(Object.isFrozen(plan.status()));
});

test("conditions must compile to boolean and an invalid replacement is fully rejected", () => {
  const { build } = fixture(["increment(v50); return;"]);
  const plan = createDebugBreakpointPlan({ build });
  plan.configure({ revision: 1, breakpoints: [spec("keep", 1)] });
  assert.throws(
    () =>
      plan.configure({
        revision: 2,
        breakpoints: [
          spec("keep", 1),
          spec("bad-number", 2, { condition: "v50 + 1" }),
          spec("bad-syntax", 2, { condition: "v50 ==" }),
          spec("bad-name", 2, { condition: "nonsense == 1" }),
        ],
      }),
    DebugBreakpointError,
  );
  assert.equal(plan.revision, 1, "the rejected update never published");
  assert.equal(plan.status().length, 1);
  const outcome = plan.atBoundary(boundary(1, { pc: 0 }), snap());
  assert.deepEqual(
    outcome.stops.map((stop) => stop.id),
    ["keep"],
    "the previous configuration still matches",
  );
  assert.equal(plan.status()[0]!.hits, 1);
});

test("encounters count before the condition and hit policies gate deterministically", () => {
  const { build } = fixture(["increment(v50); return;"]);
  const plan = createDebugBreakpointPlan({ build });
  plan.configure({
    revision: 1,
    breakpoints: [
      spec("false-cond", 1, { condition: "v50 == 99" }),
      spec("every2", 1, { hit: { kind: "every", count: 2 } }),
      spec("equal2", 1, { hit: { kind: "equal", count: 2 } }),
      spec("atleast2", 1, { hit: { kind: "atLeast", count: 2 } }),
    ],
  });
  const stopsAt = (sequence: number) =>
    plan.atBoundary(boundary(sequence, { pc: 0 }), snap()).stops.map((stop) => stop.id);
  assert.deepEqual(stopsAt(1), []);
  assert.deepEqual(stopsAt(2), ["every2", "equal2", "atleast2"]);
  assert.deepEqual(stopsAt(3), ["atleast2"]);
  assert.deepEqual(stopsAt(4), ["every2", "atleast2"]);
  const byId = Object.fromEntries(plan.status().map((status) => [status.id, status.hits]));
  assert.deepEqual(byId, { "false-cond": 4, every2: 4, equal2: 4, atleast2: 4 });
});

test("hit counts survive identical republication and reset on spec change", () => {
  const { build } = fixture(["increment(v50); return;"]);
  const plan = createDebugBreakpointPlan({ build });
  const original = spec("a", 1);
  plan.configure({ revision: 1, breakpoints: [original] });
  plan.atBoundary(boundary(1, { pc: 0 }), snap());
  plan.configure({ revision: 2, breakpoints: [{ ...original }] });
  assert.equal(plan.status()[0]!.hits, 1, "an identical spec keeps its run count");
  plan.configure({ revision: 3, breakpoints: [{ ...original, enabled: false }] });
  assert.equal(plan.status()[0]!.hits, 0, "an explicit edit resets the count");
  plan.configure({ revision: 4, breakpoints: [{ ...original }] });
  assert.equal(plan.status()[0]!.hits, 0);
});

test("exact duplicate occurrences never recount; a new sequence at the same PC hits again", () => {
  const { build } = fixture(["increment(v50); return;"]);
  const plan = createDebugBreakpointPlan({ build });
  plan.configure({
    revision: 1,
    breakpoints: [
      spec("a", 1),
      spec("l", 1, { log: { segments: [{ type: "literal", text: "x" }] } }),
    ],
  });
  const first = plan.atBoundary(boundary(7, { pc: 0 }), snap());
  assert.equal(first.repeat, false);
  const again = plan.atBoundary(boundary(7, { pc: 0 }), snap());
  assert.equal(again.repeat, true);
  assert.equal(again.stops.length, 0);
  assert.equal(again.logs.length, 0, "a repeated occurrence does not emit twice");
  assert.equal(plan.status()[0]!.hits, 1);
  const loop = plan.atBoundary(boundary(8, { pc: 0 }), snap());
  assert.equal(loop.repeat, false);
  assert.equal(loop.stops.length, 1);
  assert.equal(plan.status()[0]!.hits, 2);
  assert.equal(plan.status()[1]!.hits, 2);
});

test("invalid or stale boundary sequences are rejected instead of corrupting counts", () => {
  const { build } = fixture(["increment(v50); return;"]);
  const plan = createDebugBreakpointPlan({ build });
  plan.configure({ revision: 1, breakpoints: [spec("a", 1)] });
  for (const sequence of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => plan.atBoundary(boundary(sequence), snap()), DebugBreakpointError);
  }
  plan.atBoundary(boundary(3, { pc: 0 }), snap());
  plan.atBoundary(boundary(5, { pc: 0 }), snap());
  assert.throws(
    () => plan.atBoundary(boundary(4, { pc: 0 }), snap()),
    DebugBreakpointError,
    "an out-of-order sequence cannot be deduplicated",
  );
  assert.equal(plan.status()[0]!.hits, 2);
  assert.throws(() => plan.atBoundary(null as never, snap()), DebugBreakpointError);
});

test("two breakpoints stop together while a logpoint emits without stopping", () => {
  const { engine, build } = fixture(["increment(v50); return;"]);
  const plan = createDebugBreakpointPlan({ build });
  plan.configure({
    revision: 1,
    breakpoints: [
      spec("first", 1),
      spec("second", 1),
      spec("log", 1, {
        log: {
          segments: [
            { type: "literal", text: "v50=" },
            { type: "expression", source: "v50" },
          ],
        },
      }),
    ],
  });
  const outcomes: DebugBoundaryOutcome[] = [];
  engine.setExecutionGate((b) => {
    const outcome = plan.atBoundary(b, snapshotOf(engine, b));
    outcomes.push(outcome);
    return outcome.stops.length > 0;
  });
  engine.tick();
  assert.equal(engine.executionStop!.pc, 0);
  assert.deepEqual(
    outcomes[0]!.stops.map((stop) => stop.id),
    ["first", "second"],
  );
  assert.deepEqual(outcomes[0]!.logs, [
    { id: "log", hitCount: 1, text: "v50=0", truncated: false },
  ]);
  // The return boundary at pc 2 matches nothing; the logged "v50=0" shows the
  // log evaluated before the increment ran.
  engine.resumeExecution();
  engine.tick();
  assert.equal(outcomes[1]!.stops.length, 0);
  assert.equal(outcomes[1]!.logs.length, 0);
  assert.equal(engine.vars[50], 1);
});

test("a failing condition reports one error stop and disables the entry until corrected", () => {
  const { build } = fixture(["increment(v50); return;"]);
  const plan = createDebugBreakpointPlan({ build });
  const broken = spec("cond", 1, { condition: "10 / v50 == 1" });
  const valid = spec("other", 1, { column: 17 }); // return;
  plan.configure({ revision: 1, breakpoints: [broken, valid] });
  const state = snap();
  const fault = plan.atBoundary(boundary(1, { pc: 0 }), state);
  assert.equal(fault.stops.length, 1);
  assert.equal(fault.stops[0]!.reason, "error");
  assert.equal(fault.stops[0]!.id, "cond");
  assert.equal(fault.stops[0]!.hitCount, 1);
  assert.match(fault.stops[0]!.error ?? "", /division by zero/);
  const after = plan.atBoundary(boundary(2, { pc: 0 }), state);
  assert.equal(after.stops.length, 0, "the faulted breakpoint is disabled for this run");
  const status = plan.status().find((entry) => entry.id === "cond")!;
  assert.equal(status.hits, 1);
  assert.match(status.fault ?? "", /division by zero/);
  const other = plan.atBoundary(boundary(3, { pc: 2, kind: "return" }), state);
  assert.deepEqual(
    other.stops.map((stop) => stop.id),
    ["other"],
    "unrelated breakpoints keep reporting",
  );
  // An identical republication preserves the fault; an explicit correction clears it.
  plan.configure({ revision: 2, breakpoints: [{ ...broken }, { ...valid }] });
  assert.match(plan.status().find((entry) => entry.id === "cond")!.fault ?? "", /division/);
  plan.configure({
    revision: 3,
    breakpoints: [{ ...broken, condition: "v50 == 0" }, { ...valid }],
  });
  assert.equal(plan.status().find((entry) => entry.id === "cond")!.fault, null);
  const fixed = plan.atBoundary(boundary(4, { pc: 0 }), state);
  assert.deepEqual(
    fixed.stops.map((stop) => [stop.id, stop.reason]),
    [["cond", "hit"]],
    "the corrected expression is a real conditional breakpoint again",
  );
});

test("a failing log expression follows the same error-stop and disable rule", () => {
  const { build } = fixture(["increment(v50); return;"]);
  const plan = createDebugBreakpointPlan({ build });
  plan.configure({
    revision: 1,
    breakpoints: [
      spec("log", 1, { log: { segments: [{ type: "expression", source: "1 / v0" }] } }),
      spec("hit", 1),
    ],
  });
  const outcome = plan.atBoundary(boundary(1, { pc: 0 }), snap());
  assert.deepEqual(
    outcome.stops.map((stop) => [stop.id, stop.reason]),
    [
      ["log", "error"],
      ["hit", "hit"],
    ],
  );
  assert.equal(outcome.logs.length, 0);
  const next = plan.atBoundary(boundary(2, { pc: 0 }), snap());
  assert.deepEqual(
    next.stops.map((stop) => stop.id),
    ["hit"],
  );
});

test("hostile configuration sizes are rejected and log output is bounded", () => {
  const { build } = fixture(["return;"]);
  const plan = createDebugBreakpointPlan({ build });
  const tooMany = Array.from({ length: DEBUG_BREAKPOINT_LIMITS.breakpoints + 1 }, (_, i) =>
    spec(`b${i}`, 1),
  );
  assert.throws(() => plan.configure({ revision: 1, breakpoints: tooMany }), DebugBreakpointError);
  const bad: [string, Partial<DebugBreakpointSpec>][] = [
    ["id", { id: "x".repeat(DEBUG_BREAKPOINT_LIMITS.idLength + 1) }],
    ["hit", { hit: { kind: "every", count: 0 } }],
    ["hit", { hit: { kind: "equal", count: DEBUG_BREAKPOINT_LIMITS.hitCount + 1 } }],
    ["hit", { hit: { kind: "bogus" as never, count: 1 } }],
    ["log", { log: { segments: [] } }],
    [
      "log",
      {
        log: {
          segments: Array.from({ length: DEBUG_BREAKPOINT_LIMITS.logSegments + 1 }, () => ({
            type: "literal",
            text: "x",
          })),
        },
      },
    ],
    [
      "log",
      {
        log: {
          segments: [{ type: "literal", text: "x".repeat(DEBUG_BREAKPOINT_LIMITS.logLiteral + 1) }],
        },
      },
    ],
    ["log", { log: { segments: [{ type: "template" as never, text: "x" }] } }],
    ["line", { line: 0 }],
    ["line", { line: 1.5 }],
    ["column", { column: 0 }],
    ["logic", { logic: 256 }],
    ["mode", { mode: "instruction" as never }],
    ["enabled", { enabled: 1 as never }],
  ];
  for (const [field, override] of bad) {
    assert.throws(
      () => plan.configure({ revision: 2, breakpoints: [{ ...spec("x", 1), ...override }] }),
      DebugBreakpointError,
      field,
    );
    assert.equal(plan.revision, 0, `${field}: nothing published`);
  }
  assert.throws(
    () => plan.configure({ revision: 1, breakpoints: {} as never }),
    DebugBreakpointError,
  );
});

test("log output is truncated to its bound and reports the truncation", () => {
  const { build } = fixture(["return;"]);
  const plan = createDebugBreakpointPlan({ build });
  plan.configure({
    revision: 1,
    breakpoints: [
      spec("log", 1, {
        log: {
          segments: [
            { type: "expression", source: "s0" },
            { type: "literal", text: "|tail" },
          ],
        },
      }),
    ],
  });
  const outcome = plan.atBoundary(
    boundary(1, { pc: 0, kind: "return" }),
    snap({ strings: ["y".repeat(3000)] }),
  );
  assert.equal(outcome.logs.length, 1);
  assert.equal(outcome.logs[0]!.text.length, DEBUG_BREAKPOINT_LIMITS.logOutput);
  assert.equal(outcome.logs[0]!.truncated, true);
});

test("configuration revisions must grow monotonically", () => {
  const { build } = fixture(["return;"]);
  const plan = createDebugBreakpointPlan({ build });
  plan.configure({ revision: 5, breakpoints: [] });
  assert.equal(plan.revision, 5);
  for (const revision of [5, 4, 0, -2, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => plan.configure({ revision, breakpoints: [] }),
      DebugBreakpointError,
      String(revision),
    );
  }
  assert.equal(plan.revision, 5);
  plan.configure({ revision: 6, breakpoints: [] });
  assert.equal(plan.revision, 6);
});

test("a new plan for a new run resets counts while the same plan never does", () => {
  const { build } = fixture(["increment(v50); return;"]);
  const first = createDebugBreakpointPlan({ build });
  first.configure({ revision: 1, breakpoints: [spec("a", 1)] });
  first.atBoundary(boundary(1, { pc: 0 }), snap());
  first.atBoundary(boundary(2, { pc: 0 }), snap());
  assert.equal(first.status()[0]!.hits, 2);
  const second = createDebugBreakpointPlan({ build });
  second.configure({ revision: 1, breakpoints: [spec("a", 1)] });
  assert.equal(second.status()[0]!.hits, 0, "a fresh plan is a fresh run");
});

test("disabled breakpoints and bytecode-only logics never match or count", () => {
  // The raw container's LOGIC 0 is hand-authored bytecode
  // (increment(v50); return;) with no verified source at all.
  const { build } = fixture(["return;"]);
  const raw = createContainer();
  raw.putResource("logic", 0, buildLogicResource(new Uint8Array([0x01, 50, 0x00]), []));
  const rawBuild = captureProjectBuild({
    files: Object.fromEntries(raw.files),
    profileId: "2.936",
    sources: {},
    bindings: {},
  });
  const rawPlan = createDebugBreakpointPlan({ build: rawBuild });
  rawPlan.configure({ revision: 1, breakpoints: [spec("native", 1)] });
  const native = bindingOf(rawPlan, "native");
  assert.equal(native.bound ? "bound" : native.reason, "no-source");

  const plan = createDebugBreakpointPlan({ build });
  plan.configure({
    revision: 1,
    breakpoints: [
      spec("off", 1, { enabled: false }),
      spec("kind-mismatch", 1), // bound to the return at pc 0
    ],
  });
  const wrong = plan.atBoundary(boundary(1, { pc: 0, kind: "predicate" }), snap());
  assert.equal(wrong.stops.length, 0, "a mismatched boundary kind never satisfies a binding");
  const hit = plan.atBoundary(boundary(2, { pc: 0, kind: "return" }), snap());
  assert.deepEqual(
    hit.stops.map((stop) => stop.id),
    ["kind-mismatch"],
  );
  assert.deepEqual(
    plan.status().map((status) => status.hits),
    [0, 1],
    "the disabled entry never counted",
  );

  // The bytecode-only engine still reports real boundaries; nothing stops.
  const rawEngine = new Engine(raw, HOST, new Map());
  const reported: ExecutionBoundary[] = [];
  rawEngine.setExecutionGate((b) => {
    reported.push(b);
    return rawPlan.atBoundary(b, snapshotOf(rawEngine, b)).stops.length > 0;
  });
  rawEngine.tick();
  assert.equal(rawEngine.executionStop, null);
  assert.equal(rawEngine.vars[50], 1, "the hand-authored increment ran");
  assert.deepEqual(
    reported.map((b) => [b.pc, b.kind]),
    [
      [0, "action"],
      [2, "return"],
    ],
  );
});

test("a real engine loop reports every occurrence and hit policies decide stops", () => {
  // again: increment(v50);   pc 0..1
  // if (v50 < 4) { goto again; }   pc 2..11
  // return;   pc 12
  const { engine, build } = fixture([
    "again: increment(v50); if (v50 < 4) { goto again; } return;",
  ]);
  const plan = createDebugBreakpointPlan({ build });
  plan.configure({
    revision: 1,
    breakpoints: [spec("counter", 1, { column: 8, hit: { kind: "every", count: 2 } })],
  });
  const binding = bindingOf(plan, "counter");
  assert.deepEqual(binding.bound ? binding.pcs : null, [0]);
  const stops: number[] = [];
  engine.setExecutionGate((b) => {
    const outcome = plan.atBoundary(b, snapshotOf(engine, b));
    if (outcome.stops.length > 0) stops.push(b.sequence);
    return outcome.stops.length > 0;
  });
  for (let guard = 0; guard < 40 && (engine.vars[50] ?? 0) < 4; guard++) {
    engine.tick();
    while (engine.executionStop) {
      engine.resumeExecution();
      engine.tick();
    }
  }
  assert.equal(engine.vars[50], 4);
  assert.equal(plan.status()[0]!.hits, 4);
  assert.equal(stops.length, 2);
  assert.notEqual(stops[0], stops[1], "each loop occurrence is a fresh sequence");
});

test("the generated else-jump and skipped predicates never satisfy a source breakpoint", () => {
  // if (v50 == 1) { increment(v51); } else { increment(v52); } return;
  // if @0, pred @1, incr(v51) @7, generated goto @9, incr(v52) @12, return @14.
  const { engine, build } = fixture([
    "if (v50 == 1) { increment(v51); } else { increment(v52); } return;",
  ]);
  const plan = createDebugBreakpointPlan({ build });
  plan.configure({
    revision: 1,
    breakpoints: [
      spec("then", 1, { column: 17 }), // increment(v51)
      spec("else", 1, { column: 42 }), // increment(v52)
    ],
  });
  const thenBinding = bindingOf(plan, "then");
  const elseBinding = bindingOf(plan, "else");
  assert.deepEqual(thenBinding.bound ? thenBinding.pcs : null, [7]);
  assert.deepEqual(elseBinding.bound ? elseBinding.pcs : null, [12]);
  engine.vars[50] = 1; // take the then path so the generated else-jump runs
  const reported: ExecutionBoundary[] = [];
  const stops: { sequence: number; ids: string[] }[] = [];
  engine.setExecutionGate((b) => {
    reported.push(b);
    const outcome = plan.atBoundary(b, snapshotOf(engine, b));
    if (outcome.stops.length > 0) {
      stops.push({ sequence: b.sequence, ids: outcome.stops.map((stop) => stop.id) });
    }
    return outcome.stops.length > 0;
  });
  engine.tick();
  while (engine.executionStop) {
    engine.resumeExecution();
    engine.tick();
  }
  // Boundaries: if@0, pred@1, incr(v51)@7 → "then" stops, generated goto@9
  // (kind "goto" — must not stop), return@14.
  assert.deepEqual(
    reported.map((b) => [b.pc, b.kind]),
    [
      [0, "if"],
      [1, "predicate"],
      [7, "action"],
      [9, "goto"],
      [14, "return"],
    ],
  );
  assert.deepEqual(stops, [{ sequence: reported[2]!.sequence, ids: ["then"] }]);
  assert.equal(engine.vars[51], 1);
  assert.equal(engine.vars[52], 0);
});

test("named expression bindings resolve through the run's binding table", () => {
  const { build } = fixture(["return;"], { bindings: { lives: { num: 5 } } });
  const plan = createDebugBreakpointPlan({
    build,
    bindings: { lives: { kind: "variable", num: 5 } },
  });
  plan.configure({
    revision: 1,
    breakpoints: [
      spec("a", 1, { condition: "lives == 3" }),
      spec("b", 1, {
        log: { segments: [{ type: "expression", source: "lives + 1" }] },
      }),
    ],
  });
  const outcome = plan.atBoundary(
    boundary(1, { pc: 0, kind: "return" }),
    snap({ vars: [0, 0, 0, 0, 0, 3] }),
  );
  assert.deepEqual(
    outcome.stops.map((stop) => stop.id),
    ["a"],
  );
  assert.equal(outcome.logs[0]!.text, "4");
});

test("assembler output for the test sources stays hand-verifiable", () => {
  const check = (source: string) =>
    assembleLogic(source, { dictionary: new Map(), sourceMap: true });
  assert.deepEqual([...check("increment(v50); return;").code], [0x01, 0x32, 0x00]);
});
