/**
 * Mask-aware picking for the exploded priority-layer scene. A raycast hit on
 * a layer's quad is only a real pick when the pixel survives that layer's
 * shader mask — the same visibility, priority, ownership and transparency
 * rules that render it. Masked-out hits fall through to the next layer, so
 * the reported pick names the layer and point of the pixel the user sees.
 */
import { FRAME_HEIGHT, FRAME_WIDTH } from "./composite.ts";

/** Logical picture geometry the exploded view separates into depth layers. */
const PIC_W = 160;
const PIC_H = 168;

export interface PickHit {
  /** Mesh name identifying the layer: control, pic:N, sprite:N, explodedText. */
  name: string;
  /** Texture-space hit point; all band layers share one uv mapping. */
  u: number;
  v: number;
}

export interface PickMasks {
  /** Composed priority surface, 160x168. */
  priority?: Uint8Array | undefined;
  /** Picture-only priority surface, 160x168. */
  picturePriority?: Uint8Array | undefined;
  /** Object ownership, 160x168 (num + 1, 0 = background). */
  owner?: Uint8Array | undefined;
  /** Text-only composite RGBA, 320x200 (alpha 0 where no cell was written). */
  text?: Uint8Array | undefined;
}

export interface StagePick {
  /**
   * Logical picture-space point (0..159 x 0..167) for band layers;
   * frame-space (0..319 x 0..199) for the full-frame text layer and the
   * background case.
   */
  x: number;
  y: number;
  /**
   * The layer whose rendered pixel the ray actually selected: control lines,
   * a picture wall band, a sprite band, the modal preview, the text surface,
   * or background when geometry was hit but every layer masked the pixel
   * out. A non-sprite kind never carries an object identity.
   */
  kind: "control" | "picture" | "sprite" | "preview" | "text" | "background";
  /** Priority band for picture/sprite picks. */
  band?: number;
}

/**
 * Walk front-to-back hits and return the first whose pixel is actually
 * rendered on that layer. null only when no quad was intersected at all.
 */
export function pickThroughLayers(hits: readonly PickHit[], masks: PickMasks): StagePick | null {
  let firstFramePoint: { x: number; y: number } | null = null;
  for (const hit of hits) {
    const fx = Math.min(FRAME_WIDTH - 1, Math.max(0, Math.floor(hit.u * FRAME_WIDTH)));
    const fy = Math.min(FRAME_HEIGHT - 1, Math.max(0, Math.floor((1 - hit.v) * FRAME_HEIGHT)));
    firstFramePoint ??= { x: fx, y: fy };
    if (hit.name === "explodedText") {
      const alpha = masks.text ? masks.text[(fy * FRAME_WIDTH + fx) * 4 + 3]! : 0;
      if (alpha > 0) return { x: fx, y: fy, kind: "text" };
      continue;
    }
    const lx = Math.min(PIC_W - 1, Math.max(0, Math.floor(hit.u * PIC_W)));
    const ly = Math.min(PIC_H - 1, Math.max(0, Math.floor((1 - hit.v) * PIC_H)));
    const i = ly * PIC_W + lx;
    if (hit.name === "control") {
      if (masks.picturePriority && masks.picturePriority[i]! <= 3)
        return { x: lx, y: ly, kind: "control" };
    } else if (hit.name.startsWith("pic:")) {
      const band = Number(hit.name.slice(4));
      if (masks.picturePriority && masks.picturePriority[i] === band)
        return { x: lx, y: ly, kind: "picture", band };
    } else if (hit.name.startsWith("sprite:")) {
      const band = Number(hit.name.slice(7));
      if (masks.priority && masks.owner && masks.priority[i] === band && masks.owner[i]! > 0)
        return { x: lx, y: ly, kind: "sprite", band };
    }
  }
  return firstFramePoint ? { ...firstFramePoint, kind: "background" } : null;
}
