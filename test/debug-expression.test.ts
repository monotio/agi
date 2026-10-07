import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileDebugExpression,
  DebugExpressionError,
  type DebugBindings,
  type DebugExpressionOptions,
  type DebugObjectState,
  type DebugSnapshot,
  type DebugValue,
} from "../src/runtime/debugExpression.ts";

function snap(overrides: Partial<DebugSnapshot> = {}): DebugSnapshot {
  return {
    vars: [10, 0, 7, 255],
    flags: [true, false, true],
    strings: ["hello", "world"],
    objects: [
      { x: 10, y: 20, view: 1, loop: 0, cel: 2, direction: 3, priority: 8, active: true },
      { x: 5, y: 6, view: 2, loop: 1, cel: 0, direction: 7, priority: 4, active: false },
    ],
    inventory: [{ room: 12 }, { room: 0 }],
    room: 5,
    logic: 7,
    pc: 123,
    cycle: 9,
    ...overrides,
  };
}

function run(
  source: string,
  snapshot: DebugSnapshot = snap(),
  bindings?: DebugBindings,
  options?: DebugExpressionOptions,
): DebugValue {
  const compiled = compileDebugExpression(source, bindings, options);
  return compiled.evaluate(snapshot);
}

test("arithmetic obeys precedence, associativity and truncating division", () => {
  assert.equal(run("1 + 2 * 3"), 7);
  assert.equal(run("(1 + 2) * 3"), 9);
  assert.equal(run("10 - 2 - 3"), 5);
  assert.equal(run("2 * 3 % 4"), 2);
  assert.equal(run("20 / 3"), 6);
  assert.equal(run("-20 / 3"), -6, "division truncates toward zero");
  assert.equal(run("20 / -3"), -6);
  assert.equal(run("-7 % 3"), -1);
  assert.equal(run("7 % -3"), 1);
  assert.equal(run("--5"), 5);
  assert.equal(run("- - 5"), 5);
});

test("comparison, equality and logical operators nest by precedence", () => {
  assert.equal(run("1 + 2 < 4"), true, "arithmetic binds tighter than comparison");
  assert.equal(run("v0 == 10"), true);
  assert.equal(run("(v0 == 10) == f0"), true, "equality compares equal types");
  assert.equal(run("!f0 == f1"), true, "unary binds tighter than equality");
  assert.equal(run("f0 || f0 && f1"), true, "&& binds tighter than ||");
  assert.equal(run("(f0 || f0) && f1"), false);
  assert.equal(run("v1 == 0 && f2"), true);
  assert.equal(run("!f1"), true);
});

test("string and boolean literals support escapes and exact characters", () => {
  assert.equal(run('"hi"'), "hi");
  assert.equal(run('"a\\nb"'), "a\nb");
  assert.equal(run('"tab\\there"'), "tab\there");
  assert.equal(run('"say \\"hi\\""'), 'say "hi"');
  assert.equal(run('"back\\\\slash"'), "back\\slash");
  assert.equal(run("true"), true);
  assert.equal(run("false"), false);
  assert.equal(run('s0 == "hello"'), true);
  assert.equal(run('s1 != "hello"'), true);
  assert.throws(() => compileDebugExpression('"unterminated'), DebugExpressionError);
  assert.throws(() => compileDebugExpression('"bad \\x escape"'), DebugExpressionError);
  assert.throws(() => compileDebugExpression('"raw\nnewline"'), DebugExpressionError);
});

test("named slots read vars, flags, strings and interpreter scalars", () => {
  assert.equal(run("v0"), 10);
  assert.equal(run("v3"), 255);
  assert.equal(run("f0"), true);
  assert.equal(run("f1"), false);
  assert.equal(run("s1"), "world");
  assert.equal(run("room + logic + pc + cycle"), 5 + 7 + 123 + 9);
  assert.throws(() => run("v4"), DebugExpressionError, "var out of range");
  assert.throws(() => run("f3"), DebugExpressionError, "flag out of range");
  assert.throws(() => run("s2"), DebugExpressionError, "string out of range");
});

