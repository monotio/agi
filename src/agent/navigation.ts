import { decodeSave } from "../runtime/persistence.ts";
import type { Engine } from "../runtime/engine.ts";
import { EGA_RGB, encodePngRgb } from "../picture/png.ts";
import {
  anchorClearance,
  searchAnchors,
  smoothAnchors,
  type SearchOptions,
} from "./navigationSearch.ts";

export interface NavigationState {
  readonly engine: Engine;
  state(): { room: number; x: number; y: number };
}

export interface NavigationRun extends NavigationState {
  walkTo(x: number, y: number, maxTicks?: number): void;
}

export interface Target {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Plan {
  found: boolean;
  room: number;
  from: { x: number; y: number };
  target: Target;
  reached: { x: number; y: number };
  cells: number;
  steps: number;
  waypoints: { x: number; y: number }[];
  assumptions: string[];
  searchStatus?: "found" | "unreachable" | "budget_exhausted";
  metrics?: { cost: number; minimumClearance: number; meanClearance: number };
}

export interface PlanOptions {
  avoidTriggers?: boolean;
  attempts?: number;
  /** Widest cel is conservative; current geometry requires short execution/replanning. */
  geometry?: "widest" | "current";
  /** Chebyshev picture-coordinate distance to an illegal footprint anchor. */
  desiredClearance?: number;
  clearanceWeight?: number;
  /** Additional cost for a change between two successive movement headings. */
  turnCost?: number;
  /** Maximum expanded search states, including heading when turnCost is nonzero. */
  maxSearchNodes?: number;
  /** Controller-only terminal constraint: validate a complete cardinal border crossing. */
  exitDirection?: number;
}

export function validateTarget(target: Target): void {
  if (
    ![target.x0, target.x1, target.y0, target.y1].every(Number.isInteger) ||
    target.x0 < 0 ||
    target.x1 > 159 ||
    target.y0 < 0 ||
    target.y1 > 167 ||
    target.x0 > target.x1 ||
    target.y0 > target.y1
  )
    throw new RangeError("Target must be an ordered integer rectangle within 160x168.");
}

export function canWalkDirect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  step: number,
  maxX: number,
  minY: number,
  valid: Uint8Array,
  ego: { width: number; observeBlocks: boolean; observeObjects: boolean },
  save: {
    blockEnabled: boolean | number;
    blockLeft: number;
    blockRight: number;
    blockTop: number;
    blockBottom: number;
  },
  inside: (x: number, y: number) => boolean,
  objects: { x: number; y: number; width: number; height: number }[],
): boolean {
  if (!Number.isInteger(step) || step < 1 || (x2 - x1) % step !== 0 || (y2 - y1) % step !== 0)
    return false;
  let cx = x1;
  let cy = y1;
  while (cx !== x2 || cy !== y2) {
    const dx = Math.sign(x2 - cx);
    const dy = Math.sign(y2 - cy);
    const nx = cx + dx * step;
    const ny = cy + dy * step;
    if (nx < 0 || nx > maxX || ny < minY || ny > 167) return false;
    if (!valid[ny * 160 + nx]) return false;
    if (ego.observeBlocks && Boolean(save.blockEnabled) && inside(cx, cy) !== inside(nx, ny))
      return false;
    if (
      ego.observeObjects &&
      objects.some(
        (o) =>
          !(nx + ego.width < o.x || nx > o.x + o.width) &&
          (ny === o.y || (ny > o.y && cy < o.y) || (ny < o.y && cy > o.y)),
      )
    ) {
      return false;
    }
    cx = nx;
    cy = ny;
  }
  return true;
}

