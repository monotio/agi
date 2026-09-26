/**
 * Lens locks for Room Studio edits (decision D6). Each lens locks the planes
 * it is not about: Art locks the priority plane, Depth and Walk the visual
 * plane, and Walk also keeps depth values (priority 4–15) off limits unless
 * they are allowed explicitly. Unlocking is explicit and lasts for the
 * Studio session. Every candidate edit is checked on its decoded planes by
 * the kernel's validateEdit, with the edited items' old and new footprints on
 * each plane as the only cells that plane may change, so an edit that changes
 * another object's output indirectly (a pre-empted fill) is refused. A
 * refusal says why in plain words, keeps the technical account as its
 * detail, and carries the cells to flash.
 */

import { PAYLOAD_MAX_BYTES } from "../../../src/container/container.ts";
import {
  footprintMask,
  unionMask,
  validateEdit,
  type CellBox,
  type CompiledDocument,
  type EditViolation,
} from "../../../src/studio/editValidation.ts";
import { itemMask, type PicturePlane } from "../../../src/studio/pictureQuery.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import type { StudioLens } from "./studioView.ts";

const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;

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

/** What the item editor shows as locked: each plane's reason, or null, and the Walk depth rule. */
export function lensItemLocks(lens: StudioLens, unlocks: LensUnlocks) {
  const locked = lockedPlanes(lens, unlocks);
  const reason = (plane: PicturePlane): string | null =>
    locked.includes(plane) ? `locked in the ${lens} lens` : null;
  return {
    visual: reason("visual"),
    priority: reason("priority"),
    depthValues: depthValuesLocked(lens, unlocks),
  };
}

/** The creator's name for a plane. */
export const PLANE_NAMES: Record<PicturePlane, string> = { visual: "Art", priority: "Depth" };

/** One reason an edit was refused, with the cells to highlight. */
export interface StudioViolation {
  /** The rule it breaks: the kernel's constraints, and the Walk lens depth rule. */
  readonly rule: EditViolation["constraint"] | "walk-depth";
  /** The plane it is about; null for the byte limit. */
  readonly plane: PicturePlane | null;
  /** What the creator reads: short and plain. */
  readonly message: string;
  /** The technical account: counts and cell boxes. */
  readonly detail: string;
  readonly count: number;
  readonly bbox: CellBox | null;
  /** 160x168; 1 where a cell breaks the rule. Empty for the byte limit. */
  readonly mask: Uint8Array;
}

export interface StudioCheck {
  readonly ok: boolean;
  readonly violations: readonly StudioViolation[];
}

const lensName = (lens: StudioLens): string => `${lens[0]!.toUpperCase()}${lens.slice(1)}`;

const where = (count: number, bbox: CellBox): string =>
  `${count} cell${count === 1 ? "" : "s"} at ${bbox.x0},${bbox.y0}..${bbox.x1},${bbox.y1}`;

function boxOf(mask: Uint8Array): { count: number; bbox: CellBox } | null {
  let count = 0;
  let x0 = SCREEN_WIDTH;
  let y0 = SCREEN_HEIGHT;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < CELLS; i++) {
    if (mask[i] !== 1) continue;
    const x = i % SCREEN_WIDTH;
    const y = (i - x) / SCREEN_WIDTH;
    count++;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return count === 0 ? null : { count, bbox: { x0, y0, x1, y1 } };
}

/** Cells of `plane` that differ, where `counts` holds. */
function diffMask(
  before: CompiledDocument,
  after: CompiledDocument,
  plane: PicturePlane,
  counts: (index: number) => boolean,
): Uint8Array {
  const mask = new Uint8Array(CELLS);
  const a = before[plane];
  const b = after[plane];
  for (let i = 0; i < CELLS; i++) if (a[i] !== b[i] && counts(i)) mask[i] = 1;
  return mask;
}

/**
 * Walk lens depth rule: no priority cell anywhere may move into, out of or
 * within depth values 4–15, except where an edited control item (0–3) covers
 * another item's depth or uncovers what lay under it. Moving a barrier is
 * allowed; moving, painting or removing depth is not, and neither is an edit
 * that changes another object's depth indirectly.
 */
