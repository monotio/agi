import { directionForDelta } from "../../src/agent/gameTestSteps.ts";
import { rngDraw } from "../../src/runtime/rng.ts";
import type { Mh2, Leg } from "./mh2.ts";

/**
 * The warehouse floor of Manhunter 2 (room 103): four sentry robots patrol
 * the aisles between the crates and charge down any row or column the
 * intruder shares with them. No fixed timing survives the room, so the
 * crossing is planned one interpreter cycle at a time against a port of the
 * room's own charge rules, driven by the run's RNG stream. Every input the
 * tape records is an ordinary arrow key.
 */
/**
 * Room 103's charge rules, from the room logic. Robots 1 and 4 snap-charge
 * horizontally whenever their y matches the figure's y inside an aisle row
 * band, and charge vertically while both share column 14 or 134. Robots 2
 * and 3 charge horizontally along the top and bottom aisles (y<25 or y>150)
 * and snap-charge vertically whenever their x matches the figure's x inside
 * a column band. Any contact within ten pixels is fatal, so the figure
 * dodges by scoring each candidate step one cycle ahead: keeping distance,
 * leaving a charging robot's corridor, and staying out of trigger lines a
 * patrolling robot is about to reach.
 */
const AISLE_ROWS: readonly (readonly [number, number])[] = [
  [18, 25],
  [38, 47],
  [60, 69],
  [83, 91],
  [105, 113],
  [130, 136],
  [150, 157],
];
const inBand = (v: number, bands: readonly (readonly [number, number])[]) =>
  bands.some(([a, b]) => v > a && v < b);
const STEP_X: Record<number, number> = { 1: 0, 2: 1, 3: 1, 4: 1, 5: 0, 6: -1, 7: -1, 8: -1 };
const STEP_Y: Record<number, number> = { 1: -1, 2: -1, 3: 0, 4: 1, 5: 1, 6: 1, 7: 0, 8: -1 };
const snapRow = (y: number) => {
  const rows = [22, 44, 66, 88, 111, 134, 155];
  return rows.reduce((m, r) => (Math.abs(y - r) < Math.abs(y - m) ? r : m), rows[0]!);
};
const snapCol = (x: number) => {
  const cols = [14, 39, 63, 87, 113, 134];
  return cols.reduce((m, c) => (Math.abs(x - c) < Math.abs(x - m) ? c : m), cols[0]!);
};
/**
 * Robot state for the ported room-103 pass. `chg` mirrors the room's
 * charge-direction vars v90-v93 (0 = patrolling); `row` marks the
 * row-snapping robots o1 and o4 (o2 and o3 snap on columns). `fresh` mirrors
 * the newly-positioned bit a `reposition.to.v` snap sets: the robot's next
 * due movement pass is a zero-step, so a snapped robot teleports and holds.
 * Robots are footprint-blocked by the picture's priority screen exactly like
 * the figure — `ignore.objs` only lifts object-object collision — so patrols
 * stay inside the corridors and aisles the crates leave open.
 */
interface RobotSim {
  x: number;
  y: number;
  d: number;
  s: number;
  chg: number;
  row: boolean;
  cx: number;
  w: number;
  h: number;
  fresh: boolean;
}

/** The exact ego-x bands for the o2/o3 column snap (the >132 band needs y<146). */
const columnTrigger = (x: number, y: number) =>
  x < 26 ||
  (x > 36 && x < 50) ||
  (x > 60 && x < 74) ||
  (x > 84 && x < 98) ||
  (x > 108 && x < 122) ||
  (x > 132 && y < 146);

/**
 * One logic pass over `r`, ported from room 103: patrol bounds, the
 * snap-charge triggers, the ten-pixel kill check, then charge slowdown/end.
 * `rng` predicts the charge-end `random(1,50,v41)` draw from the live
 * stream. Returns false when the robot is touching the figure at (ex, ey).
 *
 * Two Sierra quirks are reproduced exactly: a southward lane charge on a
 * row-snapper leaks the direction byte into `step.size` and runs at step 5,
 * and a snap's `reposition.to.v` marks the robot newly-positioned so it
 * holds still through the next movement pass.
 */
