/**
 * Deterministic manual picture underlay preparation: one canonical source
 * raster and one stored recipe -> a detached 160x168 logical RGBA surface for
 * the Room Studio reference layer.
 *
 * A stored recipe's `crop` and `destination` are final. The creator captured
 * them — directly or through `derivePicturePlacement` — under a declared
 * display aspect, and rendering uses "nearest-centre-v1" exactly:
 *
 *   sx = crop.x + floor((dx - destination.x + 0.5) * crop.width  / destination.width)
 *   sy = crop.y + floor((dy - destination.y + 0.5) * crop.height / destination.height)
 *
 * evaluated in exact integer arithmetic for every cell (dx, dy) of the
 * destination rectangle. The recorded `fit`/`intendedAspect` are provenance —
 * they document how the creator chose the rectangles and are never re-applied
 * here. A changed viewport or display setting cannot move a frozen recipe's
 * pixels; refit is an explicit recipe edit through `derivePicturePlacement`.
 *
 * The surface is transient and owned by the caller: cells inside the
 * destination hold the sampled unpremultiplied RGBA pixel verbatim, source
 * alpha included; cells outside stay transparent. `opacity` is a display hint
 * for the compositor — it is reported, never baked into the bytes. The
 * `alpha.threshold`/`alpha.matte` fields are validated contract data for the
 * deferred conversion path and are echoed in diagnostics only.
 *
 * Nothing here touches PIC byte streams, the priority/control plane, Walk or
 * rule/exit data. The underlay is not a runtime bitmap and not a fake native
 * picture; traced scene work uses real PIC commands.
 *
 * Zero platform dependencies; runs in browser, worker and Node.
 */

import {
  CREATIVE_LIMITS,
  CreativeCatalogError,
  RASTER_FORMAT,
  readCreativeRecipe,
  readVersionRef,
  sameVersionRef,
  versionRefKey,
  type CreativeRecipe,
  type PicturePreparation,
  type RasterRef,
  type Rect,
  type VersionRef,
} from "../creative/catalog.ts";
import { sha256Hex } from "../crypto.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import type { SourceIdentity, SourceRaster } from "../view/preparation.ts";

/** The only algorithm this module implements; anything else is refused. */
export const PICTURE_UNDERLAY_ALGORITHM = "manual-picture-underlay-v1";

export type PictureFit = PicturePreparation["fit"];
export type PictureAspect = PicturePreparation["intendedAspect"];

/**
 * How one logical cell displays under each captured aspect. Native display is
 * `(sx, sy) = (ox + 2z*x, oy + z*y)` — a cell is 2:1. Original 4:3 is
 * `(sx, sy) = (ox + 2z*x, oy + 6z*y/5)` — a cell is 2 / (6/5) = 5:3. The
 * whole 160x168 picture band displays 320x168 = 40:21 and 320x201.6 = 100:63
 * respectively; neither is 4:3 and the full 320x200 screen aspect does not
 * apply to the band.
 */
const CELL_ASPECT: Record<PictureAspect, { readonly w: number; readonly h: number }> = {
  native: { w: 2, h: 1 },
  "original-4:3": { w: 5, h: 3 },
};

/** The detached prepared surface for the Room Studio canvas. */
export interface PreparedPictureUnderlay {
  readonly algorithm: typeof PICTURE_UNDERLAY_ALGORITHM;
  /** The recipe's own versioned identity, for staleness labelling. */
  readonly recipe: VersionRef;
  /** The source identity the pixels were sampled from. */
  readonly source: SourceIdentity;
  /** The exact source rectangle sampled (recipe provenance, detached copy). */
  readonly crop: Rect;
  /** The exact logical destination written (recipe provenance, detached copy). */
  readonly destination: Rect;
  readonly fit: PictureFit;
  readonly intendedAspect: PictureAspect;
  /** Display-only compositor hint, echoed verbatim from the recipe. */
  readonly opacity: number;
  /** Logical surface size: always 160x168. */
  readonly width: number;
  readonly height: number;
  /** Unpremultiplied RGBA8, `width * height * 4` bytes, fresh every call. */
  readonly rgba: Uint8Array;
  readonly diagnostics: {
    /** The admission bounds this module enforces; a detached copy. */
    readonly limits: {
      readonly maxDecodedSide: number;
      readonly maxDecodedPixels: number;
      readonly pictureWidth: number;
      readonly pictureHeight: number;
    };
    readonly source: { readonly width: number; readonly height: number };
    /** Contract alpha fields, validated but unused by the manual underlay. */
    readonly alpha: { readonly threshold: number; readonly matte: number };
    /** Source pixels inside the crop. */
    readonly cropPixels: number;
    /** Cells the destination rectangle covers. */
    readonly destinationPixels: number;
    /** Whole canvas: `width * height`. */
    readonly canvasPixels: number;
    /**
     * Sampled destination cells whose source alpha is below the declared
     * threshold. Informational — their RGBA is still carried verbatim.
     */
    readonly belowThreshold: number;
  };
}

