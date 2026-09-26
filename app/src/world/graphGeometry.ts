/**
 * The world graph's geometry: node boxes, edge paths that fan out when two
 * edges share a pair of rooms and stop at the node borders, and the words
 * each node and edge carries. Pure, so WorldGraph.vue only draws it.
 */
import type { RoomGraphEdge, RoomGraphNode } from "../../../src/agent/roomMap.ts";

export const NODE_W = 128;
/** Picture area height; the caption strip sits below it inside the node. */
export const IMG_H = 96;
export const CAP_H = 22;
export const NODE_H = IMG_H + CAP_H;

// Two edges on one node pair (walked both ways, or a walked side plus a
// planned exit name) would draw as identical overlapping lines. Siblings fan
// out into parallel quadratic curves so each keeps its own line, arrow and
// label position.

export interface EdgeGeom {
  readonly edge: RoomGraphEdge;
  /** Path data for the line/curve; self-loops carry their own arc. */
  readonly d: string;
  readonly lx: number;
  readonly ly: number;
  /** False when a same-direction sibling already renders this label text. */
  readonly showLabel: boolean;
}

export function edgeGeometry(
  edges: readonly RoomGraphEdge[],
  posOf: (room: number) => { x: number; y: number },
): EdgeGeom[] {
  const totals = new Map<string, number>();
  for (const e of edges) {
    const k = `${Math.min(e.from, e.to)}|${Math.max(e.from, e.to)}`;
    totals.set(k, (totals.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  // A label renders once per directed pair: an observed "right" and a static
  // "right" are the same fact — the earlier (higher-priority) edge keeps it.
  const drawnLabels = new Set<string>();
  return edges.map((edge) => {
    const a = posOf(edge.from);
    const b = posOf(edge.to);
    const x1 = a.x + NODE_W / 2;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x + NODE_W / 2;
    const y2 = b.y + NODE_H / 2;
    const labelKey = `${edge.from}|${edge.to}|${edge.label ?? ""}`;
    const showLabel = edge.label !== undefined && !drawnLabels.has(labelKey);
    if (showLabel) drawnLabels.add(labelKey);
    if (edge.from === edge.to) {
      return {
        edge,
        d: `M ${x1} ${a.y} a 26 18 0 1 1 0.1 0`,
        lx: x1,
        ly: a.y - 22,
        showLabel,
      };
    }
    const k = `${Math.min(edge.from, edge.to)}|${Math.max(edge.from, edge.to)}`;
    const n = totals.get(k)!;
    const i = seen.get(k) ?? 0;
    seen.set(k, i + 1);
    const offset = n === 1 ? 0 : (i - (n - 1) / 2) * 34;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    // The fan-out perpendicular must come from the canonical pair direction
    // (low→high room), not this edge's own direction: a reversed edge's
    // perpendicular flips, which would collapse both siblings onto the same
    // curve and the same label spot.
    const lo = posOf(Math.min(edge.from, edge.to));
    const hi = posOf(Math.max(edge.from, edge.to));
    const clen = Math.hypot(hi.x - lo.x, hi.y - lo.y) || 1;
    const px = (-(hi.y - lo.y) / clen) * offset;
    const py = ((hi.x - lo.x) / clen) * offset;
    const cx = mx + px * 2;
    const cy = my + py * 2;
    // Trim both ends to the node borders: the path must end at the target
    // rect's edge, not its centre, or the node paints over the arrowhead.
    const sd = norm(offset === 0 ? x2 - x1 : cx - x1, offset === 0 ? y2 - y1 : cy - y1);
    const ed = norm(offset === 0 ? x2 - x1 : x2 - cx, offset === 0 ? y2 - y1 : y2 - cy);
    const sx = x1 + sd.x * edgeInset(sd);
    const sy = y1 + sd.y * edgeInset(sd);
    const ex = x2 - ed.x * edgeInset(ed);
    const ey = y2 - ed.y * edgeInset(ed);
    // Labels anchor at the midpoint — which distinct pairs can share (a long
    // edge's midpoint lands on a local pair's). A deterministic per-pair
    // jitter along the edge axis separates those.
    let h = 0;
    for (let c = 0; c < k.length; c++) h = (h * 31 + k.charCodeAt(c)) | 0;
    const jitter = ((Math.abs(h) % 5) - 2) * 14;
    return {
      edge,
      d: offset === 0 ? `M ${sx} ${sy} L ${ex} ${ey}` : `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`,
      lx: mx + px + ((hi.x - lo.x) / clen) * jitter,
      ly: my + py - 6 + ((hi.y - lo.y) / clen) * jitter,
      showLabel,
    };
  });
}

/** Unit-length direction. */
function norm(x: number, y: number): { x: number; y: number } {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

/** Centre-to-border distance of a node rect along a unit direction, plus a
 * small gap so the arrowhead clears the node. */
function edgeInset(dir: { x: number; y: number }): number {
  const tx = dir.x === 0 ? Infinity : (NODE_W / 2 + 4) / Math.abs(dir.x);
  const ty = dir.y === 0 ? Infinity : (NODE_H / 2 + 4) / Math.abs(dir.y);
  return Math.min(tx, ty);
}

/** What an edge label means, spelled out — the graph shows only the word. */
export function edgeTooltip(edge: RoomGraphEdge): string {
  if (edge.provenance === "observed")
    return edge.label ? `walked off the ${edge.label} edge` : "walked";
  if (edge.provenance === "planned") return edge.label ? `planned exit “${edge.label}”` : "planned";
  return edge.label ? `logic exits off the ${edge.label} edge` : "named in logic";
}

/** One-line caption: the room number, plus a truncated title when it has one. */
export function nodeLabel(node: RoomGraphNode): string {
  const name = `Room ${node.room}`;
  if (!node.title) return name;
  const budget = 19 - name.length;
  if (budget < 3) return name;
  const title = node.title.length > budget ? `${node.title.slice(0, budget)}…` : node.title;
  return `${name} — ${title}`;
}
