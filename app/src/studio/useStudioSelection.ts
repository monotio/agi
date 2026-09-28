/**
 * Hover and selection for the Room Studio. A row hovered in the Scene list
 * wins over the canvas; otherwise the row that owns the hovered cell is
 * hovered, so each side highlights the other. Selection is explicit (a row
 * click, a canvas click or arrow-key stepping on the canvas) and is announced
 * in words.
 *
 * Several items can be selected and edited as one: Shift+click (canvas or
 * Scene list) adds an item or takes it away, a group row stands for all its
 * members, a marquee adds the items inside it, and Shift+Alt+arrows grow or
 * shrink a run of neighbours from where it started. `itemIds` is what the
 * selection covers, in draw order; a single row (an item or a group) stays
 * `selectedId`, and two rows or more read as one "N items" row.
 */

import { computed, ref, shallowRef, toValue, type MaybeRefOrGetter } from "vue";
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
  /** The picture's item ids in draw order; defaults to every row but Unassigned and the groups. */
  items?: MaybeRefOrGetter<readonly string[]>;
}

/** Row id of a selection of two rows or more (not a valid item id). */
const SEVERAL = "(selection)";

/** "Bench, depth, 4 steps". */
export function describeRow(row: Pick<SceneRow, "label" | "kind" | "entries">): string {
  const n = row.entries.length;
  const kind = row.kind === "loose" ? "not in an item" : row.kind;
  return `${row.label}, ${kind}, ${n} ${n === 1 ? "step" : "steps"}`;
}

