/**
 * Deterministic manual reference-art -> native AGI VIEW preparation.
 *
 * The caller supplies canonical RGBA8 rasters (decoded, oriented and frozen
 * upstream; this module never touches image decoding) plus an explicit recipe.
 * The recipe pins the palette, mask and sampling algorithms by name and
 * identifies every source by id/incarnation/revision; a stale or unknown
 * recipe is refused rather than silently reinterpreted.
 *
 * Per frame the recipe declares a source-space `region` (the eligible pixels,
 * also the scale numerator), an output canvas size in logical pixels (the
 * scale denominator) and two anchors. The canvas samples the source-space
 * window
 *
 *   W = [W_left, W_left + sw) x [baselineEdgeY - sh, baselineEdgeY)
 *   W_left = sourceAnchor.x - outputAnchorX * sw / ow
 *
 * that is, the chosen baseline edge lands on the canvas bottom edge (the
 * native baseline is row `outputHeight - 1`) and the horizontal source anchor
 * lands on canvas edge `outputAnchorX`. Canvas pixel (ox, oy) samples source
 * pixel
 *
 *   sx = floor(W_left + (ox + 0.5) * sw / ow)
 *   sy = floor(W_top  + (oy + 0.5) * sh / oh)
 *
 * the "nearest-centre-v1" rule, evaluated in exact integer arithmetic. A
 * sample contributes colour only when (sx, sy) lies inside the region;
 * everything else stays transparent padding. With equal region/output sizes
 * and region-aligned anchors this degenerates to a 1:1 crop+translate. No
 * picture/screen aspect transform, auto-trim or bounding-box rescale ever
 * applies: source crop coordinates are source pixels, output dimensions are
 * already logical pixels.
 *
 * Region pixels the window never samples are losses — below the baseline edge
 * (rows >= baselineEdgeY) or outside the canvas on the other three sides.
 * Opaque losses need the matching explicit approval flag and are reported
 * separately from mask losses (alpha/key erasure inside the canvas).
 *
 * Zero platform dependencies; runs in browser, worker and Node.
 */

import type { AgiProfile } from "../runtime/profile.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import { mirrorPixels } from "./spriteDocument.ts";
import {
  nearestEgaIndex,
  quantizeToEga,
  sheetViewInput,
  type SheetFrame,
  type SheetLoopLayout,
} from "./spritesheet.ts";
import { buildView, parseView, type BuildViewInput } from "./view.ts";

/** The only algorithm this module implements; anything else is refused. */
export const VIEW_PREPARATION_ALGORITHM = "manual-view-preparation-v1";

/** Declared work bounds. Engineering policy, reported in diagnostics. Frozen:
 * this object is admission authority, so callers must not be able to edit it. */
export const PREPARATION_LIMITS = Object.freeze({
  /** Canonical source rasters per call. */
  maxSources: 16,
  /** Pixels per canonical source raster (16 MiP). */
  maxSourcePixels: 16 * 1024 * 1024,
  /** Longest side of a canonical source raster. */
  maxSourceSide: 8192,
  /** Aggregate canonical RGBA bytes across all supplied sources. */
  maxSourceBytes: 128 * 1024 * 1024,
  /** Sum of output canvas pixels over all frames. */
  maxPreparedPixels: 16 * 1024 * 1024,
  /** Sum of region pixels scanned over all frames. */
  maxRegionPixels: 32 * 1024 * 1024,
  /** Native VIEW payload ceiling. */
  maxPayloadBytes: 65535,
  /** Native loop count ceiling (ordinary and packed profiles). */
  maxLoops: 255,
} as const);

/** Identity of one immutable canonical source raster. */
export interface SourceIdentity {
  readonly id: string;
  readonly incarnation: string;
  readonly revision: number;
}

/** A supplied canonical raster: tightly packed unpremultiplied RGBA8. */
export interface SourceRaster {
  readonly identity: SourceIdentity;
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array | Uint8ClampedArray;
}

/** Positive-integer rectangle with half-open source-pixel edges. */
export interface FrameRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type ViewFacing = "right" | "left" | "down" | "up";

export interface ViewRecipeMask {
  /** Alpha below this is transparent. Integer 0..255; the agreed default is 128. */
  readonly alphaThreshold: number;
  /** `null` for alpha-only masks, or an explicit key colour. */
  readonly key: null | {
    readonly mode: string;
    readonly rgb: readonly [number, number, number];
  };
}

