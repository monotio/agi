import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectDraft } from "../../src/authoring/projectDraft.ts";
import { workspaceGameStateInfos } from "../src/shell/workspaceNames.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { readBindingsDocument } from "../../src/authoring/projectDocuments.ts";
import { SYSTEM_FLAGS, SYSTEM_VARIABLES } from "../../src/logic/systemNames.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";

test("game state lists own names in code-point order and every reserved slot once in number order", () => {
  const draft = new ProjectDraft({
    bindings: JSON.stringify({
      zebra: { kind: "flag", num: 32 },
      room_alias: { kind: "variable", num: 0 },
      chime_done: { kind: "flag", num: 204, builtin: true },
      apple: { kind: "variable", num: 33 },
    }),
    "logic:0":
      "assignn(room_alias, 1); assignn(v0, 2); if (isset(f5)) { set(chime_done); } return;",
    "logic:1": "if (isset(f0)) { return; } return;",
  });
  const rows = workspaceGameStateInfos(draft.capture(), "2.936");
  assert.deepEqual(
    rows.game.map((row) => row.name),
    ["apple", "chime_done", "room_alias", "zebra"],
  );
  assert.deepEqual(
    rows.builtin.map((row) => [row.name, row.kind, row.num]),
    [
      ...Array.from({ length: 16 }, (_, num) => [SYSTEM_FLAGS[String(num)], "flag", num]),
      ...Array.from({ length: 27 }, (_, num) => [SYSTEM_VARIABLES[String(num)], "variable", num]),
    ],
  );
  assert.equal(rows.builtin[16]!.uses.length, 2);
  assert.equal(rows.game[1]!.uses.length, 1);
});

test("reserved slots are discovered in native LOGIC without adding bindings", () => {
  const payload = assembleLogic("if (isset(f5)) { assignn(v0, 1); } return;", {
    dictionary: new Map(),
  }).payload;
  const draft = new ProjectDraft({ bindings: "{}", "logic:0": payload });
  const rows = workspaceGameStateInfos(draft.capture(), "2.936");
  assert.deepEqual(rows.game, []);
  assert.equal(rows.builtin.length, 43);
  assert.equal(rows.builtin[5]!.name, "new_room");
  assert.equal(rows.builtin[5]!.uses.length, 1);
  assert.equal(rows.builtin[16]!.name, "current_room");
  assert.equal(rows.builtin[16]!.uses.length, 1);
  assert.equal(draft.capture().read("bindings")!.content, "{}");
});

test("Starter names are game names and old binding markers are ignored", () => {
  const starter = createStarterProject("starter");
  assert.deepEqual(starter.bindings["chime_done"], { kind: "flag", num: 204 });
  const legacy = readBindingsDocument(
    JSON.stringify({
      chime_done: { kind: "flag", num: 204, builtin: true },
    }),
  );
  assert.deepEqual(legacy, { chime_done: { kind: "flag", num: 204 } });
  const draft = new ProjectDraft({ bindings: JSON.stringify(starter.bindings) });
  const rows = workspaceGameStateInfos(draft.capture(), "2.936");
  assert.ok(rows.game.some((row) => row.name === "chime_done"));
  assert.ok(rows.builtin.every((row) => row.uses.length === 0));
});

test("using a reserved slot marks it without changing the list order", () => {
  const blank = new ProjectDraft({ bindings: "{}" });
  const used = new ProjectDraft({
    bindings: "{}",
    "logic:1": "set(f15); assignn(v26, 3); return;",
  });
  const before = workspaceGameStateInfos(blank.capture(), "2.936").builtin;
  const after = workspaceGameStateInfos(used.capture(), "2.936").builtin;
  assert.equal(before.length, 43);
  assert.deepEqual(
    after.map(({ name, kind, num }) => [name, kind, num]),
    before.map(({ name, kind, num }) => [name, kind, num]),
  );
  assert.equal(before[15]!.uses.length, 0);
  assert.equal(after[15]!.uses[0]!.key, "logic:1");
  assert.equal(after[42]!.uses[0]!.key, "logic:1");
});

test("built-in meanings read plainly, match the lens and name the clock", () => {
  const rows = workspaceGameStateInfos(new ProjectDraft({ bindings: "{}" }).capture(), "2.936");
  const meaning = (kind: "flag" | "variable", num: number) =>
    rows.builtin.find((row) => row.kind === kind && row.num === num)!.meaning;
  assert.equal(meaning("flag", 0), "The hero is in water.");
  assert.equal(meaning("flag", 3), "The hero is touching a trigger.");
  assert.deepEqual(
    [11, 12, 13, 14].map((num) => meaning("variable", num)),
    [
      "Seconds on the game clock.",
      "Minutes on the game clock.",
      "Hours on the game clock.",
      "Days on the game clock.",
    ],
  );
  // Documented clock roles have source names.
  assert.equal(rows.builtin[16 + 11]!.name, "clock_seconds");
  for (const row of rows.builtin)
    assert.doesNotMatch(row.meaning, /control colou?r|baseline cell/i, row.name);
});

test("Built-in names describe every documented role and keep unassigned slots reserved", () => {
  const rows = workspaceGameStateInfos(
    new ProjectDraft({
      bindings: "{}",
      "logic:0": "set(ego_in_water); increment(current_room); return;",
    }).capture(),
    "2.936",
  );
  assert.equal(rows.builtin[0]!.name, "ego_in_water");
  assert.equal(rows.builtin[7]!.name, "no_save_loads");
  assert.equal(rows.builtin[16 + 16]!.name, "ego_view");
  for (const row of rows.builtin) {
    assert.doesNotMatch(row.name, /^system_|^object_event_/);
    assert.equal(
      row.name.startsWith("reserved_"),
      row.meaning === "Kept for the interpreter.",
      row.name,
    );
  }
  assert.equal(rows.builtin[0]!.uses.length, 1);
  assert.equal(rows.builtin[16]!.uses.length, 1);
});