/** A fit request: what the creator picked before the recipe was captured. */
export interface PicturePlacementRequest {
  /** Oriented canonical source dimensions. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** The chosen crop, in oriented source pixels, inside the source. */
  readonly crop: Rect;
  /** The logical target bounds, inside the 160x168 picture band. */
  readonly bounds: Rect;
  readonly fit: PictureFit;
  readonly intendedAspect: PictureAspect;
}

/** The integer crop and destination to review and store as the recipe. */
export interface PicturePlacement {
  readonly crop: Rect;
  readonly destination: Rect;
}

function invalid(message: string): never {
  throw new CreativeCatalogError("invalid", `Invalid picture underlay data: ${message}`);
}

function unsupported(message: string): never {
  throw new CreativeCatalogError("unsupported", `Unsupported picture underlay data: ${message}`);
}

function checkInt(value: number, min: number, max: number, what: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    invalid(`${what} must be an integer ${min}..${max} (got ${String(value)}).`);
}

function checkRect(value: Rect, what: string): void {
  if (value === null || typeof value !== "object") invalid(`${what} must be a rectangle.`);
  checkInt(value.x, 0, Number.MAX_SAFE_INTEGER, `${what}.x`);
  checkInt(value.y, 0, Number.MAX_SAFE_INTEGER, `${what}.y`);
  checkInt(value.width, 1, Number.MAX_SAFE_INTEGER, `${what}.width`);
  checkInt(value.height, 1, Number.MAX_SAFE_INTEGER, `${what}.height`);
}

/** Nearest integer to num/den, halves toward +1, in exact integer arithmetic. */
function roundRatio(num: number, den: number): number {
  return Math.floor((2 * num + den) / (2 * den));
}

/**
 * Derive the explicit integer crop/destination a fit choice implies.
 *
 * `stretch` stores the chosen crop and bounds verbatim — a deliberate
 * distortion. `contain` keeps the chosen crop and shrinks the destination to
 * the largest cell rectangle inside the bounds whose displayed aspect matches
 * the crop; it centres the result, and when the spare cells split oddly the
 * extra cell goes right/bottom. `cover` keeps the bounds and shrinks the crop
 * to the largest centred source rectangle with the bounds' displayed aspect —
 * nothing outside the chosen crop is ever sampled. Contain/cover never
 * distort: the free dimension rounds to the nearest cell (halves toward +1)
 * and can never exceed its limit, and padding stays transparent so the kept
 * picture art shows through.
 *
 * Every returned edge is a positive integer; the destination stays inside the
 * bounds and the crop inside the source. CSS/DPR scaling is the compositor's
 * concern, not this module's.
 */