function robotCycle(
  r: RobotSim,
  ex: number,
  ey: number,
  ecx: number,
  rng: { state: number },
  reseed: number,
): boolean {
  if (r.chg === 0) {
    if (r.x > 136) r.d = 7;
    if (r.x < 14) r.d = 3;
    if (r.y > 154) r.d = 1;
    if (r.y < 23) r.d = 5;
    if (r.row) {
      if (ex === r.x && (r.x === 14 || r.x === 134)) {
        if (ey > r.y) {
          r.chg = r.d = 5;
          r.s = 5; // assignn(v44,5) leaks into step.size(o1,v44)
        } else {
          r.chg = r.d = 1;
          r.s = 3;
        }
      } else if (ey === r.y && inBand(ey, AISLE_ROWS)) {
        r.y = snapRow(ey);
        r.fresh = true;
        r.chg = r.d = ex > r.x ? 3 : 7;
        r.s = 3;
      }
    } else {
      if (ey === r.y && (r.y < 25 || r.y > 150)) {
        r.chg = r.d = ex > r.x ? 3 : 7;
        r.s = 3;
      } else if (ex === r.x && columnTrigger(ex, ey)) {
        r.x = snapCol(ex);
        r.fresh = true;
        r.chg = r.d = ey < r.y ? 1 : 5;
        r.s = 3;
      }
    }
  }
  if (Math.abs(ex + ecx - (r.x + r.cx)) + Math.abs(ey - r.y) < 10) return false;
  if (r.chg !== 0) {
    if (
      (r.chg === 3 && r.x > 120) ||
      (r.chg === 7 && r.x < 27) ||
      (r.chg === 1 && r.y < 40) ||
      (r.chg === 5 && r.y > 141)
    ) {
      r.s = 1;
    }
    if (
      (r.chg === 3 && r.x > 133) ||
      (r.chg === 7 && r.x < 15) ||
      (r.chg === 1 && r.y < 22) ||
      (r.chg === 5 && r.y > 153)
    ) {
      r.chg = 0;
      r.s = 1;
      // The random resume only picks along one axis: row-snappers turn
      // north/south, column-snappers east/west — predict the actual draw.
      const draw = rngDraw(rng.state, () => reseed);
      rng.state = draw.state;
      const v41 = 1 + (draw.byte % 50);
      if (r.row) {
        r.d = v41 < 25 ? (r.y > 23 ? 1 : 5) : r.y < 148 ? 5 : 1;
      } else {
        r.d = v41 < 25 ? (r.x > 18 ? 7 : 3) : r.x < 128 ? 3 : 7;
      }
    }
  }
  return true;
}

/** The engine's spiral: first collision-free, footprint-legal cell around (x,y). */
export function spiralPlace(
  x: number,
  y: number,
  footOk: (x: number, y: number) => boolean,
): readonly [number, number] | null {
  let leg = 1;
  let remaining = 1;
  let direction = 0;
  const deltas = [
    [-1, 0],
    [0, 1],
    [1, 0],
    [0, -1],
  ] as const;
  // Matches placeObject: the spiral covers the square containing every legal
  // point; the engine throws when nothing accepts, callers treat null as dead.
  const radius = Math.max(Math.abs(x), Math.abs(x - 159), Math.abs(y), Math.abs(y - 167)) + 1;
  for (let i = 0; i < (radius * 2 + 1) ** 2; i++) {
    if (footOk(x, y)) return [x, y];
    x += deltas[direction]![0];
    y += deltas[direction]![1];
    if (--remaining === 0) {
      direction = (direction + 1) % 4;
      if (direction === 0 || direction === 2) leg++;
      remaining = leg;
    }
  }
  return null;
}

/**
 * The post-logic movement pass for one robot: a freshly snapped object makes
 * its zero-step placement check (which can still push it to the nearest
 * legal cell) and otherwise moves stepSize cells along its direction,
 * footprint-blocked by the priority screen exactly like moveObject.
 */
function robotMove(r: RobotSim, footOk: (x: number, y: number) => boolean): void {
  if (r.fresh) {
    r.fresh = false;
    if (!footOk(r.x, r.y)) {
      const at = spiralPlace(r.x, r.y, footOk);
      if (at) [r.x, r.y] = at;
    }
    return;
  }
  const nx = Math.min(160 - r.w, Math.max(0, r.x + (STEP_X[r.d] ?? 0) * r.s));
  const ny = Math.min(167, Math.max(r.h - 1, r.y + (STEP_Y[r.d] ?? 0) * r.s));
  if (footOk(nx, ny)) {
    r.x = nx;
    r.y = ny;
  }
}

/** The footprint rules each mover's baseline obeys, plus the figure's size. */
interface MazeFoot {
  ego: (x: number, y: number) => boolean;
  robot: (x: number, y: number) => boolean;
  ew: number;
  eh: number;
}

