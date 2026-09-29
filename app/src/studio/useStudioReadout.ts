/**
 * What Room Studio reads out about its model: the scrubber's ticks and
 * current command, the selected row's commands and the values it draws, the
 * inspected pixel (and why a fill at the playhead does or does not reach it),
 * and the status line. Derived only; nothing here edits.
 */

import { computed } from "vue";
import { pictureCommandText } from "../../../src/studio/pictureDocument.ts";
import { tickFor } from "./studioView.ts";
import type { StudioDocument } from "./useStudioDocument.ts";
import type { StudioSelection } from "./useStudioSelection.ts";

export function useStudioReadout(options: {
  readonly doc: StudioDocument;
  readonly selection: StudioSelection;
}) {
  const { doc, selection } = options;
  const { model, playhead, total } = doc;

  const commandText = (entry: number): string => {
    const line = model.value.timeline[entry]?.line;
    return line === undefined ? "" : pictureCommandText(model.value.document.lines[line - 1] ?? "");
  };
  /** One tick per drawing command; the closing `end` draws nothing and gets none. */
  const ticks = computed(() => model.value.timeline.slice(0, total.value).map(tickFor));
  /** The last drawn command: the item it belongs to, and its text. */
  const current = computed(() => {
    const entry = model.value.timeline[playhead.value - 1];
    if (!entry) return { item: "", text: "" };
    const owner =
      entry.itemId === undefined ? undefined : model.value.rows.find((r) => r.id === entry.itemId);
    return { item: owner?.label ?? "", text: commandText(playhead.value - 1) };
  });

  /** The values the selected row's drawing commands use on a plane, ascending. */
  const drawn = (pick: "visual" | "priority"): number[] => {
    const row = selection.selectedRow.value;
    if (!row) return [];
    const values = row.entries
      .map((k) => model.value.timeline[k]!)
      .filter((entry) => tickFor(entry).kind !== "state")
      .map((entry) => entry[pick])
      .filter((value): value is number => value !== null);
    return [...new Set(values)].sort((a, b) => a - b);
  };
  /** The one value the selected row draws on a plane: null for none, undefined for several. */
  const single = (pick: "visual" | "priority"): number | null | undefined => {
    const values = drawn(pick);
    return values.length === 0 ? null : values.length === 1 ? values[0] : undefined;
  };
  const commands = computed(() =>
    (selection.selectedRow.value?.entries ?? []).map((entry) => ({
      entry,
      line: model.value.timeline[entry]!.line,
      text: commandText(entry),
    })),
  );
  const pixel = computed(() => {
    const cell = selection.inspectedCell.value;
    return cell ? doc.pixelInfo(cell.x, cell.y) : null;
  });
  const fill = computed(() => {
    const cell = selection.pinnedCell.value;
    return cell && playhead.value > 0
      ? doc.explainFill(playhead.value - 1, cell.x, cell.y)
      : undefined;
  });
  const labelOf = (id: string): string =>
    [...model.value.rows, ...model.value.folds].find((row) => row.id === id)?.label ?? id;
  /** The pixel in plain words: where, its colour and depth, and the step that last drew it. */
  const status = computed(() => {
    const info = pixel.value;
    if (!info) return "Point at a pixel";
    const writer = info.visual.entry ?? info.priority.entry;
    const step = writer === null ? "" : ` · step ${writer + 1}`;
    return `x ${info.x} y ${info.y} · colour ${info.visual.value} · depth ${info.priority.value}${step}`;
  });

  return { ticks, current, drawn, single, commands, pixel, fill, labelOf, status };
}
