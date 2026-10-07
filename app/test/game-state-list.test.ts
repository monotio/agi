import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectDraft } from "../../src/authoring/projectDraft.ts";
import { workspaceGameStateInfos } from "../src/shell/workspaceNames.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";

test("game state lists own names in code-point order and used reserved slots once by standard name", () => {
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
    ["apple", "chime_done", "zebra"],
  );
  assert.deepEqual(
    rows.builtin.map((row) => [row.name, row.kind, row.num]),
    [
      ["system_flag_0", "flag", 0],
      ["new_room", "flag", 5],
      ["current_room", "variable", 0],
    ],
  );
  assert.equal(rows.builtin[2]!.uses.length, 2);
  assert.equal(rows.game[1]!.uses.length, 1);
});

test("reserved slots are discovered in native LOGIC without adding bindings", () => {
  const payload = assembleLogic("if (isset(f5)) { assignn(v0, 1); } return;", {}).payload;
  const draft = new ProjectDraft({ bindings: "{}", "logic:0": payload });
  const rows = workspaceGameStateInfos(draft.capture(), "2.936");
  assert.deepEqual(rows.game, []);
  assert.deepEqual(
    rows.builtin.map((row) => row.name),
    ["new_room", "current_room"],
  );
  assert.equal(draft.capture().read("bindings")!.content, "{}");
});
