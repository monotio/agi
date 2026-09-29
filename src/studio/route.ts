/**
 * Room Studio routes: a static route estimate over the walkable mask, and a
 * route test the engine executes.
 *
 * `planRoute` searches the walkable estimate with navigation's own anchor
 * search; it is labelled an estimate and proves nothing. `planDoorRoute`
 * aims the same search at a door: the floor cell of an edge (the walk then
 * steps across it) or of a door box. `testRoute` is the claim: a detached
 * game boots, enters the room through the playtest harness
 * (src/agent/playtest.ts), places ego at the start and walks it to each
 * point with ordinary direction input, and reports what the engine did.
 */

import { playtestRoom } from "../agent/playtest.ts";
import type { EdgeSide } from "../agent/roomMap.ts";
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
  "An estimate from the walk lines alone; other objects, blocks and scripts can change the outcome.";

/** A route over the walkable estimate, searched the way navigation searches. */
export function planRoute(input: RouteInput): RoutePlan {
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
  return search(input, input.to);
}

/** A door a walk aims at: an exit through a screen edge, or a door box (inclusive cells). */
export type RouteDoor =
  | { readonly edge: EdgeSide }
  | {
      readonly box: {
        readonly x1: number;
        readonly y1: number;
        readonly x2: number;
        readonly y2: number;
      };
    };

export interface DoorRoutePlan extends RoutePlan {
  /** The floor cell the walk aims at; null when the estimate reaches none. */
  to: RoutePoint | null;
  /** The edge a walk steps across from `to`: what fires the engine's edge trigger (v2). */
  cross: EdgeSide | null;
}

/** How far past a door box its aim may look when no floor inside the box is in reach. */
const BOX_REACH = [0, 2, 6] as const;

/**
 * A route to a door over the walkable estimate. An edge exit aims at the
 * floor cell along that edge nearest `near` (the start by default) that the
 * start reaches, and the walk then takes one more step across it. A door
 * box aims at the reachable floor cell inside it nearest `near` (a box's
 * centre may sit on the wall), else at one just around it.
 */
export function planDoorRoute(
  input: Omit<RouteInput, "to">,
  door: RouteDoor,
  near: RoutePoint = input.from,
): DoorRoutePlan {
  const start = standVerdict(input, input.from.x, input.from.y);
  if (start !== "ok")
    return {
      path: null,
      to: null,
      cross: null,
      reason: `The start (${input.from.x},${input.from.y}) is not standable: ${start}.`,
    };
  const { minY, maxX } = walkableBounds(input);
  const reach = reachable(input);
  /** The reachable cell of a region nearest `near` on screen (AGI pixels are twice as wide). */
  const nearest = (x0: number, x1: number, y0: number, y1: number): RoutePoint | null => {
    let best: RoutePoint | null = null;
    let bestDistance = Infinity;
    for (let y = Math.max(0, y0); y <= Math.min(167, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(maxX, x1); x++) {
        if (!reach[y * SCREEN_WIDTH + x]) continue;
        const distance = ((x - near.x) * 2) ** 2 + (y - near.y) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { x, y };
        }
      }
    return best;
  };
  let to: RoutePoint | null = null;
  if ("edge" in door) {
    const edge = door.edge;
    to =
      edge === "left"
        ? nearest(0, 0, minY, 167)
        : edge === "right"
          ? nearest(maxX, maxX, minY, 167)
          : edge === "top"
            ? nearest(0, maxX, minY, minY)
            : nearest(0, maxX, 167, 167);
  } else {
    const { x1, y1, x2, y2 } = door.box;
    for (const out of BOX_REACH) {
      to = nearest(x1 - out, x2 + out, y1 - out, y2 + out);
      if (to) break;
    }
  }
  const where = "edge" in door ? `along the ${door.edge} edge` : "in or at the door box";
  if (!to)
    return {
      path: null,
      to: null,
      cross: null,
      reason: `No floor ${where} is in reach of the start. ${ESTIMATE}`,
    };
  const plan = search(input, to);
  return { ...plan, to: plan.path ? to : null, cross: "edge" in door ? door.edge : null };
}

function stepOf(input: Pick<RouteInput, "stepSize">): number {
  const step = input.stepSize ?? 1;
  if (!Number.isInteger(step) || step < 1)
    throw new RangeError("stepSize must be a positive integer.");
  return step;
}

/**
 * Where an actor may step: inside the walkable bounds, on the estimate, and
 * (docs/fidelity.md "Objects in motion") off an exact-zero left edge in
 * builds where a due proposal there reports border 4, unless that cell is
 * the goal: reaching the border is then the point.
 */
function stepper(input: Omit<RouteInput, "to">, goal: number | null) {
  const valid = walkableMask(input);
  const { minY, maxX } = walkableBounds(input);
  const borderAtZero = input.profile.clampExactZeroLeftBoundary;
  const canStep = (_from: number, to: number): boolean => {
    const x = to % SCREEN_WIDTH;
    const y = Math.floor(to / SCREEN_WIDTH);
    if (x < 0 || x > maxX || y < minY || y > 167 || !valid[to]) return false;
    return !(borderAtZero && x === 0 && (goal === null ? false : to !== goal));
  };
  return { valid, canStep };
}

