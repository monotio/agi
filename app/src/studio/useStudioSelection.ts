/**
 * Hover and selection for the Room Studio. A row hovered in the Scene list
 * wins over the canvas; otherwise the row that owns the hovered cell is
 * hovered, so each side highlights the other. Selection is explicit (a row
 * click, a canvas click or arrow-key stepping on the canvas) and is announced
 * in words.
 */

import { computed, ref, toValue, type MaybeRefOrGetter } from "vue";
import type { ViewportPoint } from "../../../src/studio/viewport.ts";
import type { SceneRow } from "./useStudioDocument.ts";

export interface StudioSelectionOptions {
  /** The item rows the canvas arrows step through, in draw order (the Scene list as filtered). */
  rows: MaybeRefOrGetter<readonly SceneRow[]>;
  /** Every row and group, for lookups (selection survives a filter that hides it). */
  allRows: MaybeRefOrGetter<readonly SceneRow[]>;
  /** A group's member ids, or undefined for an item. */
  membersOf?: (id: string) => readonly string[] | undefined;
  /** The row owning a cell under the current lens, if any. */
  rowAt: (x: number, y: number) => string | undefined;
}

/** "Bench, depth, 4 commands". */
export function describeRow(row: Pick<SceneRow, "label" | "kind" | "entries">): string {
  const n = row.entries.length;
  const kind = row.kind === "loose" ? "not in an item" : row.kind;
  return `${row.label}, ${kind}, ${n} ${n === 1 ? "command" : "commands"}`;
}

export function useStudioSelection({
  rows,
  allRows,
  rowAt,
  membersOf = () => undefined,
}: StudioSelectionOptions) {
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
   * Select the next (+1) or previous (-1) item. From a selected group, next
   * is its first member and previous the item before it. Returns false at
   * either end, where the selection stays.
   */
  function step(direction: 1 | -1): boolean {
    const list = toValue(rows);
    if (list.length === 0) return false;
    const id = selectedId.value;
    const members = id === undefined ? undefined : membersOf(id);
    const anchor = members ? members[0] : id;
    const current = list.findIndex((row) => row.id === anchor);
    let next: number;
    if (current < 0) next = direction > 0 ? 0 : list.length - 1;
    // A group sits just before its first member.
    else if (members) next = direction > 0 ? current : current - 1;
    else next = current + direction;
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

export type StudioSelection = ReturnType<typeof useStudioSelection>;
