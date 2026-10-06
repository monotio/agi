/**
 * Room Studio's keyboard. Every key pressed inside the studio stops at its
 * root, so none reaches the paused game or its parser (`[` and `]` included).
 * Widgets keep the keys they use (the Scene list, the lens switch, the
 * scrubber, text fields); the rest are studio shortcuts:
 *
 * - 1/2/3 lens; `,` `.` Home End scrub; + - 0 zoom; Esc lets go of one
 *   thing per press (a menu, what a tool is drawing, a selected door, a tool
 *   other than Select, the selection's bar, a drag, then a test walk left on
 *   the picture) and with nothing in hand
 *   does nothing: Studio closes by its × button (in a text field, Esc leaves
 *   the field instead)
 * - on the focused canvas: arrows nudge the selection 1 px (Shift: 8),
 *   Alt+arrows step through items (Up/Left previous, Down/Right next) and
 *   Shift+Alt+arrows grow or shrink the selection by the next item; with a
 *   drawing tool or the pipette the arrows move the keyboard cursor instead
 *   (Shift: 8) and Space or Enter clicks at it (useStudioInput.ts)
 * - Delete/Backspace delete; Cmd/Ctrl+D duplicate; Cmd/Ctrl+G group,
 *   Shift+Cmd/Ctrl+G ungroup; `[` `]` move back/forward
 *   in draw order; Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z (or Ctrl+Y) redo;
 *   Insert adds a point to the selected line where the cursor is nearest it
 * - the tool rail's letters (studioTools.ts TOOL_SHORTCUTS: V A L R P F B I, the
 *   Walk view's T D E, which open it first, and G H); Enter finishes a line
 *   or polygon, Backspace drops its last point
 * - `?` opens the key sheet (StudioKeySheet.vue); Tab and Shift+Tab only
 *   ever move focus
 */

import type { StudioLens } from "./studioView.ts";

const LENS_KEYS: Record<string, StudioLens> = { "1": "art", "2": "depth", "3": "walk" };

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

/** Shift+arrow nudges this far. */
const NUDGE_FAR = 8;

export interface StudioKeyActions {
  /** Whether the canvas has focus (arrows act on it only then). */
  onCanvas(target: EventTarget | null): boolean;
  /** Esc: let go of one thing (a menu, a drawing, a door, a tool, a drag); true when it did. */
  dismiss(): boolean;
  lens(lens: StudioLens): void;
  seek(to: "first" | "last" | -1 | 1): void;
  zoom(step: 1 | -1 | "fit"): void;
  step(direction: 1 | -1): void;
  /** Shift+Alt+arrow: add the next (+1) or previous (-1) item to the selection. */
  extend(direction: 1 | -1): void;
  nudge(dx: number, dy: number): void;
  /** An arrow for the drawing cursor; false when the tool takes none (the arrows nudge). */
  cursor(dx: number, dy: number): boolean;
  /** Space or Enter on the canvas: click at the drawing cursor; false when the tool takes none. */
  click(enter: boolean): boolean;
  remove(): void;
  duplicate(): void;
  /** Cmd/Ctrl+G: group the selected items (the Group dialog). */
  group(): void;
  /** Shift+Cmd/Ctrl+G: ungroup the selected item. */
  ungroup(): void;
  reorder(step: 1 | -1): void;
  undo(): void;
  redo(): void;
  /** A tool rail letter, lower-cased; true when it named a tool (or the probe). */
  tool(key: string): boolean;
  /** Enter: finish what a tool is drawing; true when there was something. */
  finish(): boolean;
  /** Insert: add a point to the selected line nearest the cursor; false when none was added. */
  insertPoint(): boolean;
  /** `?`: the key sheet. */
  keySheet(): void;
}

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** Handle one studio key; true when it was a studio shortcut (the default is then prevented). */
export function studioKey(event: KeyboardEvent, act: StudioKeyActions): boolean {
  if (event.defaultPrevented) return false;
  const { key } = event;
  const command = event.metaKey || event.ctrlKey;
  if (typing(event.target)) {
    // Esc in a text field leaves the field, never Studio.
    if (key !== "Escape") return false;
    (event.target as HTMLElement).blur();
    return true;
  }
  // Esc only lets go: with nothing in hand it does nothing, and Studio stays open.
  if (key === "Escape") {
    act.dismiss();
    return true;
  }
  const plain = !command && !event.altKey;
  if ((key === " " || key === "Enter") && plain && act.onCanvas(event.target)) {
    // A held key repeats: one press is one click.
    if (event.repeat || act.click(key === "Enter")) return true;
  }
  // Alt+Enter is Alt+click where the keyboard cursor stands: a point on the line.
  if (key === "Enter" && event.altKey && !command && act.onCanvas(event.target))
    return event.repeat || act.insertPoint();
  if (key === "Enter" && !command && act.finish()) return true;
  if (command && !event.altKey) {
    const lower = key.toLowerCase();
    if (lower === "z") (event.shiftKey ? act.redo : act.undo)();
    else if (lower === "y" && event.ctrlKey) act.redo();
    else if (lower === "d") act.duplicate();
    else if (lower === "g") (event.shiftKey ? act.ungroup : act.group)();
    else return false;
    return true;
  }
  if (command) return false;
  const arrow = ARROWS[key];
  if (arrow !== undefined) {
    if (!act.onCanvas(event.target)) return false;
    if (event.altKey) (event.shiftKey ? act.extend : act.step)(arrow[0] + arrow[1] > 0 ? 1 : -1);
    else {
      const far = event.shiftKey ? NUDGE_FAR : 1;
      if (!act.cursor(arrow[0] * far, arrow[1] * far)) act.nudge(arrow[0] * far, arrow[1] * far);
    }
    return true;
  }
  if (event.altKey) return false;
  if (key === "?") {
    act.keySheet();
    return true;
  }
  if (key === "Insert") return act.insertPoint();
  const lens = LENS_KEYS[key];
  if (lens) act.lens(lens);
  else if (key === "Delete" || key === "Backspace") act.remove();
  else if (key === "[") act.reorder(-1);
  else if (key === "]") act.reorder(1);
  else if (key === ",") act.seek(-1);
  else if (key === ".") act.seek(1);
  else if (key === "Home") act.seek("first");
  else if (key === "End") act.seek("last");
  else if (key === "+" || key === "=") act.zoom(1);
  else if (key === "-") act.zoom(-1);
  else if (key === "0") act.zoom("fit");
  else return key.length === 1 && act.tool(key.toLowerCase());
  return true;
}
