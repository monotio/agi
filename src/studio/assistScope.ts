/**
 * The scope contract of a Studio assist request (decision D6): what an AI
 * proposal made from a Room Studio or Sprite Studio selection may change.
 * The UI builds it from the selection and the lens; `checkCandidate` holds a
 * candidate to it on DECODED pixels, whatever the proposal's operations or
 * the model's words claim. Pure and deterministic.
 *
 * Pictures. A candidate must start from `baseRevision`, keep every item
 * outside `targetIds` (id, label, kind and lock), leave `lockedPlanes`
 * untouched, fit `maxBytes`, and change each plane only inside that plane's
 * allowed cells: the targets' old ∪ new footprints on the plane (their
 * owned final cells, before and after), plus `allowedMask` when given.
 * `allowedMask` only adds cells; it never lifts the footprint rule. New items
 * a proposal inserts get no licence of their own: their pixels must land in
 * the allowed cells. The lens rules a manual edit passes (lensRules.ts: the
 * Walk lens keeps depth values 4–15) apply too, with the targets and the
 * items the candidate creates as the edited items. `pictureAssistScope` licenses the selection's on-screen
 * area on every unlocked plane, so "make this bridge walkable" in the Walk
 * lens may paint priority under the selected bridge art.
 *
 * Views. A candidate must start from `baseRevision`, change displayed pixels
 * only in `targetCels`, leave `protectedLoops` untouched (pixels and
 * metadata), change loop metadata only on loops that hold a target, never
 * change the loop count or description, and fit `maxBytes`. Copy-on-write
 * splitting a targeted mirror loop from its partner is a metadata change of
 * the targeted loop and allowed; a change reaching the partner is not.
 */

import { PAYLOAD_MAX_BYTES } from "../container/container.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import {
  footprintMask,
  unionMask,
  validateEdit,
  type AllowedMask,
  type CellBox,
  type CompiledDocument,
} from "./editValidation.ts";
import {
  checkLensRules,
  lockedPlanes,
  NO_UNLOCKS,
  type LensUnlocks,
  type StudioLens,
} from "./lensRules.ts";
import { serializePictureDocument } from "./pictureDocument.ts";
import type { PicturePlane } from "./pictureQuery.ts";
import type { SpriteDocument } from "./sprite/spriteDocument.ts";
import type { CelRef } from "./sprite/spriteOperations.ts";
import { validateSpriteEdit } from "./sprite/spriteValidation.ts";

const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;
const PLANES: readonly PicturePlane[] = ["visual", "priority"];

/** A Studio draft as the assist sees it: picture source text, or an encoded VIEW. */
export type AssistDraft =
  | { readonly kind: "picture"; readonly source: string }
  | { readonly kind: "view"; readonly payload: Uint8Array };

export interface PictureAssistScope {
  readonly kind: "picture";
  readonly num: number;
  /** `draftRevision` of the draft the request was made against. */
  readonly baseRevision: string;
  /** The selected item ids. */
  readonly targetIds: readonly string[];
  /** Planes that may not change anywhere. */
  readonly lockedPlanes: readonly PicturePlane[];
  /** The Studio lens and the creator's unlocks: the lens rules (lensRules.ts) apply as to a manual edit. */
  readonly lens: StudioLens;
  readonly unlocks: LensUnlocks;
  /** Cells licensed beyond the targets' own footprints; never a way around them. */
  readonly allowedMask?: AllowedMask;
  /** The largest compiled picture, in bytes. */
  readonly maxBytes: number;
}

export interface ViewAssistScope {
  readonly kind: "view";
  readonly num: number;
  readonly baseRevision: string;
  /** The selected cels: the only cels whose displayed pixels may change. */
  readonly targetCels: readonly CelRef[];
  /** Loops none of whose pixels or metadata may change. */
  readonly protectedLoops?: readonly number[];
  /** The largest encoded VIEW, in bytes. */
  readonly maxBytes: number;
}

export type AssistScope = PictureAssistScope | ViewAssistScope;

export type AssistConstraint =
  | "stale-base"
  | "unknown-target"
  | "outside-target"
  | "locked-plane"
  | "outside-mask"
  | "walk-depth"
  | "protected-loop"
  | "max-bytes";

