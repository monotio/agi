/**
 * Direct manipulation on the Room Studio canvas. A press on a handle drags
 * that point (setPoint); an Alt+press by the selected item's line adds a
 * point on its nearest segment and drags the new point (insertPoint, one
 * undo step with the drag); a press on the selected item, or on an item it
 * selects, drags the item (moveItem). The pane captures the pointer, so the
 * drag follows it past the edge. Pointer moves only store the latest cell;
 * one animation frame previews the edit from the gesture's start, so a burst
 * of moves costs one kernel run. Release records one undo step or snaps
 * back with the reason; a cancelled pointer or Escape abandons the drag.
 *
 * With several items selected, a press on any of them drags them all (one
 * batch of moves, one undo step) and keeps the selection; a click without a
 * drag selects just the item clicked. Shift+click adds
 * the item under the pointer or takes it away; Shift+drag draws a marquee
 * whose box selects the items inside it.
 */

import { nextTick, readonly, ref } from "vue";
import type { EditOperation } from "../../../src/studio/editOperations.ts";
import type { LineHandle, PointInsertion } from "../../../src/studio/editPoints.ts";
import type { ViewportPoint } from "../../../src/studio/viewport.ts";
import type { PanePress } from "./StudioCanvas.vue";
import type { RectCorners } from "./studioTools.ts";
import type { DraftEdit, StudioDraft, DraftOutcome } from "./useStudioDraft.ts";

export interface StudioDragOptions {
  readonly draft: StudioDraft;
  /** The id of the selected item, when it is one the creator may edit. */
  readonly editableId: () => string | undefined;
  /** The selected items, when there are several the creator may edit: they move as one. */
  readonly editableIds?: () => readonly string[];
  /** Shift+click at `cell`: add its item to the selection or take it away. */
  readonly extend?: (cell: ViewportPoint) => void;
  /** Shift+drag let go: select the items inside `box` (logical cells, inclusive). */
  readonly marquee?: (box: RectCorners) => void;
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
  /** Where an Alt+press at `cell` adds a point to the item's line; undefined when it adds none. */
  readonly insertAt?: (itemId: string, cell: ViewportPoint) => PointInsertion | undefined;
  /** Wait for an animation frame; injectable for tests. */
  readonly frame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
}

interface Armed {
  readonly start: ViewportPoint;
  readonly itemId: string;
  /** Several items moving together (itemId is the first). */
  readonly itemIds?: readonly string[];
  readonly handle: LineHandle | undefined;
  /** The point an Alt+press adds, which the drag then moves. */
  readonly insert?: PointInsertion;
  started: boolean;
  latest: ViewportPoint;
}

export function useStudioDrag(options: StudioDragOptions) {
  const frame = options.frame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  const dragging = ref(false);
  let armed: Armed | null = null;
  let pending: number | null = null;
  /** A Shift+press: a click toggles, a drag draws the marquee. */
  let lasso: { start: ViewportPoint; moved: boolean } | null = null;
  /** The marquee being drawn, in logical cells; undefined when none is. */
  const marqueeBox = ref<RectCorners>();
  const boxOf = (a: ViewportPoint, b: ViewportPoint): RectCorners => ({
    x1: Math.max(0, Math.min(a.x, b.x)),
    y1: Math.max(0, Math.min(a.y, b.y)),
    x2: Math.min(159, Math.max(a.x, b.x)),
    y2: Math.min(167, Math.max(a.y, b.y)),
  });

  function operation(drag: Armed): DraftEdit {
    const dx = drag.latest.x - drag.start.x;
    const dy = drag.latest.y - drag.start.y;
    if (drag.itemIds)
      return drag.itemIds.map((itemId): EditOperation => ({ type: "moveItem", itemId, dx, dy }));
    const { handle, insert } = drag;
    if (insert)
      return {
        type: "insertPoint",
        itemId: drag.itemId,
        line: insert.line,
        pointIndex: insert.pointIndex,
        x: insert.x + dx,
        y: insert.y + dy,
      };
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
    drag.itemIds
      ? `Move ${drag.itemIds.length} items`
      : `${drag.insert ? "Add point to" : drag.handle ? "Move point of" : "Move"} ${options.labelOf(drag.itemId)}`;

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

  /** Start a gesture: the undo step it records, and its first preview on the next frame. */
  function start(drag: Armed): void {
    drag.started = true;
    dragging.value = true;
    options.draft.beginGesture(label(drag));
    pending ??= frame(preview);
  }

  function press({ event, cell, handle }: PanePress): void {
    if (event.shiftKey && !handle && options.extend) {
      armed = null;
      lasso = { start: cell, moved: false };
      return;
    }
    const several = options.editableIds?.() ?? [];
    if (
      several.length > 1 &&
      !handle &&
      (options.movesItems?.() ?? true) &&
      options.onSelection(cell)
    ) {
      armed = {
        start: cell,
        latest: cell,
        itemId: several[0]!,
        itemIds: several,
        handle: undefined,
        started: false,
      };
      return;
    }
    const selected = options.editableId();
    const insert =
      event.altKey && !handle && selected !== undefined
        ? options.insertAt?.(selected, cell)
        : undefined;
    if (insert && selected !== undefined) {
      // The point exists from the press: a click adds it, a drag places it.
      armed = { start: cell, latest: cell, itemId: selected, handle, insert, started: false };
      start(armed);
      return;
    }
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
    if (lasso) {
      lasso.moved ||= cell.x !== lasso.start.x || cell.y !== lasso.start.y;
      if (lasso.moved) marqueeBox.value = boxOf(lasso.start, cell);
      return;
    }
    const current = armed;
    if (!current) return;
    current.latest = cell;
    if (!current.started) {
      if (cell.x === current.start.x && cell.y === current.start.y) return;
      start(current);
    }
    pending ??= frame(preview);
  }

  function stopFrame(): void {
    if (pending !== null) cancelFrame(pending);
    pending = null;
  }

  function release(press: PanePress): void {
    const shifted = lasso;
    lasso = null;
    if (shifted) {
      marqueeBox.value = undefined;
      if (!shifted.moved) options.extend?.(shifted.start);
      else options.marquee?.(boxOf(shifted.start, press.cell));
      return;
    }
    const current = armed;
    armed = null;
    stopFrame();
    // A click on a selection of several, without a drag, selects just the item clicked.
    if (current?.itemIds && !current.started) options.pick(current.start);
    if (!current?.started) return;
    current.latest = press.cell;
    dragging.value = false;
    options.report(options.draft.endGesture(operation(current), label(current)));
  }

  /** Abandon a drag in progress: nothing changes. Returns whether one was. */
  function abort(): boolean {
    if (lasso) {
      lasso = null;
      marqueeBox.value = undefined;
      return true;
    }
    const current = armed;
    armed = null;
    stopFrame();
    if (!current?.started) return false;
    dragging.value = false;
    options.draft.cancelGesture();
    options.report({ ok: true });
    return true;
  }

  return {
    dragging: readonly(dragging),
    marqueeBox: readonly(marqueeBox),
    press,
    drag,
    release,
    abort,
  };
}