export interface ViewRecipeFrame {
  readonly id: string;
  /** Which declared source this frame reads; matched against the supplied rasters. */
  readonly source: SourceIdentity;
  /** Half-open crop rect in oriented canonical source pixels; never clamped. */
  readonly region: FrameRegion;
  /** Output canvas size in logical pixels; also the sampling denominator. */
  readonly outputWidth: number;
  readonly outputHeight: number;
  /** Integer source edges: the anchor column and the edge below the ground row. */
  readonly sourceAnchor: { readonly x: number; readonly baselineEdgeY: number };
  /** Canvas edge the horizontal source anchor lands on, 0..outputWidth. */
  readonly outputAnchorX: number;
  readonly sample: string;
  /** Permit dropping opaque region pixels below `baselineEdgeY`. */
  readonly allowCropBelowBaseline: boolean;
  /** Permit clipping opaque region pixels outside the canvas top/left/right. */
  readonly allowCropOutsideCanvas: boolean;
}

export type ViewRecipeLoop =
  | {
      readonly id: string;
      /** Frame ids in cel order; ids may repeat and may be shared across loops. */
      readonly frameIds: readonly string[];
      readonly facing?: ViewFacing | undefined;
    }
  | {
      readonly id: string;
      /** Earlier loop whose cels this loop shares, displayed mirrored. */
      readonly mirrorOf: string;
      readonly explicitlyApproved: boolean;
      readonly facing?: ViewFacing | undefined;
    };

/**
 * The preparation recipe. Field values are validated at runtime, so callers
 * may hand this untrusted persisted data; stale algorithm/version/name values
 * are refused.
 */
export interface ViewPreparationRecipe {
  readonly format: string;
  readonly version: number;
  readonly kind: string;
  readonly algorithm: string;
  /** The sources this recipe reads; each must match a supplied raster exactly. */
  readonly sources: readonly SourceIdentity[];
  readonly palette: string;
  readonly mask: ViewRecipeMask;
  readonly frames: readonly ViewRecipeFrame[];
  readonly loops: readonly ViewRecipeLoop[];
  /** Optional native VIEW description string (stored in the payload). */
  readonly description?: string | undefined;
}

export interface CropLossCount {
  readonly opaque: number;
  readonly transparent: number;
}

export interface FrameDiagnostics {
  /** Source-space window the canvas sampled (edges; left/right may be fractional). */
  readonly window: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  readonly regionPixels: number;
  readonly canvasPixels: number;
  /** Opaque region pixels inside the sampled window (before sampling loss). */
  readonly windowOpaque: number;
  /** Opaque pixels in the finished canvas. */
  readonly opaque: number;
  /** Sampled pixels dropped by the alpha threshold. */
  readonly alphaErased: number;
  /** Sampled pixels dropped by the colour key (0 without key mode). */
  readonly keyErased: number;
  /** EGA index of the key colour, or null without key mode. */
  readonly keyIndex: number | null;
  /** Bitmask (bit i = EGA index i) of colours used by opaque pixels. */
  readonly usedEgaMask: number;
  /** Region pixels the window never sampled, split by cause. */
  readonly cropLoss: {
    readonly belowBaseline: CropLossCount;
    readonly outsideCanvas: CropLossCount;
  };
}

export interface PreparedFrame {
  readonly id: string;
  readonly source: SourceIdentity;
  readonly region: FrameRegion;
  readonly width: number;
  readonly height: number;
  /** Native baseline row of the cel: always `height - 1`. */
  readonly baseline: number;
  /** EGA nibble per canvas pixel, row-major; transparent cells hold `transparentIndex`. */
  readonly pixels: Uint8Array;
  /** 1 = opaque, 0 = transparent, row-major. */
  readonly mask: Uint8Array;
  /** EGA index the cel reserves for transparency; null when none is free. */
  readonly transparentIndex: number | null;
  readonly diagnostics: FrameDiagnostics;
}

export interface PreparedViewLoop {
  readonly id: string;
  readonly facing: ViewFacing | null;
  readonly kind: "cels" | "mirror";
  /** Frame ids in cel order (empty for mirror loops). */
  readonly frameIds: readonly string[];
  /** Resolved earlier loop index for kind "mirror", else null. */
  readonly mirrorOf: number | null;
}

export interface PreparedView {
  readonly profileId: string;
  readonly algorithm: string;
  /** Prepared frames in recipe order, keyed by their stable ids. */
  readonly frames: readonly PreparedFrame[];
  readonly loops: readonly PreparedViewLoop[];
  /** The exact input `payload` was encoded from. */
  readonly input: BuildViewInput;
  /** The native VIEW payload: buildView(input, profile), decode-verified. */
  readonly payload: Uint8Array;
  readonly diagnostics: {
    readonly limits: typeof PREPARATION_LIMITS;
    readonly totals: {
      readonly frames: number;
      readonly loops: number;
      readonly cels: number;
      readonly preparedPixels: number;
      readonly regionPixels: number;
      readonly payloadBytes: number;
    };
  };
}

function fail(message: string): never {
  throw new RangeError(message);
}

