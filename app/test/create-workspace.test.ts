import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceEditor } from "../src/shell/workspaceEditor.ts";
import type { EngineApi } from "../src/engine/engineContext.ts";
import { createCreateWorkspace, DOCKS_STORAGE_KEY } from "../src/shell/useCreateWorkspace.ts";

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

test("workspace split orientation defaults side by side and remembers stacked", () => {
  const storage = memoryStorage();
  const previous = globalThis.localStorage;
  Object.assign(globalThis, { localStorage: storage });
  try {
    const editor = createWorkspaceEditor({} as EngineApi);
    assert.equal(editor.splitAxis.value, "horizontal");
    editor.setSplitAxis("vertical");
    assert.equal(storage.data.get("monotio_agi.workspaceSplitAxis"), "vertical");
    assert.equal(createWorkspaceEditor({} as EngineApi).splitAxis.value, "vertical");
  } finally {
    Object.assign(globalThis, { localStorage: previous });
  }
});

function workspace(
  storage: Pick<Storage, "getItem" | "setItem">,
  panelDock: (id: string) => "left" | "right" | undefined = () => undefined,
) {
  return createCreateWorkspace({ panelDock, storage });
}

test("a folded dock is remembered per viewer and survives unreadable storage", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  assert.deepEqual({ ...ws.collapsed }, { left: false, right: false });
  ws.toggleDock("left");
  assert.equal(storage.data.get(DOCKS_STORAGE_KEY), '{"left":true,"right":false}');
  // The next page load reads it back.
  assert.equal(workspace(storage).collapsed.left, true);
  // Corrupt text or a throwing store leaves both docks open, and a refused
  // write still folds the dock for this page.
  assert.deepEqual(
    { ...workspace(memoryStorage({ [DOCKS_STORAGE_KEY]: "{oops" })).collapsed },
    { left: false, right: false },
  );
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  const fallback = workspace(blocked);
  assert.equal(fallback.collapsed.right, false);
  fallback.toggleDock("right");
  assert.equal(fallback.collapsed.right, true);
});

test("showing a panel selects its tab and unfolds its dock", () => {
  const editor = createWorkspaceEditor({} as EngineApi);
  const off = editor.registerPanel({ id: "inspect", dock: "right", title: "Inspect", order: 1 });
  try {
    const storage = memoryStorage({ [DOCKS_STORAGE_KEY]: '{"left":false,"right":true}' });
    const ws = workspace(storage, (id) => editor.panelDock(id));
    ws.showPanel("inspect");
    assert.equal(ws.active.right, "inspect");
    assert.equal(ws.active.left, "world");
    assert.equal(ws.collapsed.right, false);
    assert.equal(ws.active.sheet, "inspect");
    // A panel nobody registered keeps the docks as they are.
    ws.showPanel("nope");
    assert.equal(ws.active.right, "inspect");
  } finally {
    off();
  }
});

test("the shell's default panels sit in their docks", () => {
  const editor = createWorkspaceEditor({} as EngineApi);
  assert.equal(editor.panelDock("world"), "left");
  assert.equal(editor.panelDock("assistant"), "right");
});

test("panel replacement keeps one entry and an old disposer preserves its replacement", () => {
  const editor = createWorkspaceEditor({} as EngineApi);
  const first = editor.registerPanel({ id: "inspect", dock: "right", title: "First" });
  const second = editor.registerPanel({ id: "inspect", dock: "left", title: "Second" });
  first();
  assert.equal(editor.panelDock("inspect"), "left");
  second();
  assert.equal(editor.panelDock("inspect"), undefined);
});

test("unsaved edits download reports a browser download failure and retains buffers", async (t) => {
  const editor = createWorkspaceEditor({} as EngineApi);
  editor.unsavedEdits.value = () => ({ notes: "Pending typing" });
  t.mock.method(URL, "createObjectURL", () => {
    throw new Error("Browser refused the download");
  });
  await editor.downloadUnsavedEdits();
  assert.equal(
    editor.error.value,
    "Could not download unsaved edits: Browser refused the download. Try Download unsaved edits again.",
  );
  assert.equal(editor.unsavedEdits.value()["notes"], "Pending typing");
});

test("a chosen splitter width applies to VIEW and SOUND editors", () => {
  const editor = createWorkspaceEditor({} as EngineApi);
  editor.selected.value = "view:0";
  editor.resize(65);
  assert.equal(editor.effectiveSplit.value, 65);
  editor.selected.value = "sound:1";
  editor.resize(35);
  assert.equal(editor.effectiveSplit.value, 35);
});
