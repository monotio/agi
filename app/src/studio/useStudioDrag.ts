/**
 * Direct manipulation on the Room Studio canvas. A press on a handle drags
 * that point (setPoint); a press on the selected item, or on an item it
 * selects, drags the item (moveItem). The pane captures the pointer, so the
 * drag follows it past the edge. Pointer moves only store the latest cell;
 * one animation frame previews the edit from the gesture's start, so a burst
 * of moves costs one kernel run. Release records one undo step or snaps
 * back with the reason; a cancelled pointer or Escape abandons the drag.
 */

import { nextTick, readonly, ref } from "vue";
import type { EditOperation } from "../../../src/studio/editOperations.ts";
import type { LineHandle } from "../../../src/studio/editPoints.ts";
import type { ViewportPoint } from "../../../src/studio/viewport.ts";
import type { PanePress } from "./StudioCanvas.vue";
import type { StudioDraft, DraftOutcome } from "./useStudioDraft.ts";

export interface StudioDragOptions {
  readonly draft: StudioDraft;
  /** The id of the selected item, when it is one the creator may edit. */
  readonly editableId: () => string | undefined;
  /** Select what a press lands on (and pin the cell), as a click would. */
  readonly pick: (cell: ViewportPoint) => void;
  /** Whether `cell` shows the selected item on the current lens. */
  readonly onSelection: (cell: ViewportPoint) => boolean;
  /** The item's label, for the undo step. */
  readonly labelOf: (id: string) => string;
  /** Say what happened: a refusal, or null when the edit went through. */
  readonly report: (outcome: DraftOutcome) => void;
  /** Whether a press on the item body drags it; false for the Point tool (handles only). */
  readonly movesItems?: () => boolean;
  /** Wait for an animation frame; injectable for tests. */
  readonly frame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
}

interface Armed {
  readonly start: ViewportPoint;
  readonly itemId: string;
  readonly handle: LineHandle | undefined;
  started: boolean;
  latest: ViewportPoint;
}

export function useStudioDrag(options: StudioDragOptions) {
  const frame = options.frame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  const dragging = ref(false);
  let armed: Armed | null = null;
  let pending: number | null = null;

  function operation(drag: Armed): EditOperation {
    const dx = drag.latest.x - drag.start.x;
    const dy = drag.latest.y - drag.start.y;
    const { handle } = drag;
    if (handle)
      return {
        type: "setPoint",
        line: handle.line,
        pointIndex: handle.index,
        x: handle.x + dx,
        y: handle.y + dy,
      };
    return { type: "moveItem", itemId: drag.itemId, dx, dy };
  }
  const label = (drag: Armed): string =>
    `${drag.handle ? "Move point of" : "Move"} ${options.labelOf(drag.itemId)}`;

  function preview(): void {
    pending = null;
    const drag = armed;
    if (!drag?.started) return;
    const start = performance.now();
    const outcome = options.draft.moveGesture(operation(drag));
    options.report(outcome);
    // The frame's cost: the kernel, the checks and the canvas repaint (a post-flush watcher).
    void nextTick(() =>
      performance.measure?.("studio:drag-frame", { start, end: performance.now() }),
    );
  }

  function press({ cell, handle }: PanePress): void {
    const selected = options.editableId();
    if (handle && selected !== undefined) {
      armed = { start: cell, latest: cell, itemId: selected, handle, started: false };
      return;
    }
    options.pick(cell);
    const now = options.editableId();
    armed =
      now !== undefined && (options.movesItems?.() ?? true) && options.onSelection(cell)
        ? { start: cell, latest: cell, itemId: now, handle: undefined, started: false }
        : null;
  }

  function drag({ cell }: PanePress): void {
    const current = armed;
    if (!current) return;
    current.latest = cell;
    if (!current.started) {
      if (cell.x === current.start.x && cell.y === current.start.y) return;
      current.started = true;
      dragging.value = true;
      options.draft.beginGesture(label(current));
    }
    pending ??= frame(preview);
  }

  function stopFrame(): void {
    if (pending !== null) cancelFrame(pending);
    pending = null;
  }

  function release(press: PanePress): void {
    const current = armed;
    armed = null;
    stopFrame();
    if (!current?.started) return;
    current.latest = press.cell;
    dragging.value = false;
    options.report(options.draft.endGesture(operation(current), label(current)));
  }

  /** Abandon a drag in progress: nothing changes. Returns whether one was. */
  function abort(): boolean {
    const current = armed;
    armed = null;
    stopFrame();
    if (!current?.started) return false;
    dragging.value = false;
    options.draft.cancelGesture();
    options.report({ ok: true });
    return true;
  }

  return { dragging: readonly(dragging), press, drag, release, abort };
}
