/**
 * Room Studio lens rules (decision D6), shared by the creator's own edits
 * (app/src/studio/studioLocks.ts) and AI proposals (assistScope.ts) so both
 * pass the same validators. Each lens locks the planes it is not about: Art
 * locks the priority plane, Depth and Walk the visual plane, and Walk also
 * keeps depth values (priority 4–15) off limits unless they are unlocked.
 * Unlocking is explicit and lasts for the Studio session.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import { unionMask, type CellBox, type CompiledDocument } from "./editValidation.ts";
import { itemMask, type PicturePlane } from "./pictureQuery.ts";

const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;

export type StudioLens = "art" | "depth" | "walk";

/** What the creator unlocked for this Studio session. */
export interface LensUnlocks {
  /** Art may change under the Depth and Walk lenses. */
  readonly visual: boolean;
  /** Depth may change under the Art lens. */
  readonly priority: boolean;
  /** Depth values 4–15 may change under the Walk lens. */
  readonly depthInWalk: boolean;
}

export const NO_UNLOCKS: LensUnlocks = { visual: false, priority: false, depthInWalk: false };

/** The planes `lens` keeps locked, less those unlocked. */
export function lockedPlanes(lens: StudioLens, unlocks: LensUnlocks): PicturePlane[] {
  if (lens === "art") return unlocks.priority ? [] : ["priority"];
  return unlocks.visual ? [] : ["visual"];
}

/** Whether depth values 4–15 are locked: only in the Walk lens, until allowed. */
export function depthValuesLocked(lens: StudioLens, unlocks: LensUnlocks): boolean {
  return lens === "walk" && !unlocks.depthInWalk;
}

/** A cell set that breaks the Walk lens depth rule, in `validateEdit`'s violation shape. */
export interface DepthViolation {
  readonly constraint: "walk-depth";
  readonly plane: "priority";
  readonly count: number;
  /** The first 8 violating cells, row-major. */
  readonly cells: readonly { readonly x: number; readonly y: number }[];
  readonly bbox: CellBox;
  readonly message: string;
  /** 160x168: 1 where a cell breaks the rule, for a canvas flash. */
  readonly mask: Uint8Array;
}

/**
 * The Walk lens depth rule: with depth values locked, no priority cell may
 * move into, out of or within depth values 4–15, except where an edited
 * control item (0–3) covers another item's depth or uncovers what lay under
 * it. Moving a barrier is allowed; moving, painting or removing depth is not,
 * and neither is an edit that changes another object's depth indirectly.
 * `edited` names the items the edit changes or creates. Returns no
 * violations when the lens and unlocks leave depth values open.
 */
export function checkLensRules(
  before: CompiledDocument,
  after: CompiledDocument,
  edited: readonly string[],
  lens: StudioLens,
  unlocks: LensUnlocks,
): DepthViolation[] {
  if (!depthValuesLocked(lens, unlocks)) return [];
  const wroteBefore = unionMask(
    ...edited.map((id) => itemMask(before, before.document, id, "priority")),
  );
  const wroteAfter = unionMask(
    ...edited.map((id) => itemMask(after, after.document, id, "priority")),
  );
  const mask = new Uint8Array(CELLS);
  const cells: { x: number; y: number }[] = [];
  let count = 0;
  let x0 = SCREEN_WIDTH;
  let y0 = SCREEN_HEIGHT;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < CELLS; i++) {
    const was = before.priority[i]!;
    const now = after.priority[i]!;
    if (was === now || (was < 4 && now < 4)) continue;
    const covers = now < 4 && wroteAfter[i] === 1 && !(wroteBefore[i] === 1 && was >= 4);
    const uncovers = was < 4 && wroteBefore[i] === 1 && wroteAfter[i] === 0;
    if (covers || uncovers) continue;
    mask[i] = 1;
    const x = i % SCREEN_WIDTH;
    const y = (i - x) / SCREEN_WIDTH;
    count++;
    if (cells.length < 8) cells.push({ x, y });
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  if (count === 0) return [];
  return [
    {
      constraint: "walk-depth",
      plane: "priority",
      count,
      cells,
      bbox: { x0, y0, x1, y1 },
      message: `depth values 4–15 are locked in the Walk lens, but ${count} cell${count === 1 ? "" : "s"} at ${x0},${y0}..${x1},${y1} would change`,
      mask,
    },
  ];
}
