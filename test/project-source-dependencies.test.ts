import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectProjectSourceDependencies } from "../src/authoring/projectSourceDependencies.ts";
import { PROFILES } from "../src/runtime/profile.ts";

const profile = PROFILES["2.936"];

function inspect(source: string, bindings: Record<string, { num: number }> = {}) {
  return inspectProjectSourceDependencies({ source, profile, bindings });
}

test("source dependencies use real statement and predicate operands, including unreachable branches", () => {
  const source =
    '#define character 7\nif (said("open", "door") && has(2)) { load.view(character); } else { call(8); } sound(9, f3); return; load.view(10);';
  const result = inspect(source);
  assert.deepEqual(result.dependencies, [
    "inventory",
    "logic:8",
    "sound:9",
    "view:10",
    "view:7",
    "words",
  ]);
  assert.deepEqual(result.syntaxDiagnostics, []);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.bindings, []);
  assert.equal(
    result.references.find((entry) => entry.command === "load.view")?.start,
    source.indexOf("load.view"),
  );
});

test("only consulted project bindings join the selection; local definitions and text do not", () => {
  const source =
    '#define local 12\nload.view(local); call(destination); print("load.view(unused)"); // call(unused);\nreturn;';
  const result = inspect(source, {
    local: { num: 99 },
    destination: { num: 4 },
    unused: { num: 3 },
  });
  assert.deepEqual(result.dependencies, ["bindings", "logic:4", "view:12"]);
  assert.deepEqual(result.bindings, ["destination"]);
  assert.equal(
    result.references.find((entry) => entry.command === "call")?.start,
    source.indexOf("call(destination)"),
  );
  assert.deepEqual(result.syntaxDiagnostics, []);
});

test("variable resource and inventory targets remain unresolved, never variable-number resource IDs", () => {
  const result = inspect("load.pic(v6); call.v(v2); set.view.v(o0, v5); get.v(v9); return;");
  assert.deepEqual(result.dependencies, ["inventory"]);
  assert.deepEqual(
    result.unresolved.map(({ kind, variable }) => [kind, variable]),
    [
      ["picture", 6],
      ["logic", 2],
      ["view", 5],
      ["item", 9],
    ],
  );
});

test("incomplete drafts retain valid references and flag missing binding context without claiming a complete graph", () => {
  const result = inspect('load.view(3);\ncall(next_room);\nload.view(4);\nprint("unfinished');
  assert.deepEqual(result.dependencies, ["bindings", "view:3", "view:4"]);
  assert.deepEqual(result.bindings, ["next_room"]);
  assert.ok(result.syntaxDiagnostics.length >= 2);
  assert.ok(result.syntaxDiagnostics.every((entry) => entry.start >= 0));
});

test("invalid resource operands do not invent targets; global parser limits remain visible", () => {
  const result = inspect('load.view(300); load.view("invalid"); return;');
  assert.deepEqual(result.dependencies, []);
  assert.equal(result.unresolved.length, 2);
  const bounded = inspect(" ".repeat(262145), { unused: { num: 1 } });
  assert.ok(bounded.syntaxDiagnostics.some((entry) => /source byte limit/.test(entry.message)));
  assert.deepEqual(bounded.dependencies, []);
});

test("operand meaning follows opcode roles even when source uses numeric variable slots or register spellings", () => {
  const result = inspect("load.pic(6); load.view(v7); call.v(f2); return;");
  assert.deepEqual(result.dependencies, ["view:7"]);
  assert.deepEqual(
    result.unresolved.map(({ kind, variable }) => [kind, variable]),
    [
      ["picture", 6],
      ["logic", 2],
    ],
  );
});
