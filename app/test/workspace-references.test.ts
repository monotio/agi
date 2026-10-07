import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceEditor } from "../src/shell/workspaceEditor.ts";
import type { EngineApi } from "../src/engine/engineContext.ts";
import { workspaceReferenceAt, workspaceReferenceInfo } from "../src/shell/workspaceNames.ts";

test("reference navigation reuses tabs, reveals state and clears across projects", () => {
  const editor = createWorkspaceEditor({} as EngineApi);
  const flag = { name: "door_open", kind: "flag", num: 80, uses: [] };
  editor.partsOpen.value = true;
  editor.phonePlaytest.value = true;
  editor.findReferences(flag);
  assert.equal(editor.selected.value, "state");
  assert.equal(editor.partsOpen.value, false);
  assert.equal(editor.phonePlaytest.value, false);
  assert.equal(editor.stateLocation.value?.num, 80);
  const serial = editor.stateLocation.value!.serial;
  editor.findReferences(flag);
  assert.ok(editor.stateLocation.value!.serial > serial);
  assert.deepEqual(editor.tabs.value, ["state"]);
  editor.findReferences({ name: "bird", kind: "view", num: 2, uses: [] });
  assert.equal(editor.selected.value, "uses");
  assert.equal(editor.references.value?.name, "bird");
  editor.reset();
  assert.equal(editor.references.value, undefined);
  assert.equal(editor.stateLocation.value, undefined);
});

test("references include named and numeric uses, deduplicated by source location", () => {
  const documents: Record<string, string> = {
    bindings: JSON.stringify({ bird: { kind: "view", num: 2 }, door: { kind: "flag", num: 80 } }),
    "logic:1":
      "load.view(bird);\nload.view(2);\nset(door);\nif (isset(f80)) { reset(f80); }\nreturn;",
    "logic:2": "load.view(2); return;",
  };
  const snapshot = {
    keys: Object.keys(documents),
    read: (key: string) =>
      documents[key] === undefined ? undefined : { key, content: documents[key], version: 1 },
    version: () => 1,
  };
  const bird = workspaceReferenceInfo(snapshot, "2.936", {
    name: "bird",
    kind: "view",
    num: 2,
    uses: [],
  });
  assert.deepEqual(
    bird.uses.map((use) => [use.key, use.range.start.line, use.role]),
    [
      ["logic:1", 0, "Used"],
      ["logic:1", 1, "Used"],
      ["logic:2", 0, "Used"],
    ],
  );
  const door = workspaceReferenceInfo(snapshot, "2.936", {
    name: "door",
    kind: "flag",
    num: 80,
    uses: [],
  });
  assert.deepEqual(
    door.uses.map((use) => use.role),
    ["Set", "Checked", "Set"],
  );
  assert.equal(
    workspaceReferenceInfo(snapshot, "2.936", { name: "", kind: "sound", num: 9, uses: [] }).uses
      .length,
    0,
  );
});

test("state read operands are labelled Checked", () => {
  const source = "assignv(v90, v91); return;";
  const snapshot = {
    keys: ["logic:1"],
    read: (key: string) => (key === "logic:1" ? { key, content: source, version: 1 } : undefined),
    version: () => 1,
  };
  const state = workspaceReferenceInfo(snapshot, "2.936", {
    kind: "variable",
    num: 91,
    name: "",
    uses: [],
  });
  assert.deepEqual(
    state.uses.map((use) => use.role),
    ["Checked"],
  );
});

test("numbered state and literal resources resolve through the shared operand inventory", () => {
  const source = "if (isset(f80)) { load.sound(1); } return;";
  const snapshot = {
    keys: ["logic:1"],
    read: (key: string) => (key === "logic:1" ? { key, content: source, version: 1 } : undefined),
    version: () => 1,
  };
  const flag = workspaceReferenceAt(snapshot, "2.936", "logic:1", { line: 0, character: 11 });
  assert.equal(flag?.kind, "flag");
  assert.equal(flag?.num, 80);
  const sound = workspaceReferenceAt(snapshot, "2.936", "logic:1", { line: 0, character: 29 });
  assert.equal(sound?.kind, "sound");
  assert.equal(sound?.num, 1);
});
