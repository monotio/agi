/**
 * Where an actor may stand: the engine's placement rules for one baseline
 * cell, and the mask of every cell that passes them. Navigation's static
 * planner and Room Studio's walkable overlay share this one implementation.
 *
 * The rules are the engine's own (src/runtime/engine.ts moveObject and
 * footprintAccepts): the cel stays on the picture and its baseline at least
 * one cel height down, an actor that observes the horizon stays below it,
 * and the footprint scan of controlCheck.ts accepts the baseline. Priority
 * 15 skips the scan. docs/fidelity.md: footprint-class-flags
 *
 * This is a static estimate, not a movement claim: it knows nothing of
 * object collisions, block rectangles, animation or script triggers. Only an
 * engine run says whether an actor gets somewhere.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import { footprintAccepted, scanFootprint } from "./controlCheck.ts";
import type { ScreenObject } from "./screenObject.ts";

export interface WalkableInput {
  /** The 160x168 priority/control plane. */
  priority: Uint8Array;
  /** Footprint width scanned for barriers: the cel width, or the widest cel of a view. */
  egoWidth: number;
  /** Cel height: the baseline is at least this many rows minus one from the top. */
  egoHeight: number;
  /** Control 1 blocks while the actor observes blocks. */
  observeBlocks: boolean;
  /** obj.on.water / obj.on.land state; null for neither. */
  waterGate: ScreenObject["waterGate"];
  /** The horizon an actor observing it stays below; null under ignore.horizon. */
  horizon: number | null;
  /** Fixed priority 15: the engine skips the control scan and accepts any footprint. */
  bypassControl?: boolean;
  /**
   * Cells, from the left, classified for the water gate; defaults to
   * egoWidth. Navigation's widest-cel geometry scans barriers over the
   * widest cel but classifies water on the current one.
   */
  waterWidth?: number;
}

/**
 * Why a baseline cell is refused, or "ok": off the picture, above the
 * horizon, a barrier (control 0), a conditional barrier (control 1), a
 * water-bound actor off water, a land-bound actor on all water, or both
 * gates at once.
 */
export type StandVerdict =
  "ok" | "bounds" | "horizon" | "barrier" | "conditional" | "water" | "land" | "gates";

/** The inclusive baseline range an actor's anchor can occupy: y >= minY, x <= maxX. */
export function walkableBounds(input: Pick<WalkableInput, "egoWidth" | "egoHeight" | "horizon">): {
  minY: number;
  maxX: number;
} {
  return {
    minY: Math.max(input.egoHeight - 1, input.horizon === null ? 0 : input.horizon + 1),
    maxX: SCREEN_WIDTH - input.egoWidth,
  };
}

/** The engine's verdict on an actor standing with its left baseline cell at (x, y). */
export function standVerdict(input: WalkableInput, x: number, y: number): StandVerdict {
  const { minY, maxX } = walkableBounds(input);
  if (x < 0 || x > maxX || y > SCREEN_HEIGHT - 1 || y < input.egoHeight - 1) return "bounds";
  if (y < minY) return "horizon";
  if (input.bypassControl) return "ok";
  const controls = scanFootprint(input.priority, x, y, input.egoWidth);
  const waterWidth = input.waterWidth ?? input.egoWidth;
  if (waterWidth !== input.egoWidth && (input.waterGate === "on" || input.waterGate === "off"))
    controls.water = scanFootprint(input.priority, x, y, waterWidth).water;
  if (footprintAccepted(controls, input.observeBlocks, input.waterGate)) return "ok";
  if (controls.barrier) return "barrier";
  if (controls.conditional && input.observeBlocks) return "conditional";
  return input.waterGate === "on" ? "water" : input.waterGate === "off" ? "land" : "gates";
}

/** 160x168: 1 where an actor with this footprint may stand with its baseline at that cell. */
export function walkableMask(input: WalkableInput): Uint8Array {
  const mask = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  const { minY, maxX } = walkableBounds(input);
  for (let y = minY; y < SCREEN_HEIGHT; y++)
    for (let x = 0; x <= maxX; x++)
      if (standVerdict(input, x, y) === "ok") mask[y * SCREEN_WIDTH + x] = 1;
  return mask;
}
