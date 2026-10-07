/**
 * Room Studio lens rules, shared by the creator's own edits
 * (app/src/studio/studioLocks.ts) and AI proposals (assistScope.ts) so both
 * pass the same validators. Each lens locks the plane it is not about:
 * Visual locks the priority plane, Priority locks the visual plane.
 * Unlocking is explicit and lasts for the Studio session. The locks guard
 * painting and editing within a plane; whole items move whole
 * (`editUnlocks`).
 */

import type { EditOperation } from "./editOperations.ts";
import { pictureItemAtLine, type PictureDocument } from "./pictureDocument.ts";
import type { PicturePlane } from "./pictureQuery.ts";

export type StudioLens = "art" | "depth";

/** What the creator unlocked for this Studio session. */
export interface LensUnlocks {
  /** Visual may change under the Priority lens. */
  readonly visual: boolean;
  /** Priority may change under the Visual lens. */
  readonly priority: boolean;
}

export const NO_UNLOCKS: LensUnlocks = { visual: false, priority: false };
const ALL_UNLOCKS: LensUnlocks = { visual: true, priority: true };

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
 * items carries every plane they draw (the visual and the priority plane's
 * depth and control lines) in any lens, so no lens lock refuses it. The
 * locks guard painting and editing within a plane: new shapes, fills,
 * colours, depth values and points. The unlocks an edit is checked under,
 * `wholeItems` saying whether it only takes whole items.
 */
export function editUnlocks(unlocks: LensUnlocks, wholeItems: boolean): LensUnlocks {
  return wholeItems ? ALL_UNLOCKS : unlocks;
}

/**
 * Unlock depth accompanying an item's art reshape. Manual priority painting
 * keeps the lens's ordinary locks; art keeps its lock under Priority.
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
  return derived ? { ...unlocks, priority: true } : unlocks;
}

/** The planes `lens` keeps locked, less those unlocked. */
export function lockedPlanes(lens: StudioLens, unlocks: LensUnlocks): PicturePlane[] {
  if (lens === "art") return unlocks.priority ? [] : ["priority"];
  return unlocks.visual ? [] : ["visual"];
}