export interface AssistViolation {
  readonly constraint: AssistConstraint;
  /** Plain words: what the candidate would break. */
  readonly message: string;
  readonly plane?: PicturePlane;
  readonly loop?: number;
  readonly cel?: number;
  /** Cells or pixels that break the constraint. */
  readonly count?: number;
  readonly bbox?: CellBox;
}

export interface AssistCheck {
  readonly ok: boolean;
  readonly violations: readonly AssistViolation[];
}

/** FNV-1a over 16-bit units (source text) or bytes (payloads). */
function fnv(length: number, unit: (index: number) => number): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < length; i++) {
    const value = unit(i);
    hash = Math.imul(hash ^ (value & 0xff), 0x01000193) >>> 0;
    if (value > 0xff) hash = Math.imul(hash ^ (value >>> 8), 0x01000193) >>> 0;
  }
  return `${length}-${hash.toString(16).padStart(8, "0")}`;
}

/**
 * The draft's revision: `picture-<length>-<fnv>` over the source text (so a
 * label edit is a new revision), `view-<length>-<fnv>` over the payload.
 */
export function draftRevision(draft: AssistDraft): string {
  if (draft.kind === "picture") {
    const { source } = draft;
    return `picture-${fnv(source.length, (i) => source.charCodeAt(i))}`;
  }
  const { payload } = draft;
  return `view-${fnv(payload.length, (i) => payload[i]!)}`;
}

/** 160x168: 1 where any target owns the final cell on either plane (its on-screen area). */
export function selectionArea(
  compiled: CompiledDocument,
  targetIds: readonly string[],
): Uint8Array {
  return unionMask(...targetIds.map((id) => footprintMask(compiled, id, "both")));
}

/**
 * The scope the UI sends for a Room Studio selection: the draft's revision,
 * the lens and unlocks the Studio holds (and so its locked planes), and the
 * selection's on-screen area licensed on every unlocked plane.
 */
export function pictureAssistScope(input: {
  readonly num: number;
  readonly compiled: CompiledDocument;
  readonly targetIds: readonly string[];
  readonly lens: StudioLens;
  readonly unlocks?: LensUnlocks;
  readonly maxBytes?: number;
}): PictureAssistScope {
  const unlocks = input.unlocks ?? NO_UNLOCKS;
  const locked = lockedPlanes(input.lens, unlocks);
  const area = selectionArea(input.compiled, input.targetIds);
  const allowedMask: { visual?: Uint8Array; priority?: Uint8Array } = {};
  for (const plane of PLANES) if (!locked.includes(plane)) allowedMask[plane] = area;
  return {
    kind: "picture",
    num: input.num,
    baseRevision: draftRevision({
      kind: "picture",
      source: serializePictureDocument(input.compiled.document),
    }),
    targetIds: [...input.targetIds],
    lockedPlanes: locked,
    lens: input.lens,
    unlocks: { ...unlocks },
    allowedMask,
    maxBytes: input.maxBytes ?? PAYLOAD_MAX_BYTES,
  };
}

/** The scope the UI sends for a Sprite Studio selection of cels. */
export function viewAssistScope(input: {
  readonly num: number;
  readonly document: SpriteDocument;
  readonly targetCels: readonly CelRef[];
  readonly protectedLoops?: readonly number[];
  readonly maxBytes?: number;
}): ViewAssistScope {
  return {
    kind: "view",
    num: input.num,
    baseRevision: draftRevision({ kind: "view", payload: input.document.payload }),
    targetCels: input.targetCels.map(({ loop, cel }) => ({ loop, cel })),
    ...(input.protectedLoops ? { protectedLoops: [...input.protectedLoops] } : {}),
    maxBytes: input.maxBytes ?? PAYLOAD_MAX_BYTES,
  };
}

/** The extra cells `allowed` licenses on `plane`, checked for size. */
function extraCells(allowed: AllowedMask | undefined, plane: PicturePlane): Uint8Array | undefined {
  const mask = allowed instanceof Uint8Array ? allowed : allowed?.[plane];
  if (mask !== undefined && mask.length !== CELLS)
    throw new RangeError(`allowedMask has ${mask.length} cells; expected ${CELLS}`);
  return mask;
}

