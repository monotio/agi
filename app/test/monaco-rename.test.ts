import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mock, test } from "node:test";
import { patchRenameFocus } from "../src/studio/logic/renameFocus.ts";

// Player rule: after F2 the rename box takes the keys the player types, even when the editor
// draws the box late (workspace-names.spec.ts covers it in the browser). The fix patches private
// members of Monaco's RenameWidget, so these tests pin what it relies on and how it degrades.

/** A stand-in for the rename box's input element. */
function fakeInput(document: { activeElement: unknown }) {
  return {
    ownerDocument: document,
    focused: 0,
    selection: [] as number[],
    focus() {
      this.focused++;
    },
    getAttribute(name: string) {
      return name === "selectionStart" ? "2" : "5";
    },
    setSelectionRange(start: number, end: number) {
      this.selection = [start, end];
    },
  };
}

function widgetClass() {
  const calls: unknown[][] = [];
  class Widget {
    _editor = { hasTextFocus: () => true };
    _inputWithButton = { input: fakeInput({ activeElement: null }) };
    _show(...args: unknown[]) {
      calls.push(["_show", ...args]);
    }
    afterRender(...args: unknown[]) {
      calls.push(["afterRender", ...args]);
    }
  }
  return { Widget, calls };
}

test("a rename box that missed Monaco's focus takes it once it is drawn", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { Widget, calls } = widgetClass();
    assert.equal(patchRenameFocus(Widget.prototype), true);
    const widget = new Widget();
    widget._show();
    mock.timers.tick(100);
    widget.afterRender(3, { top: 1, left: 2 });
    assert.equal(widget._inputWithButton.input.focused, 1);
    assert.deepEqual(widget._inputWithButton.input.selection, [2, 5]);
    // Every argument reaches Monaco's own methods, the drawn coordinate included.
    assert.deepEqual(calls, [["_show"], ["afterRender", 3, { top: 1, left: 2 }]]);
    // The fix is one-shot: a later layout leaves focus where the player put it.
    widget.afterRender(3, null);
    assert.equal(widget._inputWithButton.input.focused, 1);
  } finally {
    mock.timers.reset();
  }
});

test("a rename box that got Monaco's focus, or a code view without focus, is left alone", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { Widget } = widgetClass();
    patchRenameFocus(Widget.prototype);
    const focused = new Widget();
    focused._inputWithButton.input.ownerDocument.activeElement = focused._inputWithButton.input;
    focused._show();
    mock.timers.tick(100);
    focused.afterRender(3, null);
    assert.equal(focused._inputWithButton.input.focused, 0);
    const elsewhere = new Widget();
    elsewhere._editor.hasTextFocus = () => false;
    elsewhere._show();
    mock.timers.tick(100);
    elsewhere.afterRender(3, null);
    assert.equal(elsewhere._inputWithButton.input.focused, 0);
  } finally {
    mock.timers.reset();
  }
});

test("a Monaco without the patched members keeps its own rename behaviour", () => {
  for (const missing of ["_show", "afterRender"] as const) {
    const { Widget } = widgetClass();
    const proto = Widget.prototype as unknown as Record<string, unknown>;
    delete proto[missing];
    const before = { _show: proto["_show"], afterRender: proto["afterRender"] };
    assert.equal(patchRenameFocus(Widget.prototype), false, missing);
    assert.deepEqual({ _show: proto["_show"], afterRender: proto["afterRender"] }, before);
  }
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { Widget } = widgetClass();
    patchRenameFocus(Widget.prototype);
    const bare = new Widget();
    const fields = bare as unknown as Record<string, unknown>;
    delete fields["_inputWithButton"];
    delete fields["_editor"];
    bare._show();
    assert.doesNotThrow(() => mock.timers.tick(100));
    assert.doesNotThrow(() => bare.afterRender(3, null));
  } finally {
    mock.timers.reset();
  }
});

test("the installed Monaco still has what the rename focus patch relies on", () => {
  const read = (path: string) =>
    readFileSync(fileURLToPath(import.meta.resolve(`monaco-editor/${path}`)), "utf8");
  const widget = read("editor/contrib/rename/browser/renameWidget.js");
  const layout = read("editor/browser/viewParts/contentWidgets/contentWidgets.js");
  const needs: [string, RegExp][] = [
    ["RenameWidget._show()", /\n {4}_show\(\) \{/],
    [
      "Monaco focusing the rename box on a 100 ms timer in _show",
      /\.input\.focus\(\);[^]*?\}, 100\);/,
    ],
    ["RenameWidget.afterRender(position)", /\n {4}afterRender\(position\) \{/],
    ["RenameWidget._editor", /this\._editor = _editor;/],
    ["RenameWidget._inputWithButton", /this\._inputWithButton = new InputWithButton\(\);/],
    ["InputWithButton.input", /\n {4}get input\(\) \{/],
    ["the content widget layout calling afterRender", /safeInvoke\(this\._actual\.afterRender,/],
  ];
  const missing = needs.filter(([, pattern]) => !pattern.test(widget + layout));
  assert.deepEqual(
    missing.map(([name]) => name),
    [],
    "Monaco changed under the rename focus patch (app/src/studio/logic/renameFocus.ts): " +
      "check the patch against the new renameWidget.js and update or remove it.",
  );
});
