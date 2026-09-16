/**
 * Uploaded character art -> staged AGI VIEW: the reference-art pipeline's
 * deterministic half. The player supplies one image per facing — each a
 * single pose row on a flat key colour or real alpha — and the harness owns
 * the sheet manifest: poses per row, facings, target cel size and the ground
 * line. None of that is inferred from the pixels; the upload dialog states
 * the constraints from src/view/spritesheet.ts's header.
 *
 * Loop order is the engine's four-direction table (see selectLoop in
 * src/runtime/engine.ts): loop 0 right, loop 1 left, loop 2 down, loop 3 up.
 * A missing facing is filled so the table stays aligned: the opposite
 * facing's cels mirrored when the design is declared symmetric, the same
 * frames unmirrored otherwise — either way the substitution is a named
 * diagnostic, never a silent choice.
 *
 * Zero dependencies; runs in browser, worker and Node.
 */
import {
  cutGrid,
  quantizeToEga,
  sheetViewInput,
  type EgaSheet,
  type SheetFrame,
  type SheetLoopLayout,
} from "./spritesheet.ts";
import { buildView, type BuildViewInput } from "./view.ts";

export type SheetFacing = "right" | "left" | "down" | "up";

/** The four-loop order — index in this list is the AGI loop number. */
export const FACING_LOOP_ORDER: readonly SheetFacing[] = ["right", "left", "down", "up"];

const OPPOSITE: Record<SheetFacing, SheetFacing> = {
  right: "left",
  left: "right",
  down: "up",
  up: "down",
};

/** A decoded upload: RGBA pixels, row-major, four bytes per pixel. */
export interface SheetBitmap {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array | Uint8ClampedArray;
}

/**
 * The harness-owned sheet manifest. The player declares poses per row and
 * whether the design may mirror; nothing here is derived from the image.
 */
export interface CharacterSheetSpec {
  /** Poses in each facing's row, left to right. 4-6 per the upload contract. */
  readonly poses: number;
  /** Target cel height in logical pixels; width follows the aspect rule. */
  readonly celHeight?: number | undefined;
  /** Missing opposite facings (right/left) may reuse mirrored cels. */
  readonly symmetric?: boolean | undefined;
  /**
   * Explicit background key colour. Default: colour-keying applies only to
   * fully opaque input — a sheet that uses alpha is segmented by alpha alone
   * ("transparency is alpha first").
   */
  readonly keyColor?: readonly [number, number, number] | null | undefined;
}

export interface ConvertedCharacter {
  /** The packed VIEW payload — `buildView(input)`. */
  readonly view: Uint8Array;
  /** The same view as an editable spec; a keep lands it in `sources.views`. */
  readonly input: BuildViewInput;
  /** Cel dimensions per loop, in layout order. */
  readonly loops: readonly {
    facing: SheetFacing;
    cels: readonly { width: number; height: number }[];
  }[];
  /** Non-fatal findings — sideways drift, height change, ground-line departure. */
  readonly warnings: readonly string[];
  /** Substitutions the layout made for missing facings. */
  readonly substitutions: readonly string[];
}

/** One frame's opaque-pixel bounding box, in source cell coordinates. */
interface FrameBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function frameBox(sheet: EgaSheet, col: number, cellWidth: number, cellHeight: number): FrameBox {
  const box: FrameBox = { left: cellWidth, right: -1, top: cellHeight, bottom: -1 };
  const originX = col * cellWidth;
  for (let y = 0; y < cellHeight; y++) {
    for (let x = 0; x < cellWidth; x++) {
      if (sheet.mask[y * sheet.width + originX + x] !== 1) continue;
      if (x < box.left) box.left = x;
      if (x > box.right) box.right = x;
      if (y < box.top) box.top = y;
      if (y > box.bottom) box.bottom = y;
    }
  }
  return box;
}

/**
 * Per-pose findings inside one facing row, measured in source pixels before
 * any resampling: a figure that slides sideways, grows or shrinks, or lifts
 * off the shared ground line converts badly no matter how clean the colours
 * are.
 */
function poseDiagnostics(sheet: EgaSheet, facing: SheetFacing, poses: number): string[] {
  const cellWidth = sheet.width / poses;
  const boxes: FrameBox[] = [];
  for (let col = 0; col < poses; col++) {
    const box = frameBox(sheet, col, cellWidth, sheet.height);
    if (box.right >= 0) boxes.push(box);
  }
  if (boxes.length < 2) return [];
  const warnings: string[] = [];
  const centerDrift = Math.max(
    ...boxes.map((b) => Math.abs(b.left + b.right - boxes[0]!.left - boxes[0]!.right)),
  );
  // Centre-x comparison doubles the drift — a 2px silhouette slide reads 4.
  if (centerDrift >= 6)
    warnings.push(
      `The ${facing}-facing figure drifts sideways between poses — keep it centred in each cell.`,
    );
  const heights = boxes.map((b) => b.bottom - b.top + 1);
  if (Math.max(...heights) - Math.min(...heights) >= 4)
    warnings.push(
      `The ${facing}-facing figure changes height between poses (${Math.min(...heights)}-${Math.max(...heights)}px) — draw every pose the same size.`,
    );
  const bottoms = boxes.map((b) => b.bottom);
  if (Math.max(...bottoms) - Math.min(...bottoms) >= 2)
    warnings.push(
      `The ${facing}-facing figure leaves the ground line between poses — feet must rest on the same row.`,
    );
  return warnings;
}