/** Each plane's allowed cells: the targets' old ∪ new footprints plus the scope's extra cells. */
export function allowedCells(
  before: CompiledDocument,
  after: CompiledDocument,
  scope: Pick<PictureAssistScope, "targetIds" | "allowedMask">,
): Record<PicturePlane, Uint8Array> {
  const cells = (plane: PicturePlane) => {
    const extra = extraCells(scope.allowedMask, plane);
    return unionMask(
      ...(extra ? [extra] : []),
      ...scope.targetIds.flatMap((id) => [
        footprintMask(before, id, plane),
        footprintMask(after, id, plane),
      ]),
    );
  };
  return { visual: cells("visual"), priority: cells("priority") };
}

const PLANE_WORDS: Record<PicturePlane, string> = {
  visual: "art (visual plane)",
  priority: "depth and walk (priority plane)",
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const staleBase = (scope: AssistScope, actual: string): AssistViolation => ({
  constraint: "stale-base",
  message: `the draft changed since this request was made (request base ${scope.baseRevision}, draft now ${actual})`,
});

function checkPicture(
  before: CompiledDocument,
  after: CompiledDocument,
  scope: PictureAssistScope,
): AssistCheck {
  const violations: AssistViolation[] = [];
  const revision = draftRevision({
    kind: "picture",
    source: serializePictureDocument(before.document),
  });
  if (revision !== scope.baseRevision) violations.push(staleBase(scope, revision));
  const known = new Set(before.document.items.map((item) => item.id));
  const missing = scope.targetIds.filter((id) => !known.has(id));
  if (missing.length > 0)
    violations.push({
      constraint: "unknown-target",
      message: `the selection names ${missing.length === 1 ? "an item" : "items"} the draft does not have: ${missing.join(", ")}`,
    });
  for (const item of before.document.items) {
    if (scope.targetIds.includes(item.id)) continue;
    const next = after.document.items.find((candidate) => candidate.id === item.id);
    const change = !next
      ? "be removed"
      : next.label !== item.label || next.kind !== item.kind || next.locked !== item.locked
        ? "have its label, kind or lock changed"
        : null;
    if (change)
      violations.push({
        constraint: "outside-target",
        message: `item '${item.id}' ("${item.label}") is not selected but would ${change}`,
      });
  }
  const allowed = allowedCells(before, after, scope);
  const result = validateEdit(before, after, {
    lockedPlanes: scope.lockedPlanes,
    allowedMask: allowed,
    maxBytes: scope.maxBytes,
  });
  for (const violation of result.violations) {
    if (violation.constraint === "max-bytes") {
      violations.push({
        constraint: "max-bytes",
        count: violation.bytes,
        message: `the picture would be ${violation.bytes} bytes, ${violation.over} over the ${violation.maxBytes}-byte budget`,
      });
      continue;
    }
    const { plane, count, bbox } = violation;
    const at = `${plural(count, "cell")} at ${bbox.x0},${bbox.y0}..${bbox.x1},${bbox.y1}`;
    violations.push({
      constraint: violation.constraint,
      plane,
      count,
      bbox,
      message:
        violation.constraint === "locked-plane"
          ? `the ${PLANE_WORDS[plane]} is locked, but ${at} would change`
          : `${at} of the ${PLANE_WORDS[plane]} outside the selection would change`,
    });
  }
  const created = after.document.items.flatMap((item) => (known.has(item.id) ? [] : [item.id]));
  for (const { constraint, plane, count, bbox, message } of checkLensRules(
    before,
    after,
    [...scope.targetIds, ...created],
    scope.lens,
    scope.unlocks,
  ))
    violations.push({ constraint, plane, count, bbox, message });
  return { ok: violations.length === 0, violations };
}

function checkView(
  before: SpriteDocument,
  after: SpriteDocument,
  scope: ViewAssistScope,
): AssistCheck {
  const violations: AssistViolation[] = [];
  const revision = draftRevision({ kind: "view", payload: before.payload });
  if (revision !== scope.baseRevision) violations.push(staleBase(scope, revision));
  const missing = scope.targetCels.filter(({ loop, cel }) => !before.loops[loop]?.cels[cel]);
  if (missing.length > 0)
    violations.push({
      constraint: "unknown-target",
      message: `the selection names cels the view does not have: ${missing.map(({ loop, cel }) => `loop ${loop} cel ${cel}`).join(", ")}`,
    });
  const protectedLoops = new Set(scope.protectedLoops ?? []);
  const targets = new Set(scope.targetCels.map(({ loop, cel }) => `${loop}:${cel}`));
  const targetLoops = new Set(scope.targetCels.map(({ loop }) => loop));
  const validation = validateSpriteEdit(before, after, { protectedLoops: [...protectedLoops] });
  for (const violation of validation.violations)
    if (violation.constraint === "protected-loop")
      violations.push({
        constraint: "protected-loop",
        loop: violation.loop,
        ...(violation.cel === undefined ? {} : { cel: violation.cel }),
        ...(violation.pixels === undefined ? {} : { count: violation.pixels }),
        message: violation.message,
      });
  for (const { loop, cel, pixels } of validation.changedCels) {
    if (protectedLoops.has(loop) || targets.has(`${loop}:${cel}`)) continue;
    violations.push({
      constraint: "outside-target",
      loop,
      cel,
      count: pixels,
      message: `loop ${loop}, cel ${cel} is not selected, but ${plural(pixels, "pixel")} of it would change`,
    });
  }
  // Splitting a targeted loop from its mirror partner re-links the partner
  // too; its display stays, so its link and orientation bits may follow.
  const owner = (loop: number) => before.loops[loop]?.alias ?? loop;
  const targetBlocks = new Set([...targetLoops].map(owner));
  for (const change of validation.metadata) {
    if ("loop" in change && (protectedLoops.has(change.loop) || targetLoops.has(change.loop)))
      continue;
    if (
      (change.kind === "alias" || change.kind === "mirror-bit") &&
      targetBlocks.has(owner(change.loop))
    )
      continue;
    const what =
      change.kind === "loop-count"
        ? `the view's loop count would change from ${change.before} to ${change.after}`
        : change.kind === "description"
          ? "the view's description would change"
          : `loop ${change.loop} is not selected, but its ${change.kind === "cel-count" ? "cel count" : change.kind === "alias" ? "mirror link" : `cel ${change.cel} ${change.kind}`} would change`;
    violations.push({
      constraint: "outside-target",
      ...("loop" in change ? { loop: change.loop } : {}),
      message: what,
    });
  }
  if (after.payload.length > scope.maxBytes)
    violations.push({
      constraint: "max-bytes",
      count: after.payload.length,
      message: `the view would be ${after.payload.length} bytes, ${after.payload.length - scope.maxBytes} over the ${scope.maxBytes}-byte budget`,
    });
  return { ok: violations.length === 0, violations };
}

/**
 * Hold a candidate to its scope: `before` is the draft the candidate was made
 * from, `after` the candidate, both decoded. Runs `validateEdit` for a
 * picture and `validateSpriteEdit` for a view, plus the scope's revision and
 * target rules.
 */
export function checkCandidate(
  before: CompiledDocument,
  after: CompiledDocument,
  scope: PictureAssistScope,
): AssistCheck;
export function checkCandidate(
  before: SpriteDocument,
  after: SpriteDocument,
  scope: ViewAssistScope,
): AssistCheck;
export function checkCandidate(
  before: CompiledDocument | SpriteDocument,
  after: CompiledDocument | SpriteDocument,
  scope: AssistScope,
): AssistCheck {
  return scope.kind === "picture"
    ? checkPicture(before as CompiledDocument, after as CompiledDocument, scope)
    : checkView(before as SpriteDocument, after as SpriteDocument, scope);
}

/**
 * The violations in plain words, for a refusal the model and the creator
 * read: a locked plane says it all for that plane, so its outside-selection
 * cells are not repeated.
 */
export function assistRefusalText(check: AssistCheck): string {
  const locked = new Set(
    check.violations.flatMap((v) => (v.constraint === "locked-plane" ? [v.plane] : [])),
  );
  return check.violations
    .filter((v) => !(v.constraint === "outside-mask" && locked.has(v.plane)))
    .map((v) => v.message)
    .join("; ");
}