export function useStudioSelection({
  rows,
  allRows,
  rowAt,
  membersOf = () => undefined,
  items,
}: StudioSelectionOptions) {
  const listHover = ref<string>();
  const canvasCell = ref<ViewportPoint>();
  /** The last clicked cell; the inspector falls back to it when nothing is hovered. */
  const pinnedCell = ref<ViewportPoint>();
  /** The selected rows: one item or group, or several items. */
  const selectedIds = shallowRef<readonly string[]>([]);
  /** A run grown with Shift+Alt+arrows: the item it started at and the one it reaches. */
  let run: { anchor: string; focus: string } | null = null;

  const itemOrder = computed(
    () =>
      toValue(items) ??
      toValue(allRows)
        .filter((row) => row.kind !== "loose" && membersOf(row.id) === undefined)
        .map((row) => row.id),
  );
  const isItem = (id: string): boolean => itemOrder.value.includes(id);
  /** The items `id` stands for: a group's members, an item itself, or none. */
  const itemsOf = (id: string): readonly string[] =>
    (membersOf(id) ?? [id]).filter((member) => isItem(member));
  const inOrder = (ids: Iterable<string>): string[] => {
    const set = new Set(ids);
    return itemOrder.value.filter((id) => set.has(id));
  };

  /** One row, or none: the selection as a single row (an item, a group, Unassigned). */
  const selectedId = computed<string | undefined>({
    get: () => (selectedIds.value.length === 1 ? selectedIds.value[0] : undefined),
    set: (id) => {
      run = null;
      selectedIds.value = id === undefined ? [] : [id];
    },
  });
  /** The items the selection covers, in draw order. */
  const itemIds = computed(() => inOrder(selectedIds.value.flatMap(itemsOf)));

  const canvasRowId = computed(() =>
    canvasCell.value ? rowAt(canvasCell.value.x, canvasCell.value.y) : undefined,
  );
  const hoveredId = computed(() => listHover.value ?? canvasRowId.value);
  const inspectedCell = computed(() => canvasCell.value ?? pinnedCell.value);
  const find = (id: string | undefined): SceneRow | undefined =>
    id === undefined ? undefined : toValue(allRows).find((row) => row.id === id);
  /** The selection as one row: the row itself, or for several items one that stands for them. */
  const selectedRow = computed<SceneRow | undefined>(() => {
    if (selectedIds.value.length <= 1) return find(selectedId.value);
    const parts = selectedIds.value.flatMap((id) => find(id) ?? []);
    const kinds = new Set(parts.map((row) => row.kind));
    const [kind] = kinds;
    return {
      id: SEVERAL,
      label: `${itemIds.value.length} items`,
      kind: kinds.size === 1 && kind !== undefined ? kind : "mixed",
      locked: parts.every((row) => row.locked),
      entries: [...new Set(parts.flatMap((row) => row.entries))].sort((a, b) => a - b),
      swatch: null,
      value: null,
      tag: "selection",
    };
  });
  const hoveredRow = computed(() => find(hoveredId.value));
  const announcement = computed(() => (selectedRow.value ? describeRow(selectedRow.value) : ""));

  /** Select exactly `ids` (items), in draw order; one item reads as that item. */
  function selectItems(ids: readonly string[]): void {
    run = null;
    selectedIds.value = inOrder(ids);
  }

  /** Shift+click: add `id` (an item, or a group's members), or take it away when all of it is in. */
  function toggle(id: string | undefined): void {
    if (id === undefined) return;
    const adding = itemsOf(id);
    if (adding.length === 0) return;
    const current = itemIds.value;
    const all = adding.every((member) => current.includes(member));
    selectItems(
      all ? current.filter((member) => !adding.includes(member)) : [...current, ...adding],
    );
  }

  /** Click on the canvas: pin the cell and select its owner (or clear); with `extend`, toggle it. */
  function pick(cell: ViewportPoint, extend = false): void {
    pinnedCell.value = cell;
    if (extend) toggle(rowAt(cell.x, cell.y));
    else selectedId.value = rowAt(cell.x, cell.y);
  }

  /**
   * Select the next (+1) or previous (-1) item. From a selected group, next
   * is its first member and previous the item before it; from several items,
   * the item after the last or before the first. Returns false at either
   * end, where the selection stays.
   */
  function step(direction: 1 | -1): boolean {
    const list = toValue(rows);
    if (list.length === 0) return false;
    const several = selectedIds.value.length > 1;
    const id = several
      ? direction > 0
        ? itemIds.value.at(-1)
        : itemIds.value[0]
      : selectedId.value;
    const members = id === undefined || several ? undefined : membersOf(id);
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

  /**
   * Shift+Alt+arrow: grow or shrink a run of neighbouring items. A new run
   * starts at the selection's first item going forward or its last going
   * back; its far end moves one item per press, over the items the canvas
   * arrows step through (the Scene list as filtered). False at either end.
   */
  function extend(direction: 1 | -1): boolean {
    const list = toValue(rows)
      .map((row) => row.id)
      .filter((id) => isItem(id));
    if (list.length === 0) return false;
    const at = (id: string): number => list.indexOf(id);
    const span = (a: number, b: number): string[] => list.slice(Math.min(a, b), Math.max(a, b) + 1);
    const covered = itemIds.value;
    let state = run;
    const same =
      state !== null &&
      at(state.anchor) >= 0 &&
      at(state.focus) >= 0 &&
      span(at(state.anchor), at(state.focus)).join() === covered.join();
    if (!state || !same) {
      const shown = covered.filter((id) => at(id) >= 0);
      if (shown.length === 0) {
        const start = list[direction > 0 ? 0 : list.length - 1]!;
        selectItems([start]);
        run = { anchor: start, focus: start };
        return true;
      }
      state =
        direction > 0
          ? { anchor: shown[0]!, focus: shown.at(-1)! }
          : { anchor: shown.at(-1)!, focus: shown[0]! };
    }
    const focus = at(state.focus) + direction;
    if (focus < 0 || focus >= list.length) return false;
    selectItems(span(at(state.anchor), focus));
    run = { anchor: state.anchor, focus: list[focus]! };
    return true;
  }

  return {
    listHover,
    canvasCell,
    pinnedCell,
    selectedId,
    selectedIds,
    itemIds,
    hoveredId,
    inspectedCell,
    selectedRow,
    hoveredRow,
    announcement,
    pick,
    step,
    toggle,
    extend,
    selectItems,
  };
}

export type StudioSelection = ReturnType<typeof useStudioSelection>;