/** 160x168: 1 where the start reaches over the estimate, in whole movement steps. */
function reachable(input: Omit<RouteInput, "to">): Uint8Array {
  const step = stepOf(input);
  // Any border cell may be the goal: the search to it then allows stepping on.
  const { canStep } = stepper(input, null);
  const seen = new Uint8Array(SCREEN_WIDTH * 168);
  const start = input.from.y * SCREEN_WIDTH + input.from.x;
  const queue = [start];
  seen[start] = 1;
  while (queue.length) {
    const at = queue.pop()!;
    const x = at % SCREEN_WIDTH;
    const y = Math.floor(at / SCREEN_WIDTH);
    for (const dy of [-step, 0, step])
      for (const dx of [-step, 0, step]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= SCREEN_WIDTH || ny < 0 || ny > 167) continue;
        const next = ny * SCREEN_WIDTH + nx;
        if (seen[next] || !canStep(at, next)) continue;
        seen[next] = 1;
        queue.push(next);
      }
  }
  return seen;
}

/** Navigation's anchor search from the start to one cell. */
function search(input: Omit<RouteInput, "to">, to: RoutePoint): RoutePlan {
  const step = stepOf(input);
  const goal = to.y * SCREEN_WIDTH + to.x;
  const { valid, canStep } = stepper(input, goal);
  const options: SearchOptions = {
    desiredClearance: 4,
    clearanceWeight: 1,
    turnCost: 0,
    maxSearchNodes: 160 * 168,
    ...input.options,
  };
  const clearance = anchorClearance(valid);
  const found = searchAnchors(
    input.from.y * SCREEN_WIDTH + input.from.x,
    { x0: to.x, x1: to.x, y0: to.y, y1: to.y },
    step,
    clearance,
    canStep,
    options,
  );
  if (found.status !== "found")
    return {
      path: null,
      reason:
        found.status === "unreachable"
          ? `No route in the walkable estimate. ${ESTIMATE}`
          : `The search budget ran out before a route was found. ${ESTIMATE}`,
    };
  const smoothed = smoothAnchors(found.chain, step, clearance, canStep, options);
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
  /**
   * An edge to step across once ego stands at the target (planDoorRoute's
   * `cross`): the step that fires the engine's own edge trigger (v2), so the
   * room's logic decides where it leads.
   */
  cross?: EdgeSide;
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
 * the player, ran out of cycles, refused the start position, or (a walk
 * across an edge) stepped across it and stayed in the room.
 */
export type RouteOutcome =
  | "reached"
  | "blocked"
  | "room_changed"
  | "modal"
  | "no_control"
  | "budget"
  | "start_blocked"
  | "stayed"
  | "failed";

export interface RouteTestResult {
  /** Reached the target; a walk across an edge: left the room through it. */
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

/** The direction key that steps across each edge (AGI directions: 1 up, 3 right, 5 down, 7 left). */
const CROSS_DIRECTION: Readonly<Record<EdgeSide, number>> = {
  top: 1,
  right: 3,
  bottom: 5,
  left: 7,
};
/** Logic cycles the step across an edge may take: a slow step.time still gets its update. */
const CROSS_CYCLES = 20;
const EDGE_WORDS: Readonly<Record<EdgeSide, string>> = {
  top: "north",
  right: "east",
  bottom: "south",
  left: "west",
};

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
  const state = createAgentSessionState(
    openContainer(files, { kind: profile.container, profile }),
    profile,
  );
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
        // The step across: held until the room changes, or for a few cycles.
        ...(input.cross
          ? [{ action: "move", direction: CROSS_DIRECTION[input.cross], ticks: CROSS_CYCLES }]
          : []),
      ],
    },
    input.flags || input.vars
      ? { preset: { flags: input.flags ?? [], vars: input.vars ?? [] } }
      : {},
  );
  const details = result.details ?? {};
  const final = details["state"] as
    { room: number; egoX: number; egoY: number; modalKind: string | null } | undefined;
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
  if (input.cross && kind === "reached") {
    const edge = `the ${EDGE_WORDS[input.cross]} edge`;
    const stood = `Ego stood at (${outcome.x},${outcome.y}) and stepped across ${edge}`;
    if (missing !== undefined || room !== input.room) {
      const to = missing ?? room;
      return {
        reached: true,
        outcome: "room_changed",
        ...run,
        room: to,
        reason:
          missing !== undefined
            ? `${stood}: the walk left for room ${to}, which has not been authored.`
            : `${stood}: the room's logic sent ego to room ${to}.`,
        ...frames,
      };
    }
    if (final?.modalKind)
      return {
        reached: false,
        outcome: "modal",
        ...run,
        reason: `${stood}: a message window opened and the game stayed in room ${input.room}.`,
        ...frames,
      };
    return {
      reached: false,
      outcome: "stayed",
      ...run,
      end: { x: outcome.x, y: outcome.y },
      reason: `${stood}, and the game stayed in room ${input.room}: nothing in the room's logic answers that edge now.`,
      ...frames,
    };
  }
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
