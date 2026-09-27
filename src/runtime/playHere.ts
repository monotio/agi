/**
 * "Play here": start the live game in a room with ego at a chosen spot and
 * the session's current flags. The worker runs it at a safe boundary as
 * ordinary host actions (app/src/worker/playHere.ts): acknowledge open
 * windows, re-enter the room exactly as new.room would, run the room's
 * entry cycle so its own logic sets the room up, then place ego. The
 * placement is the one playtest spawns use, gated by the engine's
 * footprint rules for ego's current cel.
 *
 * These helpers only read and write the engine's object table; they touch
 * no save or replay format.
 */

import type { Engine } from "./engine.ts";
import { standVerdict, type StandVerdict, type WalkableInput } from "./walkable.ts";

export interface PlayHereTarget {
  room: number;
  x: number;
  y: number;
}

/** A target's shape, before any engine is involved; null when it is valid. */
export function playHereProblem(target: PlayHereTarget): string | null {
  if (!Number.isInteger(target.room) || target.room < 1 || target.room > 255)
    return "room must be an integer from 1 to 255.";
  if (!Number.isInteger(target.x) || target.x < 0 || target.x > 159)
    return "x must be an integer from 0 to 159.";
  if (!Number.isInteger(target.y) || target.y < 0 || target.y > 167)
    return "y must be an integer from 0 to 167.";
  return null;
}

/** The walkable-rule input for ego as the engine holds it now: current cel, room horizon. */
function egoWalkable(engine: Engine): WalkableInput {
  const ego = engine.screenObjects[0]!;
  return {
    priority: engine.surface.priority,
    egoWidth: ego.width,
    egoHeight: ego.height,
    observeBlocks: ego.observeBlocks,
    waterGate: ego.waterGate,
    horizon: ego.observeHorizon ? engine.horizon : null,
    bypassControl: ego.fixedPriority && ego.priority === 15,
  };
}

/**
 * Put ego's baseline at (x, y) when the engine would accept it there, and
 * stop it: no heading carries over from before the jump. Returns the
 * verdict ("no-ego" when the room has not animated ego); anything but
 * "ok" leaves ego where it was.
 */
export function placeEgo(engine: Engine, x: number, y: number): StandVerdict | "no-ego" {
  const ego = engine.screenObjects[0]!;
  if (!ego.active) return "no-ego";
  const verdict = standVerdict(egoWalkable(engine), x, y);
  if (verdict !== "ok") return verdict;
  ego.x = ego.prevX = x;
  ego.y = ego.prevY = y;
  ego.direction = 0;
  engine.vars[6] = 0;
  return verdict;
}
