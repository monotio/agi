/**
 * AGI view-resource decoder and cel composition.
 *
 * Decodes expanded view payloads into loops of cels per Peter Kelly's agi-re
 * behavioral specification, "View Resources and Cel Drawing": the payload header with
 * per-loop offsets, RLE row chunks with color-nibble/run-length encoding,
 * per-cel orientation mirroring as mutable loaded-resource state, baseline
 * placement, and priority/control-surface composition with downward
 * control-color scanning.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH, type PictureSurface } from "../types.ts";
import { DEFAULT_V2_PROFILE, type AgiProfile } from "../runtime/profile.ts";

export interface ViewCel {
  /** Width in logical pixels. */
  readonly width: number;
  /** Height in logical pixels. */
  readonly height: number;
  /** Transparent color, 0..15 (low nibble of the cel control byte). */
  readonly transparentColor: number;
  /**
   * True when the current pixels are mirrored relative to the file row stream.
   */
  mirrored: boolean;
  /**
   * Decoded visual-nibble bitmap of the cel as drawn by this loop, row-major,
   * width*height bytes, 0..15. Transparent cells hold `transparentColor`;
   * mirroring is already applied.
   */
  readonly pixels: Uint8Array;
}

export interface ViewLoop {
  readonly cels: ViewCel[];
}

export interface BuildCelInput {
  /** Width in logical pixels (1..SCREEN_WIDTH). */
  readonly width: number;
  /** Height in logical pixels (1..168). */
  readonly height: number;
  /** Transparent color index (0..15). Defaults to 0 if omitted or null. */
  readonly transparentColor?: number | null | undefined;
  /**
   * Row-major visual pixels (0..15), length must equal width * height.
   */
  readonly pixels: Uint8Array | readonly number[];
  /**
   * If true, this cel is marked mirrorable (control bit 0x80).
   */
  readonly mirror?: boolean | null | undefined;
}

export interface BuildLoopInput {
  /**
   * Cels belonging to this loop.
   * If `mirrorLoop` is specified and `cels` is absent or empty, this loop shares the cels of `mirrorLoop`.
   */
  readonly cels?: readonly BuildCelInput[] | null | undefined;
  /**
   * If specified (and `cels` is absent or empty), this loop reuses the cels and loop offset of another loop (0-based index).
   * The referenced loop must appear before this loop.
   */
  readonly mirrorLoop?: number | null | undefined;
}

export interface BuildViewInput {
  readonly loops: readonly BuildLoopInput[];
  /** Optional description string (null-terminated text). */
  readonly description?: string | null | undefined;
}

export interface AgiView {
  readonly loops: ViewLoop[];
  readonly description?: string;
}

