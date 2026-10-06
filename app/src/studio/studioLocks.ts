/**
 * Lens locks for Room Studio edits, judged on decoded pixels, never on the
 * edit's operations. The lens rules themselves
 * (src/studio/lensRules.ts) are shared with AI proposals (assistScope.ts),
 * so both pass the same validators. A refusal says why in plain words, keeps
 * the technical account as its detail, and carries the cells to flash. An
 * edit may change other items' output indirectly (a fill that pours
 * differently around a moved outline): that is no refusal but a side effect,
 * reported (src/studio/sideEffects.ts) from the cells outside the edited
 * items' old and new footprints on each plane.
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
import { sideEffects, type SideEffectReport } from "../../../src/studio/sideEffects.ts";
import type { PicturePlane } from "../../../src/studio/pictureQuery.ts";
import {
  checkLensRules,
  depthValuesLocked,
  lockedPlanes,
  NO_UNLOCKS,
  type LensUnlocks,
} from "../../../src/studio/lensRules.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import { LENS_NAMES, type StudioLens } from "./studioView.ts";

const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;

export { depthValuesLocked, lockedPlanes, NO_UNLOCKS, type LensUnlocks };

/** What the item editor shows as locked: each plane's reason, or null, and the Walk depth rule. */
export function lensItemLocks(lens: StudioLens, unlocks: LensUnlocks) {
  const locked = lockedPlanes(lens, unlocks);
  const reason = (plane: PicturePlane): string | null =>
    locked.includes(plane) ? `${LOCKED_PLANES[plane]} in the ${lensName(lens)} lens.` : null;
  return {
    visual: reason("visual"),
    priority: reason("priority"),
    depthValues: depthValuesLocked(lens, unlocks),
  };
}

/**
 * A locked plane, as the lock chip names it, with its verb: the priority
 * plane holds both depth and walk lines.
 */
export const LOCKED_PLANES: Record<PicturePlane, string> = {
  visual: "Visual is locked",
  priority: "Priority is locked",
};

/** One reason an edit was refused, with the cells to highlight. */
interface StudioViolation {
  /** The rule it breaks: a locked plane, the byte limit, or the Walk lens depth rule. */
  readonly rule: Exclude<EditViolation["constraint"], "outside-mask"> | "walk-depth";
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

const lensName = (lens: StudioLens): string => LENS_NAMES[lens].label;

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

/** The edited items' footprints on `plane`, before and after: the cells the edit draws itself. */
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
 * `edited`: the lens's locked planes, the container's record size, and the
 * Walk lens depth rule.
 */
export function checkStudioEdit(
  before: CompiledDocument,
  after: CompiledDocument,
  edited: readonly string[],
  lens: StudioLens,
  unlocks: LensUnlocks,
): StudioCheck {
  const result = validateEdit(before, after, {
    lockedPlanes: lockedPlanes(lens, unlocks),
    maxBytes: PAYLOAD_MAX_BYTES,
  });
  const violations: StudioViolation[] = result.violations.flatMap(
    (violation): StudioViolation[] => {
      if (violation.constraint === "max-bytes")
        return [
          {
            rule: "max-bytes",
            plane: null,
            message: `This would make the picture too big to keep (over ${violation.maxBytes} bytes).`,
            detail: `The picture would be ${violation.bytes} bytes, over the ${violation.maxBytes}-byte resource limit.`,
            count: 0,
            bbox: null,
            mask: new Uint8Array(CELLS),
          },
        ];
      if (violation.constraint !== "locked-plane") return [];
      const { plane, count, bbox } = violation;
      return [
        {
          rule: "locked-plane",
          plane,
          message: `${LOCKED_PLANES[plane]} in the ${lensName(lens)} lens.`,
          detail: `${LOCKED_PLANES[plane]} in the ${lensName(lens)} lens: ${where(count, bbox)} would change.`,
          count,
          bbox,
          mask: diffMask(before, after, plane, () => true),
        },
      ];
    },
  );
  for (const depth of checkLensRules(before, after, edited, lens, unlocks))
    violations.push({
      rule: depth.constraint,
      plane: depth.plane,
      message: "The Walk lens draws walk lines 0–3 only.",
      detail: `Depth values 4–15 are locked in the Walk lens: ${where(depth.count, depth.bbox)} would change.`,
      count: depth.count,
      bbox: depth.bbox,
      mask: depth.mask,
    });
  return { ok: violations.length === 0, violations };
}

/**
 * What an accepted edit does to other items: the changed cells outside the
 * edited items' old and new footprints on each plane, put down to the items
 * whose output changed there; null when there are none.
 */
export function studioSideEffects(
  before: CompiledDocument,
  after: CompiledDocument,
  edited: readonly string[],
): SideEffectReport | null {
  const outside = (plane: PicturePlane) => {
    const own = footprints(before, after, edited, plane);
    return diffMask(before, after, plane, (i) => own[i] === 0);
  };
  return sideEffects(
    before,
    after,
    { visual: outside("visual"), priority: outside("priority") },
    new Set(edited),
  );
}

/**
 * What a refusal says: the first reason for each plane (a locked plane says
 * it all; else the Walk depth rule) plus the byte limit, and the technical account of every violation, one per line,
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

/**
 * What moving `ids` carried that `lens` does not paint, in the lock chip's
 * words: "priority" and "walk lines" (values 4–15 and 0–3) in the Visual
 * lens, "visual" in the Priority lens, "visual" and "priority" in the Walk
 * lens. Read from the cells the items own in `compiled`, so lines drawn over
 * entirely count for nothing.
 */
export function carriedPlanes(
  compiled: CompiledDocument,
  ids: readonly string[],
  lens: StudioLens,
): string[] {
  let visual = false;
  let depth = false;
  let walk = false;
  for (const id of ids) {
    visual ||= footprintMask(compiled, id, "visual").includes(1);
    const priority = footprintMask(compiled, id, "priority");
    for (let i = 0; i < CELLS; i++) {
      if (priority[i] !== 1) continue;
      if (compiled.priority[i]! < 4) walk = true;
      else depth = true;
    }
  }
  const hidden: readonly [string, boolean][] =
    lens === "art"
      ? [
          ["priority", depth],
          ["walk lines", walk],
        ]
      : lens === "depth"
        ? [["visual", visual]]
        : [
            ["visual", visual],
            ["priority", depth],
          ];
  return hidden.flatMap(([name, carried]) => (carried ? [name] : []));
}
