/**
 * Room Studio routes: a static route estimate over the walkable mask, and a
 * route test the engine executes.
 *
 * `planRoute` searches the walkable estimate with navigation's own anchor
 * search; it is labelled an estimate and proves nothing. `testRoute` is the
 * claim: a detached game boots, enters the room through the playtest
 * harness (src/agent/playtest.ts), places ego at the start and walks it to
 * each point with ordinary direction input, and reports what the engine did.
 */

import { playtestRoom } from "../agent/playtest.ts";
import type { NavigationOutcome } from "../agent/navigationController.ts";
import {
  anchorClearance,
  searchAnchors,
  smoothAnchors,
  type SearchOptions,
} from "../agent/navigationSearch.ts";
import { createAgentSessionState } from "../agent/agentState.ts";
import { openContainer } from "../container/container.ts";
import { detectProfile, type AgiProfile, type ProfileId } from "../runtime/profile.ts";
import { SCREEN_WIDTH, type GameContainer } from "../types.ts";
import {
  standVerdict,
  walkableBounds,
  walkableMask,
  type WalkableInput,
} from "../runtime/walkable.ts";

export interface RoutePoint {
  x: number;
  y: number;
}

export interface RouteInput extends WalkableInput {
  from: RoutePoint;
  to: RoutePoint;
  /** An exact-zero left edge is a border crossing in some builds. */
  profile: Pick<AgiProfile, "clampExactZeroLeftBoundary">;
  /** Pixels per movement update (step.size); 1 by default. */
  stepSize?: number;
  /** Navigation's search weights; navigation's defaults otherwise. */
  options?: Partial<SearchOptions>;
}

export interface RoutePlan {
  /**
   * From the start to the target; each segment is walked the way direction
   * input walks it, diagonally toward the point and then straight. Null
   * without a route.
   */
  path: RoutePoint[] | null;
  reason: string;
}

const ESTIMATE =
  "Static estimate from the walkable mask: object collisions, block rectangles, animation and script triggers are not modelled. Run testRoute for the engine's answer.";

/** A route over the walkable estimate, searched the way navigation searches. */
export function planRoute(input: RouteInput): RoutePlan {
  const step = input.stepSize ?? 1;
  if (!Number.isInteger(step) || step < 1)
    throw new RangeError("stepSize must be a positive integer.");
  for (const [name, point] of [
    ["start", input.from],
    ["target", input.to],
  ] as const) {
    const verdict = standVerdict(input, point.x, point.y);
    if (verdict !== "ok")
      return {
        path: null,
        reason: `The ${name} (${point.x},${point.y}) is not standable: ${verdict}.`,
      };
  }
  const valid = walkableMask(input);
  const { minY, maxX } = walkableBounds(input);
  // docs/fidelity.md "Objects in motion": a due proposal at exactly x=0
  // reports border 4 in 3.002.086, which room logic reads as an exit.
  const borderAtZero = input.profile.clampExactZeroLeftBoundary;
  const canStep = (_from: number, to: number): boolean => {
    const x = to % SCREEN_WIDTH;
    const y = Math.floor(to / SCREEN_WIDTH);
    if (x < 0 || x > maxX || y < minY || y > 167 || !valid[to]) return false;
    return !(borderAtZero && x === 0 && to !== input.to.y * SCREEN_WIDTH + input.to.x);
  };
  const options: SearchOptions = {
    desiredClearance: 4,
    clearanceWeight: 1,
    turnCost: 0,
    maxSearchNodes: 160 * 168,
    ...input.options,
  };
  const clearance = anchorClearance(valid);
  const search = searchAnchors(
    input.from.y * SCREEN_WIDTH + input.from.x,
    { x0: input.to.x, x1: input.to.x, y0: input.to.y, y1: input.to.y },
    step,
    clearance,
    canStep,
    options,
  );
  if (search.status !== "found")
    return {
      path: null,
      reason:
        search.status === "unreachable"
          ? `No route in the walkable estimate. ${ESTIMATE}`
          : `The search budget ran out before a route was found. ${ESTIMATE}`,
    };
  const smoothed = smoothAnchors(search.chain, step, clearance, canStep, options);
  return {
    path: [{ ...input.from }, ...smoothed.waypoints],
    reason: `A route of ${smoothed.steps} movement updates. ${ESTIMATE}`,
  };
}

