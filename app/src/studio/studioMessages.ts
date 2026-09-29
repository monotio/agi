/**
 * Room Studio's plain wording for the edit kernel's refusals. The kernel's
 * own text names lines, operands and coordinate ranges, which is right for
 * logs, tests and the agent; the creator reads one short sentence and can
 * open the technical text as its detail.
 */

import type { EditOperation, SurfaceEdge } from "../../../src/studio/editOperations.ts";
import { MAX_X, MAX_Y } from "../../../src/studio/editSource.ts";
import type { PictureDocument } from "../../../src/studio/pictureDocument.ts";

/** Kernel refusal patterns, first match wins, each with its plain sentence. */
const PLAIN: readonly (readonly [
  RegExp,
  (match: RegExpMatchArray, op: EditOperation) => string,
])[] = [
  [
    /off the surface at -?\d+,-?\d+/,
    (_match, op) =>
      op.type === "duplicateItem"
        ? "The copy would leave the picture."
        : "That would move part of it off the picture.",
  ],
  [/^point -?\d+,-?\d+ is off the surface/, () => "The point would leave the picture."],
  [/^seed .* off the surface/, () => "A fill has to start inside the picture."],
  [/^plot point .* off the surface/, () => "The brush has to stay inside the picture."],
  [
    /rel delta \d+ would be/,
    () => "That point is too far from its neighbour for this kind of line (7 pixels at most).",
  ],
  [
    /is locked; unlock it first|belongs to locked item/,
    () => "This object is locked. Unlock it first.",
  ],
  [/raw bytes/, () => "This part of the picture is stored as raw data and can't be changed here."],
  [
    /\bcop(y|ies)\b/,
    () => "Another part of the picture repeats this object's lines, so it can't be changed here.",
  ],
  [/self-intersects/, () => "A polygon's edges can't cross. Remove the last point or start again."],
  [/draws on neither plane/, () => "Choose an art colour or a depth value to draw with."],
  [/is inside item/, () => "Move the step marker out of this item, then draw."],
  [/continues the command on line/, () => "This would split a drawing command in two."],
  [/in progress/, () => "Finish the current edit first."],
  [
    /not next to each other in the draw order|draws between .* outside any item/,
    () => "Group takes neighbours in the draw order. Include the items between them.",
  ],
  [/needs at least two items/, () => "Select two items or more to group."],
  [/is one drawing element/, () => "This item is one drawing element: it has no parts to ungroup."],
];

/** The creator's sentence for kernel refusal `error` of `op`. */
export function plainKernelRefusal(op: EditOperation, error: string): string {
  for (const [pattern, say] of PLAIN) {
    const match = error.match(pattern);
    if (match) return say(match, op);
  }
  return "The picture can't be changed that way.";
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
    message: `${label} is at the picture's ${stop.edge} edge.`,
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
  if (steps === 0) return "New shapes are the first steps.";
  if (index >= steps) return `New shapes go last, after step ${steps}, on top of everything.`;
  const where = index === 0 ? "first, before step 1" : `after step ${index}`;
  return `New shapes go ${where} of ${steps}; the steps after them paint over them.`;
}

/** insertionText for the options bar: where new shapes go, in a few words. */
export function insertionShort(index: number, steps: number): string {
  if (steps === 0 || index === 0) return "Before step 1";
  return `After step ${Math.min(index, steps)}`;
}
