/**
 * Monaco 0.57 focuses the rename box 100 ms after showing it (renameWidget.js
 * `_show`), while the editor draws the box on its next animation frame. When
 * that frame comes later, the box is still hidden, the browser ignores the
 * focus, and the keys a player types change the code instead. Here a box that
 * missed its focus takes it when it is drawn, as long as the code still has
 * focus. A box drawn in time keeps Monaco's own focus, which also selects the
 * name, so typing that has already started is never selected over.
 *
 * The fix reads private members of Monaco's RenameWidget. It checks each one
 * and leaves Monaco as it ships when one is missing, and
 * `app/test/monaco-rename.test.ts` fails when the installed Monaco no longer
 * has them.
 */

interface RenameInput {
  readonly ownerDocument: { readonly activeElement: unknown };
  focus(): void;
  getAttribute(name: string): string | null;
  setSelectionRange(start: number, end: number): void;
}
type Method = (this: Widget, ...args: unknown[]) => unknown;
interface Widget {
  _show?: Method;
  afterRender?: Method;
  _editor?: { hasTextFocus?: unknown };
  _inputWithButton?: { input?: Partial<RenameInput> };
}

/** The rename input, or null when this Monaco keeps it elsewhere. */
function renameInput(widget: Widget): RenameInput | null {
  const input = widget._inputWithButton?.input;
  return typeof input?.focus === "function" &&
    typeof input.getAttribute === "function" &&
    typeof input.setSelectionRange === "function" &&
    input.ownerDocument !== undefined
    ? (input as RenameInput)
    : null;
}

/** Installs the fix on RenameWidget's prototype; false when Monaco lacks what it needs. */
export function patchRenameFocus(prototype: object): boolean {
  const proto = prototype as Widget;
  const show = proto._show;
  const afterRender = proto.afterRender;
  if (typeof show !== "function" || typeof afterRender !== "function") return false;
  const missed = new WeakSet<Widget>();
  proto._show = function (this: Widget, ...args: unknown[]) {
    missed.delete(this);
    const result = Reflect.apply(show, this, args);
    // Timers with the same delay run in order, so this runs after Monaco's focus.
    setTimeout(() => {
      const input = renameInput(this);
      if (input && input.ownerDocument.activeElement !== input) missed.add(this);
    }, 100);
    return result;
  };
  proto.afterRender = function (this: Widget, ...args: unknown[]) {
    const result = Reflect.apply(afterRender, this, args);
    if (args[0] === null || !missed.delete(this)) return result;
    const editor = this._editor;
    const input = renameInput(this);
    if (!input || typeof editor?.hasTextFocus !== "function" || !editor.hasTextFocus()) {
      return result;
    }
    input.focus();
    input.setSelectionRange(
      Number(input.getAttribute("selectionStart")),
      Number(input.getAttribute("selectionEnd")),
    );
    return result;
  };
  return true;
}
