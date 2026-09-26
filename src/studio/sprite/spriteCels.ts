/**
 * Pure transforms of one displayed cel for the Sprite Studio operations.
 * Each returns a new cel (the input is never written) or throws
 * SpriteRefusal; a refusal names the offending value rather than clamping it.
 *
 * Colours are 0..15. `null` paints transparent (the eraser); painting the
 * cel's transparent colour as a number is refused, because an opaque pixel
 * cannot use the transparent colour.
 */
import { SCREEN_WIDTH } from "../../types.ts";
import { mirrorPixels, type SpriteCel } from "./spriteDocument.ts";

/** Widest and tallest cel `buildView` accepts. */
export const MAX_CEL_WIDTH = SCREEN_WIDTH;
export const MAX_CEL_HEIGHT = 168;

export class SpriteRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpriteRefusal";
  }
}

export type ResizeAnchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export const RESIZE_ANCHORS: readonly ResizeAnchor[] = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

/** How far along each axis an anchor pins the pixels, 0 (start) to 1 (end). */
const ANCHOR_SHARE: Record<string, number> = {
  left: 0,
  center: 0.5,
  right: 1,
  top: 0,
  middle: 0.5,
  bottom: 1,
};

export function requireInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new SpriteRefusal(`${label} must be an integer in ${min}..${max} (got ${String(value)})`);
  return value;
}

/** The stored value for a paint colour: null is transparent; the transparent colour is refused. */
function paintValue(cel: SpriteCel, color: number | null, label: string): number {
  if (color === null) return cel.transparent;
  requireInteger(color, label, 0, 15);
  if (color === cel.transparent)
    throw new SpriteRefusal(
      `${label} ${color} is the cel's transparent colour; an opaque pixel cannot use it (paint null to erase)`,
    );
  return color;
}

function withPixels(cel: SpriteCel, pixels: Uint8Array, width = cel.width, height = cel.height) {
  return { ...cel, width, height, pixels };
}

export interface PixelChange {
  readonly x: number;
  readonly y: number;
  /** 0..15, or null for transparent. */
  readonly color: number | null;
}

export function setPixels(cel: SpriteCel, changes: readonly PixelChange[]): SpriteCel {
  if (!Array.isArray(changes)) throw new SpriteRefusal("changes must be a list");
  const pixels = cel.pixels.slice();
  changes.forEach((change, index) => {
    const x = requireInteger(change.x, `changes[${index}].x`, 0, cel.width - 1);
    const y = requireInteger(change.y, `changes[${index}].y`, 0, cel.height - 1);
    pixels[y * cel.width + x] = paintValue(cel, change.color, `changes[${index}].color`);
  });
  return withPixels(cel, pixels);
}

/** 4-connected flood from (x, y) over the pixels holding its value, transparent included. */
export function fillCel(cel: SpriteCel, x: number, y: number, color: number | null): SpriteCel {
  requireInteger(x, "x", 0, cel.width - 1);
  requireInteger(y, "y", 0, cel.height - 1);
  const value = paintValue(cel, color, "color");
  const pixels = cel.pixels.slice();
  const from = pixels[y * cel.width + x]!;
  if (from === value) return cel;
  const stack = [y * cel.width + x];
  pixels[stack[0]!] = value;
  while (stack.length > 0) {
    const at = stack.pop()!;
    const px = at % cel.width;
    const neighbours = [
      px > 0 ? at - 1 : -1,
      px < cel.width - 1 ? at + 1 : -1,
      at - cel.width,
      at + cel.width,
    ];
    for (const next of neighbours) {
      if (next < 0 || next >= pixels.length || pixels[next] !== from) continue;
      pixels[next] = value;
      stack.push(next);
    }
  }
  return withPixels(cel, pixels);
}

/**
 * Opaque pixels of colour `from` become `to`; transparent pixels are never
 * remapped. Refused when an opaque pixel would take the transparent colour.
 */
export function recolorCel(cel: SpriteCel, from: number, to: number, label: string): SpriteCel {
  const pixels = cel.pixels.slice();
  let changed = false;
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] !== from || from === cel.transparent) continue;
    if (to === cel.transparent)
      throw new SpriteRefusal(
        `${label}: colour ${to} is the cel's transparent colour; an opaque pixel cannot use it`,
      );
    pixels[i] = to;
    changed = true;
  }
  return changed ? withPixels(cel, pixels) : cel;
}