/** One simulated interpreter cycle: the room's logic pass, then its movement pass. */
interface SimState {
  ex: number;
  ey: number;
  rs: RobotSim[];
  rng: number;
}

function simTick(
  s: SimState,
  dir: number,
  ecx: number,
  foot: MazeFoot,
  reseed: number,
): SimState | null {
  const rs = s.rs.map((r) => ({ ...r }));
  const rng = { state: s.rng };
  for (const r of rs) {
    if (!robotCycle(r, s.ex, s.ey, ecx, rng, reseed)) return null;
  }
  let ex = s.ex;
  let ey = s.ey;
  const nx = Math.min(160 - foot.ew, Math.max(0, ex + (STEP_X[dir] ?? 0)));
  const ny = Math.min(167, Math.max(foot.eh - 1, ey + (STEP_Y[dir] ?? 0)));
  if (foot.ego(nx, ny)) {
    ex = nx;
    ey = ny;
  }
  for (const r of rs) robotMove(r, foot.robot);
  return { ex, ey, rs, rng: rng.state };
}

interface BeamNode extends SimState {
  parent: BeamNode | null;
  dir: number;
}

function stateKey(s: SimState): string {
  let k = `${s.ex},${s.ey},${s.rng}`;
  for (const r of s.rs) k += `|${r.x},${r.y},${r.d},${r.s},${r.chg},${r.fresh ? 1 : 0}`;
  return k;
}

/**
 * Beam search over the exact room model: finds a survivable direction
 * sequence from the current state through the remaining legs to the exit
 * edge — "wait for the charge to pass, then dash" plans that a greedy
 * controller cannot commit to. Planning only to the next waypoint is not
 * enough: the figure can arrive in a state the following leg cannot leave
 * (it once reached the west corridor while a south charge was already
 * sweeping it), so the score measures distance left along the whole route
 * and the goal is the exit threshold itself. Returns the predicted state
 * after every planned cycle plus the headings that produce them; when
 * nothing reaches the exit inside MAX_DEPTH, the best-ranked frontier
 * node's path still leads the walk.
 */
const BEAM = 48;
const MAX_DEPTH = 800;
function planSearch(
  x: number,
  y: number,
  ecx: number,
  robots: readonly RobotSim[],
  foot: MazeFoot,
  legs: readonly Leg[],
  legIndex: number,
  rngState: number,
  reseed: number,
): { states: SimState[]; dirs: number[]; reached: boolean } {
  const gx = legs.at(-1)![0];
  const gy = legs.at(-1)![1];
  // The exit is an edge, not a point: crossing it changes rooms.
  const goal = (s: SimState) =>
    gx <= 2 ? s.ex <= gx : gx >= 150 ? s.ex >= gx : s.ex === gx && s.ey === gy;
  // Distance left along the waypoint chain, taking the suffix the position
  // fits best so a state that already passed a waypoint isn't pulled back.
  const left = (px: number, py: number) => {
    let best = Number.POSITIVE_INFINITY;
    for (let i = legIndex; i < legs.length; i++) {
      let d = Math.abs(legs[i]![0] - px) + Math.abs(legs[i]![1] - py);
      for (let j = i; j < legs.length - 1; j++)
        d += Math.abs(legs[j + 1]![0] - legs[j]![0]) + Math.abs(legs[j + 1]![1] - legs[j]![1]);
      if (d < best) best = d;
    }
    return best;
  };
  const root: BeamNode = {
    ex: x,
    ey: y,
    rs: robots.map((r) => ({ ...r })),
    rng: rngState,
    parent: null,
    dir: 0,
  };
  const seen = new Set([stateKey(root)]);
  let frontier = [root];
  const margin = (s: SimState) =>
    Math.min(...s.rs.map((r) => Math.abs(s.ex + ecx - (r.x + r.cx)) + Math.abs(s.ey - r.y)));
  const score = (s: SimState) => -left(s.ex, s.ey) * 16 + Math.min(24, margin(s));
  const rebuild = (node: BeamNode, reached: boolean) => {
    const states: SimState[] = [];
    const dirs: number[] = [];
    for (let n: BeamNode | null = node; n; n = n.parent) {
      states.unshift({ ex: n.ex, ey: n.ey, rs: n.rs, rng: n.rng });
      dirs.unshift(n.dir);
    }
    dirs.shift(); // the root's own move is meaningless
    return { states, dirs, reached };
  };
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next: BeamNode[] = [];
    for (const s of frontier) {
      for (let dir = 0; dir <= 8; dir++) {
        const st = simTick(s, dir, ecx, foot, reseed);
        if (!st) continue;
        const k = stateKey(st);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push({ ...st, parent: s, dir });
      }
    }
    if (!next.length) break;
    const hit = next.find((s) => goal(s));
    if (hit) return rebuild(hit, true);
    next.sort((a, b) => score(b) - score(a));
    frontier = next.slice(0, BEAM);
  }
  frontier.sort((a, b) => score(b) - score(a));
  return frontier.length ? rebuild(frontier[0]!, false) : { states: [], dirs: [], reached: false };
}

