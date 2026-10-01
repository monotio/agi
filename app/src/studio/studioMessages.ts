import { VOCABULARY } from "../../../src/studio/vocabulary.ts";
/**
 * Room Studio's plain wording for the edit kernel's refusals. The kernel's
 * own text names lines, operands and coordinate ranges, which is right for
 * logs, tests and the agent; the creator reads one short sentence and can
 * open the technical text as its detail.
 */

import type { EditOperation, SurfaceEdge } from "../../../src/studio/editOperations.ts";
import { MAX_X, MAX_Y } from "../../../src/studio/editSource.ts";
import type { PictureDocument } from "../../../src/studio/pictureDocument.ts";
import type { SideEffectReport } from "../../../src/studio/sideEffects.ts";

/** Kernel refusal patterns, first match wins, each with its plain sentence. */
const PLAIN: readonly (readonly [
  RegExp,
  (match: RegExpMatchArray, op: EditOperation) => string,
])[] = [
  [
    /off the surface at -?\d+,-?\d+/,
    (_match, op) =>
      op.type === "duplicateItem"
        ? "The copy would leave the picture. Move it closer to the centre."
        : "Part of the item would leave the picture. Move it closer to the centre.",
  ],
  [
    /^point -?\d+,-?\d+ is off the surface/,
    () => "The point would leave the picture. Choose a point inside it.",
  ],
  [
    /^seed .* off the surface/,
    () => "The fill starts outside the picture. Choose a point inside it.",
  ],
  [/^plot point .* off the surface/, () => "The brush is outside the picture. Move it inside."],
  [
    /rel delta \d+ would be/,
    () => "The points are more than 7 pixels apart. Move them closer or add a point.",
  ],
  [
    /is locked; unlock it first|belongs to locked item/,
    () => "This item is locked. Unlock it first.",
  ],
  [/raw bytes/, () => "This step contains raw bytes. Expand it into editable steps first."],
  [
    /\bcop(y|ies)\b/,
    () => "This item shares steps with another item. Expand its source before editing.",
  ],
  [/self-intersects/, () => "These edges cross. Remove the last point or start again."],
  [/draws on neither plane/, () => "Choose an art colour or a depth value to draw with."],
  [/is inside item/, () => "Move the step marker out of this item, then draw."],
  [
    /continues the command on line/,
    () => "The insertion would split a step. Move the marker to the next step.",
  ],
  [/in progress/, () => "Finish the current edit first."],
  [
    /not next to each other in the draw order|draws between .* outside any item/,
    () => "Group takes neighbours in the draw order. Include the items between them.",
  ],
  [/needs at least two items/, () => "Select two items or more to group."],
  [
    /is one drawing element/,
    () => "This item has one step. Select an item with several steps to ungroup.",
  ],
];

/** The creator's sentence for kernel refusal `error` of `op`. */
export function plainKernelRefusal(op: EditOperation, error: string): string {
  for (const [pattern, say] of PLAIN) {
    const match = error.match(pattern);
    if (match) return say(match, op);
  }
  return `${VOCABULARY.picture.label} edit: ${error}. Correct the source or undo your last change.`;
}

/**
 * Kernel refusal `error` as the notice's Details show it: each quoted item
 * id the document has becomes its label in double quotes, and a leading
 * "item" goes ("item 'el-1' is locked" reads "\"Element 1\" is locked").
 */
export function kernelDetail(error: string, document: PictureDocument): string {
  return error.replace(/(^item )?'([^']+)'/g, (text, _lead, id: string) => {
    const item = document.items.find((candidate) => candidate.id === id);
    return item ? `"${item.label}"` : text;
  });
}

/**
 * A move that cannot go one pixel further the way it is dragged: the item
 * at the edge in plain words, and the offset and surface bounds as detail.
 */
export function edgeRefusal(
  document: PictureDocument,
  stop: { readonly itemId: string; readonly edge: SurfaceEdge },
  dx: number,
  dy: number,
): { message: string; detail: string } {
  const label = document.items.find((item) => item.id === stop.itemId)?.label ?? stop.itemId;
  return {
    message: `${label} is at the picture's ${stop.edge} edge. Move it inward.`,
    detail: `moving by ${dx},${dy}: "${label}" is at the ${stop.edge} edge of the surface (x 0..${MAX_X}, y 0..${MAX_Y})`,
  };
}

/**
 * After a move that carried planes the lens does not paint: "Moved Pond with
 * its walk lines.", "Moved 3 items with their depth and walk lines.";
 * null when it carried none.
 */
export function movedWith(
  what: string,
  several: boolean,
  carried: readonly string[],
): string | null {
  if (carried.length === 0) return null;
  const list =
    carried.length === 1
      ? carried[0]!
      : `${carried.slice(0, -1).join(", ")} and ${carried.at(-1)!}`;
  return `Moved ${what} with ${several ? "their" : "its"} ${list}.`;
}

/** Where the drawing tools put new shapes: `index` steps draw before them, of `steps`. */
export function insertionText(index: number, steps: number): string {
  if (steps === 0) return "New steps are the first steps.";
  if (index >= steps) return `New steps go last, after step ${steps}, on top of everything.`;
  const where = index === 0 ? "first, before step 1" : `after step ${index}`;
  return `New steps go ${where} of ${steps}; the steps after them paint over them.`;
}

/** insertionText for the options bar: where new shapes go, in a few words. */
export function insertionShort(index: number, steps: number): string {
  if (steps === 0 || index === 0) return "Before step 1";
  return `After step ${Math.min(index, steps)}`;
}

/**
 * What an accepted edit did to other items, for the status line, with the
 * undo key: "Grass flows differently: 17,802 cells changed. ⌘Z undoes it.";
 * "3 other items change: 17,802 cells. ⌘Z undoes it."
 */
export function sideEffectNote(report: SideEffectReport, undo: string): string {
  const cells = `${report.cells.toLocaleString("en-US")} ${report.cells === 1 ? "cell" : "cells"}`;
  const [only, ...more] = report.items;
  const what =
    only && more.length === 0
      ? only.fill
        ? `${only.label} flows differently: ${cells} changed.`
        : `${only.label} changes too: ${cells}.`
      : `${report.items.length} other items change: ${cells}.`;
  return `${what} ${undo} undoes it.`;
}
