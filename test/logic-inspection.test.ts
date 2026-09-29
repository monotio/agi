import assert from "node:assert/strict";
import { test } from "node:test";
import * as disassembler from "../src/logic/disassembler.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { PROFILES } from "../src/runtime/profile.ts";

test("inspection exposes predicate operands at their actual byte positions", () => {
  // if (isset(f35) && has(2) && said(word 10)) { load.view(9); } return;
  const payload = buildLogicResource(
    Uint8Array.of(0xff, 0x07, 35, 0x09, 2, 0x0e, 1, 10, 0, 0xff, 2, 0, 0x1e, 9, 0),
    ["%v32 %o33"],
  );
  const result = disassembler.inspectLogicResource(payload, {
    dictionary: new Map([["look", 10]]),
  });
  assert.deepEqual(result.predicates, [
    { at: 1, name: "isset", args: [35] },
    { at: 3, name: "has", args: [2] },
    { at: 5, name: "said", args: [10] },
  ]);
  assert.deepEqual(
    result.instructions.map(({ at, end, kind }) => ({ at, end, kind })),
    [
      { at: 0, end: 12, kind: "if" },
      { at: 12, end: 14, kind: "action" },
      { at: 14, end: 15, kind: "return" },
    ],
  );
  assert.deepEqual(result.messages, ["%v32 %o33"]);
  assert.deepEqual(result.warnings, []);
});

test("inspection retains predicate uses inside negation and OR groups and detects bad branches", () => {
  // NOT and OR markers do not move the operand's origin onto the containing IF.
  const payload = buildLogicResource(
    Uint8Array.of(0xff, 0xfc, 0xfd, 0x07, 40, 0x01, 32, 9, 0xfc, 0xff, 0, 0, 0),
    [],
  );
  const result = disassembler.inspectLogicResource(payload);
  assert.deepEqual(result.predicates, [
    { at: 3, name: "isset", args: [40] },
    { at: 5, name: "equaln", args: [32, 9] },
  ]);
  assert.deepEqual(result.warnings, []);
  const bad = buildLogicResource(Uint8Array.of(0xfe, 0xff, 0xff, 0), []);
  assert.ok(disassembler.inspectLogicResource(bad).warnings.length > 0);
});

test("inspection uses profile operand widths and never certifies unknown code", () => {
  const payload = buildLogicResource(Uint8Array.of(0x86, 0), []);
  const result = disassembler.inspectLogicResource(payload, { profile: PROFILES["2.089"] });
  assert.equal(result.instructions[0]!.end, 1);
  assert.equal(result.instructions[1]!.kind, "return");
  assert.ok(
    disassembler.inspectLogicResource(buildLogicResource(Uint8Array.of(0xf0, 0), [])).warnings
      .length > 0,
  );
  assert.throws(
    () => disassembler.inspectLogicResource(buildLogicResource(Uint8Array.of(0xff, 0x07), [])),
    /mid-instruction/,
  );
});
