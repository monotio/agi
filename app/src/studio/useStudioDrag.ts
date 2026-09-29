/**
 * Direct manipulation on the Room Studio canvas, following vector editors
 * (Figma, Inkscape, tldraw): selecting and moving are separate gestures.
 *
 * - A press on the selection (any of its pixels, on every plane) drags it:
 *   the one item, or all of several as one batch and one undo step.
 * - A plain press anywhere else draws a selection box that replaces the
 *   selection with the items lying wholly inside it; Shift+press draws one
 *   that adds to it. A press in the margin around the picture does the same.
 * - A click (no drag) selects the item under the pointer, Shift+click adds
 *   or removes it, and a click in the margin clears the selection. A click
 *   on a selection of several selects just the item clicked.
 * - A press on a handle drags that point (setPoint); an Alt+press by the
 *   selected item's line adds a point on its nearest segment and drags the
 *   new point (insertPoint, one undo step with the drag).
 *
 * The Point tool (`movesItems` false) never moves items or draws a plain
 * box: its press selects, and its handles drag points.
 *
 * A move stops at the picture's edge: its offset is cut, per axis, to the
 * largest that keeps every moved coordinate on the surface (limitMove), so
 * the preview and the recorded step agree. A move stopped dead says which
 * item is at which edge.
 *
 * The pane captures the pointer, so the drag follows it past the edge.
 * Pointer moves only store the latest cell; one animation frame previews the
 * edit from the gesture's start, so a burst of moves costs one kernel run.
 * Release records one undo step or snaps back with the reason; a cancelled
 * pointer or Escape abandons the drag.
 */

import { nextTick, readonly, ref } from "vue";
import {
  limitMove,
  type EditOperation,
  type MoveLimit,
} from "../../../src/studio/editOperations.ts";
import { onSurface } from "../../../src/studio/editSource.ts";
import type { LineHandle, PointInsertion } from "../../../src/studio/editPoints.ts";
import type { ViewportPoint } from "../../../src/studio/viewport.ts";
import type { PanePress } from "./StudioCanvas.vue";
import { edgeRefusal } from "./studioMessages.ts";
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
  /**
   * A selection box let go: select the items inside `box` (logical cells,
   * inclusive), added to the selection (Shift) or in its place.
   */
  readonly marquee?: (box: RectCorners, add: boolean) => void;
  /** Select what a click lands on (and pin the cell). */
  readonly pick: (cell: ViewportPoint) => void;
  /** A click in the margin around the picture: select nothing. */
  readonly clear?: () => void;
  /** Whether `cell` shows the selection, on either plane. */
  readonly onSelection: (cell: ViewportPoint) => boolean;
  /** The item's label, for the undo step. */
  readonly labelOf: (id: string) => string;
  /** Say what happened: a refusal, or null when the edit went through. */
  readonly report: (outcome: DraftOutcome) => void;
  /** Items `ids` were moved (a whole-item drag, kept). */
  readonly moved?: (ids: readonly string[]) => void;
  /** Whether a press on the selection drags it and elsewhere draws a box; false for the Point tool. */
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

/** A selection box: a click selects (or toggles, or clears) instead. */
interface Lasso {
  readonly start: ViewportPoint;
  /** Shift: the box adds to the selection, and a click toggles. */
  readonly add: boolean;
  moved: boolean;
}