export function flipCel(cel: SpriteCel, axis: "h" | "v"): SpriteCel {
  if (axis === "h") return withPixels(cel, mirrorPixels(cel.pixels, cel.width, cel.height));
  if (axis !== "v") throw new SpriteRefusal(`axis must be "h" or "v" (got ${String(axis)})`);
  const pixels = new Uint8Array(cel.pixels.length);
  for (let y = 0; y < cel.height; y++)
    pixels.set(
      cel.pixels.subarray((cel.height - 1 - y) * cel.width, (cel.height - y) * cel.width),
      y * cel.width,
    );
  return withPixels(cel, pixels);
}

const wrap = (value: number, size: number): number => ((value % size) + size) % size;

/**
 * Move every pixel by (dx, dy), wrapping around the cel's edges: a shift is
 * lossless and the opposite shift undoes it exactly.
 */
export function shiftCel(cel: SpriteCel, dx: number, dy: number): SpriteCel {
  requireInteger(dx, "dx", -MAX_CEL_WIDTH, MAX_CEL_WIDTH);
  requireInteger(dy, "dy", -MAX_CEL_HEIGHT, MAX_CEL_HEIGHT);
  const pixels = new Uint8Array(cel.pixels.length);
  for (let y = 0; y < cel.height; y++)
    for (let x = 0; x < cel.width; x++)
      pixels[wrap(y + dy, cel.height) * cel.width + wrap(x + dx, cel.width)] =
        cel.pixels[y * cel.width + x]!;
  return withPixels(cel, pixels);
}

/**
 * Change the canvas size, keeping the pixels pinned at `anchor` (default
 * bottom-center: the feet stay on the baseline, which is where AGI places a
 * cel). New area is transparent; pixels outside the new size are dropped. A
 * centred offset rounds toward zero, so resizing back restores the pixels
 * that survived.
 */
export function resizeCel(
  cel: SpriteCel,
  width: number,
  height: number,
  anchor: ResizeAnchor = "bottom-center",
): SpriteCel {
  requireInteger(width, "width", 1, MAX_CEL_WIDTH);
  requireInteger(height, "height", 1, MAX_CEL_HEIGHT);
  if (!RESIZE_ANCHORS.includes(anchor))
    throw new SpriteRefusal(`anchor must be one of ${RESIZE_ANCHORS.join(", ")}`);
  const [vertical, horizontal] = anchor.split("-");
  const ax = ANCHOR_SHARE[horizontal!]!;
  const ay = ANCHOR_SHARE[vertical!]!;
  const offsetX = Math.trunc((width - cel.width) * ax);
  const offsetY = Math.trunc((height - cel.height) * ay);
  const pixels = new Uint8Array(width * height).fill(cel.transparent);
  for (let y = 0; y < cel.height; y++) {
    const ty = y + offsetY;
    if (ty < 0 || ty >= height) continue;
    for (let x = 0; x < cel.width; x++) {
      const tx = x + offsetX;
      if (tx >= 0 && tx < width) pixels[ty * width + tx] = cel.pixels[y * cel.width + x]!;
    }
  }
  return withPixels(cel, pixels, width, height);
}

/**
 * Make `color` the transparent colour. Transparent pixels stay transparent;
 * opaque pixels already using `color` are refused unless `remap` names the
 * colour they take instead.
 */
export function setTransparent(cel: SpriteCel, color: number, remap?: number): SpriteCel {
  requireInteger(color, "color", 0, 15);
  if (remap !== undefined) {
    requireInteger(remap, "remap", 0, 15);
    if (remap === color) throw new SpriteRefusal(`remap must differ from color ${color}`);
  }
  if (color === cel.transparent) return cel;
  const pixels = cel.pixels.slice();
  for (let i = 0; i < pixels.length; i++) {
    const pixel = pixels[i]!;
    if (pixel === cel.transparent) pixels[i] = color;
    else if (pixel === color) {
      if (remap === undefined)
        throw new SpriteRefusal(
          `opaque pixels already use colour ${color}; pass remap to give them another colour`,
        );
      pixels[i] = remap;
    }
  }
  return { ...cel, transparent: color, pixels };
}

/** A cel of the given geometry with every pixel transparent. */
export function blankCel(width: number, height: number, transparent: number): SpriteCel {
  return {
    width,
    height,
    transparent,
    pixels: new Uint8Array(width * height).fill(transparent),
    mirrorBit: false,
    mirrored: false,
    encoding: null,
  };
}

/** The cel as new, independent data: displayed pixels, no stored metadata. */
export function detachCel(cel: SpriteCel): SpriteCel {
  return { ...cel, mirrorBit: false, mirrored: false, encoding: null };
}

/** The cel flipped left to right, as its mirror partner displays it. */
export function mirroredCel(cel: SpriteCel): SpriteCel {
  return {
    ...cel,
    pixels: mirrorPixels(cel.pixels, cel.width, cel.height),
    mirrored: !cel.mirrored,
  };
}
