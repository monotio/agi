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
}

export interface SearchResult {
  status: "found" | "unreachable" | "budget_exhausted";
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
  // Heading is part of identity only when future cost depends on it.
  const headings = options.turnCost > 0 ? 9 : 1;
  const initial = start * headings + headings - 1;
  const costs = new Float64Array(SIZE * headings).fill(Infinity);
  const parents = new Int32Array(SIZE * headings).fill(-1);
  const closed = new Uint8Array(SIZE * headings);
  costs[initial] = 0;
  const open = new OpenSet();
  let order = 0,
    cells = 0,
    best = start;
  open.push({
    state: initial,
    cost: 0,
    estimate: distance(start),
    remaining: distance(start),
    order: order++,
  });
  while (open.size > 0) {
    const entry = open.pop();
    if (closed[entry.state] || entry.cost !== costs[entry.state]) continue;
    if (cells >= options.maxSearchNodes)
      return { status: "budget_exhausted", chain: [], reached: best, cells };
    closed[entry.state] = 1;
    cells++;
    const at = Math.floor(entry.state / headings);
    if (distance(at) < distance(best)) best = at;
    if (distance(at) === 0) {
      const chain: number[] = [];
      for (let state = entry.state; state >= 0; state = parents[state]!)
        chain.push(Math.floor(state / headings));
      return { status: "found", chain: chain.reverse(), reached: at, cells };
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
      const nextState = next * headings + (headings === 1 ? 0 : direction);
      if (closed[nextState]) continue;
      const heading = entry.state % headings;
      const turn = headings > 1 && heading !== 8 && heading !== direction ? options.turnCost : 0;
      const cost = entry.cost + movementCost(clearance[next]!, options) + turn;
      if (cost >= costs[nextState]!) continue;
      costs[nextState] = cost;
      parents[nextState] = entry.state;
      const remaining = distance(next);
      open.push({ state: nextState, cost, estimate: cost + remaining, remaining, order: order++ });
    }
  }
  return { status: "unreachable", chain: [], reached: best, cells };
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