test("bindings whitelist named records onto vars, flags and strings", () => {
  const bindings: DebugBindings = {
    lives: { kind: "variable", num: 3 },
    hasKey: { kind: "flag", num: 1 },
    title: { kind: "string", num: 1 },
  };
  assert.equal(run("lives", snap(), bindings), 255);
  assert.equal(run("lives + 1", snap(), bindings), 256, "no implicit byte wrap");
  assert.equal(run("!hasKey", snap(), bindings), true);
  assert.equal(run('title == "world"', snap(), bindings), true);
  assert.throws(() => compileDebugExpression("score", bindings), DebugExpressionError);
  assert.throws(() => compileDebugExpression("toString", bindings), DebugExpressionError);
  assert.throws(() => compileDebugExpression("constructor", bindings), DebugExpressionError);
});

test("invalid binding records are rejected at compile time", () => {
  assert.throws(
    () => compileDebugExpression("1", { bad: { kind: "bogus", num: 0 } as never }),
    DebugExpressionError,
  );
  assert.throws(
    () => compileDebugExpression("1", { bad: { kind: "variable", num: -1 } }),
    DebugExpressionError,
  );
  assert.throws(
    () => compileDebugExpression("1", { bad: { kind: "variable", num: 1.5 } }),
    DebugExpressionError,
  );
  assert.throws(() => compileDebugExpression("1", { bad: null as never }), DebugExpressionError);
});

test("object and inventory access is whitelisted to declared fields", () => {
  assert.equal(run("object[0].x"), 10);
  assert.equal(run("object[0].y"), 20);
  assert.equal(run("object[0].priority"), 8);
  assert.equal(run("object[0].active"), true);
  assert.equal(run("object[1].active"), false);
  assert.equal(run("inventory[0].room"), 12);
  assert.equal(run("inventory[1].room"), 0);
  assert.equal(run("object[v0 % 2].x"), 10, "index may be an integer expression");
  assert.equal(run("object[object[1].cel].y"), 20, "nested index expressions");
  assert.equal(run("inventory[object[1].cel].room"), 12);
});

test("unknown members, bare aggregates and arbitrary access are rejected", () => {
  for (const source of [
    "object[0].speed",
    "object[0].toString",
    "object[0].constructor",
    "object[0]",
    "object",
    "object.length",
    "inventory[0]",
    "inventory[0].x",
    "v1.x",
    "s0.length",
    "v1[0]",
    "v1()",
    "abs(v1)",
    "globalThis",
    "__proto__",
  ]) {
    assert.throws(() => compileDebugExpression(source), DebugExpressionError, source);
  }
});

test("index expressions reject wrong types and out-of-range values", () => {
  assert.throws(() => compileDebugExpression("object[f0].x"), DebugExpressionError);
  assert.throws(() => compileDebugExpression("object[s0].x"), DebugExpressionError);
  assert.throws(() => compileDebugExpression('inventory["a"].room'), DebugExpressionError);
  assert.throws(() => run("object[2].x"), DebugExpressionError, "past end");
  assert.throws(() => run("object[-1].x"), DebugExpressionError, "negative");
  assert.throws(() => run("inventory[5].room"), DebugExpressionError);
  assert.throws(
    () => run("object[v0].x", snap({ vars: [1.5, 0, 0, 0] })),
    DebugExpressionError,
    "non-integer index source",
  );
});

test("short-circuit operators never evaluate the guarded side", () => {
  assert.equal(run("f1 && object[9].x > 0"), false, "false && skips bad access");
  assert.equal(run("f0 || object[9].x > 0"), true, "true || skips bad access");
  assert.equal(run("v1 == 0 || 10 / v1 > 2"), true, "|| guards the division");
  assert.equal(run("v1 != 0 && 10 / v1 > 2"), false, "&& guards the division");
  const nonzero = snap({ vars: [10, 2, 7, 255] });
  assert.equal(run("v1 != 0 && 10 / v1 > 2", nonzero), true, "guard passes when safe");
});

test("integer overflow, zero divisors and unsafe literals are errors", () => {
  assert.throws(() => run("9007199254740991 + 1"), DebugExpressionError, "add overflow");
  assert.throws(() => run("9007199254740991 * 2"), DebugExpressionError, "mul overflow");
  assert.throws(() => run("-9007199254740991 - 2"), DebugExpressionError, "sub overflow");
  assert.throws(() => run("1 / 0"), DebugExpressionError, "division by zero");
  assert.throws(() => run("1 % 0"), DebugExpressionError, "modulo by zero");
  assert.throws(() => run("v1 / 0"), DebugExpressionError);
  assert.throws(
    () => compileDebugExpression("9007199254740992"),
    DebugExpressionError,
    "unsafe integer literal",
  );
  assert.equal(run("-1 / 2"), 0, "truncated negative fractions normalize -0 to 0");
});

