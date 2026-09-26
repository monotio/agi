/**
 * Sprite Studio's keyboard. Every key pressed inside the studio stops at its
 * root, so none reaches the paused game or its parser. Widgets keep the keys
 * they use (the timeline's cels, the palette, fields and menus prevent the
 * default of what they handle); the rest are studio shortcuts:
 *
 * - the rail's letters (useSpriteTools.ts SPRITE_TOOL_KEYS: B E G L R M I C,
 *   and H to flip); Esc cancels a stroke or selection, closes the contact
 *   sheet or the recolour tool, then leaves Studio. In a text field Esc is
 *   the field's (it reverts or leaves the field) and never leaves Studio
 * - on the focused canvas: arrows move the cursor 1 px (Shift: 8), or the
 *   selection (Alt: a copy); Space or Enter clicks at the cursor; Delete
 *   clears the selection
 * - `,` `.` the previous and next cel, `<` `>` the previous and next loop
 * - + - 0 zoom; Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z (or Ctrl+Y) redo
 */

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

/** Shift+arrow moves this far. */
export const ARROW_FAR = 8;

export interface SpriteKeyActions {
  /** Whether the canvas has focus (arrows, Space and Enter act on it only then). */
  onCanvas(target: EventTarget | null): boolean;
  /** Esc: cancel a stroke, drop the selection or close a panel first; true when it did. */
  dismiss(): boolean;
  close(): void;
  /** An arrow on the canvas: (dx, dy), `alt` held. */
  arrow(dx: number, dy: number, alt: boolean): void;
  /** Space or Enter on the canvas. */
  click(): void;
  /** Delete or Backspace. */
  remove(): void;
  /** The previous or next cel (`cel`) or loop (`loop`). */
  step(what: "cel" | "loop", direction: 1 | -1): void;
  zoom(step: 1 | -1 | "fit"): void;
  undo(): void;
  redo(): void;
  /** A tool rail letter, lower-cased; true when it named a tool (or the flip). */
  tool(key: string): boolean;
}

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** Handle one studio key; true when it was a studio shortcut (the default is then prevented). */
export function spriteKey(event: KeyboardEvent, act: SpriteKeyActions): boolean {
  if (event.defaultPrevented) return false;
  const { key } = event;
  const command = event.metaKey || event.ctrlKey;
  if (typing(event.target)) {
    // The field has had Esc first (a revert); it then leaves the field, not Studio.
    if (key !== "Escape") return false;
    (event.target as HTMLElement).blur();
    return true;
  }
  if (key === "Escape") {
    if (!act.dismiss()) act.close();
    return true;
  }
  if (command && !event.altKey) {
    const lower = key.toLowerCase();
    if (lower === "z") (event.shiftKey ? act.redo : act.undo)();
    else if (lower === "y" && event.ctrlKey) act.redo();
    else return false;
    return true;
  }
  if (command) return false;
  const canvas = act.onCanvas(event.target);
  const arrow = ARROWS[key];
  if (arrow !== undefined) {
    if (!canvas) return false;
    const far = event.shiftKey ? ARROW_FAR : 1;
    act.arrow(arrow[0] * far, arrow[1] * far, event.altKey);
    return true;
  }
  if ((key === " " || key === "Enter") && !event.altKey) {
    if (!canvas) return false;
    // A held key repeats: one press is one click.
    if (!event.repeat) act.click();
    return true;
  }
  if (event.altKey) return false;
  if (key === "Delete" || key === "Backspace") act.remove();
  else if (key === ",") act.step("cel", -1);
  else if (key === ".") act.step("cel", 1);
  else if (key === "<") act.step("loop", -1);
  else if (key === ">") act.step("loop", 1);
  else if (key === "+" || key === "=") act.zoom(1);
  else if (key === "-") act.zoom(-1);
  else if (key === "0") act.zoom("fit");
  else return key.length === 1 && act.tool(key.toLowerCase());
  return true;
}
