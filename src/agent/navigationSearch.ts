/** Static anchor-space navigation. A move is one full cardinal or diagonal step. */
export const NAVIGATION_DIRECTIONS = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
] as const;

const WIDTH = 160;
const HEIGHT = 168;
const SIZE = WIDTH * HEIGHT;

export interface SearchOptions {
  desiredClearance: number;
  clearanceWeight: number;
  turnCost: number;
  maxSearchNodes: number;
  maxSteps?: number;
}

export interface SearchResult {
  status: "found" | "unreachable" | "budget_exhausted" | "movement_budget_exhausted";
  chain: number[];
  reached: number;
  cells: number;
}

/** Chebyshev distance in picture cells to an illegal anchor, including the outside. */
export function anchorClearance(valid: Uint8Array): Uint16Array {
  const distance = new Uint16Array(SIZE).fill(65535);
  const queue = new Int32Array(SIZE);
  let head = 0,
    tail = 0;
  for (let at = 0; at < SIZE; at++) {
    if (!valid[at]) {
      distance[at] = 0;
      queue[tail++] = at;
    }
  }
  // Outside anchors are also illegal. Insert the legal boundary after zero seeds.
  for (let at = 0; at < SIZE; at++) {
    const x = at % WIDTH,
      y = Math.floor(at / WIDTH);
    if (valid[at] && (x === 0 || x === WIDTH - 1 || y === 0 || y === HEIGHT - 1)) {
      distance[at] = 1;
      queue[tail++] = at;
    }
  }
  while (head < tail) {
    const at = queue[head++]!;
    const x = at % WIDTH,
      y = Math.floor(at / WIDTH);
    for (const [dx, dy] of NAVIGATION_DIRECTIONS) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) continue;
      const next = ny * WIDTH + nx;
      if (distance[next] !== 65535) continue;
      distance[next] = distance[at]! + 1;
      queue[tail++] = next;
    }
  }
  return distance;
}

interface Entry {
  state: number;
  cost: number;
  estimate: number;
  remaining: number;
  order: number;
}

function less(a: Entry, b: Entry): boolean {
  return (
    a.estimate < b.estimate ||
    (a.estimate === b.estimate &&
      (a.remaining < b.remaining || (a.remaining === b.remaining && a.order < b.order)))
  );
}

class OpenSet {
  private entries: Entry[] = [];
  get size(): number {
    return this.entries.length;
  }
  push(entry: Entry): void {
    let at = this.entries.length;
    this.entries.push(entry);
    while (at > 0) {
      const parent = Math.floor((at - 1) / 2);
      if (!less(entry, this.entries[parent]!)) break;
      this.entries[at] = this.entries[parent]!;
      at = parent;
    }
    this.entries[at] = entry;
  }
  pop(): Entry {
    const first = this.entries[0]!;
    const last = this.entries.pop()!;
    if (this.entries.length > 0) {
      let at = 0;
      while (at * 2 + 1 < this.entries.length) {
        let child = at * 2 + 1;
        if (child + 1 < this.entries.length && less(this.entries[child + 1]!, this.entries[child]!))
          child++;
        if (!less(this.entries[child]!, last)) break;
        this.entries[at] = this.entries[child]!;
        at = child;
      }
      this.entries[at] = last;
    }
    return first;
  }
}

export function movementCost(clearance: number, options: SearchOptions): number {
  const deficit = Math.max(0, options.desiredClearance - clearance);
  return 1 + options.clearanceWeight * deficit * deficit;
}

