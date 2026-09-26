/**
 * The Room Studio ghost-actor probe: what the engine would do with one cel
 * standing still at one place on a picture. Occlusion is the engine's cel
 * blit (`forEachPaintedPixel`), priority its baseline bands, and control hits
 * its footprint scan, so the probe cannot disagree with a real frame. It is a
 * static probe, not a walk test: no motion, horizon, object collision or
 * add.to.pic pixels.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import {
  footprintAccepted,
  scanFootprint,
  type FootprintControls,
} from "../runtime/controlCheck.ts";
import { priorityForY } from "../runtime/priority.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import { forEachPaintedPixel, type ViewCel } from "../view/view.ts";

export interface ProbeInput {
  picture: { readonly visual: Uint8Array; readonly priority: Uint8Array };
  cel: ViewCel;
  /** The object's x: the cel's left edge before the blit's edge adjustments. */
  x: number;
  /** The object's y: the cel's bottom row. */
  baselineY: number;
  /** A fixed priority (set.priority) or the baseline's band. */
  priority: number | "band";
  /** The room's set.pri.base value when known; 48 otherwise. */
  priorityBase?: number | undefined;
  /** Builds whose set.pri.base is a stub keep the default base. */
  profile: Pick<AgiProfile, "priorityBaseAction">;
}

export interface ProbeCell {
  x: number;
  y: number;
}

export interface ControlHit {
  /** 0 barrier, 1 conditional, 2 signal, 3 water. */
  value: 0 | 1 | 2 | 3;
  /** Footprint cells holding this control value, left to right. */
  cells: ProbeCell[];
}

export interface ProbeFootprint {
  x: number;
  y: number;
  width: number;
  controls: FootprintControls;
  /** Priority 15 skips the scan; the engine accepts any footprint. */
  bypassed: boolean;
  /** The engine's verdict for an object that observes blocks and has no water gate. */
  accepted: boolean;
}

export interface ProbeResult {
  /** The band of the baseline row, whatever priority the cel draws at. */
  bandPriority: number;
  /** The priority the cel draws at: the fixed one, or the band. */
  drawPriority: number;
  /** 160x168: 1 where the engine would paint a cel pixel. */
  drawnMask: Uint8Array;
  /** 160x168: 1 where an opaque cel pixel lands but the picture's priority hides it. */
  hiddenMask: Uint8Array;
  /** Control values 0..3 on the footprint, ascending; values not touched are absent. */
  controlHits: ControlHit[];
  footprint: ProbeFootprint;
}

export function probeActor(input: ProbeInput): ProbeResult {
  const { picture, cel, x, baselineY } = input;
  const base = input.profile.priorityBaseAction === "effect" ? (input.priorityBase ?? 48) : 48;
  const bandPriority = priorityForY(baselineY, base);
  const drawPriority = input.priority === "band" ? bandPriority : input.priority;

  const cells = SCREEN_WIDTH * SCREEN_HEIGHT;
  const drawnMask = new Uint8Array(cells);
  const hiddenMask = new Uint8Array(cells);
  forEachPaintedPixel(picture, cel, x, baselineY, drawPriority, (cell) => {
    drawnMask[cell] = 1;
  });
  // At priority 15 no comparison value exceeds the drawing priority, so this
  // visits every opaque cell the blit places.
  forEachPaintedPixel(picture, cel, x, baselineY, 15, (cell) => {
    if (drawnMask[cell] === 0) hiddenMask[cell] = 1;
  });

  const byValue: ProbeCell[][] = [[], [], [], []];
  const onSurface = baselineY >= 0 && baselineY < SCREEN_HEIGHT;
  const controls: FootprintControls = onSurface
    ? scanFootprint(picture.priority, x, baselineY, cel.width, (cx, value) => {
        byValue[value]?.push({ x: cx, y: baselineY });
      })
    : { barrier: false, conditional: false, signal: false, water: false };
  const bypassed = drawPriority === 15;
  const controlHits = byValue.flatMap((hits, value) =>
    hits.length > 0 ? [{ value: value as ControlHit["value"], cells: hits }] : [],
  );
  return {
    bandPriority,
    drawPriority,
    drawnMask,
    hiddenMask,
    controlHits,
    footprint: {
      x,
      y: baselineY,
      width: cel.width,
      controls,
      bypassed,
      accepted: bypassed || (onSurface && footprintAccepted(controls, true, null)),
    },
  };
}
