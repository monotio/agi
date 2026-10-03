/**
 * Deterministic edit-selection compositor for the generation workflow.
 *
 * An Edit selection authorizes exactly one rectangle of the canonical
 * RGBA base: the provider's mask guides its model, it is not the
 * authorization boundary. After the offer's bytes are decoded through the
 * shared intake, this module composites the provider raster into the
 * approved rectangle only — every pixel outside it stays byte-exact with
 * the captured base, and every pixel inside it is a nearest-neighbour
 * resample of the proportionally mapped region of the provider output.
 * Same-size inputs therefore copy that region exactly.
 *
 * The mask PNG this module builds is what the provider API accepts:
 * RGBA, same dimensions as the edited asset, alpha 0 inside the
 * selection (the editable area) and opaque elsewhere. It travels with the
 * request as guidance; the composite above is what lands in the project.
 *
 * The pixel transform and the RGBA PNG encoder are the shared
 * platform-free implementation in `src/creative/composite.ts`, so the
 * issuer stage and private archive admission recompute the exact bytes a
 * composite record claims.
 */
import type { Rect } from "../../../../src/creative/catalog.ts";
import {
  checkCompositeSelection,
  compositeRegion,
  compositeSelection as compositeShared,
  encodePngRgba,
} from "../../../../src/creative/composite.ts";

/** Names the transform for recipes and derivations; bump on any change. */
export const EDIT_COMPOSITE_ALGORITHM = "agi.edit-selection-composite-v1";

/** Why a selection or raster was refused. Stable; UI and tests branch on it. */
export type CreativeSelectionReason =
  /** A declared raster's pixels do not match its width x height x 4. */
  | "pixels"
  /** The selection is not an integer rectangle inside the base. */
  | "bounds";

export class CreativeSelectionError extends Error {
  readonly reason: CreativeSelectionReason;
  constructor(reason: CreativeSelectionReason, message: string) {
    super(message);
    this.name = "CreativeSelectionError";
    this.reason = reason;
  }
}

/** A tightly packed unpremultiplied RGBA8 image. */
export interface RgbaRaster {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

function checkRaster(image: RgbaRaster, label: string): void {
  const { width, height, pixels } = image;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 1 << 26
  )
    throw new CreativeSelectionError(
      "bounds",
      `${label} has invalid dimensions ${String(width)}x${String(height)}.`,
    );
  if (!(pixels instanceof Uint8Array) || pixels.length !== width * height * 4)
    throw new CreativeSelectionError(
      "pixels",
      `${label} pixels must be ${width}x${height} tightly packed RGBA8.`,
    );
}

/**
 * Clamp a user rectangle to an integer rectangle inside the base's bounds.
 * Refuses fractional or out-of-range edges rather than moving the approval.
 */
export function normalizeSelection(rect: Rect, width: number, height: number): Rect {
  const x = rect.x;
  const y = rect.y;
  const w = rect.width;
  const h = rect.height;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(w) || !Number.isInteger(h))
    throw new CreativeSelectionError("bounds", "The selection needs whole-pixel edges.");
  if (w < 1 || h < 1)
    throw new CreativeSelectionError("bounds", "The selection needs a positive size.");
  if (x < 0 || y < 0 || x + w > width || y + h > height)
    throw new CreativeSelectionError(
      "bounds",
      `The selection ${x},${y} ${w}x${h} leaves the ${width}x${height} image.`,
    );
  return { x, y, width: w, height: h };
}

/**
 * Map a base-space selection proportionally into provider-output space:
 * floor on the origin, ceil on the far edge, at least one pixel. When the
 * provider returned the base's own dimensions this is the selection itself.
 */
export function mapSelection(
  selection: Rect,
  baseWidth: number,
  baseHeight: number,
  outWidth: number,
  outHeight: number,
): Rect {
  const region = compositeRegion(selection, baseWidth, baseHeight, outWidth, outHeight);
  return {
    x: Math.min(outWidth - 1, region.x),
    y: Math.min(outHeight - 1, region.y),
    width: Math.max(
      1,
      Math.min(outWidth, region.x + region.width) - Math.min(outWidth - 1, region.x),
    ),
    height: Math.max(
      1,
      Math.min(outHeight, region.y + region.height) - Math.min(outHeight - 1, region.y),
    ),
  };
}

export interface SelectionComposite {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** The region of the provider raster that fed the selection. */
  readonly region: Rect;
  /** The authorized base-space rectangle the pixels were written into. */
  readonly selection: Rect;
  readonly algorithm: typeof EDIT_COMPOSITE_ALGORITHM;
}

/**
 * Composite the provider's decoded raster into the authorized selection of
 * the captured canonical base. Returns an owned copy: pixels outside the
 * selection are identical to `base.pixels` byte for byte; pixels inside are
 * the nearest sample of the mapped provider region, alpha included.
 */
export function compositeSelection(
  base: RgbaRaster,
  edited: RgbaRaster,
  selection: Rect,
): SelectionComposite {
  checkRaster(base, "The base image");
  checkRaster(edited, "The provider image");
  const rect = normalizeSelection(selection, base.width, base.height);
  const composed = compositeShared(base, edited, rect);
  return {
    pixels: composed.pixels,
    width: composed.width,
    height: composed.height,
    region: composed.region,
    selection: rect,
    algorithm: EDIT_COMPOSITE_ALGORITHM,
  };
}

/**
 * The provider-facing mask for one authorized selection: an RGBA PNG the
 * size of the edited asset with alpha 0 inside the selection (editable)
 * and opaque elsewhere. Guidance for the model only — the local composite
 * above is the actual protection.
 */
export function buildSelectionMaskPng(width: number, height: number, selection: Rect): Uint8Array {
  const rect = normalizeSelection(selection, width, height);
  checkCompositeSelection(rect, width, height);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside =
        x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
      const p = (y * width + x) * 4;
      rgba[p] = 255;
      rgba[p + 1] = 255;
      rgba[p + 2] = 255;
      rgba[p + 3] = inside ? 0 : 255;
    }
  }
  return encodePngRgba(width, height, rgba);
}