export function buildView(
  input: BuildViewInput,
  profile: Pick<AgiProfile, "packedViewLoopHeader"> = DEFAULT_V2_PROFILE,
): Uint8Array {
  const packed = profile.packedViewLoopHeader;
  const loopCount = input.loops.length;
  if (loopCount < 1 || loopCount > 255) {
    throw new RangeError(`view must have between 1 and 255 loops (got ${loopCount})`);
  }

  // Determine which loops are mirrored by any subsequent loop.
  const isMirroredLoop = new Set<number>();
  for (let i = 0; i < loopCount; i++) {
    const loop = input.loops[i]!;
    const hasCels = Array.isArray(loop.cels) && loop.cels.length > 0;
    const hasMirror = typeof loop.mirrorLoop === "number";

    if (hasMirror && !hasCels) {
      if (loop.mirrorLoop! < 0 || loop.mirrorLoop! >= i) {
        throw new RangeError(
          `loop ${i} mirrorLoop ${loop.mirrorLoop} must reference a preceding loop (0..${i - 1})`,
        );
      }
      if (packed && i > 3) {
        throw new RangeError("packed mutable loop indices must be in 0..3");
      }
      isMirroredLoop.add(loop.mirrorLoop!);
    } else {
      if (!hasCels) {
        throw new RangeError(`loop ${i} must have at least 1 cel or specify mirrorLoop`);
      }
      const maxCels = packed ? 15 : 255;
      if (loop.cels!.length > maxCels) {
        throw new RangeError(`loop ${i} exceeds ${maxCels} cels`);
      }
    }
  }

  const headerAndTableSize = 5 + loopCount * 2;
  const loopOffsets: number[] = new Array(loopCount).fill(0);
  const loopBytesList: Uint8Array[] = [];
  const loopStartOffsets = new Map<number, number>();
  let currentOffset = headerAndTableSize;

  for (let loopIndex = 0; loopIndex < loopCount; loopIndex++) {
    const loop = input.loops[loopIndex]!;
    const hasCels = Array.isArray(loop.cels) && loop.cels.length > 0;
    const hasMirror = typeof loop.mirrorLoop === "number";

    if (hasMirror && !hasCels) {
      const targetOffset = loopStartOffsets.get(loop.mirrorLoop!);
      if (targetOffset === undefined) {
        throw new RangeError(`loop ${loopIndex} references unencoded loop ${loop.mirrorLoop}`);
      }
      loopOffsets[loopIndex] = targetOffset;
      continue;
    }

    const cels = loop.cels!;
    const celCount = cels.length;
    const forceMirror = isMirroredLoop.has(loopIndex);
    const packedMirror = packed && (forceMirror || cels.some((cel) => cel.mirror));
    if (packedMirror && loopIndex > 3) {
      throw new RangeError("packed mutable loop indices must be in 0..3");
    }

    const encodedCels: Uint8Array[] = [];
    for (let celIndex = 0; celIndex < celCount; celIndex++) {
      const cel = cels[celIndex]!;
      const { width, height, transparentColor, mirror, pixels } = cel;
      const transColor = typeof transparentColor === "number" ? transparentColor : 0;
      const mirrorBit = Boolean(mirror);

      if (width < 1 || width > SCREEN_WIDTH) {
        throw new RangeError(`cel width must be between 1 and ${SCREEN_WIDTH} (got ${width})`);
      }
      if (height < 1 || height > 168) {
        throw new RangeError(`cel height must be between 1 and 168 (got ${height})`);
      }
      if (transColor < 0 || transColor > 15) {
        throw new RangeError(`transparentColor must be 0..15 (got ${transColor})`);
      }
      if (pixels.length !== width * height) {
        throw new RangeError(
          `cel pixels length ${pixels.length} does not match width ${width} * height ${height} = ${width * height}`,
        );
      }

      const mirrorable = mirrorBit || forceMirror;
      const control = packed
        ? transColor & 0x0f
        : (mirrorable ? 0x80 : 0) | ((loopIndex & 7) << 4) | (transColor & 0x0f);

      const celChunks: number[] = [width, height, control];
      for (let row = 0; row < height; row++) {
        const rowStart = row * width;
        let lastNonTrans = -1;
        for (let x = width - 1; x >= 0; x--) {
          const color = pixels[rowStart + x]!;
          if (!Number.isInteger(color) || color < 0 || color > 15) {
            throw new RangeError(`pixel at row ${row}, col ${x} has invalid color ${color}`);
          }
          if (color !== transColor) {
            lastNonTrans = x;
            break;
          }
        }

        if (lastNonTrans === -1) {
          celChunks.push(0x00);
        } else {
          const end = lastNonTrans + 1;
          let x = 0;
          while (x < end) {
            const color = pixels[rowStart + x]! & 0x0f;
            let runLen = 1;
            while (x + runLen < end && pixels[rowStart + x + runLen] === color) {
              runLen++;
            }
            x += runLen;
            while (runLen > 15) {
              celChunks.push((color << 4) | 15);
              runLen -= 15;
            }
            celChunks.push((color << 4) | runLen);
          }
          celChunks.push(0x00);
        }
      }

      encodedCels.push(new Uint8Array(celChunks));
    }

    const loopHeaderSize = 1 + celCount * 2;
    let loopTotalSize = loopHeaderSize;
    for (const ec of encodedCels) {
      loopTotalSize += ec.length;
    }

    const loopBytes = new Uint8Array(loopTotalSize);
    loopBytes[0] = celCount | (packedMirror ? 0xc0 | ((loopIndex & 3) << 4) : 0);

    let celRelativeOffset = loopHeaderSize;
    for (let c = 0; c < celCount; c++) {
      loopBytes[1 + c * 2] = celRelativeOffset & 0xff;
      loopBytes[1 + c * 2 + 1] = (celRelativeOffset >>> 8) & 0xff;
      loopBytes.set(encodedCels[c]!, celRelativeOffset);
      celRelativeOffset += encodedCels[c]!.length;
    }

    loopOffsets[loopIndex] = currentOffset;
    loopStartOffsets.set(loopIndex, currentOffset);
    loopBytesList.push(loopBytes);
    currentOffset += loopTotalSize;
  }

  let descBytes: Uint8Array | null = null;
  let descOffset = 0;
  if (
    input.description !== undefined &&
    input.description !== null &&
    input.description.length > 0
  ) {
    descBytes = new Uint8Array(input.description.length + 1);
    for (let i = 0; i < input.description.length; i++) {
      const byte = input.description.charCodeAt(i);
      if (byte === 0) throw new RangeError("view description cannot contain a zero byte");
      if (byte > 255) throw new RangeError("view description characters must fit one byte");
      descBytes[i] = byte;
    }
    descOffset = currentOffset;
    currentOffset += descBytes.length;
  }

  if (currentOffset > 65535) {
    throw new RangeError(`view payload exceeds 65535 bytes (got ${currentOffset})`);
  }

  const payload = new Uint8Array(currentOffset);
  payload[0] = 0;
  payload[1] = 0;
  payload[2] = loopCount;
  payload[3] = descOffset & 0xff;
  payload[4] = (descOffset >>> 8) & 0xff;

  for (let i = 0; i < loopCount; i++) {
    const off = loopOffsets[i]!;
    payload[5 + i * 2] = off & 0xff;
    payload[5 + i * 2 + 1] = (off >>> 8) & 0xff;
  }

  let writeOffset = headerAndTableSize;
  for (const lb of loopBytesList) {
    payload.set(lb, writeOffset);
    writeOffset += lb.length;
  }

  if (descBytes) {
    payload.set(descBytes, descOffset);
  }

  return payload;
}

