/**
 * Sound Studio's keyboard. Presses inside the studio stop at its root so none
 * reaches a paused game behind the overlay. Fields keep their own keys; the
 * timeline answers arrows/Home/End/Delete, `N` adds a note, `R` a rest, Space
 * toggles the preview, and Cmd/Ctrl+Z / Shift+Cmd+Z (or Ctrl+Y) undo and redo.
 * Esc lets go of the current selection; it never closes the workspace.
 */

export interface SoundStudioKeyActions {
  /** True when the event's target is the timeline's focus surface. */
  onTimeline(target: EventTarget | null): boolean;
  /** Esc: clear the event selection or a transient notice. */
  dismiss(): boolean;
  step(direction: 1 | -1): void;
  lane(direction: 1 | -1): void;
  jump(to: "first" | "last"): void;
  remove(): void;
  insertNote(): void;
  insertRest(): void;
  undo(): void;
  redo(): void;
  /** Space on the timeline: toggle the private preview. */
  togglePlay(): void;
}

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** Handle one key; true when it was a studio shortcut (default prevented). */
export function soundStudioKey(event: KeyboardEvent, act: SoundStudioKeyActions): boolean {
  if (event.defaultPrevented) return false;
  const { key } = event;
  const command = event.metaKey || event.ctrlKey;
  if (typing(event.target)) {
    // Esc leaves the field, never the workspace.
    if (key !== "Escape") return false;
    (event.target as HTMLElement).blur();
    return true;
  }
  if (key === "Escape") {
    act.dismiss();
    return true;
  }
  if (command && !event.altKey) {
    const lower = key.toLowerCase();
    if (lower === "z") (event.shiftKey ? act.redo : act.undo)();
    else if (lower === "y" && event.ctrlKey) act.redo();
    else return false;
    return true;
  }
  if (command || event.altKey) return false;
  if (key === " " && act.onTimeline(event.target)) {
    if (!event.repeat) act.togglePlay();
    return true;
  }
  const lanes: Record<string, 1 | -1> = { ArrowUp: -1, ArrowDown: 1 };
  if (key === "ArrowLeft" || key === "ArrowRight") {
    if (!act.onTimeline(event.target)) return false;
    act.step(key === "ArrowRight" ? 1 : -1);
    return true;
  }
  if (lanes[key] !== undefined) {
    if (!act.onTimeline(event.target)) return false;
    act.lane(lanes[key]);
    return true;
  }
  if (key === "Home") {
    if (!act.onTimeline(event.target)) return false;
    act.jump("first");
    return true;
  }
  if (key === "End") {
    if (!act.onTimeline(event.target)) return false;
    act.jump("last");
    return true;
  }
  if (key === "Delete" || key === "Backspace") {
    if (!act.onTimeline(event.target)) return false;
    act.remove();
    return true;
  }
  if (key.toLowerCase() === "n" && act.onTimeline(event.target)) {
    if (!event.repeat) act.insertNote();
    return true;
  }
  if (key.toLowerCase() === "r" && act.onTimeline(event.target)) {
    if (!event.repeat) act.insertRest();
    return true;
  }
  return false;
}