function navigationModel(run: NavigationState, options?: PlanOptions) {
  const searchOptions: SearchOptions = {
    desiredClearance: options?.desiredClearance ?? 4,
    clearanceWeight: options?.clearanceWeight ?? 1,
    turnCost: options?.turnCost ?? 0,
    maxSearchNodes: options?.maxSearchNodes ?? 160 * 168,
  };
  if (
    !Object.values(searchOptions).every((value) => Number.isFinite(value) && value >= 0) ||
    searchOptions.desiredClearance > 160 ||
    searchOptions.clearanceWeight > 1e6 ||
    searchOptions.turnCost > 1e6 ||
    !Number.isInteger(searchOptions.maxSearchNodes) ||
    searchOptions.maxSearchNodes < 1 ||
    searchOptions.maxSearchNodes > 160 * 168 * 9 ||
    (options?.exitDirection !== undefined && ![1, 3, 5, 7].includes(options.exitDirection)) ||
    (options?.geometry !== undefined &&
      options.geometry !== "widest" &&
      options.geometry !== "current")
  ) {
    throw new RangeError("Invalid navigation search options.");
  }
  const engine = run.engine;
  const ego = { ...engine.screenObjects[0]! };
  if (
    ![ego.x, ego.y, ego.width, ego.height, ego.stepSize].every(Number.isInteger) ||
    !ego.active ||
    ego.width < 1 ||
    ego.width > 160 ||
    ego.height < 1 ||
    ego.height > 168 ||
    ego.x < 0 ||
    ego.x + ego.width > 160 ||
    ego.y < ego.height - 1 ||
    ego.y > 167 ||
    ego.stepSize < 1
  )
    throw new RangeError("Navigation needs an initialized, movable ego within the picture.");
  const save = decodeSave(engine.serialize(), engine.profile);
  const objects = engine.screenObjects
    .filter((o, i) => i > 0 && o.active && o.update && o.observeObjects)
    .map((o) => ({ ...o }));
  const view = engine.getView(ego.view);
  let egoWidth = ego.width;
  if (view && options?.geometry !== "current") {
    for (const loop of view.loops) {
      for (const cel of loop.cels) {
        if (cel.width > egoWidth) egoWidth = cel.width;
      }
    }
  }
  const control = engine.surface.priority.slice();
  const step = Math.max(1, ego.stepSize);
  const minY = Math.max(ego.height - 1, ego.observeHorizon ? engine.horizon + 1 : 0);
  const maxX = 160 - egoWidth;
  const inside = (x: number, y: number) =>
    x > save.blockLeft && x < save.blockRight && y > save.blockTop && y < save.blockBottom;
  const valid = new Uint8Array(160 * 168);
  for (let y = minY; y < 168; y++)
    for (let x = 0; x <= maxX; x++) {
      let accepted = true;
      let water = true;
      if (!(ego.fixedPriority && ego.priority === 15)) {
        for (let dx = 0; dx < egoWidth; dx++) {
          const c = control[y * 160 + x + dx]!;
          if (c === 0 || (c === 1 && ego.observeBlocks)) {
            accepted = false;
            break;
          }
          if (options?.avoidTriggers && c === 2 && (x !== ego.x || y !== ego.y)) {
            accepted = false;
            break;
          }
          if (dx < ego.width && c !== 3) water = false;
        }
        if (ego.waterGate === "on" && !water) accepted = false;
        if (ego.waterGate === "off" && water) accepted = false;
      }
      if (
        accepted &&
        ego.observeObjects &&
        objects.some(
          (other) => y === other.y && !(x + egoWidth < other.x || x > other.x + other.width),
        )
      )
        accepted = false;
      if (accepted) valid[y * 160 + x] = 1;
    }
  const canStep = (from: number, to: number): boolean => {
    const x = from % 160,
      y = Math.floor(from / 160);
    const nx = to % 160,
      ny = Math.floor(to / 160);
    if (nx < 0 || nx > maxX || ny < minY || ny > 167 || !valid[to]) return false;
    if (ego.observeBlocks && save.blockEnabled && inside(x, y) !== inside(nx, ny)) return false;
    return (
      !ego.observeObjects ||
      !objects.some(
        (other) =>
          !(nx + egoWidth < other.x || nx > other.x + other.width) &&
          (ny === other.y || (ny > other.y && y < other.y) || (ny < other.y && y > other.y)),
      )
    );
  };
  const acceptsExit = (at: number): boolean => {
    if (options?.exitDirection === undefined) return true;
    const direction = options.exitDirection;
    const dx = direction === 3 ? 1 : direction === 7 ? -1 : 0;
    const dy = direction === 5 ? 1 : direction === 1 ? -1 : 0;
    let x = at % 160,
      y = Math.floor(at / 160);
    // The conservative approach can end before the current cel's real edge.
    // Validate every full proposal and its final clipped footprint using the
    // current cel, including water classification and pre-clipping block tests.
    for (let count = 0; count <= 168; count++) {
      const proposedX = x + dx * step,
        proposedY = y + dy * step;
      if (ego.observeBlocks && save.blockEnabled && inside(x, y) !== inside(proposedX, proposedY))
        return false;
      const nx = Math.max(0, Math.min(160 - ego.width, proposedX));
      const ny = Math.max(minY, Math.min(167, proposedY));
      const border =
        nx !== proposedX ||
        ny !== proposedY ||
        (direction === 7 && proposedX === 0 && engine.profile.clampExactZeroLeftBoundary);
      if (!(ego.fixedPriority && ego.priority === 15)) {
        let water = true;
        for (let offset = 0; offset < ego.width; offset++) {
          const color = control[ny * 160 + nx + offset]!;
          if (
            color === 0 ||
            (color === 1 && ego.observeBlocks) ||
            (color === 2 && options.avoidTriggers)
          )
            return false;
          if (color !== 3) water = false;
        }
        if ((ego.waterGate === "on" && !water) || (ego.waterGate === "off" && water)) return false;
      }
      if (
        ego.observeObjects &&
        objects.some(
          (other) =>
            !(nx + ego.width < other.x || nx > other.x + other.width) &&
            (ny === other.y || (ny > other.y && y < other.y) || (ny < other.y && y > other.y)),
        )
      )
        return false;
      if (border) return true;
      x = nx;
      y = ny;
    }
    return false;
  };
  return { ego, step, valid, canStep, searchOptions, acceptsExit };
}