export interface RouteTestInput {
  /** The game's files, or an open container. */
  game: GameContainer | ReadonlyMap<string, Uint8Array>;
  /** Interpreter profile; detected from the files by default. */
  profile?: ProfileId | AgiProfile;
  room: number;
  from: RoutePoint;
  to: RoutePoint;
  /** Points to walk through before the target, e.g. a planRoute path. */
  via?: readonly RoutePoint[];
  /** Written after boot, before the room is entered, so its entry logic sees them. */
  flags?: readonly { id: number; value: boolean }[];
  vars?: readonly { id: number; value: number }[];
  /** Logic cycles the walk may take; 600 by default. */
  maxCycles?: number;
  /** Return the run's composed frames as PNG bytes. */
  frames?: boolean;
}

/**
 * What the engine did: reached the target, stopped against something,
 * changed room, opened a window that needs input, took movement away from
 * the player, ran out of cycles, or refused the start position.
 */
export type RouteOutcome =
  | "reached"
  | "blocked"
  | "room_changed"
  | "modal"
  | "no_control"
  | "budget"
  | "start_blocked"
  | "failed";

export interface RouteTestResult {
  reached: boolean;
  outcome: RouteOutcome;
  /** Ego's baseline where the run ended. */
  end: RoutePoint;
  room: number;
  /** Movement updates the engine ran during the walk. */
  steps: number;
  /** Logic cycles the walk ran. */
  cycles: number;
  reason: string;
  frames?: Uint8Array[];
}

const OUTCOMES: Readonly<Record<string, RouteOutcome>> = {
  reached: "reached",
  blocked: "blocked",
  unexpected_transition: "room_changed",
  needs_input: "modal",
  movement_control_unavailable: "no_control",
  budget_exhausted: "budget",
};

interface ObservedStep {
  completedTicks?: number;
  navigation?: NavigationOutcome | null;
}

/**
 * Walk ego from `from` to `to` in a detached engine and report what it did.
 * Room setup follows playtestRoom: boot, then enter the room directly; the
 * room's entry windows are acknowledged as setup, one cycle without input.
 * The walk itself is ordinary direction input toward each point in turn,
 * with no planning: a barrier stops the actor where the engine stops it.
 */
export function testRoute(input: RouteTestInput): RouteTestResult {
  const files = "files" in input.game ? input.game.files : input.game;
  const profile = detectProfile(files, input.profile);
  const state = createAgentSessionState(openContainer(files, { kind: profile.container }), profile);
  const maxCycles = input.maxCycles ?? 600;
  const result = playtestRoom(
    state,
    {
      room: input.room,
      spawnX: input.from.x,
      spawnY: input.from.y,
      cycleBudget: Math.min(60000, maxCycles + 1200),
      steps: [
        // Setup: acknowledge the entry windows and run one cycle without input.
        { action: "move", direction: 0, ticks: 1 },
        {
          action: "walkWaypoints",
          waypoints: [...(input.via ?? []), input.to].map(({ x, y }) => ({ x, y })),
          ticks: maxCycles,
        },
      ],
    },
    input.flags || input.vars
      ? { preset: { flags: input.flags ?? [], vars: input.vars ?? [] } }
      : {},
  );
  const details = result.details ?? {};
  const final = details["state"] as { room: number; egoX: number; egoY: number } | undefined;
  const walk = (details["steps"] as ObservedStep[] | undefined)?.[1];
  const outcome = walk?.navigation ?? null;
  const frames = input.frames ? { frames: (result.images ?? []).map((image) => image.png) } : {};
  const end = { x: final?.egoX ?? input.from.x, y: final?.egoY ?? input.from.y };
  const room = final?.room ?? input.room;
  const run = {
    end,
    room,
    steps: outcome?.counters.movementUpdates ?? 0,
    cycles: walk?.completedTicks ?? 0,
  };
  if (details["simulation"] === "spawn_blocked")
    return {
      reached: false,
      outcome: "start_blocked",
      ...run,
      reason: result.error ?? "The start position is not standable.",
      ...frames,
    };
  const missing = (details["missingRooms"] as number[] | undefined)?.at(-1);
  if (outcome === null && missing !== undefined)
    return {
      reached: false,
      outcome: "room_changed",
      ...run,
      room: missing,
      reason: `The walk left for room ${missing}, which has not been authored.`,
      ...frames,
    };
  if (outcome === null)
    return {
      reached: false,
      outcome: "failed",
      ...run,
      reason: result.error ?? "The route test did not run its walk.",
      ...frames,
    };
  const kind = OUTCOMES[outcome.status] ?? "failed";
  return {
    reached: kind === "reached",
    outcome: kind,
    ...run,
    end: { x: outcome.x, y: outcome.y },
    room: outcome.room,
    reason: `${kind === "blocked" ? "Blocked" : outcome.status}: ${outcome.reason} Engine run, room ${outcome.room}, ego at (${outcome.x},${outcome.y}).`,
    ...frames,
  };
}
