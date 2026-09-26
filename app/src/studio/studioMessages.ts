/**
 * Room Studio's plain wording for the edit kernel's refusals. The kernel's
 * own text names lines, operands and coordinate ranges, which is right for
 * logs, tests and the agent; the creator reads one short sentence and can
 * open the technical text as its detail.
 */

import type { EditOperation } from "../../../src/studio/editOperations.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";

const LEAVES = "it would leave the picture";

/** The way a point at x,y lies off the picture, or null when it is on it or off two ways. */
function direction(x: number, y: number): string | null {
  const ways = [
    x < 0 && "left",
    x >= SCREEN_WIDTH && "right",
    y < 0 && "up",
    y >= SCREEN_HEIGHT && "down",
  ].filter((way) => way !== false);
  return ways.length === 1 ? ways[0]! : null;
}

/** Kernel refusal patterns, first match wins, each with its plain sentence. */
const PLAIN: readonly (readonly [
  RegExp,
  (match: RegExpMatchArray, op: EditOperation) => string,
])[] = [
  [
    /off the surface at (-?\d+),(-?\d+)/,
    (match, op) => {
      if (op.type === "duplicateItem") return `The copy can't go there — ${LEAVES}.`;
      const way = direction(Number(match[1]), Number(match[2]));
      return way ? `Can't move it further ${way} — ${LEAVES}.` : `Can't move it there — ${LEAVES}.`;
    },
  ],
  [/^point -?\d+,-?\d+ is off the surface/, () => `Can't put the point there — ${LEAVES}.`],
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
  [/is inside item/, () => "New shapes can't go inside another object. Move the playhead first."],
  [/continues the command on line/, () => "This would split a drawing command in two."],
  [/in progress/, () => "Finish the current edit first."],
];

/** The creator's sentence for kernel refusal `error` of `op`. */
export function plainKernelRefusal(op: EditOperation, error: string): string {
  for (const [pattern, say] of PLAIN) {
    const match = error.match(pattern);
    if (match) return say(match, op);
  }
  return "The picture can't be changed that way.";
}

/** Where the drawing tools put new shapes: `index` commands draw before them, of `commands`. */
export function insertionText(index: number, commands: number): string {
  if (commands === 0) return "New shapes are drawn first.";
  if (index >= commands) return `New shapes are drawn last, after step ${commands}.`;
  const where = index === 0 ? `first, before step 1` : `after step ${index}`;
  return `New shapes are drawn ${where} of ${commands} (use the draw order to change where).`;
}