export function searchAnchors(
  start: number,
  target: { x0: number; x1: number; y0: number; y1: number },
  step: number,
  clearance: Uint16Array,
  canStep: (from: number, to: number) => boolean,
  options: SearchOptions,
  acceptsTarget?: (at: number) => boolean,
  terminalSteps: (at: number) => number = () => 0,
): SearchResult {
  const sx = start % WIDTH,
    sy = Math.floor(start / WIDTH);
  // Full normal-input steps preserve both coordinate residues. Border clipping is excluded.
  if (
    sx + Math.ceil((target.x0 - sx) / step) * step > target.x1 ||
    sy + Math.ceil((target.y0 - sy) / step) * step > target.y1
  ) {
    return { status: "unreachable", chain: [], reached: start, cells: 0 };
  }
  const distance = (at: number): number => {
    const x = at % WIDTH,
      y = Math.floor(at / WIDTH);
    return Math.ceil(
      Math.max(target.x0 - x, 0, x - target.x1, target.y0 - y, y - target.y1) / step,
    );
  };
  const limit = options.maxSteps ?? Infinity;
  if (distance(start) > limit)
    return { status: "movement_budget_exhausted", chain: [], reached: start, cells: 0 };
  // Being inside the requested region is already success; centering never moves
  // an actor whose goal has already been satisfied.
  if (distance(start) === 0 && (acceptsTarget?.(start) ?? true) && terminalSteps(start) <= limit)
    return { status: "found", chain: [start], reached: start, cells: 0 };
  let spent = 0;
  // With ample movement slack, the ordinary optimum usually already fits.
  // If so it is also the constrained optimum and needs no Pareto labels.
  // An overlong optimum falls through to bounded search with the work left.
  if (Number.isFinite(limit) && limit - distance(start) >= 32) {
    const relaxed = searchAnchors(
      start,
      target,
      step,
      clearance,
      canStep,
      {
        desiredClearance: options.desiredClearance,
        clearanceWeight: options.clearanceWeight,
        turnCost: options.turnCost,
        maxSearchNodes: options.maxSearchNodes,
      },
      acceptsTarget,
      terminalSteps,
    );
    if (
      relaxed.status !== "found" ||
      relaxed.chain.length - 1 + terminalSteps(relaxed.reached) <= limit
    )
      return relaxed;
    spent = relaxed.cells;
    if (spent >= options.maxSearchNodes)
      return { status: "budget_exhausted", chain: [], reached: relaxed.reached, cells: spent };
  }
  const centerX = (target.x0 + target.x1) / 2;
  const centerY = (target.y0 + target.y1) / 2;
  const terminalCost = (at: number): number =>
    2 *
    Math.min(
      8,
      Math.max(Math.abs((at % WIDTH) - centerX), Math.abs(Math.floor(at / WIDTH) - centerY)) / step,
    );
  // Heading matters for turn costs. With a movement constraint, two arrivals
  // can both matter: a cheaper detour must not erase a shorter costly arrival.
  const headings = options.turnCost > 0 ? 9 : 1;
  interface Label {
    state: number;
    cost: number;
    steps: number;
    parent: number;
    active: boolean;
  }
  const labels: Label[] = [];
  const arrivals = new Map<number, number[]>();
  const open = new OpenSet();
  const labelLimit = Math.min(262144, (options.maxSearchNodes - spent) * 8 + 1);
  let cells = spent,
    best = start,
    winner = -1,
    winnerCost = Infinity,
    movementPruned = false;
  const initial = start * headings + headings - 1;
  labels.push({ state: initial, cost: 0, steps: 0, parent: -1, active: true });
  arrivals.set(initial, [0]);
  open.push({ state: 0, cost: 0, estimate: distance(start), remaining: distance(start), order: 0 });
  const finish = (): SearchResult => {
    const chain: number[] = [];
    for (let id = winner; id >= 0; id = labels[id]!.parent)
      chain.push(Math.floor(labels[id]!.state / headings));
    chain.reverse();
    return { status: "found", chain, reached: chain[chain.length - 1]!, cells };
  };
  while (open.size > 0) {
    const entry = open.pop();
    const label = labels[entry.state]!;
    if (!label.active) continue;
    if (winner >= 0 && entry.estimate >= winnerCost) return finish();
    if (cells >= options.maxSearchNodes)
      return { status: "budget_exhausted", chain: [], reached: best, cells };
    cells++;
    const at = Math.floor(label.state / headings);
    if (distance(at) < distance(best)) best = at;
    if (distance(at) === 0 && (acceptsTarget?.(at) ?? true)) {
      const crossingSteps = terminalSteps(at);
      const total = label.cost + terminalCost(at) + crossingSteps;
      if (label.steps + crossingSteps > limit) {
        movementPruned = true;
      } else if (total < winnerCost) {
        winner = entry.state;
        winnerCost = total;
      }
    }
    const x = at % WIDTH,
      y = Math.floor(at / WIDTH);
    for (let direction = 0; direction < NAVIGATION_DIRECTIONS.length; direction++) {
      const [dx, dy] = NAVIGATION_DIRECTIONS[direction]!;
      const nx = x + dx * step,
        ny = y + dy * step;
      if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) continue;
      const next = ny * WIDTH + nx;
      if (!canStep(at, next)) continue;
      const remaining = distance(next);
      const steps = label.steps + 1;
      if (steps + remaining > limit) {
        movementPruned = true;
        continue;
      }
      const nextState = next * headings + (headings === 1 ? 0 : direction);
      const heading = label.state % headings;
      const turn = headings > 1 && heading !== 8 && heading !== direction ? options.turnCost : 0;
      const cost = label.cost + movementCost(clearance[next]!, options) + turn;
      if (cost + remaining >= winnerCost) continue;
      const previous = arrivals.get(nextState) ?? [];
      if (
        previous.some(
          (id) => labels[id]!.cost <= cost && (limit === Infinity || labels[id]!.steps <= steps),
        )
      )
        continue;
      if (labels.length >= labelLimit)
        return { status: "budget_exhausted", chain: [], reached: best, cells };
      const kept = previous.filter((id) => {
        const other = labels[id]!;
        if (cost <= other.cost && (limit === Infinity || steps <= other.steps)) {
          other.active = false;
          return false;
        }
        return true;
      });
      const id = labels.length;
      labels.push({ state: nextState, cost, steps, parent: entry.state, active: true });
      kept.push(id);
      arrivals.set(nextState, kept);
      open.push({ state: id, cost, estimate: cost + remaining, remaining, order: id });
    }
  }
  if (winner >= 0) return finish();
  return {
    status: movementPruned ? "movement_budget_exhausted" : "unreachable",
    chain: [],
    reached: best,
    cells,
  };
}