function checkInt(value: number, min: number, max: number, what: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${what} must be an integer ${min}..${max} (got ${String(value)})`);
  }
}

function checkIdentity(ref: SourceIdentity, what: string): void {
  if (ref === null || typeof ref !== "object") fail(`${what} must be a source identity object`);
  if (typeof ref.id !== "string" || ref.id.length === 0) {
    fail(`${what}.id must be a non-empty string`);
  }
  if (typeof ref.incarnation !== "string" || ref.incarnation.length === 0) {
    fail(`${what}.incarnation must be a non-empty string`);
  }
  checkInt(ref.revision, 0, Number.MAX_SAFE_INTEGER, `${what}.revision`);
}

function sameIdentity(a: SourceIdentity, b: SourceIdentity): boolean {
  return a.id === b.id && a.incarnation === b.incarnation && a.revision === b.revision;
}

function identityKey(identity: SourceIdentity): string {
  return `${identity.id} ${identity.incarnation} ${identity.revision}`;
}

function samePixels(a: Uint8Array, b: Uint8Array | readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A horizontally flipped copy — the explicit remedy offered when a native
 * mirror loop is not representable. */
export function flipSheetFrame(frame: SheetFrame): SheetFrame {
  return {
    width: frame.width,
    height: frame.height,
    pixels: mirrorPixels(frame.pixels, frame.width, frame.height),
    mask: mirrorPixels(frame.mask, frame.width, frame.height),
  };
}

interface ResolvedFrame {
  readonly spec: ViewRecipeFrame;
  readonly raster: SourceRaster;
}

interface ResolvedLoop {
  readonly spec: ViewRecipeLoop;
  /** Cel frame indexes into the frame table (content loops only). */
  readonly frameIndexes: readonly number[];
  /** Earlier loop index this loop aliases (mirror loops only). */
  readonly mirrorOf: number | null;
}

const FACING_VALUES: readonly ViewFacing[] = ["right", "left", "down", "up"];

/**
 * Prepare a native VIEW from canonical rasters and an explicit recipe.
 *
 * Throws RangeError naming the offending field or frame on any invalid input;
 * all shape/coordinate/bounds failures are raised before any raster is
 * scanned or output buffer allocated.
 */
export function prepareView(
  rasters: readonly SourceRaster[],
  recipe: ViewPreparationRecipe,
  profile: AgiProfile,
): PreparedView {
  // ---- Phase 1: recipe shape, pinned algorithms and static native bounds ----
  if (recipe === null || typeof recipe !== "object") fail("recipe must be an object");
  if (recipe.format !== "agi.preparation") {
    fail(`unsupported recipe format "${String(recipe.format)}" (expected "agi.preparation")`);
  }
  if (recipe.version !== 1) {
    fail(`unsupported recipe version ${String(recipe.version)} (expected 1)`);
  }
  if (recipe.kind !== "view") {
    fail(`unsupported preparation kind "${String(recipe.kind)}" (expected "view")`);
  }
  if (recipe.algorithm !== VIEW_PREPARATION_ALGORITHM) {
    fail(
      `unsupported preparation algorithm "${String(recipe.algorithm)}" ` +
        `(expected "${VIEW_PREPARATION_ALGORITHM}")`,
    );
  }
  if (recipe.palette !== "ega-weighted-243-v1") {
    fail(`unsupported palette "${String(recipe.palette)}" (expected "ega-weighted-243-v1")`);
  }

  const maskSpec = recipe.mask;
  if (maskSpec === null || typeof maskSpec !== "object") fail("recipe.mask must be an object");
  const alphaThreshold = maskSpec.alphaThreshold;
  checkInt(alphaThreshold, 0, 255, "mask.alphaThreshold");
  let keyIndex: number | null = null;
  let keyColor: readonly [number, number, number] | null = null;
  const key = maskSpec.key;
  if (key !== null) {
    if (typeof key !== "object") {
      fail("mask.key must be null or an explicit key object");
    }
    if (key.mode !== "ega-index-v1") {
      fail(`unsupported mask.key.mode "${String(key.mode)}" (expected "ega-index-v1")`);
    }
    const rgb = key.rgb;
    if (
      !Array.isArray(rgb) ||
      rgb.length !== 3 ||
      !rgb.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)
    ) {
      fail("mask.key.rgb must be three integers 0..255");
    }
    keyColor = [rgb[0]!, rgb[1]!, rgb[2]!];
    keyIndex = nearestEgaIndex(rgb[0]!, rgb[1]!, rgb[2]!);
  }

  if (!Array.isArray(recipe.sources)) fail("recipe.sources must be an array");
  for (const [i, ref] of recipe.sources.entries()) {
    checkIdentity(ref, `recipe.sources[${i}]`);
  }

  if (!Array.isArray(recipe.frames) || recipe.frames.length === 0) {
    fail("recipe.frames must be a non-empty array");
  }
  const frameIndexById = new Map<string, number>();
  let preparedPixels = 0;
  let regionPixels = 0;
  for (const [i, frame] of recipe.frames.entries()) {
    const what = `frames[${i}]${typeof frame?.id === "string" ? ` "${frame.id}"` : ""}`;
    if (frame === null || typeof frame !== "object") fail(`${what} must be an object`);
    if (typeof frame.id !== "string" || frame.id.length === 0) {
      fail(`${what}.id must be a non-empty string`);
    }
    if (frameIndexById.has(frame.id)) fail(`duplicate frame id "${frame.id}"`);
    frameIndexById.set(frame.id, i);
    checkIdentity(frame.source, `${what}.source`);
    const region = frame.region;
    if (region === null || typeof region !== "object") fail(`${what}.region must be an object`);
    checkInt(region.x, 0, Number.MAX_SAFE_INTEGER, `${what}.region.x`);
    checkInt(region.y, 0, Number.MAX_SAFE_INTEGER, `${what}.region.y`);
    checkInt(region.width, 1, Number.MAX_SAFE_INTEGER, `${what}.region.width`);
    checkInt(region.height, 1, Number.MAX_SAFE_INTEGER, `${what}.region.height`);
    checkInt(frame.outputWidth, 1, SCREEN_WIDTH, `${what}.outputWidth`);
    checkInt(frame.outputHeight, 1, SCREEN_HEIGHT, `${what}.outputHeight`);
    const anchor = frame.sourceAnchor;
    if (anchor === null || typeof anchor !== "object") {
      fail(`${what}.sourceAnchor must be an object`);
    }
    if (!Number.isInteger(anchor.x) || anchor.x < 0) {
      fail(`${what}.sourceAnchor.x must be a non-negative integer (got ${String(anchor.x)})`);
    }
    if (!Number.isInteger(anchor.baselineEdgeY) || anchor.baselineEdgeY < 0) {
      fail(
        `${what}.sourceAnchor.baselineEdgeY must be a non-negative integer ` +
          `(got ${String(anchor.baselineEdgeY)})`,
      );
    }
    checkInt(frame.outputAnchorX, 0, frame.outputWidth, `${what}.outputAnchorX`);
    if (frame.sample !== "nearest-centre-v1") {
      fail(
        `${what}.sample "${String(frame.sample)}" is unsupported (expected "nearest-centre-v1")`,
      );
    }
    if (typeof frame.allowCropBelowBaseline !== "boolean") {
      fail(`${what}.allowCropBelowBaseline must be an explicit boolean`);
    }
    if (typeof frame.allowCropOutsideCanvas !== "boolean") {
      fail(`${what}.allowCropOutsideCanvas must be an explicit boolean`);
    }
    preparedPixels += frame.outputWidth * frame.outputHeight;
    regionPixels += region.width * region.height;
  }
  if (preparedPixels > PREPARATION_LIMITS.maxPreparedPixels) {
    fail(
      `frames would prepare ${preparedPixels} canvas pixels, ` +
        `over the ${PREPARATION_LIMITS.maxPreparedPixels} limit`,
    );
  }
  if (regionPixels > PREPARATION_LIMITS.maxRegionPixels) {
    fail(
      `frames would scan ${regionPixels} region pixels, ` +
        `over the ${PREPARATION_LIMITS.maxRegionPixels} limit`,
    );
  }

  if (!Array.isArray(recipe.loops) || recipe.loops.length === 0) {
    fail("recipe.loops must be a non-empty array");
  }
  if (recipe.loops.length > PREPARATION_LIMITS.maxLoops) {
    fail(
      `view must have at most ${PREPARATION_LIMITS.maxLoops} loops (got ${recipe.loops.length})`,
    );
  }
  const packed = profile.packedViewLoopHeader;
  const maxCels = packed ? 15 : 255;
  const loopIndexById = new Map<string, number>();
  const resolvedLoops: ResolvedLoop[] = [];
  const referencedFrames = new Set<number>();
  let celTotal = 0;
  for (const [i, loop] of recipe.loops.entries()) {
    const what = `loops[${i}]${typeof loop?.id === "string" ? ` "${loop.id}"` : ""}`;
    if (loop === null || typeof loop !== "object") fail(`${what} must be an object`);
    if (typeof loop.id !== "string" || loop.id.length === 0) {
      fail(`${what}.id must be a non-empty string`);
    }
    if (loopIndexById.has(loop.id)) fail(`duplicate loop id "${loop.id}"`);
    loopIndexById.set(loop.id, i);
    if (loop.facing !== undefined && !FACING_VALUES.includes(loop.facing)) {
      fail(`${what}.facing must be one of ${FACING_VALUES.join("/")} (got ${String(loop.facing)})`);
    }
    const hasFrames = "frameIds" in loop && loop.frameIds !== undefined;
    const hasMirror = "mirrorOf" in loop && loop.mirrorOf !== undefined;
    if (hasFrames === hasMirror) {
      fail(`${what} must declare exactly one of frameIds or mirrorOf`);
    }
    if (hasFrames) {
      const frameIds = (loop as { frameIds: readonly string[] }).frameIds;
      if (!Array.isArray(frameIds) || frameIds.length === 0) {
        fail(`${what}.frameIds must be a non-empty array`);
      }
      if (frameIds.length > maxCels) {
        fail(
          `${what} declares ${frameIds.length} cels; profile "${profile.id}" allows at most ${maxCels}`,
        );
      }
      const indexes: number[] = [];
      for (const frameId of frameIds) {
        const index = frameIndexById.get(frameId);
        if (index === undefined) {
          fail(`${what} references unknown frame id "${String(frameId)}"`);
        }
        referencedFrames.add(index);
        indexes.push(index);
      }
      celTotal += frameIds.length;
      resolvedLoops.push({ spec: loop, frameIndexes: indexes, mirrorOf: null });
    } else {
      const mirrorSpec = loop as { mirrorOf: string; explicitlyApproved: boolean };
      const mirrorOf = mirrorSpec.mirrorOf;
      if (mirrorSpec.explicitlyApproved !== true) {
        fail(
          `${what} is a mirrored loop; mirroring requires explicitlyApproved: true ` +
            `(asymmetric art must not be mirrored silently)`,
        );
      }
      const target = loopIndexById.get(mirrorOf);
      if (target === undefined || target >= i) {
        fail(`${what}.mirrorOf "${String(mirrorOf)}" must name an earlier loop`);
      }
      const targetLoop = resolvedLoops[target]!;
      if (targetLoop.mirrorOf !== null) {
        fail(
          `${what} mirrors loop ${target} which is itself a mirror; the native format cannot ` +
            `chain data blocks — reference the original loop or supply an explicit ` +
            `pixel-flipped independent copy`,
        );
      }
      if (packed) {
        if (i > 3 || target > 3) {
          fail(
            `${what} mirrors loop ${target} at index ${i}; profile "${profile.id}" can only ` +
              `encode mirrored loops for indices 0..3 — supply an explicit pixel-flipped ` +
              `independent copy instead`,
          );
        }
      } else if ((i & 7) === (target & 7)) {
        fail(
          `${what} mirrors loop ${target} at index ${i}; the format's orientation nibbles ` +
            `are equal mod 8 so it would display unmirrored — supply an explicit ` +
            `pixel-flipped independent copy instead`,
        );
      }
      resolvedLoops.push({ spec: loop, frameIndexes: [], mirrorOf: target });
    }
  }

  if (recipe.description !== undefined) {
    if (typeof recipe.description !== "string") fail("recipe.description must be a string");
    for (let i = 0; i < recipe.description.length; i++) {
      const byte = recipe.description.charCodeAt(i);
      if (byte === 0 || byte > 255) {
        fail(`recipe.description character ${i} does not fit a non-zero byte`);
      }
    }
  }

  // Payload lower bound: header + loop table, then per content loop the cel
  // count byte, cel offset table and per cel the 3-byte header plus one
  // terminator byte per row. Fails oversized recipes before any raster work.
  let minPayloadBytes = 5 + recipe.loops.length * 2;
  for (const loop of resolvedLoops) {
    if (loop.mirrorOf !== null) continue;
    let loopBytes = 1 + loop.frameIndexes.length * 2;
    for (const frameIndex of loop.frameIndexes) {
      loopBytes += 3 + recipe.frames[frameIndex]!.outputHeight;
    }
    minPayloadBytes += loopBytes;
  }
  if (recipe.description !== undefined) minPayloadBytes += recipe.description.length + 1;
  if (minPayloadBytes > PREPARATION_LIMITS.maxPayloadBytes) {
    fail(
      `view payload cannot fit: minimum encoding is ${minPayloadBytes} bytes, ` +
        `over the ${PREPARATION_LIMITS.maxPayloadBytes} limit`,
    );
  }

  // ---- Phase 2: supplied raster registry and source-bound checks ----
  if (!Array.isArray(rasters) || rasters.length === 0) {
    fail("at least one source raster is required");
  }
  if (rasters.length > PREPARATION_LIMITS.maxSources) {
    fail(
      `at most ${PREPARATION_LIMITS.maxSources} sources per preparation (got ${rasters.length})`,
    );
  }
  const rasterByIdentity = new Map<string, SourceRaster>();
  let sourceBytes = 0;
  for (const [i, raster] of rasters.entries()) {
    const what = `sources[${i}]`;
    if (raster === null || typeof raster !== "object") fail(`${what} must be an object`);
    checkIdentity(raster.identity, `${what}.identity`);
    checkInt(raster.width, 1, PREPARATION_LIMITS.maxSourceSide, `${what}.width`);
    checkInt(raster.height, 1, PREPARATION_LIMITS.maxSourceSide, `${what}.height`);
    if (raster.width * raster.height > PREPARATION_LIMITS.maxSourcePixels) {
      fail(
        `${what} is ${raster.width}x${raster.height} = ${raster.width * raster.height} pixels, ` +
          `over the ${PREPARATION_LIMITS.maxSourcePixels} limit`,
      );
    }
    const expected = raster.width * raster.height * 4;
    if (raster.rgba.length !== expected) {
      fail(
        `${what}.rgba length ${raster.rgba.length} does not match ` +
          `${raster.width}x${raster.height}x4 = ${expected}`,
      );
    }
    sourceBytes += raster.rgba.length;
    if (sourceBytes > PREPARATION_LIMITS.maxSourceBytes) {
      fail(`supplied sources exceed ${PREPARATION_LIMITS.maxSourceBytes} aggregate bytes`);
    }
    const keyName = identityKey(raster.identity);
    if (rasterByIdentity.has(keyName)) {
      fail(`two supplied rasters share identity ${keyName}`);
    }
    rasterByIdentity.set(keyName, raster);
  }

  const declaredSources: SourceIdentity[] = recipe.sources;
  const declaredKeySet = new Set<string>();
  for (const ref of declaredSources) {
    const keyName = identityKey(ref);
    if (declaredKeySet.has(keyName)) fail(`recipe.sources lists ${keyName} twice`);
    declaredKeySet.add(keyName);
    if (!rasterByIdentity.has(keyName)) {
      fail(
        `recipe declares source ${keyName} but no matching raster was supplied ` +
          `(stale or missing source — refusing to reinterpret)`,
      );
    }
  }

  const resolvedFrames: ResolvedFrame[] = recipe.frames.map((frame, i) => {
    const what = `frames[${i}] "${frame.id}"`;
    if (!declaredSources.some((ref) => sameIdentity(ref, frame.source))) {
      fail(`${what}.source ${identityKey(frame.source)} is not declared in recipe.sources`);
    }
    const raster = rasterByIdentity.get(identityKey(frame.source));
    if (raster === undefined) {
      fail(
        `${what}.source ${identityKey(frame.source)} does not match any supplied raster ` +
          `(stale or missing source — refusing to reinterpret)`,
      );
    }
    const { region } = frame;
    if (region.x + region.width > raster.width || region.y + region.height > raster.height) {
      fail(
        `${what}.region ${region.x},${region.y} ${region.width}x${region.height} extends past ` +
          `source ${raster.width}x${raster.height} (crops are never clamped)`,
      );
    }
    if (frame.sourceAnchor.x > raster.width) {
      fail(`${what}.sourceAnchor.x ${frame.sourceAnchor.x} is past source width ${raster.width}`);
    }
    if (frame.sourceAnchor.baselineEdgeY > raster.height) {
      fail(
        `${what}.sourceAnchor.baselineEdgeY ${frame.sourceAnchor.baselineEdgeY} is past ` +
          `source height ${raster.height}`,
      );
    }
    return { spec: frame, raster };
  });

  // ---- Phase 3: per-frame sampling, clip approval and quantisation ----
  const frames: PreparedFrame[] = [];
  const sheetFrames: SheetFrame[] = [];
  for (const { spec: frame, raster } of resolvedFrames) {
    const prepared = prepareFrame(frame, raster, alphaThreshold, keyIndex, keyColor);
    if (referencedFrames.has(frameIndexById.get(frame.id)!) && prepared.transparentIndex === null) {
      fail(
        `frame "${frame.id}" uses all 16 EGA colours in opaque pixels; no index remains ` +
          `for native transparency — a palette remap is required`,
      );
    }
    frames.push(prepared);
    sheetFrames.push({
      width: prepared.width,
      height: prepared.height,
      pixels: prepared.pixels,
      mask: prepared.mask,
    });
  }

  // ---- Phase 4: pack through the shared helpers, then decode-verify ----
  const layoutLoops: SheetLoopLayout[] = resolvedLoops.map((loop) =>
    loop.mirrorOf === null ? { frames: loop.frameIndexes } : { mirrorOf: loop.mirrorOf },
  );
  const input = sheetViewInput(sheetFrames, {
    loops: layoutLoops,
    ...(keyIndex !== null ? { preferTransparent: keyIndex } : {}),
    ...(recipe.description !== undefined ? { description: recipe.description } : {}),
  });
  const payload = buildView(input, profile);
  verifyEncoded(input, resolvedLoops, payload, profile);

  const loops: PreparedViewLoop[] = resolvedLoops.map((loop) => {
    const spec = loop.spec;
    return {
      id: spec.id,
      facing: spec.facing ?? null,
      kind: loop.mirrorOf === null ? "cels" : "mirror",
      frameIds:
        loop.mirrorOf === null ? [...(spec as { frameIds: readonly string[] }).frameIds] : [],
      mirrorOf: loop.mirrorOf,
    };
  });

  return {
    profileId: profile.id,
    algorithm: recipe.algorithm,
    frames,
    loops,
    input,
    payload,
    diagnostics: {
      limits: { ...PREPARATION_LIMITS },
      totals: {
        frames: frames.length,
        loops: recipe.loops.length,
        cels: celTotal,
        preparedPixels,
        regionPixels,
        payloadBytes: payload.length,
      },
    },
  };
}