test("assignments, calls, increments and coercions are rejected", () => {
  for (const source of [
    "v1 = 2",
    "v1 += 1",
    "v1 ++",
    "v1 --",
    "++ v1",
    "v1(2)",
    "f0 ? 1 : 2",
    "v1 & f0",
    "v1 | f0",
    "~v1",
    "v1 ^ v2",
    "1 . x",
  ]) {
    assert.throws(() => compileDebugExpression(source), DebugExpressionError, source);
  }
});

test("static type errors are rejected at compile time", () => {
  for (const source of [
    "v1 && f0",
    "f0 || 1",
    "1 == f0",
    "s0 == v1",
    "true == 1",
    "v1 < f0",
    "s0 < s1",
    '"a" < "b"',
    "s0 + s1",
    "f0 + 1",
    "v1 - f0",
    "!v1",
    "-f0",
    "v1 % f0",
    "object[0].active + 1",
  ]) {
    assert.throws(() => compileDebugExpression(source), DebugExpressionError, source);
  }
});

test("watch values require opt-in and an explicit static type", () => {
  assert.throws(() => compileDebugExpression("old"), DebugExpressionError, "watch off");
  assert.throws(() => compileDebugExpression("new"), DebugExpressionError, "watch off");
  assert.throws(
    () => compileDebugExpression("old", undefined, { watch: true }),
    DebugExpressionError,
    "watchType required",
  );
  assert.throws(
    () => compileDebugExpression("old", undefined, { watchType: "number" }),
    DebugExpressionError,
    "watch flag required",
  );
});

test("watch expressions evaluate old and new against the snapshot", () => {
  const numberWatch: DebugExpressionOptions = { watch: true, watchType: "number" };
  assert.equal(run("old + new", snap({ old: 3, new: 4 }), undefined, numberWatch), 7);
  assert.equal(run("old != new", snap({ old: 3, new: 4 }), undefined, numberWatch), true);
  const booleanWatch: DebugExpressionOptions = { watch: true, watchType: "boolean" };
  assert.equal(run("old && !new", snap({ old: true, new: false }), undefined, booleanWatch), true);
  const stringWatch: DebugExpressionOptions = { watch: true, watchType: "string" };
  assert.equal(
    run('old == "open"', snap({ old: "open", new: "shut" }), undefined, stringWatch),
    true,
  );
  assert.throws(
    () => run("old", snap(), undefined, numberWatch),
    DebugExpressionError,
    "missing watch value",
  );
  assert.throws(
    () => run("old", snap({ old: "3" }), undefined, numberWatch),
    DebugExpressionError,
    "wrong watch type",
  );
  assert.throws(
    () => run("old + 1", snap({ old: Number.NaN }), undefined, numberWatch),
    DebugExpressionError,
    "NaN watch value",
  );
});

test("source length, node count and nesting depth are bounded", () => {
  assert.throws(
    () => compileDebugExpression(`1 ${" ".repeat(1024)}`),
    DebugExpressionError,
    "source over 1024 UTF-16 units",
  );
  assert.equal(run("1".padEnd(1024)), 1, "exactly 1024 units is allowed");
  const sum63 = `1${"+1".repeat(63)}`;
  assert.equal(sum63.split("+").length, 64);
  assert.equal(run(sum63), 64, "127 nodes allowed");
  assert.throws(
    () => compileDebugExpression(`1${"+1".repeat(64)}`),
    DebugExpressionError,
    "129 nodes rejected",
  );
  const nest = (n: number): string => `${"(".repeat(n)}1${")".repeat(n)}`;
  assert.equal(run(nest(16)), 1, "depth 16 allowed");
  assert.throws(() => compileDebugExpression(nest(17)), DebugExpressionError);
  assert.equal(run(`${"!".repeat(16)}f0`), true);
  assert.throws(() => compileDebugExpression(`${"!".repeat(17)}f0`), DebugExpressionError);
  assert.throws(() => compileDebugExpression(`${"-".repeat(17)}1`), DebugExpressionError);
});