export function derivePicturePlacement(request: PicturePlacementRequest): PicturePlacement {
  if (request === null || typeof request !== "object") invalid("request must be an object.");
  checkInt(request.sourceWidth, 1, CREATIVE_LIMITS.maxDecodedSide, "request.sourceWidth");
  checkInt(request.sourceHeight, 1, CREATIVE_LIMITS.maxDecodedSide, "request.sourceHeight");
  if (request.sourceWidth * request.sourceHeight > CREATIVE_LIMITS.maxDecodedPixels)
    invalid(
      `request source ${request.sourceWidth}x${request.sourceHeight} is over the ` +
        `${CREATIVE_LIMITS.maxDecodedPixels} decoded pixel limit.`,
    );
  checkRect(request.crop, "request.crop");
  checkRect(request.bounds, "request.bounds");
  const { crop, bounds } = request;
  if (crop.x + crop.width > request.sourceWidth || crop.y + crop.height > request.sourceHeight)
    invalid(
      `request.crop ${crop.x},${crop.y} ${crop.width}x${crop.height} extends past source ` +
        `${request.sourceWidth}x${request.sourceHeight} (crops are never clamped).`,
    );
  if (
    bounds.x + bounds.width > CREATIVE_LIMITS.pictureWidth ||
    bounds.y + bounds.height > CREATIVE_LIMITS.pictureHeight
  )
    invalid(
      `request.bounds must fit inside ${CREATIVE_LIMITS.pictureWidth}x` +
        `${CREATIVE_LIMITS.pictureHeight} logical cells.`,
    );
  if (request.fit !== "contain" && request.fit !== "cover" && request.fit !== "stretch")
    invalid(`request.fit '${String(request.fit)}' is unknown.`);
  if (request.intendedAspect !== "native" && request.intendedAspect !== "original-4:3")
    invalid(`request.intendedAspect '${String(request.intendedAspect)}' is unknown.`);

  const destination = { ...bounds };
  if (request.fit === "stretch") return { crop: { ...crop }, destination };

  const cell = CELL_ASPECT[request.intendedAspect];
  if (request.fit === "contain") {
    // An undistorted destination of dw x dh cells displays the crop at aspect
    // dw*cw / dh*ch = sw/sh, so the target cell aspect is dw/dh = sw*ch/sh*cw.
    const aspectNum = crop.width * cell.h;
    const aspectDen = crop.height * cell.w;
    let dw: number;
    let dh: number;
    if (aspectNum * bounds.height >= aspectDen * bounds.width) {
      // The target aspect is at least as wide as the bounds: width limits.
      dw = bounds.width;
      dh = Math.max(1, roundRatio(bounds.width * aspectDen, aspectNum));
    } else {
      dh = bounds.height;
      dw = Math.max(1, roundRatio(bounds.height * aspectNum, aspectDen));
    }
    return {
      crop: { ...crop },
      destination: {
        x: bounds.x + Math.floor((bounds.width - dw) / 2),
        y: bounds.y + Math.floor((bounds.height - dh) / 2),
        width: dw,
        height: dh,
      },
    };
  }

  // cover: the sampled crop must display at the bounds' aspect,
  // sw/sh = bounds.width*cw / bounds.height*ch, centred inside the chosen crop.
  const fillNum = bounds.width * cell.w;
  const fillDen = bounds.height * cell.h;
  let sw = crop.width;
  let sh = crop.height;
  if (sw * fillDen >= sh * fillNum) {
    sw = Math.max(1, roundRatio(sh * fillNum, fillDen));
  } else {
    sh = Math.max(1, roundRatio(sw * fillDen, fillNum));
  }
  return {
    crop: {
      x: crop.x + Math.floor((crop.width - sw) / 2),
      y: crop.y + Math.floor((crop.height - sh) / 2),
      width: sw,
      height: sh,
    },
    destination,
  };
}

/**
 * Prepare the logical RGBA underlay for one stored recipe and its canonical
 * raster.
 *
 * `recipe` is the catalog's `CreativeRecipe` record; it is re-validated
 * through the strict `readCreativeRecipe` codec before anything else, so
 * untrusted persisted data may be handed in directly. The recipe must pin
 * `algorithm` to `PICTURE_UNDERLAY_ALGORITHM` and carry a `picture-underlay`
 * preparation — the `picture-conversion` kind names the deferred automated
 * experiment and is refused here. `preparation.source` must equal the
 * raster's identity exactly; a stale or missing revision is refused rather
 * than reinterpreted.
 *
 * `descriptor`, when supplied, is the stored `RasterRef` the raster claims to
 * be: its format, dimensions, byte length and SHA-256 must all match the
 * supplied pixels or the call refuses.
 *
 * Every shape, identity, bound and claim failure is raised before the output
 * buffer is allocated. Throws CreativeCatalogError — "invalid" for bad data,
 * "unsupported" for known-but-unhandled versions, kinds and algorithms.
 */
