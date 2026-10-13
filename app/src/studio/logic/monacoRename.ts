import { RenameWidget } from "monaco-editor/editor/contrib/rename/browser/renameWidget.js";

/**
 * Monaco 0.57 focuses the rename box 100 ms after showing it (renameWidget.js
 * `_show`), while the editor draws the box on its next animation frame. When
 * that frame comes later, the box is still hidden, the browser ignores the
 * focus, and the keys a player types change the code instead. Here a box that
 * missed its focus takes it when it is drawn, as long as the code still has
 * focus. A box drawn in time keeps Monaco's own focus, which also selects the
 * name, so typing that has already started is never selected over.
 */
const missed = new WeakSet<RenameWidget>();
const show = RenameWidget.prototype._show;
RenameWidget.prototype._show = function () {
  missed.delete(this);
  show.call(this);
  // Timers with the same delay run in order, so this runs after Monaco's focus.
  setTimeout(() => {
    const input = this._inputWithButton.input;
    if (input.ownerDocument.activeElement !== input) missed.add(this);
  }, 100);
};
const afterRender = RenameWidget.prototype.afterRender;
RenameWidget.prototype.afterRender = function (position) {
  afterRender.call(this, position);
  if (position === null || !missed.delete(this) || !this._editor.hasTextFocus()) return;
  const input = this._inputWithButton.input;
  input.focus();
  input.setSelectionRange(
    Number(input.getAttribute("selectionStart")),
    Number(input.getAttribute("selectionEnd")),
  );
};
