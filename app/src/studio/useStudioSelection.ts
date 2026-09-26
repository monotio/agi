/**
 * Hover and selection for the Room Studio. A row hovered in the Scene list
 * wins over the canvas; otherwise the row that owns the hovered cell is
 * hovered, so each side highlights the other. Selection is explicit (a row
 * click, a canvas click or Tab stepping) and is announced in words.
 */

import { computed, ref, toValue, type MaybeRefOrGetter } from "vue";
import type { ViewportPoint } from "../../../src/studio/viewport.ts";
import type { SceneRow } from "./useStudioDocument.ts";

export interface StudioSelectionOptions {
  /** The rows Tab steps through, in order (the Scene list as filtered). */
  rows: MaybeRefOrGetter<readonly SceneRow[]>;
  /** Every row, for lookups (selection survives a filter that hides it). */
  allRows: MaybeRefOrGetter<readonly SceneRow[]>;
  /** The row owning a cell under the current lens, if any. */
  rowAt: (x: number, y: number) => string | undefined;
}

/** "Bench, depth, 4 commands". */
export function describeRow(row: Pick<SceneRow, "label" | "kind" | "entries">): string {
  const n = row.entries.length;
  const kind = row.kind === "loose" ? "not in an item" : row.kind;
  return `${row.label}, ${kind}, ${n} ${n === 1 ? "command" : "commands"}`;
}

export function useStudioSelection({ rows, allRows, rowAt }: StudioSelectionOptions) {
  const listHover = ref<string>();
  const canvasCell = ref<ViewportPoint>();
  /** The last clicked cell; the inspector falls back to it when nothing is hovered. */
  const pinnedCell = ref<ViewportPoint>();
  const selectedId = ref<string>();

  const canvasRowId = computed(() =>
    canvasCell.value ? rowAt(canvasCell.value.x, canvasCell.value.y) : undefined,
  );
  const hoveredId = computed(() => listHover.value ?? canvasRowId.value);
  const inspectedCell = computed(() => canvasCell.value ?? pinnedCell.value);
  const find = (id: string | undefined): SceneRow | undefined =>
    id === undefined ? undefined : toValue(allRows).find((row) => row.id === id);
  const selectedRow = computed(() => find(selectedId.value));
  const hoveredRow = computed(() => find(hoveredId.value));
  const announcement = computed(() => (selectedRow.value ? describeRow(selectedRow.value) : ""));

  /** Click on the canvas: pin the cell and select its owner (or clear the selection). */
  function pick(cell: ViewportPoint): void {
    pinnedCell.value = cell;
    selectedId.value = rowAt(cell.x, cell.y);
  }

  /**
   * Select the next (+1) or previous (-1) row. Returns false at either end so
   * the caller lets Tab move focus on instead of trapping it.
   */
  function step(direction: 1 | -1): boolean {
    const list = toValue(rows);
    if (list.length === 0) return false;
    const current = list.findIndex((row) => row.id === selectedId.value);
    const next = current < 0 ? (direction > 0 ? 0 : list.length - 1) : current + direction;
    if (next < 0 || next >= list.length) return false;
    selectedId.value = list[next]!.id;
    return true;
  }

  return {
    listHover,
    canvasCell,
    pinnedCell,
    selectedId,
    hoveredId,
    inspectedCell,
    selectedRow,
    hoveredRow,
    announcement,
    pick,
    step,
  };
}
