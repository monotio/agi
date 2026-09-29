/**
 * The one logical <-> screen transform shared by the Room Studio canvas,
 * overlays and pointer input. A logical AGI pixel is `pixelAspect * zoom`
 * screen pixels wide and `zoom` tall; `offsetX`/`offsetY` place logical 0,0.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";

export interface Viewport {
  /** Integer >= 1. */
  readonly zoom: number;
  /** AGI pixels are twice as wide as they are tall. */
  readonly pixelAspect: 2;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface ViewportPoint {
  x: number;
  y: number;
}

/** Top-left screen pixel of logical cell x,y (floored), or null off-surface. */
export function toScreen(viewport: Viewport, x: number, y: number): ViewportPoint | null {
  const lx = Math.floor(x);
  const ly = Math.floor(y);
  if (lx < 0 || lx >= SCREEN_WIDTH || ly < 0 || ly >= SCREEN_HEIGHT) return null;
  return {
    x: viewport.offsetX + lx * viewport.pixelAspect * viewport.zoom,
    y: viewport.offsetY + ly * viewport.zoom,
  };
}

/**
 * The logical cell under screen point sx,sy (floored), or null off-surface;
 * with `clamp`, an off-surface point maps to the nearest edge cell instead
 * (for drags that leave the canvas).
 */
export function toLogical(
  viewport: Viewport,
  sx: number,
  sy: number,
  opts?: { clamp?: boolean },
): ViewportPoint | null {
  const x = Math.floor((sx - viewport.offsetX) / (viewport.pixelAspect * viewport.zoom));
  const y = Math.floor((sy - viewport.offsetY) / viewport.zoom);
  if (x >= 0 && x < SCREEN_WIDTH && y >= 0 && y < SCREEN_HEIGHT) return { x, y };
  if (!opts?.clamp) return null;
  return {
    x: Math.min(Math.max(x, 0), SCREEN_WIDTH - 1),
    y: Math.min(Math.max(y, 0), SCREEN_HEIGHT - 1),
  };
}

/** The largest integer zoom at which 160*2*zoom x 168*zoom fits the container; at least 1. */
export function fitZoom(containerW: number, containerH: number): number {
  const zoom = Math.min(
    Math.floor(containerW / (SCREEN_WIDTH * 2)),
    Math.floor(containerH / SCREEN_HEIGHT),
  );
  return Math.max(1, zoom);
}