function u16le(payload: Uint8Array, offset: number): number {
  return payload[offset]! | (payload[offset + 1]! << 8);
}

interface LoadedCel {
  cel: ViewCel;
  orientation: number;
  mirrorable: boolean;
}

interface LoadedLoop {
  cels: LoadedCel[];
  orientation: number;
  mutable: boolean;
  mirrorable: boolean;
}

interface LoadedView {
  loops: LoadedLoop[];
  packed: boolean;
}

// Loaded orientations belong to this decoded resource, never to container
// bytes. Aliased offsets share state; loading the resource again resets it.
const loadedViews = new WeakMap<AgiView, LoadedView>();

/**
 * Validate a view and provide independent, initially selected cel previews.
 * Runtime users call selectViewCel on selection and readViewCel for drawing:
 * selecting three aliases in sequence cannot be represented by static images.
 */
export function parseView(
  payload: Uint8Array,
  profile: Pick<AgiProfile, "packedViewLoopHeader"> = DEFAULT_V2_PROFILE,
): AgiView {
  if (payload.length < 5) {
    throw new RangeError("view payload shorter than the 5-byte header");
  }
  const loopCount = payload[2]!;
  if (5 + loopCount * 2 > payload.length) {
    throw new RangeError("loop offset table extends past the payload");
  }
  const packed = profile.packedViewLoopHeader;
  const celsByOffset = new Map<number, LoadedCel>();
  const loopsByOffset = new Map<number, LoadedLoop>();
  const loaded: LoadedView = { loops: [], packed };
  const loops: ViewLoop[] = [];
  for (let loopIndex = 0; loopIndex < loopCount; loopIndex++) {
    const loopStart = u16le(payload, 5 + loopIndex * 2);
    if (loopStart + 1 > payload.length) {
      throw new RangeError(`loop ${loopIndex} header outside the payload`);
    }
    const header = payload[loopStart]!;
    const celCount = packed ? header & 0x0f : header;
    if (loopStart + 1 + celCount * 2 > payload.length) {
      throw new RangeError(`loop ${loopIndex} cel offset table outside the payload`);
    }
    let loop = loopsByOffset.get(loopStart);
    if (!loop) {
      loop = {
        cels: [],
        orientation: (header & 0x30) >>> 4,
        mutable: packed && (header & 0x80) !== 0,
        mirrorable: packed && (header & 0x40) !== 0,
      };
      for (let celIndex = 0; celIndex < celCount; celIndex++) {
        const celStart = loopStart + u16le(payload, loopStart + 1 + celIndex * 2);
        let cel = celsByOffset.get(celStart);
        if (!cel) {
          cel = decodeCel(payload, celStart);
          celsByOffset.set(celStart, cel);
        }
        loop.cels.push(cel);
      }
      loopsByOffset.set(loopStart, loop);
    }
    loaded.loops.push(loop);
    loops.push({
      cels: loop.cels.map((state) => {
        const mirrored = packed
          ? loop.mutable && loop.mirrorable && loop.orientation !== loopIndex
          : state.mirrorable && state.orientation !== (loopIndex & 7);
        const cel = { ...state.cel, pixels: state.cel.pixels.slice(), mirrored: false };
        if (mirrored) mirrorPixels(cel);
        return cel;
      }),
    });
  }

  const descOffset = u16le(payload, 3);
  let description: string | undefined;
  if (descOffset > 0 && descOffset < payload.length) {
    description = "";
    for (let pos = descOffset; pos < payload.length && payload[pos] !== 0; pos++) {
      description += String.fromCharCode(payload[pos]!);
    }
  }
  const view: AgiView = description !== undefined ? { loops, description } : { loops };
  loadedViews.set(view, loaded);
  return view;
}

