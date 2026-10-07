import assert from "node:assert/strict";
import { test } from "node:test";
import { logicValues } from "../src/studio/workspace/debugValues.ts";

test("Used here follows operand types and names, excluding messages and unused defines", () => {
  assert.deepEqual(
    logicValues(
      `#define count 40
#define done 42
#define unused 99
#define view 40
#message 1 "v99 done"
// set(f99);
assignn(count, 4);
load.view(view);
if (equaln(count, 3) && isset(done)) { set(done); }
count = 2;
return;`,
      {},
    ),
    [
      { kind: "variable", slot: 40, names: "count" },
      { kind: "flag", slot: 42, names: "done" },
    ],
  );
});

test("Used here accepts global bindings, raw slots and numeric operands", () => {
  assert.deepEqual(
    logicValues("assignv(41, points); if (isset(f5)) { set(42); } return;", {
      points: { kind: "variable", num: 40 },
      unrelated: { kind: "flag", num: 99 },
    }),
    [
      { kind: "variable", slot: 40, names: "points" },
      { kind: "variable", slot: 41, names: "" },
      { kind: "flag", slot: 5, names: "" },
      { kind: "flag", slot: 42, names: "" },
    ],
  );
});
