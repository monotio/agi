import assert from "node:assert/strict";
import { test } from "node:test";
import { computed, ref } from "vue";
import type { SceneRow } from "../src/studio/useStudioDocument.ts";
import { describeRow, useStudioSelection } from "../src/studio/useStudioSelection.ts";

const row = (id: string, label: string, kind: SceneRow["kind"], commands: number): SceneRow => ({
  id,
  label,
  kind,
  locked: false,
  entries: Array.from({ length: commands }, (_, k) => k),
  swatch: null,
  value: null,
  tag: kind,
});
const ROWS = [
  row("wall", "Wall", "art", 2),
  row("bench", "Bench", "depth", 4),
  row("exit", "Exit", "walk", 1),
];
/** Cell owners: x 0 is the wall, x 1 the bench, anything else nothing. */
const owner = (x: number): string | undefined => (x === 0 ? "wall" : x === 1 ? "bench" : undefined);

function setup() {
  const filter = ref("");
  const rows = computed(() => ROWS.filter((r) => r.label.toLowerCase().includes(filter.value)));
  const selection = useStudioSelection({ rows, allRows: ROWS, rowAt: (x) => owner(x) });
  return { filter, selection };
}

test("the canvas hovers the owning row and a list hover wins over it", () => {
  const { selection } = setup();
  assert.equal(selection.hoveredId.value, undefined);
  selection.canvasCell.value = { x: 1, y: 7 };
  assert.equal(selection.hoveredId.value, "bench");
  assert.equal(selection.hoveredRow.value?.label, "Bench");
  selection.listHover.value = "exit";
  assert.equal(selection.hoveredId.value, "exit");
  selection.listHover.value = undefined;
  selection.canvasCell.value = { x: 5, y: 7 };
  assert.equal(selection.hoveredId.value, undefined);
});

test("a canvas click pins the cell and selects its owner, or clears the selection", () => {
  const { selection } = setup();
  selection.pick({ x: 0, y: 3 });
  assert.equal(selection.selectedId.value, "wall");
  assert.deepEqual(selection.inspectedCell.value, { x: 0, y: 3 });
  selection.canvasCell.value = { x: 1, y: 3 };
  assert.deepEqual(selection.inspectedCell.value, { x: 1, y: 3 });
  selection.canvasCell.value = undefined;
  selection.pick({ x: 9, y: 9 });
  assert.equal(selection.selectedId.value, undefined);
  assert.deepEqual(selection.inspectedCell.value, { x: 9, y: 9 });
});

test("stepping walks the visible rows and stops at either end", () => {
  const { selection, filter } = setup();
  assert.equal(selection.step(1), true);
  assert.equal(selection.selectedId.value, "wall");
  assert.equal(selection.step(1), true);
  assert.equal(selection.step(1), true);
  assert.equal(selection.selectedId.value, "exit");
  assert.equal(selection.step(1), false);
  assert.equal(selection.selectedId.value, "exit");

  selection.selectedId.value = undefined;
  assert.equal(selection.step(-1), true);
  assert.equal(selection.selectedId.value, "exit");

  // A filter hides rows from stepping but keeps the selection readable.
  filter.value = "b";
  assert.equal(selection.selectedRow.value?.label, "Exit");
  assert.equal(selection.step(1), true);
  assert.equal(selection.selectedId.value, "bench");
  assert.equal(selection.step(1), false);
});

test("from a selected group, next is its first member and previous the item before it", () => {
  const rows = [...ROWS, row("pond", "Pond", "mixed", 1)];
  // "(group)bench" stands for bench and exit.
  const membersOf = (id: string) => (id === "(group)bench" ? ["bench", "exit"] : undefined);
  const selection = useStudioSelection({ rows, allRows: rows, rowAt: () => undefined, membersOf });
  selection.selectedId.value = "(group)bench";
  assert.equal(selection.step(1), true);
  assert.equal(selection.selectedId.value, "bench");
  selection.selectedId.value = "(group)bench";
  assert.equal(selection.step(-1), true);
  assert.equal(selection.selectedId.value, "wall");
});

test("selection is announced as label, kind and command count", () => {
  const { selection } = setup();
  assert.equal(selection.announcement.value, "");
  selection.selectedId.value = "bench";
  assert.equal(selection.announcement.value, "Bench, depth, 4 commands");
  selection.selectedId.value = "exit";
  assert.equal(selection.announcement.value, "Exit, walk, 1 command");
  assert.equal(
    describeRow(row("(unassigned)", "Unassigned", "loose", 3)),
    "Unassigned, not in an item, 3 commands",
  );
});