export function walkDodging(mh: Mh2, legs: readonly Leg[], alive: () => boolean): boolean {
  const { run, engine } = mh;
  const room = mh.room;
  let plan: { states: SimState[]; dirs: number[]; reached: boolean } = {
    states: [],
    dirs: [],
    reached: false,
  };
  for (let li = 0; li < legs.length; li++) {
    const [x, y, wait] = legs[li]!;
    for (let c = 0; c < wait; c++) {
      mh.cycle();
      if (!alive()) return false;
    }
    let stuck = 0;
    for (let c = 0; c < 900 && stuck < 48; c++) {
      if (!alive()) return false;
      if (mh.room !== room) return true;
      const o = mh.cursor;
      const at = o.x + o.y * 256;
      const goal = directionForDelta(Math.sign(x - o.x), Math.sign(y - o.y));
      if (goal === 0) break;
      const robots: RobotSim[] = [];
      for (let i = 1; i <= 4; i++) {
        const r = engine.screenObjects[i];
        if (r && r.active && r.view !== 0)
          robots.push({
            x: r.x,
            y: r.y,
            d: r.direction,
            s: Math.max(1, r.stepSize),
            chg: engine.vars[89 + i] ?? 0,
            row: i === 1 || i === 4,
            cx: Math.floor(r.width / 2),
            w: r.width,
            h: r.height,
            fresh: r.newlyPositioned,
          });
      }
      const ecx = Math.floor(o.width / 2);
      // The footprint rule from the picture's priority screen: a baseline
      // row on black (priority 0) rejects the step, same as the engine.
      const prio = engine.surface.priority;
      const footAt = (w: number, observeBlocks: boolean) => (nx: number, ny: number) => {
        if (ny < 0 || ny > 167) return false;
        for (let i = 0; i < w; i++) {
          const cx = nx + i;
          if (cx < 0 || cx > 159) continue;
          const v = prio[ny * 160 + cx];
          if (v === 0 || (v === 1 && observeBlocks)) return false;
        }
        return true;
      };
      const foot: MazeFoot = {
        ego: footAt(o.width, o.observeBlocks),
        robot: footAt(7, true),
        ew: o.width,
        eh: o.height,
      };
      // Clone of the live RNG stream — room 103's only draws are the four
      // charge-end `random(1,50,v41)` calls, so resumes are predictable.
      const rngState = run.rng;
      const reseed = run.seed & 0xffff;
      // Follow the committed plan while the live engine still matches its
      // next predicted state; a divergence (or an exhausted plan) replans.
      const snap: SimState = { ex: o.x, ey: o.y, rs: robots, rng: rngState };
      const ahead = plan.states[0];
      const inSync =
        ahead !== undefined &&
        ahead.ex === snap.ex &&
        ahead.ey === snap.ey &&
        ahead.rng === snap.rng &&
        ahead.rs.length === snap.rs.length &&
        ahead.rs.every((r, i) => {
          const q = snap.rs[i]!;
          return (
            r.x === q.x &&
            r.y === q.y &&
            r.d === q.d &&
            r.s === q.s &&
            r.chg === q.chg &&
            r.fresh === q.fresh
          );
        });
      if (!inSync || plan.dirs.length === 0)
        plan = planSearch(o.x, o.y, ecx, robots, foot, legs, li, rngState, reseed);
      const dir = plan.dirs.length ? plan.dirs.shift()! : 0;
      plan.states.shift();
      if (engine.vars[6] !== dir) run.direction(dir);
      else mh.cycle();
      // Holding still on purpose is a wait, not a stall; only a blocked
      // step (or a genuine trap) should wind the leg down.
      stuck = dir !== 0 && o.x + o.y * 256 === at ? stuck + 1 : 0;
    }
    if (mh.room === room && engine.vars[6] !== 0) run.direction(0);
    if (!alive()) return false;
  }
  return true;
}
