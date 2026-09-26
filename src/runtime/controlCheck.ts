/**
 * Footprint control acceptance, shared by the engine's movement code and the
 * Room Studio probe: the scan of the priority/control cells along an object's
 * baseline, exactly the cel width, left to right, and the verdict it gives.
 * docs/fidelity.md: footprint-class-flags
 */

import { SCREEN_WIDTH } from "../types.ts";
import type { ScreenObject } from "./screenObject.ts";

/** The control classes one footprint scan found. */
export interface FootprintControls {
  /** Some scanned cell is control 0: the footprint is rejected. */
  barrier: boolean;
  /** Some scanned cell is control 1: rejected while the object observes blocks. */
  conditional: boolean;
  /** Some scanned cell is control 2: the trigger flag (f3) for ego, latched. */
  signal: boolean;
  /** Every scanned cell is control 3 (vacuously true when none is on the surface): f0 for ego. */
  water: boolean;
}

/**
 * Scan row `y` from `x` for `width` cells; cells left or right of the surface
 * are skipped. `visit` sees each scanned cell's x and value in scan order.
 * The caller keeps `y` on the surface.
 */
export function scanFootprint(
  priority: Uint8Array,
  x: number,
  y: number,
  width: number,
  visit?: (cx: number, value: number) => void,
): FootprintControls {
  const controls = { barrier: false, conditional: false, signal: false, water: true };
  for (let i = 0; i < width; i++) {
    const cx = x + i;
    if (cx < 0 || cx >= SCREEN_WIDTH) continue;
    const value = priority[y * SCREEN_WIDTH + cx] ?? 4;
    visit?.(cx, value);
    if (value === 3) continue;
    controls.water = false;
    if (value === 0) controls.barrier = true;
    else if (value === 1) controls.conditional = true;
    else if (value === 2) controls.signal = true;
  }
  return controls;
}

/**
 * Whether a scanned footprint is acceptable: control 0 rejects; control 1
 * rejects unless ignore.blocks; then obj.on.water needs every cell water,
 * obj.on.land needs some cell not water, and both together reject.
 */
export function footprintAccepted(
  controls: FootprintControls,
  observeBlocks: boolean,
  waterGate: ScreenObject["waterGate"],
): boolean {
  if (controls.barrier) return false;
  if (controls.conditional && observeBlocks) return false;
  if (waterGate === "both") return false;
  if (waterGate === "on" && !controls.water) return false;
  if (waterGate === "off" && controls.water) return false;
  return true;
}