/**
 * True when any pixel carries meaningful alpha. Alpha input is segmented by
 * alpha alone — colour-keying is only for fully opaque sheets, applied
 * before quantisation collapses the key's neighbours into it.
 */
function usesAlpha(bitmap: SheetBitmap): boolean {
  for (let i = 3; i < bitmap.rgba.length; i += 4) if (bitmap.rgba[i]! < 255) return true;
  return false;
}

/**
 * Convert per-facing pose rows into a staged VIEW. Throws with the named
 * constraint on unusable input; findings that leave a usable but flawed
 * result come back as warnings.
 */
export function convertCharacterSheet(
  images: Partial<Record<SheetFacing, SheetBitmap>>,
  spec: CharacterSheetSpec,
): ConvertedCharacter {
  const poses = spec.poses;
  if (!Number.isInteger(poses) || poses < 4 || poses > 6)
    throw new RangeError(`a pose row holds four to six poses (got ${poses})`);
  const supplied = FACING_LOOP_ORDER.filter((facing) => images[facing] !== undefined);
  if (supplied.length === 0)
    throw new RangeError("a character sheet needs at least one facing's pose row");

  const warnings: string[] = [];
  const substitutions: string[] = [];
  const frames: SheetFrame[] = [];
  const facingFrames = new Map<SheetFacing, number[]>();
  let preferTransparent: number | undefined;
  for (const facing of FACING_LOOP_ORDER) {
    const bitmap = images[facing];
    if (bitmap === undefined) continue;
    // Alpha first: a sheet with real transparency keys nothing. Only opaque
    // input gets border-key detection or the explicit key colour.
    const keyColor = usesAlpha(bitmap)
      ? null
      : spec.keyColor !== undefined
        ? spec.keyColor
        : undefined;
    const sheet = quantizeToEga(
      bitmap.rgba,
      bitmap.width,
      bitmap.height,
      keyColor === undefined ? {} : { keyColor },
    );
    if (preferTransparent === undefined && sheet.keyIndex !== null)
      preferTransparent = sheet.keyIndex;
    warnings.push(...poseDiagnostics(sheet, facing, poses));
    const cut = cutGrid(sheet, poses, 1, { targetHeight: spec.celHeight ?? 32 });
    const indexes: number[] = [];
    for (const frame of cut) {
      indexes.push(frames.length);
      frames.push(frame);
    }
    facingFrames.set(facing, indexes);
  }

  // Keep the four-loop direction table aligned. A missing facing borrows its
  // opposite — mirrored only when the design is declared symmetric — and
  // falls back to any supplied row so the loop count stays four.
  const fallback = facingFrames.get(supplied[0]!)!;
  const loops: SheetLoopLayout[] = [];
  const loopReport: {
    facing: SheetFacing;
    cels: { width: number; height: number }[];
  }[] = [];
  for (const facing of FACING_LOOP_ORDER) {
    let indexes = facingFrames.get(facing);
    if (indexes === undefined) {
      const opposite = OPPOSITE[facing];
      const oppositeIndexes = facingFrames.get(opposite);
      if (
        oppositeIndexes !== undefined &&
        spec.symmetric === true &&
        (facing === "left" || facing === "right")
      ) {
        loops.push({ mirrorOf: FACING_LOOP_ORDER.indexOf(opposite) });
        loopReport.push({
          facing,
          cels: oppositeIndexes.map((i) => ({
            width: frames[i]!.width,
            height: frames[i]!.height,
          })),
        });
        substitutions.push(
          `No ${facing}-facing image supplied — the ${opposite}-facing cels are mirrored.`,
        );
        continue;
      }
      const donor = oppositeIndexes ?? fallback;
      const donorFacing = oppositeIndexes !== undefined ? opposite : supplied[0]!;
      substitutions.push(
        `No ${facing}-facing image supplied — reused the ${donorFacing}-facing cels unmirrored.`,
      );
      indexes = donor;
    }
    loops.push({ frames: indexes });
    loopReport.push({
      facing,
      cels: indexes.map((i) => ({ width: frames[i]!.width, height: frames[i]!.height })),
    });
  }

  const input = sheetViewInput(frames, {
    loops,
    description: "Uploaded reference character",
    ...(preferTransparent !== undefined ? { preferTransparent } : {}),
  });
  return { view: buildView(input), input, loops: loopReport, warnings, substitutions };
}