/**
 * Sample, clip-check and quantise one frame. The output canvas is ow x oh
 * logical pixels; the sampled window is the source-space rect derived from
 * the anchors described in this file's header.
 */
function prepareFrame(
  frame: ViewRecipeFrame,
  raster: SourceRaster,
  alphaThreshold: number,
  keyIndex: number | null,
  keyColor: readonly [number, number, number] | null,
): PreparedFrame {
  const { x: rx, y: ry, width: sw, height: sh } = frame.region;
  const ow = frame.outputWidth;
  const oh = frame.outputHeight;
  const baseline = frame.sourceAnchor.baselineEdgeY;
  const wTop = baseline - sh;
  // W_left is rational: keep it as numerator over ow so every comparison and
  // sample is exact integer arithmetic.
  const wLeftNum = ow * frame.sourceAnchor.x - frame.outputAnchorX * sw;
  const wRightNum = wLeftNum + sw * ow;

  const rgba = raster.rgba;
  const srcWidth = raster.width;
  const isOpaque = (offset: number): boolean =>
    rgba[offset + 3]! >= alphaThreshold &&
    (keyIndex === null ||
      nearestEgaIndex(rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!) !== keyIndex);

  const belowBaseline: { opaque: number; transparent: number } = { opaque: 0, transparent: 0 };
  const outsideCanvas: { opaque: number; transparent: number } = { opaque: 0, transparent: 0 };
  let windowOpaque = 0;
  for (let sy = ry; sy < ry + sh; sy++) {
    if (sy >= baseline) {
      for (let sx = rx; sx < rx + sw; sx++) {
        belowBaseline[isOpaque((sy * srcWidth + sx) * 4) ? "opaque" : "transparent"]++;
      }
      continue;
    }
    const aboveWindow = sy < wTop;
    for (let sx = rx; sx < rx + sw; sx++) {
      // Pixel interval [sx, sx+1) is inside the window iff it intersects
      // [W_left, W_right): (sx+1)*ow > wLeftNum && sx*ow < wRightNum.
      const inside = !aboveWindow && (sx + 1) * ow > wLeftNum && sx * ow < wRightNum;
      if (!inside) {
        outsideCanvas[isOpaque((sy * srcWidth + sx) * 4) ? "opaque" : "transparent"]++;
      } else if (isOpaque((sy * srcWidth + sx) * 4)) {
        windowOpaque++;
      }
    }
  }
  if (belowBaseline.opaque > 0 && !frame.allowCropBelowBaseline) {
    fail(
      `frame "${frame.id}": ${belowBaseline.opaque} opaque source pixel(s) sit below ` +
        `baselineEdgeY ${baseline}; move the baseline or region, or set ` +
        `allowCropBelowBaseline to approve the crop`,
    );
  }
  if (outsideCanvas.opaque > 0 && !frame.allowCropOutsideCanvas) {
    fail(
      `frame "${frame.id}": ${outsideCanvas.opaque} opaque source pixel(s) fall outside ` +
        `the ${ow}x${oh} output canvas; adjust the region, anchors or output size, ` +
        `or set allowCropOutsideCanvas to approve the crop`,
    );
  }

  const canvas = new Uint8Array(ow * oh * 4);
  const sampled = new Uint8Array(ow * oh);
  for (let oy = 0; oy < oh; oy++) {
    const sy = wTop + Math.floor(((2 * oy + 1) * sh) / (2 * oh));
    const inY = sy >= ry && sy < ry + sh;
    for (let ox = 0; ox < ow; ox++) {
      const sx = Math.floor((2 * wLeftNum + (2 * ox + 1) * sw) / (2 * ow));
      if (!inY || sx < rx || sx >= rx + sw) continue;
      const src = (sy * srcWidth + sx) * 4;
      const dst = (oy * ow + ox) * 4;
      canvas[dst] = rgba[src]!;
      canvas[dst + 1] = rgba[src + 1]!;
      canvas[dst + 2] = rgba[src + 2]!;
      canvas[dst + 3] = rgba[src + 3]!;
      sampled[oy * ow + ox] = 1;
    }
  }

  // Border-key detection is always off for this path: new imports erase only
  // by alpha plus an explicit key, never by the old quantizer's border guess.
  const sheet = quantizeToEga(canvas, ow, oh, { alphaThreshold, keyColor });

  // Padding is not source data: a threshold of 0 must not turn it into art.
  for (let i = 0; i < ow * oh; i++) {
    if (sampled[i] === 0) sheet.mask[i] = 0;
  }

  let opaque = 0;
  let alphaErased = 0;
  let keyErased = 0;
  let usedEgaMask = 0;
  for (let i = 0; i < ow * oh; i++) {
    if (sheet.mask[i] === 1) {
      opaque++;
      usedEgaMask |= 1 << sheet.pixels[i]!;
    } else if (sampled[i] === 1) {
      // Mask losses count source pixels the recipe erased; padding that never
      // sampled the region is not a loss.
      if (canvas[i * 4 + 3]! >= alphaThreshold) keyErased++;
      else alphaErased++;
    }
  }
  let transparentIndex: number | null = keyIndex;
  if (transparentIndex === null) {
    for (let i = 0; i < 16; i++) {
      if ((usedEgaMask & (1 << i)) === 0) {
        transparentIndex = i;
        break;
      }
    }
  }
  if (transparentIndex !== null) {
    for (let i = 0; i < ow * oh; i++) {
      if (sheet.mask[i] === 0) sheet.pixels[i] = transparentIndex;
    }
  }

  return {
    id: frame.id,
    source: { ...frame.source },
    region: { ...frame.region },
    width: ow,
    height: oh,
    baseline: oh - 1,
    pixels: sheet.pixels,
    mask: sheet.mask,
    transparentIndex,
    diagnostics: {
      window: {
        left: wLeftNum / ow,
        top: wTop,
        right: wRightNum / ow,
        bottom: baseline,
      },
      regionPixels: sw * sh,
      canvasPixels: ow * oh,
      windowOpaque,
      opaque,
      alphaErased,
      keyErased,
      keyIndex,
      usedEgaMask,
      cropLoss: { belowBaseline, outsideCanvas },
    },
  };
}

