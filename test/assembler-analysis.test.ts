import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleLogic, AssemblerError } from "../src/logic/assembler.ts";
import { createContainer } from "../src/container/container.ts";
import { Engine } from "../src/runtime/engine.ts";

const dictionary = new Map<string, number>();

test("strict compilation bounds nesting, source and distribution before VM failure", () => {
  for (const source of [
    `if (${"(".repeat(4096)}isset(f1)${")".repeat(4096)}) { return; }`,
    `if (${"!".repeat(4096)}isset(f1)) { return; }`,
    `${"if (isset(f1)) {".repeat(512)}return;${"}".repeat(512)}`,
    `// ${"x".repeat(262144)}\nreturn;`,
    `if (${Array(18).fill("(isset(f1) && isset(f2))").join(" || ")}) { return; }`,
  ]) {
    assert.throws(
      () => assembleLogic(source, { dictionary }),
      (error: unknown) =>
        error instanceof AssemblerError &&
        error.line > 0 &&
        error.col > 0 &&
        /limit|budget/i.test(error.message),
    );
  }
});

test("said word count is validated before its single-byte count is emitted", () => {
  assert.throws(
    () => assembleLogic(`if (said(${Array(256).fill("1").join(",")})) { return; }`, { dictionary }),
    /said.*255/,
  );
  const valid = assembleLogic(`if (said(${Array(255).fill("1").join(",")})) { return; }`, {
    dictionary,
  });
  assert.equal(valid.code[2], 255);
  assert.equal(valid.code.length, 518); // IF + said/count/510 operand bytes + IF/delta + early and implicit RETURN
});

test("CNF cross-product produces four hand-computed clauses, preserving legacy order", () => {
  const result = assembleLogic(
    "if ((isset(f1) && isset(f2)) || (isset(f3) && isset(f4))) { return; }",
    { dictionary },
  );
  // Legacy distribution puts the chosen AND member before the remaining OR operands:
  // (3 OR 1), (4 OR 1), (3 OR 2), (4 OR 2).
  assert.deepEqual(
    [...result.code],
    [
      255, 252, 7, 3, 7, 1, 252, 252, 7, 4, 7, 1, 252, 252, 7, 3, 7, 2, 252, 252, 7, 4, 7, 2, 252,
      255, 1, 0, 0, 0,
    ],
  );
});

test("source maps identify each emitted predicate and exact UTF-16 source span", () => {
  const source = "// 😀\nif (said(100) || (isset(f10) && isset(f11))) { set(f50); }\nreturn;";
  const result = assembleLogic(source, { dictionary, sourceMap: true });
  const map = result.sourceMap!;
  assert.equal(map.source, source);
  assert.equal(map.codeLength, result.code.length);
  assert.equal(map.version, 1);
  const said = map.entries.filter(
    (entry) => entry.kind === "predicate" && source.slice(entry.start, entry.end) === "said(100)",
  );
  assert.deepEqual(
    said.map((entry) => entry.pc),
    [4, 12],
  );
  assert.notEqual(said[0]!.emissionId, said[1]!.emissionId);
  assert.equal(said[0]!.statementId, said[1]!.statementId);
  assert.equal(said[0]!.start, source.indexOf("said"));
  assert.equal(result.diagnostics.filter((d) => d.code === "condition-effects").length, 1);
  for (const entry of map.entries) {
    assert.ok(entry.start >= 0 && entry.end <= source.length && entry.start < entry.end);
    assert.ok(entry.pc >= 0 && entry.endPc <= result.code.length && entry.pc < entry.endPc);
  }
});

test("mapping is optional and comment-only edits retain bytes with different origins", () => {
  const a = assembleLogic("return;", { dictionary, sourceMap: true });
  const b = assembleLogic("// comment\nreturn;", { dictionary, sourceMap: true });
  assert.deepEqual(a.payload, b.payload);
  assert.equal(a.sourceMap!.entries[0]!.start, 0);
  assert.equal(b.sourceMap!.entries[0]!.start, 11);
  assert.equal(assembleLogic("return;", { dictionary }).sourceMap, undefined);
});

test("generated else jump maps to its IF; labels emit no executable map entry", () => {
  const source = "start: if (!isset(f1)) { call(2); } else { goto start; } return;";
  const { code, sourceMap } = assembleLogic(source, { dictionary, sourceMap: true });
  assert.deepEqual([...code], [255, 253, 7, 1, 255, 5, 0, 22, 2, 254, 3, 0, 254, 241, 255, 0]);
  assert.deepEqual(
    sourceMap!.entries.map((entry) => [entry.kind, entry.pc, entry.endPc]),
    [
      ["if", 0, 7],
      ["predicate", 1, 4],
      ["action", 7, 9],
      ["generated-jump", 9, 12],
      ["goto", 12, 15],
      ["return", 15, 16],
    ],
  );
});

test("repaired pure cross-product agrees with its independent truth table in Engine", () => {
  const { payload } = assembleLogic(
    "if ((isset(f50) && isset(f51)) || (isset(f52) && isset(f53))) { set(f60); } return;",
    { dictionary },
  );
  const trueRows = new Set([3, 7, 11, 12, 13, 14, 15]);
  for (let row = 0; row < 16; row++) {
    const container = createContainer();
    container.putResource("logic", 0, payload);
    const engine = new Engine(
      container,
      {
        print() {},
        displayAt() {},
        statusLine() {},
        takeKeys: () => [],
        takeInputLine: () => null,
      },
      dictionary,
    );
    for (let bit = 0; bit < 4; bit++) engine.flags[50 + bit] = (row >> bit) & 1;
    engine.tick();
    assert.equal(engine.flags[60], Number(trueRows.has(row)), `truth-table row ${row}`);
  }
});

test("analysis warns for reordered have.key but leaves ordinary pure tests quiet", () => {
  const reordered = assembleLogic("if (have.key() || (isset(f50) && isset(f51))) { return; }", {
    dictionary,
  });
  assert.equal(reordered.diagnostics.length, 1);
  assert.match(reordered.diagnostics[0]!.message, /repeats or reorders/);
  assert.deepEqual(
    assembleLogic("if (isset(f50) || isset(f51)) { return; }", { dictionary }).diagnostics,
    [],
  );
});

test("strict compilation owns framing diagnostics and refuses invalid dictionary ids", () => {
  assert.throws(
    () => assembleLogic('#message 1 "' + "a".repeat(65536) + '"\nreturn;', { dictionary }),
    AssemblerError,
  );
  for (const id of [-1, 65536, 1.5, NaN]) {
    assert.throws(
      () => assembleLogic('if (said("open")) { return; }', { dictionary: new Map([["open", id]]) }),
      /dictionary id/,
    );
  }
});
