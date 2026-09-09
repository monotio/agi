import { writeFileSync } from "node:fs";
import { decodeSave } from "../src/runtime/persistence.ts";
import { EGA_RGB, encodePngRgb } from "../src/picture/png.ts";
import type { Engine } from "../src/runtime/engine.ts";

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
}
export interface PlanOptions {
  avoidTriggers?: boolean;
  attempts?: number;
}
function validateTarget(target: Target): void {
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
const dirs = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
] as const;

function canWalkDirect(
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
  let cx = x1;
  let cy = y1;
  while (cx !== x2 || cy !== y2) {
    const dx = Math.sign(x2 - cx);
    const dy = Math.sign(y2 - cy);
    const nx = Math.abs(x2 - cx) < step ? x2 : cx + dx * step;
    const ny = Math.abs(y2 - cy) < step ? y2 : cy + dy * step;
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

/** Advisory static geometry only. This function reads state; it never moves or restores an engine. */
export function planWalk(run: NavigationState, target: Target, options?: PlanOptions): Plan {
  validateTarget(target);
  const engine = run.engine,
    ego = { ...engine.screenObjects[0]! };
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
  if (view) {
    for (const loop of view.loops) {
      for (const cel of loop.cels) {
        if (cel.width > egoWidth) egoWidth = cel.width;
      }
    }
  }
  const control = engine.surface.priority.slice();
  const step = Math.max(1, ego.stepSize);
  const minY = Math.max(ego.height - 1, ego.observeHorizon ? engine.horizon + 1 : 0);
  const maxX = Math.max(ego.x, 160 - egoWidth);
  const inside = (x: number, y: number) =>
    x > save.blockLeft && x < save.blockRight && y > save.blockTop && y < save.blockBottom;
  const valid = new Uint8Array(160 * 168);
  for (let y = minY; y < 168; y++)
    for (let x = 0; x <= maxX; x++) {
      let accepted = true,
        water = true;
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
      if (accepted) valid[y * 160 + x] = 1;
    }
  const start = ego.y * 160 + ego.x;
  const parent = new Int32Array(160 * 168).fill(-2),
    queue = new Int32Array(160 * 168);
  parent[start] = -1;
  queue[0] = start;
  let head = 0,
    tail = 1,
    end = -1,
    best = start;
  const distance = (x: number, y: number) =>
    Math.max(target.x0 - x, 0, x - target.x1) + Math.max(target.y0 - y, 0, y - target.y1);
  while (head < tail) {
    const at = queue[head++]!,
      x = at % 160,
      y = Math.floor(at / 160);
    if (distance(x, y) < distance(best % 160, Math.floor(best / 160))) best = at;
    if (distance(x, y) === 0) {
      end = at;
      break;
    }
    for (const [dx, dy] of dirs) {
      const nx = x + dx * step,
        ny = y + dy * step;
      if (nx < 0 || nx > maxX || ny < minY || ny > 167) continue;
      const next = ny * 160 + nx;
      if (parent[next] !== -2 || !valid[next]) continue;
      if (ego.observeBlocks && save.blockEnabled && inside(x, y) !== inside(nx, ny)) continue;
      if (
        ego.observeObjects &&
        objects.some(
          (o) =>
            !(nx + egoWidth < o.x || nx > o.x + o.width) &&
            (ny === o.y || (ny > o.y && y < o.y) || (ny < o.y && y > o.y)),
        )
      )
        continue;
      parent[next] = at;
      queue[tail++] = next;
    }
  }
  const chain: number[] = [];
  if (end >= 0) for (let n = end; n >= 0; n = parent[n]!) chain.push(n);
  chain.reverse();
  const waypoints: { x: number; y: number }[] = [];
  if (chain.length > 1) {
    let curr = 0;
    while (curr < chain.length - 1) {
      let furthest = curr + 1;
      for (let next = chain.length - 1; next > curr; next--) {
        const pCurr = chain[curr]!;
        const pNext = chain[next]!;
        const x1 = pCurr % 160;
        const y1 = Math.floor(pCurr / 160);
        const x2 = pNext % 160;
        const y2 = Math.floor(pNext / 160);
        if (
          canWalkDirect(
            x1,
            y1,
            x2,
            y2,
            step,
            maxX,
            minY,
            valid,
            {
              width: egoWidth,
              observeBlocks: ego.observeBlocks,
              observeObjects: ego.observeObjects,
            },
            save,
            inside,
            objects,
          )
        ) {
          furthest = next;
          break;
        }
      }
      const pt = chain[furthest]!;
      waypoints.push({ x: pt % 160, y: Math.floor(pt / 160) });
      curr = furthest;
    }
  }
  const reached = end >= 0 ? end : best;
  return {
    found: end >= 0,
    room: run.state().room,
    from: { x: ego.x, y: ego.y },
    target,
    reached: { x: reached % 160, y: Math.floor(reached / 160) },
    cells: tail,
    steps: Math.max(0, chain.length - 1),
    waypoints,
    assumptions: [
      "Static live controls and stationary object baselines; animation, moving objects, automatic priority-table changes, script triggers and border clipping are not predicted. Replan after state changes.",
      "A candidate path is not proof. Execute normal inputs and assert the milestone.",
    ],
  };
}
export function describePosition(run: NavigationState): unknown {
  const e = run.engine,
    o = e.screenObjects[0]!,
    s = decodeSave(e.serialize(), e.profile);
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
  const attempts = options?.attempts ?? 5;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const s = run.state();
    if (s.x >= target.x0 && s.x <= target.x1 && s.y >= target.y0 && s.y <= target.y1) {
      return {
        found: true,
        room: s.room,
        from: { x: s.x, y: s.y },
        target,
        reached: { x: s.x, y: s.y },
        cells: 0,
        steps: 0,
        waypoints: [],
        assumptions: [],
      };
    }
    const plan = planWalk(run, target, options);
    if (!plan.found) {
      if (attempt === attempts - 1) {
        throw new Error(
          "No static path: " + JSON.stringify({ plan, state: describePosition(run) }),
        );
      }
      continue;
    }
    let blocked = false;
    for (const point of plan.waypoints) {
      try {
        run.walkTo(point.x, point.y, Math.max(300, plan.steps * 12));
      } catch (error) {
        if (
          attempt < attempts - 1 &&
          error instanceof Error &&
          error.message.startsWith("Walk blocked")
        ) {
          blocked = true;
          break;
        }
        throw error;
      }
      if (run.state().room !== plan.room) {
        throw new Error("Unexpected room transition during planned walk.");
      }
    }
    if (!blocked) {
      const state = run.state();
      if (
        state.room === plan.room &&
        state.x >= target.x0 &&
        state.x <= target.x1 &&
        state.y >= target.y0 &&
        state.y <= target.y1
      ) {
        return plan;
      }
    }
  }
  const state = run.state();
  throw new Error("Planned walk did not reach target: " + JSON.stringify({ state, target }));
}
/** Live frame plus control map, footprint and target; coordinates remain AGI logical pixels. */
export function renderLive(
  run: NavigationState,
  target: Target,
  path: string,
  plan = planWalk(run, target),
): void {
  validateTarget(target);
  if (!path.endsWith(".png")) throw new Error("Navigation image path must end in .png.");
  for (const point of [plan.from, ...plan.waypoints])
    validateTarget({ x0: point.x, x1: point.x, y0: point.y, y1: point.y });
  const e = run.engine,
    frame = e.getFrame(),
    o = e.screenObjects[0]!;
  const width = 640,
    height = 336,
    rgb = new Uint8Array(width * height * 3);
  const controls = [
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
  const box = (x0: number, y0: number, x1: number, y1: number, color: number[]) => {
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
  writeFileSync(path, encodePngRgb(width, height, rgb));
  writeFileSync(
    path.replace(/\.png$/, ".json"),
    JSON.stringify(
      {
        legend:
          "Left: composed scene. Right: red=solid, white=conditional block, magenta=trigger, cyan=water, orange=objects, blue=ego baseline, green=target, yellow=candidate path; grid every 10 pixels.",
        plan,
        state: describePosition(run),
      },
      null,
      2,
    ),
  );
}