export function preparePictureUnderlay(
  raster: SourceRaster,
  recipe: CreativeRecipe,
  descriptor?: RasterRef,
): PreparedPictureUnderlay {
  // ---- Phase 1: strict codec validation and pinned algorithm/kind ----
  const checked = readCreativeRecipe(recipe, "recipe");
  if (checked.algorithm !== PICTURE_UNDERLAY_ALGORITHM)
    unsupported(`recipe.algorithm '${checked.algorithm}' is not '${PICTURE_UNDERLAY_ALGORITHM}'.`);
  const preparation = checked.preparation as PicturePreparation;
  if (preparation.kind !== "picture-underlay")
    unsupported(
      `preparation.kind '${String(preparation.kind)}' is not 'picture-underlay' ` +
        `(the conversion path is a separate deferred experiment).`,
    );

  // ---- Phase 2: the supplied raster, its identity and descriptor claims ----
  if (raster === null || typeof raster !== "object") invalid("raster must be an object.");
  const identity = readVersionRef(raster.identity, "raster.identity");
  if (!sameVersionRef(preparation.source, identity))
    invalid(
      `preparation.source ${versionRefKey(preparation.source)} does not match the ` +
        `supplied raster ${versionRefKey(identity)} (stale source — refusing to reinterpret).`,
    );
  checkInt(raster.width, 1, CREATIVE_LIMITS.maxDecodedSide, "raster.width");
  checkInt(raster.height, 1, CREATIVE_LIMITS.maxDecodedSide, "raster.height");
  if (raster.width * raster.height > CREATIVE_LIMITS.maxDecodedPixels)
    invalid(
      `raster is ${raster.width}x${raster.height} = ${raster.width * raster.height} pixels, ` +
        `over the ${CREATIVE_LIMITS.maxDecodedPixels} limit.`,
    );
  const rgba = raster.rgba;
  if (!(rgba instanceof Uint8Array) && !(rgba instanceof Uint8ClampedArray))
    invalid("raster.rgba must be a Uint8Array or Uint8ClampedArray.");
  if (rgba.length !== raster.width * raster.height * 4)
    invalid(
      `raster.rgba length ${rgba.length} does not match ` +
        `${raster.width}x${raster.height}x4 = ${raster.width * raster.height * 4}.`,
    );

  if (descriptor !== undefined) {
    if (descriptor === null || typeof descriptor !== "object")
      invalid("descriptor must be a raster descriptor object.");
    if (descriptor.format !== RASTER_FORMAT)
      unsupported(`descriptor.format '${String(descriptor.format)}' is not '${RASTER_FORMAT}'.`);
    if (descriptor.width !== raster.width || descriptor.height !== raster.height)
      invalid(
        `descriptor ${descriptor.width}x${descriptor.height} does not match raster ` +
          `${raster.width}x${raster.height}.`,
      );
    const blob = descriptor.blob;
    if (blob === null || typeof blob !== "object") invalid("descriptor.blob must be an object.");
    if (blob.byteLength !== rgba.length)
      invalid(
        `descriptor.blob.byteLength ${blob.byteLength} does not match the raster's ` +
          `${rgba.length} bytes.`,
      );
    const bytes =
      rgba instanceof Uint8Array
        ? rgba
        : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    if (sha256Hex(bytes) !== blob.hash)
      invalid("descriptor.blob.hash does not match the supplied raster bytes.");
  }

  // ---- Phase 3: geometry against the real source bounds ----
  const { crop, destination } = preparation;
  if (crop.x + crop.width > raster.width || crop.y + crop.height > raster.height)
    invalid(
      `preparation.crop ${crop.x},${crop.y} ${crop.width}x${crop.height} extends past ` +
        `source ${raster.width}x${raster.height} (crops are never clamped).`,
    );

  // ---- Phase 4: nearest-centre sampling into the detached canvas ----
  const canvas = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
  let belowThreshold = 0;
  for (let v = 0; v < destination.height; v++) {
    const sy = crop.y + Math.floor(((2 * v + 1) * crop.height) / (2 * destination.height));
    const row = (destination.y + v) * SCREEN_WIDTH + destination.x;
    for (let u = 0; u < destination.width; u++) {
      const sx = crop.x + Math.floor(((2 * u + 1) * crop.width) / (2 * destination.width));
      const s = (sy * raster.width + sx) * 4;
      const d = (row + u) * 4;
      canvas[d] = rgba[s]!;
      canvas[d + 1] = rgba[s + 1]!;
      canvas[d + 2] = rgba[s + 2]!;
      canvas[d + 3] = rgba[s + 3]!;
      if (rgba[s + 3]! < preparation.alpha.threshold) belowThreshold++;
    }
  }

  return {
    algorithm: PICTURE_UNDERLAY_ALGORITHM,
    recipe: { ...checked.identity },
    source: { ...identity },
    crop: { ...crop },
    destination: { ...destination },
    fit: preparation.fit,
    intendedAspect: preparation.intendedAspect,
    opacity: preparation.opacity,
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    rgba: canvas,
    diagnostics: {
      limits: {
        maxDecodedSide: CREATIVE_LIMITS.maxDecodedSide,
        maxDecodedPixels: CREATIVE_LIMITS.maxDecodedPixels,
        pictureWidth: CREATIVE_LIMITS.pictureWidth,
        pictureHeight: CREATIVE_LIMITS.pictureHeight,
      },
      source: { width: raster.width, height: raster.height },
      alpha: { ...preparation.alpha },
      cropPixels: crop.width * crop.height,
      destinationPixels: destination.width * destination.height,
      canvasPixels: SCREEN_WIDTH * SCREEN_HEIGHT,
      belowThreshold,
    },
  };
}