export function smoothAnchors(
  chain: number[],
  step: number,
  clearance: Uint16Array,
  canStep: (from: number, to: number) => boolean,
  options: SearchOptions,
): {
  waypoints: { x: number; y: number }[];
  steps: number;
  cost: number;
  minimumClearance: number;
  meanClearance: number;
} {
  if (chain.length > 0 && chain.length - 1 > (options.maxSteps ?? Infinity))
    throw new RangeError("Navigation trace exceeds its movement limit.");
  const prefixCost = [0];
  for (let i = 1; i < chain.length; i++)
    prefixCost.push(prefixCost[i - 1]! + movementCost(clearance[chain[i]!]!, options));
  const waypoints: { x: number; y: number }[] = [];
  let current = 0,
    steps = 0,
    cost = 0,
    sumClearance = 0,
    minimumClearance = Infinity;
  let previousDirection = -1;
  // Bound smoothing separately; exhausted work falls back to the verified search trace.
  let remainingWork = SIZE * 8;
  while (current < chain.length - 1) {
    let furthest = current + 1;
    // Merging an existing collinear run preserves every position and heading.
    const delta = chain[furthest]! - chain[current]!;
    while (furthest + 1 < chain.length && chain[furthest + 1]! - chain[furthest]! === delta)
      furthest++;
    for (
      let next = chain.length - 1;
      options.turnCost === 0 && next > furthest && remainingWork > 0;
      next--
    ) {
      let at = chain[current]!;
      const end = chain[next]!,
        ex = end % WIDTH,
        ey = Math.floor(end / WIDTH);
      let candidateCost = 0,
        candidateSteps = 0,
        legal = true;
      let requiredClearance = Infinity;
      for (let i = current; i <= next; i++) {
        if (remainingWork-- <= 0) {
          legal = false;
          break;
        }
        requiredClearance = Math.min(requiredClearance, clearance[chain[i]!]!);
      }
      while (legal && at !== end) {
        if (remainingWork-- <= 0) {
          legal = false;
          break;
        }
        const x = at % WIDTH,
          y = Math.floor(at / WIDTH);
        const nx = x + Math.sign(ex - x) * step,
          ny = y + Math.sign(ey - y) * step;
        const proposed = ny * WIDTH + nx;
        if (!canStep(at, proposed) || clearance[proposed]! < requiredClearance) {
          legal = false;
          break;
        }
        candidateSteps++;
        if (candidateSteps > next - current) {
          legal = false;
          break;
        }
        candidateCost += movementCost(clearance[proposed]!, options);
        if (candidateCost > prefixCost[next]! - prefixCost[current]! + 1e-9) {
          legal = false;
          break;
        }
        at = proposed;
      }
      if (legal) {
        furthest = next;
        break;
      }
    }
    const end = chain[furthest]!,
      ex = end % WIDTH,
      ey = Math.floor(end / WIDTH);
    let at = chain[current]!;
    while (at !== end) {
      const x = at % WIDTH,
        y = Math.floor(at / WIDTH);
      const dx = Math.sign(ex - x),
        dy = Math.sign(ey - y);
      const direction = NAVIGATION_DIRECTIONS.findIndex(([cx, cy]) => dx === cx && dy === cy);
      at = (y + dy * step) * WIDTH + x + dx * step;
      const value = clearance[at]!;
      cost +=
        movementCost(value, options) +
        (previousDirection >= 0 && previousDirection !== direction ? options.turnCost : 0);
      previousDirection = direction;
      sumClearance += value;
      minimumClearance = Math.min(minimumClearance, value);
      steps++;
    }
    waypoints.push({ x: ex, y: ey });
    current = furthest;
  }
  return {
    waypoints,
    steps,
    cost,
    minimumClearance: steps ? minimumClearance : 0,
    meanClearance: steps ? sumClearance / steps : 0,
  };
}