/**
 * Decode-verify the built payload: every cel's displayed pixels must equal
 * the prepared pixels, with mirror loops showing their source loop's display
 * flipped. A mismatch means the encoding cannot express the recipe — refuse
 * rather than ship bytes that display differently.
 */
function verifyEncoded(
  input: BuildViewInput,
  loops: readonly ResolvedLoop[],
  payload: Uint8Array,
  profile: AgiProfile,
): void {
  const decoded = parseView(payload, profile);
  if (decoded.loops.length !== input.loops.length) {
    fail(`encoded view has ${decoded.loops.length} loops, expected ${input.loops.length}`);
  }
  const expectedByLoop: {
    width: number;
    height: number;
    transparent: number;
    pixels: Uint8Array;
  }[][] = [];
  for (const [i, loop] of loops.entries()) {
    const actual = decoded.loops[i]!;
    let expected: { width: number; height: number; transparent: number; pixels: Uint8Array }[];
    if (loop.mirrorOf === null) {
      expected = input.loops[i]!.cels!.map((cel) => ({
        width: cel.width,
        height: cel.height,
        transparent: typeof cel.transparentColor === "number" ? cel.transparentColor : 0,
        pixels: cel.pixels instanceof Uint8Array ? cel.pixels : Uint8Array.from(cel.pixels),
      }));
    } else {
      expected = expectedByLoop[loop.mirrorOf]!.map((cel) => ({
        width: cel.width,
        height: cel.height,
        transparent: cel.transparent,
        pixels: mirrorPixels(cel.pixels, cel.width, cel.height),
      }));
    }
    expectedByLoop.push(expected);
    if (actual.cels.length !== expected.length) {
      fail(`loop ${i} encodes ${actual.cels.length} cels, expected ${expected.length}`);
    }
    for (const [c, cel] of actual.cels.entries()) {
      const want = expected[c]!;
      const matches =
        cel.width === want.width &&
        cel.height === want.height &&
        cel.transparentColor === want.transparent &&
        samePixels(cel.pixels, want.pixels);
      if (!matches || (loop.mirrorOf !== null && !cel.mirrored)) {
        if (loop.mirrorOf !== null) {
          fail(
            `loop ${i} cannot be represented natively as a mirror of loop ${loop.mirrorOf} ` +
              `under profile "${profile.id}" — supply an explicit pixel-flipped ` +
              `independent copy instead`,
          );
        }
        fail(`loop ${i} cel ${c} failed the native encoding round-trip`);
      }
    }
  }
}