/** Validate full-step ordinary-input traces in the same live geometry as search, without searching. */
export function validateWalk(
  run: NavigationState,
  points: readonly { x: number; y: number }[],
  options?: PlanOptions,
): boolean {
  const { ego, step, canStep, acceptsExit } = navigationModel(run, options);
  let x = ego.x,
    y = ego.y;
  for (const point of points) {
    validateTarget({ x0: point.x, x1: point.x, y0: point.y, y1: point.y });
    if ((point.x - x) % step !== 0 || (point.y - y) % step !== 0) return false;
    while (x !== point.x || y !== point.y) {
      const nx = x + Math.sign(point.x - x) * step;
      const ny = y + Math.sign(point.y - y) * step;
      if (!canStep(y * 160 + x, ny * 160 + nx)) return false;
      x = nx;
      y = ny;
    }
  }
  return acceptsExit(y * 160 + x);
}

/** Advisory static geometry only. This function reads state; it never moves or restores an engine. */
export function planWalk(run: NavigationState, target: Target, options?: PlanOptions): Plan {
  validateTarget(target);
  const { ego, step, valid, canStep, searchOptions, acceptsExit } = navigationModel(run, options);
  const start = ego.y * 160 + ego.x;
  const clearance = anchorClearance(valid);
  const search = searchAnchors(start, target, step, clearance, canStep, searchOptions, acceptsExit);
  const smoothed = smoothAnchors(search.chain, step, clearance, canStep, searchOptions);
  const reached = search.reached;
  return {
    found: search.status === "found",
    searchStatus: search.status,
    room: run.state().room,
    from: { x: ego.x, y: ego.y },
    target,
    reached: { x: reached % 160, y: Math.floor(reached / 160) },
    cells: search.cells,
    steps: smoothed.steps,
    waypoints: smoothed.waypoints,
    metrics: {
      cost: smoothed.cost,
      minimumClearance: smoothed.minimumClearance,
      meanClearance: smoothed.meanClearance,
    },
    assumptions: [
      `Geometry: ${options?.geometry ?? "widest"} cel width. Clearance is Chebyshev distance in picture-coordinate anchor cells after footprint acceptance; narrow legal passages remain usable.`,
      "Each full cardinal or diagonal step costs one movement update plus clearanceWeight * max(0, desiredClearance - clearance)^2 and optional turnCost. Search has an admissible Chebyshev/step lower bound; smoothing cannot increase this cost.",
      options?.exitDirection === undefined
        ? "Static live controls and stationary object baselines; animation, moving objects, automatic priority-table changes, script triggers and border clipping are not predicted. Replan after state changes."
        : "Cardinal terminal crossing checks each full proposal and clipped endpoint with the current cel; future animation, moving objects and script transitions remain unpredicted. Revalidate after state changes.",
      "A candidate path is not proof. Execute normal inputs and assert the milestone.",
    ],
  };
}

export function describePosition(run: NavigationState): unknown {
  const e = run.engine;
  const o = e.screenObjects[0]!;
  const s = decodeSave(e.serialize(), e.profile);
  return {
    room: e.vars[0],
    ego: {
      x: o.x,
      y: o.y,
      width: o.width,
      height: o.height,
      step: o.stepSize,
      observeBlocks: o.observeBlocks,
      observeObjects: o.observeObjects,
      water: o.waterGate,
    },
    horizon: e.horizon,
    block: s.blockEnabled
      ? { left: s.blockLeft, top: s.blockTop, right: s.blockRight, bottom: s.blockBottom }
      : null,
    objects: e.screenObjects.flatMap((o, num) =>
      o.active
        ? [
            {
              num,
              x: o.x,
              y: o.y,
              width: o.width,
              height: o.height,
              update: o.update,
              observeObjects: o.observeObjects,
            },
          ]
        : [],
    ),
  };
}

