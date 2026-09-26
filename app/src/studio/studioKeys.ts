/**
 * Room Studio's keyboard. Every key pressed inside the studio stops at its
 * root, so none reaches the paused game or its parser (`[` and `]` included).
 * Widgets keep the keys they use (the Scene list, the lens switch, the
 * scrubber, text fields); the rest are studio shortcuts:
 *
 * - 1/2/3 lens; `,` `.` Home End scrub; + - 0 zoom; Esc back to Create
 * - on the focused canvas: arrows nudge the selected item 1 px (Shift: 8),
 *   Alt+arrows step through items (Up/Left previous, Down/Right next)
 * - Delete/Backspace delete; Cmd/Ctrl+D duplicate; `[` `]` move back/forward
 *   in draw order; Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z (or Ctrl+Y) redo
 */

import type { StudioLens } from "./studioView.ts";

export const LENS_KEYS: Record<string, StudioLens> = { "1": "art", "2": "depth", "3": "walk" };

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

/** Shift+arrow nudges this far. */
export const NUDGE_FAR = 8;

export interface StudioKeyActions {
  /** Whether the canvas has focus (arrows act on it only then). */
  onCanvas(target: EventTarget | null): boolean;
  /** Esc: close a popover or drag first; true when it did. */
  dismiss(): boolean;
  close(): void;
  lens(lens: StudioLens): void;
  seek(to: "first" | "last" | -1 | 1): void;
  zoom(step: 1 | -1 | "fit"): void;
  step(direction: 1 | -1): void;
  nudge(dx: number, dy: number): void;
  remove(): void;
  duplicate(): void;
  reorder(step: 1 | -1): void;
  undo(): void;
  redo(): void;
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
  if (key === "Escape") {
    if (!act.dismiss()) act.close();
    return true;
  }
  if (typing(event.target)) return false;
  if (command && !event.altKey) {
    const lower = key.toLowerCase();
    if (lower === "z") (event.shiftKey ? act.redo : act.undo)();
    else if (lower === "y" && event.ctrlKey) act.redo();
    else if (lower === "d") act.duplicate();
    else return false;
    return true;
  }
  if (command) return false;
  const arrow = ARROWS[key];
  if (arrow !== undefined) {
    if (!act.onCanvas(event.target)) return false;
    if (event.altKey) act.step(arrow[0] + arrow[1] > 0 ? 1 : -1);
    else {
      const far = event.shiftKey ? NUDGE_FAR : 1;
      act.nudge(arrow[0] * far, arrow[1] * far);
    }
    return true;
  }
  if (event.altKey) return false;
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
  else return false;
  return true;
}