/** Read the current shared row image without triggering an orientation change. */
export function readViewCel(view: AgiView, loop: number, cel: number): ViewCel | undefined {
  const loaded = loadedViews.get(view);
  return loaded ? loaded.loops[loop]?.cels[cel]?.cel : view.loops[loop]?.cels[cel];
}

/**
 * Select a cel, applying the profile's mutable orientation contract. Returned
 * pixels remain shared: a later selection through an alias can mirror them.
 */
export function selectViewCel(
  view: AgiView,
  loopIndex: number,
  celIndex: number,
): ViewCel | undefined {
  const loaded = loadedViews.get(view);
  if (!loaded) return view.loops[loopIndex]?.cels[celIndex];
  const loop = loaded.loops[loopIndex];
  const state = loop?.cels[celIndex];
  if (!loop || !state) return undefined;
  if (loaded.packed) {
    if (loop.mutable && loop.orientation !== loopIndex) {
      if (loop.mirrorable) {
        for (const cel of loop.cels) mirrorPixels(cel.cel);
      }
      loop.orientation = loopIndex;
    }
  } else if (state.mirrorable && state.orientation !== (loopIndex & 7)) {
    mirrorPixels(state.cel);
    state.orientation = loopIndex & 7;
  }
  return state.cel;
}

function mirrorPixels(cel: ViewCel): void {
  cel.mirrored = !cel.mirrored;
  // For valid row streams, reversing the decoded width is pixel-equivalent to
  // the spec's run reversal, including explicit/implicit transparent padding.
  for (let row = 0; row < cel.height; row++) {
    const start = row * cel.width;
    cel.pixels.subarray(start, start + cel.width).reverse();
  }
}

