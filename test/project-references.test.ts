import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { buildWordsTok } from "../src/logic/words.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { buildObjectFile } from "../src/authoring/inventory.ts";
import { inspectProjectReferences } from "../src/authoring/projectReferences.ts";

const profile = PROFILES["2.936"];
function project(source: string) {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(source, { profile, dictionary: new Map() }).payload,
  );
  return container;
}

test("native references identify resource families and exact operand PCs without parsing rendered strings", () => {
  const container = project(
    'load.view(3); set.view(o0, 4); sound(7, f8); call(2); trace.info(9, 0, 3); print("call(99)"); return;',
  );
  const result = inspectProjectReferences({ container, profile });
  assert.deepEqual(
    result.references.map(({ pc, target }) => [pc, target]),
    [
      [0, { kind: "view", num: 3 }],
      [2, { kind: "view", num: 4 }],
      [5, { kind: "sound", num: 7 }],
      [8, { kind: "logic", num: 2 }],
      [10, { kind: "logic", num: 9 }],
    ],
  );
  assert.equal(result.diagnostics.filter((entry) => entry.code === "missing-resource").length, 5);
  assert.deepEqual(result.dependencies["logic:0"], [
    "logic:2",
    "logic:9",
    "sound:7",
    "view:3",
    "view:4",
  ]);
});

test("variable targets remain explicitly unknown instead of being mistaken for numbered resources", () => {
  const result = inspectProjectReferences({
    container: project("load.pic(v6); call.v(v2); set.view.v(o0, v5); get.v(v9); return;"),
    profile,
  });
  assert.deepEqual(
    result.references.map(({ target }) => target),
    [
      { kind: "picture", variable: 6 },
      { kind: "logic", variable: 2 },
      { kind: "view", variable: 5 },
      { kind: "item", variable: 9 },
    ],
  );
  assert.equal(
    result.diagnostics.filter((entry) => entry.code === "unresolved-reference").length,
    4,
  );
  assert.equal(
    result.diagnostics.some((entry) => entry.severity === "error"),
    false,
  );
  assert.deepEqual(result.dependencies["logic:0"], ["inventory"]);
});

test("said groups and inventory references include condition operands and auxiliary room locations", () => {
  const container = project("if (said(100, 1, 9999) && has(2)) { get(1); } return;");
  container.putFile("WORDS.TOK", buildWordsTok([{ word: "look", id: 100 }]));
  container.putFile(
    "OBJECT",
    buildObjectFile([
      { name: "Key", startingRoom: 8 },
      { name: "Lamp", startingRoom: 255 },
    ]),
  );
  const result = inspectProjectReferences({ container, profile });
  assert.deepEqual(
    result.references.filter((edge) => edge.target.kind === "word").map((edge) => edge.target),
    [{ kind: "word", num: 100 }],
  );
  assert.equal(result.diagnostics.filter((entry) => entry.code === "missing-item").length, 1);
  assert.equal(
    result.diagnostics.some((entry) => entry.code === "missing-word"),
    false,
  );
  assert.deepEqual(result.dependencies["inventory"], ["logic:8"]);
  assert.deepEqual(result.dependencies["logic:0"], ["inventory", "words"]);
});

test("a missing word group and a corrupt logic stay visible without suppressing valid references elsewhere", () => {
  const container = project("if (said(101)) { load.view(3); } return;");
  container.putResource("logic", 1, buildLogicResource(Uint8Array.of(0xf0, 0), []));
  const result = inspectProjectReferences({ container, profile });
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.code === "missing-word" && entry.document === "logic:0",
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.code === "incomplete-logic" && entry.document === "logic:1",
    ),
  );
  assert.ok(
    result.references.some(
      (edge) => edge.target.kind === "view" && "num" in edge.target && edge.target.num === 3,
    ),
  );
  assert.ok(result.unknownDocuments.includes("logic:1"));
});

test("missing future rooms are distinct from missing callable logic and reserved bindings", () => {
  const container = project("new.room(5); call(6); return;");
  const result = inspectProjectReferences({
    container,
    profile,
    allowMissingRooms: true,
    bindings: { future_art: { kind: "view", num: 9 } },
  });
  assert.equal(
    result.diagnostics.find((entry) => entry.command === "new.room")?.severity,
    "warning",
  );
  assert.equal(result.diagnostics.find((entry) => entry.command === "call")?.severity, "error");
  assert.deepEqual(result.dependencies["bindings"], ["view:9"]);
  assert.equal(
    result.diagnostics.some((entry) => entry.document === "bindings" && entry.severity === "error"),
    false,
  );
});
