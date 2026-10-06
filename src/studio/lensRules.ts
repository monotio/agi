/**
 * Room Studio lens rules, shared by the creator's own edits
 * (app/src/studio/studioLocks.ts) and AI proposals (assistScope.ts) so both
 * pass the same validators. Each lens locks the planes it is not about: Art
 * locks the priority plane, Depth and Walk the visual plane, and Walk also
 * keeps depth values (priority 4–15) off limits unless they are unlocked.
 * Unlocking is explicit and lasts for the Studio session. The locks guard
 * painting and editing within a plane; whole items move whole
 * (`editUnlocks`).
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import { unionMask, type CellBox, type CompiledDocument } from "./editValidation.ts";
import type { EditOperation } from "./editOperations.ts";
import { pictureItemAtLine, type PictureDocument } from "./pictureDocument.ts";
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
const ALL_UNLOCKS: LensUnlocks = { visual: true, priority: true, depthInWalk: true };

/** Operations that intentionally change whole items, including derived depth. */
export const WHOLE_ITEM_OPERATIONS: readonly string[] = [
  "moveItem",
  "duplicateItem",
  "deleteItem",
  "addDepth",
  "standInRoom",
];

/**
 * Whole items move whole: an edit that only moves, copies or deletes whole
 * items carries every plane they draw (art, depth and walk lines) in any
 * lens, so no lens lock refuses it. The locks guard painting and editing
 * within a plane: new shapes, fills, colours, depth values and points. The
 * unlocks an edit is checked under, `wholeItems` saying whether it only
 * takes whole items.
 */
export function editUnlocks(unlocks: LensUnlocks, wholeItems: boolean): LensUnlocks {
  return wholeItems ? ALL_UNLOCKS : unlocks;
}

/**
 * Unlock depth accompanying an item's art reshape. Manual priority painting
 * keeps the lens's ordinary locks; art keeps its lock under Depth and Walk.
 * Hosts can use this in place of the whole-item boolean for edit batches.
 */
export function editOperationUnlocks(
  document: PictureDocument,
  ops: readonly EditOperation[],
  unlocks: LensUnlocks,
): LensUnlocks {
  if (ops.length === 0) return unlocks;
  if (ops.every((op) => WHOLE_ITEM_OPERATIONS.includes(op.type))) return ALL_UNLOCKS;
  const derived = ops.every((op) => {
    if (WHOLE_ITEM_OPERATIONS.includes(op.type)) return true;
    if (op.type === "setItemColor") {
      return (
        op.plane === "visual" && document.items.some((item) => item.id === op.itemId && item.depth)
      );
    }
    if (op.type === "setStepColor" && op.plane !== "visual") return false;
    if (
      op.type !== "setPoint" &&
      op.type !== "insertPoint" &&
      op.type !== "removePoint" &&
      op.type !== "setStepColor"
    )
      return false;
    const item = pictureItemAtLine(document, op.line);
    return (
      item?.depth !== undefined && (op.line < item.depth.openLine || op.line > item.depth.closeLine)
    );
  });
  return derived ? { ...unlocks, priority: true, depthInWalk: true } : unlocks;
}

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
