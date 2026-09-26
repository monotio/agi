/**
 * Edit validation for the Room Studio (decision D6): the UI and the agent
 * pass the same check, which compares the DECODED visual and priority planes
 * before and after an edit, never the operations or the source text.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import type { PictureDocument } from "./pictureDocument.ts";
import {
  compileDocument,
  itemMask,
  type CompiledPictureDocument,
  type PicturePlane,
} from "./pictureQuery.ts";

const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;
const PLANES: readonly PicturePlane[] = ["visual", "priority"];
/** How many violating cells a violation lists. */
export const VIOLATION_SAMPLE = 8;

/** A compiled document together with the document it was compiled from. */
export interface CompiledDocument extends CompiledPictureDocument {
  readonly document: PictureDocument;
}

/** `compileDocument`, keeping the document for `footprintMask`. Throws PictureSourceSyntaxError. */
export function compileEditDocument(
  document: PictureDocument,
  profile: AgiProfile,
): CompiledDocument {
  return { ...compileDocument(document, profile), document };
}

/**
 * Where the planes may change, 160x168 row-major with 1 = the cell may
 * change: one mask for both planes, or one per plane. A plane the per-plane
 * form leaves out is not restricted by it.
 */
export type AllowedMask =
  Uint8Array | { readonly visual?: Uint8Array; readonly priority?: Uint8Array };

export interface EditConstraints {
  /** Planes that may not change anywhere. */
  readonly lockedPlanes: readonly PicturePlane[];
  /**
   * The cells that may change. An edit can change other items' output
   * indirectly (a moved outline stops a later fill short, an inserted fill
   * pre-empts one), so "the edited items and nothing else" is each plane's
   * own footprints: an art item's visual footprint is no licence to change
   * priority there.
   */
  readonly allowedMask?: AllowedMask;
  /** The largest compiled picture, in bytes. */
  readonly maxBytes?: number;
}

export interface CellBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export type EditViolation =
  | {
      readonly constraint: "locked-plane" | "outside-mask";
      readonly plane: PicturePlane;
      /** How many cells break the constraint. */
      readonly count: number;
      /** The first VIOLATION_SAMPLE of them, row-major. */
      readonly cells: readonly { readonly x: number; readonly y: number }[];
      readonly bbox: CellBox;
      readonly message: string;
    }
  | {
      readonly constraint: "max-bytes";
      readonly bytes: number;
      readonly maxBytes: number;
      readonly over: number;
      readonly message: string;
    };

export interface ValidationResult {
  readonly ok: boolean;
  readonly violations: readonly EditViolation[];
}

type Planes = Pick<CompiledPictureDocument, "bytes" | "visual" | "priority">;

/** The cells of `plane` that differ between `before` and `after` where `counts(i)` holds. */
function changedCells(
  before: Planes,
  after: Planes,
  plane: PicturePlane,
  constraint: "locked-plane" | "outside-mask",
  counts: (index: number) => boolean,
): EditViolation | null {
  const a = before[plane];
  const b = after[plane];
  const cells: { x: number; y: number }[] = [];
  let count = 0;
  let x0 = SCREEN_WIDTH;
  let y0 = SCREEN_HEIGHT;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < CELLS; i++) {
    if (a[i] === b[i] || !counts(i)) continue;
    const x = i % SCREEN_WIDTH;
    const y = (i - x) / SCREEN_WIDTH;
    count++;
    if (cells.length < VIOLATION_SAMPLE) cells.push({ x, y });
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  if (count === 0) return null;
  const where = constraint === "locked-plane" ? "on the locked" : "outside the allowed area on the";
  return {
    constraint,
    plane,
    count,
    cells,
    bbox: { x0, y0, x1, y1 },
    message: `${count} cell${count === 1 ? "" : "s"} changed ${where} ${plane} plane, within ${x0},${y0}..${x1},${y1}`,
  };
}

/** `allowed`'s mask for `plane`, checked for size; undefined when the plane is unrestricted. */
function planeMask(allowed: AllowedMask | undefined, plane: PicturePlane): Uint8Array | undefined {
  const mask = allowed instanceof Uint8Array ? allowed : allowed?.[plane];
  if (mask !== undefined && mask.length !== CELLS) {
    throw new RangeError(`allowedMask has ${mask.length} cells; expected ${CELLS}`);
  }
  return mask;
}

/**
 * Check an edit by its decoded planes: no cell of a locked plane may change,
 * no cell outside `allowedMask` (that plane's, in the per-plane form) may
 * change, and the compiled picture may not exceed `maxBytes`.
 */
export function validateEdit(
  before: Planes,
  after: Planes,
  constraints: EditConstraints,
): ValidationResult {
  const violations: EditViolation[] = [];
  for (const plane of PLANES) {
    if (!constraints.lockedPlanes.includes(plane)) continue;
    const violation = changedCells(before, after, plane, "locked-plane", () => true);
    if (violation) violations.push(violation);
  }
  for (const plane of PLANES) {
    const mask = planeMask(constraints.allowedMask, plane);
    if (mask === undefined) continue;
    const violation = changedCells(before, after, plane, "outside-mask", (i) => mask[i] === 0);
    if (violation) violations.push(violation);
  }
  const { maxBytes } = constraints;
  if (maxBytes !== undefined && after.bytes.length > maxBytes) {
    const over = after.bytes.length - maxBytes;
    violations.push({
      constraint: "max-bytes",
      bytes: after.bytes.length,
      maxBytes,
      over,
      message: `the picture is ${after.bytes.length} bytes, ${over} over the ${maxBytes}-byte budget`,
    });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 160x168 mask: 1 where item `itemId` owns the final cell on `plane` (or on
 * either plane for "both"); all zero when the document has no such item. The
 * UI builds each plane's `allowedMask` as the OR of the edited items' masks
 * on that plane, before and after the edit.
 */
export function footprintMask(
  compiled: CompiledDocument,
  itemId: string,
  plane: PicturePlane | "both",
): Uint8Array {
  if (plane !== "both") return itemMask(compiled, compiled.document, itemId, plane);
  const mask = itemMask(compiled, compiled.document, itemId, "visual");
  const priority = itemMask(compiled, compiled.document, itemId, "priority");
  for (let i = 0; i < CELLS; i++) if (priority[i] === 1) mask[i] = 1;
  return mask;
}

/** The cell-wise OR of `masks`. */
export function unionMask(...masks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(CELLS);
  for (const mask of masks) for (let i = 0; i < CELLS; i++) if (mask[i] === 1) out[i] = 1;
  return out;
}