function decodeCel(payload: Uint8Array, celStart: number): LoadedCel {
  if (celStart + 3 > payload.length) {
    throw new RangeError("cel header outside the payload");
  }
  const width = payload[celStart]!;
  const height = payload[celStart + 1]!;
  const control = payload[celStart + 2]!;
  const transparentColor = control & 0x0f;
  const pixels = new Uint8Array(width * height).fill(transparentColor);
  let pos = celStart + 3;
  for (let row = 0; row < height; row++) {
    let x = 0;
    for (;;) {
      if (pos >= payload.length) {
        throw new RangeError(`cel row ${row} has no zero terminator`);
      }
      const run = payload[pos++]!;
      if (run === 0) break;
      const color = run >>> 4;
      const length = run & 0x0f;
      if (color !== transparentColor) {
        for (let i = 0; i < length && x + i < width; i++) {
          pixels[row * width + x + i] = color;
        }
      }
      x += length;
    }
  }
  return {
    cel: { width, height, transparentColor, mirrored: false, pixels },
    orientation: (control & 0x70) >>> 4,
    mirrorable: (control & 0x80) !== 0,
  };
}

export interface DrawCelOptions {
  /** Drawing object's priority, 0..15. Defaults to 15 (preview semantics). */
  priority?: number;
  /** Observe pixels that survive transparency and priority tests (for visibility bookkeeping). */
  onPixel?(index: number): void;
}

/**
 * Draw a cel with its baseline row at `yBaseline` and left edge at `x`,
 * composing into both surface channels.
 *
 * Placement (spec order): top = yBaseline - height + 1; a negative top shifts
 * left X left and the baseline down (a position adjustment, not clipping);
 * a cel extending past the right edge shifts left to fit; destination cells
 * outside the 160x168 surface are skipped.
 *
 * Composition: transparent source pixels never modify the destination. Every
 * other source pixel is tested independently against the priority/control
 * channel: a destination value above 2 is the comparison value; values 0..2
 * scan downward in the same column for the first value above 2 (0 if none).
 * The pixel draws when the comparison value is <= the drawing priority p,
 * replacing the visual color and the priority value with p.
 */
export function drawCel(
  surface: PictureSurface,
  cel: ViewCel,
  x: number,
  yBaseline: number,
  opts?: DrawCelOptions,
): void {
  const p = opts?.priority ?? 15;
  forEachPaintedPixel(surface, cel, x, yBaseline, p, (cell, color) => {
    surface.visual[cell] = color;
    surface.priority[cell] = p;
    opts?.onPixel?.(cell);
  });
}

/**
 * Visit every destination pixel `drawCel` would paint for this cel at this
 * placement and priority, in row-major order, without painting. The same
 * placement, transparency and priority rules as drawCel apply, so a caller
 * that paints inside `visit` reproduces drawCel exactly.
 */
export function forEachPaintedPixel(
  surface: PictureSurface,
  cel: ViewCel,
  x: number,
  yBaseline: number,
  p: number,
  visit: (cell: number, color: number) => void,
): void {
  let left = x;
  let top = yBaseline - cel.height + 1;
  if (top < 0) {
    left += top;
    top = 0;
  }
  if (left + cel.width > SCREEN_WIDTH) {
    left = SCREEN_WIDTH - cel.width;
  }

  const bottom = Math.min(top + cel.height, SCREEN_HEIGHT);
  for (let dy = top; dy < bottom; dy++) {
    const rowBase = (dy - top) * cel.width;
    for (let sx = 0; sx < cel.width; sx++) {
      const dx = left + sx;
      if (dx < 0 || dx >= SCREEN_WIDTH) continue;
      const color = cel.pixels[rowBase + sx]!;
      if (color === cel.transparentColor) continue;
      const cell = dy * SCREEN_WIDTH + dx;
      let comparison = surface.priority[cell]!;
      if (comparison <= 2) {
        comparison = 0;
        for (let sy = dy + 1; sy < SCREEN_HEIGHT; sy++) {
          const below = surface.priority[sy * SCREEN_WIDTH + dx]!;
          if (below > 2) {
            comparison = below;
            break;
          }
        }
      }
      if (comparison > p) continue;
      visit(cell, color);
    }
  }
}