function depthViolation(
  before: CompiledDocument,
  after: CompiledDocument,
  edited: readonly string[],
): StudioViolation | null {
  const wroteBefore = unionMask(
    ...edited.map((id) => itemMask(before, before.document, id, "priority")),
  );
  const wroteAfter = unionMask(
    ...edited.map((id) => itemMask(after, after.document, id, "priority")),
  );
  const mask = diffMask(before, after, "priority", (i) => {
    const was = before.priority[i]!;
    const now = after.priority[i]!;
    if (was < 4 && now < 4) return false;
    const covers = now < 4 && wroteAfter[i] === 1 && !(wroteBefore[i] === 1 && was >= 4);
    const uncovers = was < 4 && wroteBefore[i] === 1 && wroteAfter[i] === 0;
    return !covers && !uncovers;
  });
  const box = boxOf(mask);
  if (!box) return null;
  return {
    rule: "walk-depth",
    plane: "priority",
    message: "This would change depth values 4–15, which are locked in the Walk lens.",
    detail: `Depth values 4–15 are locked in the Walk lens: ${where(box.count, box.bbox)} would change.`,
    count: box.count,
    bbox: box.bbox,
    mask,
  };
}

/** The edited items' footprints on `plane`, before and after: the cells that plane may change. */
function footprints(
  before: CompiledDocument,
  after: CompiledDocument,
  edited: readonly string[],
  plane: PicturePlane,
): Uint8Array {
  return unionMask(
    ...edited.flatMap((id) => [footprintMask(before, id, plane), footprintMask(after, id, plane)]),
  );
}

/**
 * Check a candidate edit from `before` to `after` that edits the items
 * `edited`: the kernel's plane and per-plane footprint rules under the lens
 * locks, the container's record size, and the Walk lens depth rule.
 */
export function checkStudioEdit(
  before: CompiledDocument,
  after: CompiledDocument,
  edited: readonly string[],
  lens: StudioLens,
  unlocks: LensUnlocks,
): StudioCheck {
  const allowed: Record<PicturePlane, Uint8Array> = {
    visual: footprints(before, after, edited, "visual"),
    priority: footprints(before, after, edited, "priority"),
  };
  const result = validateEdit(before, after, {
    lockedPlanes: lockedPlanes(lens, unlocks),
    allowedMask: allowed,
    maxBytes: PAYLOAD_MAX_BYTES,
  });
  const violations: StudioViolation[] = result.violations.map((violation) => {
    if (violation.constraint === "max-bytes")
      return {
        rule: "max-bytes",
        plane: null,
        message: `This would make the picture too big to keep (over ${violation.maxBytes} bytes).`,
        detail: `The picture would be ${violation.bytes} bytes, over the ${violation.maxBytes}-byte resource limit.`,
        count: 0,
        bbox: null,
        mask: new Uint8Array(CELLS),
      };
    const { plane, count, bbox } = violation;
    const locked = violation.constraint === "locked-plane";
    const mask = diffMask(
      before,
      after,
      plane,
      locked ? () => true : (i) => allowed[plane][i] === 0,
    );
    const name = PLANE_NAMES[plane].toLowerCase();
    const rule = violation.constraint;
    return locked
      ? {
          rule,
          plane,
          message: `This would change the ${name}, which is locked in the ${lensName(lens)} lens.`,
          detail: `${PLANE_NAMES[plane]} is locked in the ${lensName(lens)} lens: ${where(count, bbox)} would change.`,
          count,
          bbox,
          mask,
        }
      : {
          rule,
          plane,
          message: `This would change another object's ${name}.`,
          detail: `The edit reaches outside the edited item: ${where(count, bbox)} of other items' ${name} would change.`,
          count,
          bbox,
          mask,
        };
  });
  if (depthValuesLocked(lens, unlocks)) {
    const depth = depthViolation(before, after, edited);
    if (depth) violations.push(depth);
  }
  return { ok: violations.length === 0, violations };
}

/**
 * What a refusal says: the first reason for each plane (a locked plane says
 * it all; else another object's output; else the Walk depth rule) plus the
 * byte limit, and the technical account of every violation, one per line,
 * as the detail.
 */
export function refusalText(check: StudioCheck): { message: string; detail: string } {
  const told = new Set<PicturePlane | null>();
  const plain: string[] = [];
  for (const violation of check.violations) {
    if (told.has(violation.plane)) continue;
    told.add(violation.plane);
    plain.push(violation.message);
  }
  return {
    message: plain.join(" "),
    detail: check.violations.map((violation) => violation.detail).join("\n"),
  };
}

/** The cell-wise OR of every violation's cells, for the canvas flash. */
export function violationCells(check: StudioCheck): Uint8Array {
  return unionMask(...check.violations.map((violation) => violation.mask));
}
