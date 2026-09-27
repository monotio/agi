/**
 * Lens locks for Room Studio edits, judged on decoded pixels, never on the
 * edit's operations. The lens rules themselves
 * (src/studio/lensRules.ts) are shared with AI proposals (assistScope.ts),
 * so both pass the same validators. Every candidate edit is checked on its decoded planes by
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
import type { PicturePlane } from "../../../src/studio/pictureQuery.ts";
import {
  checkLensRules,
  depthValuesLocked,
  lockedPlanes,
  NO_UNLOCKS,
  type LensUnlocks,
} from "../../../src/studio/lensRules.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import type { StudioLens } from "./studioView.ts";

const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;

export { depthValuesLocked, lockedPlanes, NO_UNLOCKS, type LensUnlocks };

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
interface StudioViolation {
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
  for (const depth of checkLensRules(before, after, edited, lens, unlocks))
    violations.push({
      rule: depth.constraint,
      plane: depth.plane,
      message: "This would change depth values 4–15, which are locked in the Walk lens.",
      detail: `Depth values 4–15 are locked in the Walk lens: ${where(depth.count, depth.bbox)} would change.`,
      count: depth.count,
      bbox: depth.bbox,
      mask: depth.mask,
    });
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
