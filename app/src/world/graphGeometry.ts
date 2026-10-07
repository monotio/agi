import {
  numberedLabel,
  numberedSlot,
  type NumberedLabelContext,
} from "../../../src/logic/numberedLabels.ts";
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
    // Each exit word sits about a third of the way along its line from the
    // room it leaves, so the two directions of one pair read apart ("top"
    // near one room, "bottom" near the other) at any zoom. Distinct pairs
    // can still share a spot (a long edge crossing a short one); a small
    // deterministic per-pair nudge along the line separates those.
    let h = 0;
    for (let c = 0; c < k.length; c++) h = (h * 31 + k.charCodeAt(c)) | 0;
    const t = 0.3 + ((Math.abs(h) % 5) - 2) * 0.02;
    const u = 1 - t;
    const lx = offset === 0 ? sx + (ex - sx) * t : u * u * sx + 2 * u * t * cx + t * t * ex;
    const ly = offset === 0 ? sy + (ey - sy) * t : u * u * sy + 2 * u * t * cy + t * t * ey;
    return {
      edge,
      d: offset === 0 ? `M ${sx} ${sy} L ${ex} ${ey}` : `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`,
      lx,
      ly: ly - 6,
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

/**
 * Below this zoom exit words go quiet and the arrows alone show the way.
 * Labels keep an 11 px on-screen size while the layout shrinks: at 0.6 the
 * 92-unit gap between neighbouring nodes (CELL_W − NODE_W) is 55 px, room for
 * "bottom" and its halo (about 44 px); at 0.5 the gap is 46 px and words
 * from different pairs run into each other and onto the thumbnails.
 */
export const QUIET_LABEL_ZOOM = 0.6;

/**
 * Whether an edge's exit word renders: always at or above QUIET_LABEL_ZOOM,
 * below it only on edges touching a room the user is looking at (selected,
 * hovered or focused).
 */
export function edgeLabelShown(
  geom: Pick<EdgeGeom, "edge" | "showLabel">,
  zoom: number,
  inView: ReadonlySet<number>,
): boolean {
  if (!geom.showLabel) return false;
  return zoom >= QUIET_LABEL_ZOOM || inView.has(geom.edge.from) || inView.has(geom.edge.to);
}

/** Characters a node caption holds: the node's width at the caption's type size. */
const NODE_LABEL_CHARS = 18;

/**
 * One-line caption that fits the node: "Room 4" alone, or the room number
 * and its title ("The Vault · Room 4"), the title cut with an ellipsis so the
 * whole caption, ellipsis included, stays within NODE_LABEL_CHARS.
 */
export function nodeLabel(node: RoomGraphNode, context: NumberedLabelContext = {}): string {
  const name = numberedLabel("room", node.room, { ...context, name: node.title ?? "" });
  const slot = numberedSlot("room", node.room);
  if (name === slot) return slot;
  const budget = NODE_LABEL_CHARS - slot.length - 3;
  const title = name.length > budget ? `${name.slice(0, budget - 1).trimEnd()}…` : name;
  return numberedLabel("room", node.room, { name: title }, "row");
}
