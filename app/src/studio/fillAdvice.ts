/**
 * The fill tool's advice when a seed would flood nothing. AGI's fill only
 * spreads over white (visual 15) or, with the colour off, over uncoloured
 * depth (priority 4); a spot something painted earlier stops it where it
 * starts. The notice says so in plain words (`fillNotice`), and `fillFix`
 * finds where in the draw order the spot is still white: just before the
 * item that painted it, or, when something earlier covers it too, before
 * that, as far back as it takes. Moving the scrubber there makes the next
 * shape and its fill land while the area is still white. A shape drawn there
 * as an outline alone would keep the later fill out of its inside, changing
 * another item's art, which the lens checks refuse; a filled rectangle or
 * polygon paints its inside itself, so the fix turns Filled on.
 */

import type { PictureSourceSpan } from "../../../src/picture/source.ts";
import { pictureItemAtLine, type PictureDocument } from "../../../src/studio/pictureDocument.ts";
import type {
  CompiledPictureDocument,
  FillExplanation,
  PicturePlane,
} from "../../../src/studio/pictureQuery.ts";
import { EGA_COLOUR_NAMES } from "../../../src/studio/sceneGroups.ts";
import { SCREEN_WIDTH } from "../../../src/types.ts";
import { CONTROL_VALUES, spanIndexAt } from "./studioView.ts";

/** Where a shape and its fill can go so the spot is still white. */
export interface FillFix {
  /** The playhead (commands drawn) to draw at: the start of an item, or a loose command. */
  readonly step: number;
  /** What the new shape then goes before: the item's label, else "line N". */
  readonly before: string;
  /** Right before what painted the spot; false when something earlier covers it too. */
  readonly direct: boolean;
  /** When not direct: what already covers the spot before that, found first. */
  readonly still?: { readonly value: number; readonly line: number; readonly label: string | null };
}

/** What an options-bar notice says: a short summary, the whole reason, and its fix. */
export interface BarNotice {
  readonly summary: string;
  /** The summary in a few words, for a bar short of room. */
  readonly short: string;
  readonly detail: string;
  /** The one-click fix's label, when there is one. */
  readonly action?: string;
}

/** A spot's value in words: an EGA colour, a depth band, or a control line. */
export function spotName(plane: PicturePlane, value: number): string {
  if (plane === "visual") return EGA_COLOUR_NAMES[value & 0x0f]!;
  const control = CONTROL_VALUES[value];
  return control ? `a ${control.name} line` : `depth band ${value}`;
}

/**
 * The step to draw at so the spot `why` asked about (at playhead `at`) is
 * still white: the start of the item that painted it, and further back
 * while something earlier covers it too. Null when nothing painted it.
 */
export function fillFix(
  why: FillExplanation,
  at: number,
  model: { readonly document: PictureDocument; readonly spans: readonly PictureSourceSpan[] },
  compiledAt: (count: number) => CompiledPictureDocument,
): FillFix | null {
  const cell = why.y * SCREEN_WIDTH + why.x;
  const { document, spans } = model;
  const itemOf = (k: number) => pictureItemAtLine(document, spans[k]!.line);
  /** The step a shape drawn just before command `k` goes at: its item's first command. */
  const startOf = (k: number): number => {
    const item = itemOf(k);
    return item ? spans.findIndex((span) => span.line > item.openLine) : k;
  };
  /** The command that last wrote the spot after `count` commands, or -1. */
  const ownerAt = (compiled: CompiledPictureDocument): number => {
    const owner = compiled.owners[why.plane][cell]!;
    return owner < 0 ? -1 : spanIndexAt(compiled.spans, owner);
  };
  const painter = ownerAt(compiledAt(at));
  if (painter < 0) return null;
  const first = startOf(painter);
  let step = first;
  let still: FillFix["still"];
  for (;;) {
    const compiled = compiledAt(step);
    const value = compiled[why.plane][cell]!;
    if (value === why.target) break;
    const k = ownerAt(compiled);
    if (k < 0) return null;
    still ??= { value, line: spans[k]!.line, label: itemOf(k)?.label ?? null };
    const earlier = startOf(k);
    if (earlier >= step) return null;
    step = earlier;
  }
  const before = itemOf(step)?.label ?? `line ${spans[step]!.line}`;
  return { step, before, direct: step === first, ...(still ? { still } : {}) };
}

/** The notice for a fill that would flood nothing: `owner` names the item that painted the spot. */
export function fillNotice(
  why: FillExplanation,
  owner: string | null,
  fix: FillFix | null,
): BarNotice {
  const name = spotName(why.plane, why.value);
  const clear = why.plane === "visual" ? "white" : "uncoloured depth";
  const by =
    why.line === null
      ? "was there from the start"
      : `was painted earlier by line ${why.line}${owner ? ` (${owner})` : ""}`;
  let detail = `An AGI fill only spreads over ${clear}. The ${name} here ${by}, so draw your shape before it in the draw order.`;
  const filled = " A filled rectangle or polygon paints every pixel itself, so it works anywhere.";
  if (fix?.still) {
    const { value, line, label } = fix.still;
    const white = why.plane === "visual" ? "white" : "uncoloured";
    detail += ` Before ${owner ?? `line ${why.line}`} it is still ${spotName(why.plane, value)}, painted by line ${line}${label ? ` (${label})` : ""}, so it is ${white} only before ${fix.before}.`;
  }
  return {
    summary: `Can't fill here: this spot is already ${name}.`,
    short: "Can't fill here",
    detail: detail + filled,
    ...(fix ? { action: `Draw before ${fix.before}` } : {}),
  };
}
