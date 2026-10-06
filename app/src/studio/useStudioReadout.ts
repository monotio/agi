/**
 * What Room Studio reads out about its model: the scrubber's ticks and
 * current command, the selected row's commands and the values it draws, the
 * inspected pixel (and why a fill at the playhead does or does not reach it),
 * and the status line. Derived only; nothing here edits.
 */

import { computed } from "vue";
import { pictureCommandText } from "../../../src/studio/pictureDocument.ts";
import { insertionPoint } from "./studioTools.ts";
import { tickFor } from "./studioView.ts";
import { UNASSIGNED } from "./useStudioDocument.ts";
import type { StudioDocument } from "./useStudioDocument.ts";
import type { StudioSelection } from "./useStudioSelection.ts";

/**
 * One stop on the draw-order transport: an item, or a run of loose steps.
 * The playhead moves stop to stop; a stop's commands fold together, state
 * lines inside the item with it.
 */
export interface DrawStop {
  /** The command where the stop starts drawing. */
  readonly index: number;
  /** One past its last command. */
  readonly end: number;
  /** The row it belongs to: an item id, or the loose row's. */
  readonly rowId: string;
  /** Its name, in plain words. */
  readonly label: string;
  /** Its colour for the transport's strip, null when it draws nothing yet. */
  readonly colour: number | null;
  /** Its drawing includes a flood fill. */
  readonly fill: boolean;
}

/** Where new shapes draw, in the words the transport and status bar share. */
export interface DrawingPosition {
  /** "Drawing before Cottage", "Drawing after Red line", "Drawing the first steps". */
  readonly text: string;
  /** What the next shape goes before, when it goes before something. */
  readonly before: string | null;
  /** What the next shape goes after, when it goes after everything. */
  readonly after: string | null;
  /** New shapes go last: nothing paints over them. */
  readonly atEnd: boolean;
}

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
  /**
   * The transport's stops, in draw order: each item is one stop, and each run
   * of loose steps is one. The playhead can still stand inside a stop (the
   * inspector's command list seeks there); the stops only mark the places a
   * new shape can begin.
   */
  const stops = computed<DrawStop[]>(() => {
    const { rows, timeline } = model.value;
    const fills = (entries: readonly number[]) =>
      entries.some((k) => tickFor(timeline[k]!).kind === "fill");
    const out: DrawStop[] = [];
    for (const row of rows) {
      if (row.entries.length === 0) continue;
      if (row.id !== UNASSIGNED) {
        out.push({
          index: row.entries[0]!,
          end: row.entries.at(-1)! + 1,
          rowId: row.id,
          label: row.display,
          colour: row.swatch,
          fill: fills(row.entries),
        });
        continue;
      }
      // Loose steps group into one stop per run of neighbours.
      let start = -1;
      row.entries.forEach((k, i) => {
        if (start < 0) start = k;
        const runEnd = i === row.entries.length - 1 || row.entries[i + 1] !== k + 1;
        if (!runEnd) return;
        out.push({
          index: start,
          end: k + 1,
          rowId: row.id,
          label: "Loose steps",
          colour: null,
          fill: fills(row.entries.slice(row.entries.indexOf(start), i + 1)),
        });
        start = -1;
      });
    }
    return out.sort((a, b) => a.index - b.index);
  });
  /** The last drawn command: the item it belongs to, and its text. */
  const current = computed(() => {
    const entry = model.value.timeline[playhead.value - 1];
    if (!entry) return { item: "", text: "" };
    const owner =
      entry.itemId === undefined ? undefined : model.value.rows.find((r) => r.id === entry.itemId);
    return { item: owner?.display ?? "", text: commandText(playhead.value - 1) };
  });

  /** The display name of what draws at timeline `index`: its item's, or "loose steps". */
  const nameAt = (index: number): string => {
    const entry = model.value.timeline[index];
    const owner =
      entry?.itemId === undefined
        ? undefined
        : model.value.rows.find((row) => row.id === entry.itemId);
    return owner?.display ?? "loose steps";
  };
  /**
   * Where the playhead puts new shapes: before the item that draws next, or
   * after the one that drew last. The transport and the options bar say the
   * same thing.
   */
  const position = computed<DrawingPosition>(() => {
    const { document, compiled } = model.value;
    const { index } = insertionPoint(document, compiled.spans, total.value, playhead.value);
    if (total.value === 0)
      return { text: "Drawing the first steps", before: null, after: null, atEnd: true };
    if (index >= total.value)
      return {
        text: `Drawing after ${nameAt(total.value - 1)}`,
        before: null,
        after: nameAt(total.value - 1),
        atEnd: true,
      };
    return {
      text: `Drawing before ${nameAt(index)}`,
      before: nameAt(index),
      after: null,
      atEnd: false,
    };
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
    [...model.value.rows, ...model.value.folds].find((row) => row.id === id)?.display ?? id;
  /** The status bar's line: where new shapes draw. */
  const status = computed(() => position.value.text);

  return { ticks, stops, current, drawn, single, commands, pixel, fill, labelOf, status, position };
}
