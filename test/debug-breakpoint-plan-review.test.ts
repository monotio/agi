import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { captureProjectBuild } from "../src/authoring/projectBuild.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import { createDebugBreakpointPlan } from "../src/runtime/debugBreakpoints.ts";
import type { DebugSnapshot } from "../src/runtime/debugExpression.ts";

function build(source: string) {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    compileProjectLogic(source, {
      profile: DEFAULT_V2_PROFILE,
      dictionary: new Map(),
      bindings: {},
    }).assembly.payload,
  );
  return captureProjectBuild({
    files: Object.fromEntries(container.files),
    profileId: "2.936",
    sources: { "0": source },
    bindings: {},
  });
}

test("a breakpoint plan retains its captured expression bindings across republication", () => {
  const binding = { kind: "variable" as const, num: 5 };
  const plan = createDebugBreakpointPlan({ build: build("return;"), bindings: { lives: binding } });
  const entry = {
    id: "remaining",
    enabled: true,
    logic: 0,
    line: 1,
    mode: "statement" as const,
    condition: "lives == 1",
  };
  const vars = new Array<number>(256).fill(0);
  vars[5] = 1;
  const snapshot: DebugSnapshot = {
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
  plan.configure({ revision: 1, breakpoints: [entry] });
  const first = plan.atBoundary(
    { sequence: 1, logic: 0, pc: 0, opcodePc: 0, kind: "return", frames: [] },
    snapshot,
  );
  assert.deepEqual(
    first.stops.map((stop) => stop.id),
    ["remaining"],
  );
  // A UI may reuse and edit its binding objects for the next draft/build.
  // Republishing an unchanged spec must still read the captured run's v5.
  binding.num = 6;
  plan.configure({ revision: 2, breakpoints: [entry] });
  const second = plan.atBoundary(
    { sequence: 2, logic: 0, pc: 0, opcodePc: 0, kind: "return", frames: [] },
    snapshot,
  );
  assert.deepEqual(
    second.stops.map((stop) => stop.id),
    ["remaining"],
  );
  assert.equal(plan.status()[0]!.hits, 2);
});

for (const [newline, column] of [
  ["\n", 20],
  ["\r\n", 11],
] as const) {
  test(`a column beyond a ${JSON.stringify(newline)} line cannot bind a multiline IF`, () => {
    // The opening line has nine UTF-16 units. Column 10 is its end position;
    // CRLF adds no editor columns, so column 11 must remain out of range.
    const source = ["if (f1) {", "  increment(v50);", "}", "return;"].join(newline);
    const plan = createDebugBreakpointPlan({ build: build(source) });
    const result = plan.configure({
      revision: 1,
      breakpoints: [
        { id: "outside-line", enabled: true, logic: 0, line: 1, column, mode: "statement" },
      ],
    });
    assert.equal(result.entries[0]!.binding.bound, false);
  });
}