export function useStudioDrag(options: StudioDragOptions) {
  const frame = options.frame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  const dragging = ref(false);
  let armed: Armed | null = null;
  let pending: number | null = null;
  /** A press that selects: a click picks, a drag draws the marquee. */
  let lasso: Lasso | null = null;
  /** The marquee being drawn, in logical cells; undefined when none is. */
  const marqueeBox = ref<RectCorners>();
  const boxOf = (a: ViewportPoint, b: ViewportPoint): RectCorners => ({
    x1: Math.max(0, Math.min(a.x, b.x)),
    y1: Math.max(0, Math.min(a.y, b.y)),
    x2: Math.min(159, Math.max(a.x, b.x)),
    y2: Math.min(167, Math.max(a.y, b.y)),
  });

  /** A move's offset, stopped at the picture's edge; undefined for a point edit. */
  function limitOf(drag: Armed): MoveLimit | undefined {
    if (drag.handle || drag.insert) return undefined;
    return limitMove(
      options.draft.document.value,
      drag.itemIds ?? [drag.itemId],
      drag.latest.x - drag.start.x,
      drag.latest.y - drag.start.y,
    );
  }

  /** The refusal when a move cannot go even one pixel the way it is dragged. */
  function stoppedDead(drag: Armed, limit: MoveLimit | undefined): DraftOutcome | undefined {
    const stop = limit?.stops[0];
    if (!limit || !stop || limit.dx !== 0 || limit.dy !== 0) return undefined;
    const dx = drag.latest.x - drag.start.x;
    const dy = drag.latest.y - drag.start.y;
    return {
      ok: false,
      refusal: { kind: "kernel", ...edgeRefusal(options.draft.document.value, stop, dx, dy) },
    };
  }

  function operation(drag: Armed, limit: MoveLimit | undefined): DraftEdit {
    const dx = limit?.dx ?? drag.latest.x - drag.start.x;
    const dy = limit?.dy ?? drag.latest.y - drag.start.y;
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
    const limit = limitOf(drag);
    const outcome = options.draft.moveGesture(operation(drag, limit));
    options.report(stoppedDead(drag, limit) ?? outcome);
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
    armed = null;
    lasso = null;
    const moves = options.movesItems?.() ?? true;
    if (!handle && !onSurface(cell.x, cell.y)) {
      // The margin around the picture is empty canvas.
      if (moves) lasso = { start: cell, add: event.shiftKey, moved: false };
      return;
    }
    if (event.shiftKey && !handle && options.extend) {
      lasso = { start: cell, add: true, moved: false };
      return;
    }
    const several = options.editableIds?.() ?? [];
    if (several.length > 1 && !handle && moves && options.onSelection(cell)) {
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
    if (!moves) {
      options.pick(cell);
      return;
    }
    if (selected !== undefined && options.onSelection(cell)) {
      armed = { start: cell, latest: cell, itemId: selected, handle: undefined, started: false };
      return;
    }
    lasso = { start: cell, add: false, moved: false };
  }

  function drag({ cell }: PanePress): void {
    if (lasso) {
      lasso.moved ||= cell.x !== lasso.start.x || cell.y !== lasso.start.y;
      if (!lasso.moved) return;
      const box = boxOf(lasso.start, cell);
      // A box wholly in the margin covers no cell of the picture.
      marqueeBox.value = box.x1 <= box.x2 && box.y1 <= box.y2 ? box : undefined;
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
    const selecting = lasso;
    lasso = null;
    if (selecting) {
      marqueeBox.value = undefined;
      const { start: at, add } = selecting;
      if (selecting.moved) options.marquee?.(boxOf(at, press.cell), add);
      else if (!onSurface(at.x, at.y)) {
        if (!add) options.clear?.();
      } else if (add) options.extend?.(at);
      else options.pick(at);
      return;
    }
    const current = armed;
    armed = null;
    stopFrame();
    // A click on the selection, without a drag, selects just the item clicked.
    if (current && !current.started && !current.handle) options.pick(current.start);
    if (!current?.started) return;
    current.latest = press.cell;
    dragging.value = false;
    const limit = limitOf(current);
    const stopped = stoppedDead(current, limit);
    if (stopped) {
      options.draft.cancelGesture();
      options.report(stopped);
      return;
    }
    const outcome = options.draft.endGesture(operation(current, limit), label(current));
    options.report(outcome);
    if (outcome.ok && limit && (limit.dx !== 0 || limit.dy !== 0))
      options.moved?.(current.itemIds ?? [current.itemId]);
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
