/**
 * The fill tool's advice when a seed would flood nothing. AGI's fill only
 * spreads over white (visual 15) or, with the colour off, over uncoloured
 * depth (priority 4); a spot something painted earlier stops it where it
 * starts. On a painted spot the bucket recolours the step that painted it
 * instead, so this notice is for the leftovers: a spot whose painter cannot
 * be recoloured (a locked item, derived depth, raw bytes). The notice says
 * what the spot holds and why (`fillNotice`), in plain words.
 */

import type { FillExplanation, PicturePlane } from "../../../src/studio/pictureQuery.ts";
import { EGA_COLOUR_NAMES } from "../../../src/studio/sceneGroups.ts";
import { CONTROL_VALUES } from "./studioView.ts";

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

/** The notice for a fill that would flood nothing: `owner` names the item that painted the spot. */
export function fillNotice(why: FillExplanation, owner: string | null): BarNotice {
  const name = spotName(why.plane, why.value);
  const clear = why.plane === "visual" ? "white" : "uncoloured depth";
  const by =
    why.line === null
      ? "was there from the start"
      : `was painted earlier by line ${why.line}${owner ? ` (${owner})` : ""}`;
  return {
    summary: `Fill stops here: this spot is already ${name}.`,
    short: "Fill stops here",
    detail: `An AGI fill only spreads over ${clear}. The ${name} here ${by}, and the step that painted it is one the bucket cannot recolour.`,
  };
}