/** Execute only a found candidate through the existing ordinary-input driver. Errors propagate. */
export function walkPlanned(run: NavigationRun, target: Target, options?: PlanOptions): Plan {
  // The shared controller owns bounded state-driven replanning. A static failed
  // snapshot yields no new information from repeating the same search here.
  const plan = planWalk(run, target, options);
  if (!plan.found)
    throw new Error("No static path: " + JSON.stringify({ plan, state: describePosition(run) }));
  for (const point of plan.waypoints) {
    run.walkTo(point.x, point.y, Math.max(300, plan.steps * 12));
    if (run.state().room !== plan.room)
      throw new Error("Unexpected room transition during planned walk.");
  }
  const state = run.state();
  if (
    state.room === plan.room &&
    state.x >= target.x0 &&
    state.x <= target.x1 &&
    state.y >= target.y0 &&
    state.y <= target.y1
  )
    return plan;
  throw new Error("Planned walk did not reach target: " + JSON.stringify({ state, target }));
}

export interface NavigationSnapshot {
  readonly png: Uint8Array;
  readonly json: string;
}

/** Render a 2-panel navigation overlay (composed visual + EGA priority/control plane with path). */
export function renderNavigationSnapshot(
  run: NavigationState,
  target: Target,
  plan = planWalk(run, target),
): NavigationSnapshot {
  validateTarget(target);
  for (const point of [plan.from, ...plan.waypoints])
    validateTarget({ x0: point.x, x1: point.x, y0: point.y, y1: point.y });
  const e = run.engine,
    frame = e.getFrame(),
    o = e.screenObjects[0]!;
  const width = 640,
    height = 336,
    rgb = new Uint8Array(width * height * 3);
  const controls: readonly (readonly [number, number, number])[] = [
    [255, 60, 60],
    [255, 255, 255],
    [255, 0, 255],
    [0, 220, 255],
  ];
  function pixel(panel: number, x: number, y: number, color: readonly number[]) {
    if (x < 0 || x >= 160 || y < 0 || y >= 168) return;
    for (let dy = 0; dy < 2; dy++)
      for (let dx = 0; dx < 2; dx++)
        rgb.set(color, ((y * 2 + dy) * width + panel * 320 + x * 2 + dx) * 3);
  }
  for (let y = 0; y < 168; y++)
    for (let x = 0; x < 160; x++) {
      pixel(0, x, y, EGA_RGB[frame.visual[y * 160 + x]!]!);
      const v = e.surface.priority[y * 160 + x]!;
      pixel(
        1,
        x,
        y,
        v < 4 ? controls[v]! : x % 10 === 0 || y % 10 === 0 ? [70, 70, 70] : [20, 20, 20],
      );
    }
  const box = (x0: number, y0: number, x1: number, y1: number, color: readonly number[]) => {
    for (let x = x0; x <= x1; x++) {
      pixel(1, x, y0, color);
      pixel(1, x, y1, color);
    }
    for (let y = y0; y <= y1; y++) {
      pixel(1, x0, y, color);
      pixel(1, x1, y, color);
    }
  };
  for (const other of e.screenObjects)
    if (other.active)
      box(other.x, other.y - other.height + 1, other.x + other.width - 1, other.y, [255, 150, 0]);
  box(target.x0, target.y0, target.x1, target.y1, [70, 255, 70]);
  let from = plan.from;
  for (const point of plan.waypoints) {
    let x = from.x,
      y = from.y;
    while (x !== point.x || y !== point.y) {
      pixel(1, x, y, [255, 255, 0]);
      x += Math.sign(point.x - x);
      y += Math.sign(point.y - y);
    }
    from = point;
  }
  for (let x = o.x; x < o.x + o.width; x++) pixel(1, x, o.y, [0, 120, 255]);
  const png = encodePngRgb(width, height, rgb);
  const json = JSON.stringify(
    {
      legend:
        "Left: composed scene. Right: red=solid, white=conditional block, magenta=trigger, cyan=water, orange=objects, blue=ego baseline, green=target, yellow=candidate path; grid every 10 pixels.",
      plan,
      state: describePosition(run),
    },
    null,
    2,
  );
  return { png, json };
}