test("malformed snapshots surface errors instead of invalid values", () => {
  assert.throws(() => run("v0", snap({ vars: [Number.NaN] })), DebugExpressionError);
  assert.throws(() => run("v0", snap({ vars: [1.5] })), DebugExpressionError);
  assert.throws(() => run("v0", snap({ vars: ["x" as unknown as number] })), DebugExpressionError);
  assert.throws(() => run("f0", snap({ flags: [1 as unknown as boolean] })), DebugExpressionError);
  assert.throws(
    () => run("s0", snap({ strings: [undefined as unknown as string] })),
    DebugExpressionError,
  );
  assert.throws(
    () => run("object[0].x", snap({ objects: [null as unknown as DebugObjectState] })),
    DebugExpressionError,
  );
  assert.throws(
    () => run("object[0].x", snap({ objects: [{} as unknown as DebugObjectState] })),
    DebugExpressionError,
  );
  assert.throws(
    () => run("inventory[0].room", snap({ inventory: [{} as never] })),
    DebugExpressionError,
  );
  assert.throws(() => run("room", snap({ room: Number.NaN })), DebugExpressionError);
  assert.throws(
    () => compileDebugExpression("v0").evaluate(null as unknown as DebugSnapshot),
    DebugExpressionError,
  );
});

test("incomplete and trailing syntax is rejected", () => {
  for (const source of ["", "   ", "1 2", "v1 ==", "(", ")", "|| f0", "v1 +", "."]) {
    assert.throws(() => compileDebugExpression(source), DebugExpressionError, `"${source}"`);
  }
});

test("compiled expressions are immutable and evaluations are pure and stable", () => {
  const compiled = compileDebugExpression("v0 + object[0].x + inventory[0].room", {
    base: { kind: "variable", num: 0 },
  });
  assert.ok(Object.isFrozen(compiled), "compiled object frozen");
  assert.equal(compiled.type, "number");

  const snapshot = snap();
  for (const object of snapshot.objects) Object.freeze(object);
  for (const item of snapshot.inventory) Object.freeze(item);
  Object.freeze(snapshot.vars);
  Object.freeze(snapshot.flags);
  Object.freeze(snapshot.strings);
  Object.freeze(snapshot.objects);
  Object.freeze(snapshot.inventory);
  Object.freeze(snapshot);
  const before = JSON.stringify(snapshot);

  assert.equal(compiled.evaluate(snapshot), 10 + 10 + 12);
  assert.equal(compiled.evaluate(snapshot), 32, "repeated inspection stable");
  assert.equal(JSON.stringify(snapshot), before, "snapshot untouched");

  const changed = snap({ vars: [1, 0, 7, 255] });
  assert.equal(compiled.evaluate(changed), 1 + 10 + 12, "follows snapshot data");
});

test("inspection refuses inherited or accessor-backed snapshot data without invoking it", () => {
  const inherited = Object.create({ x: 123 }) as DebugObjectState;
  assert.throws(() => run("object[0].x", snap({ objects: [inherited] })), DebugExpressionError);
  assert.throws(
    () => run("inventory[0].room", snap({ inventory: [Object.create({ room: 255 })] })),
    DebugExpressionError,
  );
  const vars = new Array<number>(1);
  Object.setPrototypeOf(vars, { 0: 77 });
  assert.throws(() => run("v0", snap({ vars })), DebugExpressionError);
  let invoked = 0;
  const accessor = Object.defineProperty({}, "x", {
    get() {
      invoked++;
      return 3;
    },
  }) as DebugObjectState;
  assert.throws(() => run("object[0].x", snap({ objects: [accessor] })), DebugExpressionError);
  const top = Object.defineProperty(snap(), "vars", {
    get() {
      invoked++;
      return [3];
    },
  });
  assert.throws(() => run("v0", top), DebugExpressionError);
  assert.equal(invoked, 0);
});

test("missing aggregate errors are typed and remain behind short-circuit guards", () => {
  for (const source of ["v0", "f0", "s0", "object[0].x", "inventory[0].room"]) {
    assert.throws(() => run(source, {} as DebugSnapshot), DebugExpressionError);
  }
  assert.equal(run("false && object[0].active", {} as DebugSnapshot), false);
  assert.equal(run("true || v0 == 1", {} as DebugSnapshot), true);
});
