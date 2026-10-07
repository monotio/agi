import assert from "node:assert/strict";
import { test } from "node:test";
import {
  QUIET_LABEL_ZOOM,
  edgeGeometry,
  edgeLabelShown,
  nodeLabel,
} from "../src/world/graphGeometry.ts";
import type { RoomGraphEdge, RoomGraphNode } from "../../src/agent/roomMap.ts";

/** The caption strip is one line inside the node; 18 characters fill it. */
const FITS = 18;

const node = (room: number, title?: string): RoomGraphNode =>
  ({ room, ...(title === undefined ? {} : { title }) }) as RoomGraphNode;

test("a node caption names the room and never overflows the node, ellipsis included", () => {
  assert.equal(nodeLabel(node(4)), "Room 4");
  assert.equal(nodeLabel(node(3, "The Vault")), "The Vault · Room 3");
  for (const [room, title] of [
    [1, "Picture Gallery"],
    [1, "Picture Gallery of the Old Masters"],
    [140, "Inside the Great Hall of the Castle"],
    [12, "The Hall   with trailing space"],
  ] as const) {
    const label = nodeLabel(node(room, title));
    assert.ok(label.length <= FITS, `"${label}" is ${label.length} characters`);
    assert.ok(label.endsWith(` · Room ${room}`), label);
  }
  assert.equal(nodeLabel(node(1, "Picture Gallery of the Old Masters")), "Picture… · Room 1");
  // The cut never leaves a space before the ellipsis.
  assert.ok(!/\s…$/.test(nodeLabel(node(12, "The Hall   with trailing space"))));
});

test("exit words hide below the quiet zoom except on edges touching a room in view", () => {
  const geom = (from: number, to: number, showLabel = true) => ({
    edge: { from, to, label: "left", provenance: "static" } as RoomGraphEdge,
    showLabel,
  });
  const none = new Set<number>();
  // At or above the threshold every labelled edge shows.
  assert.equal(edgeLabelShown(geom(1, 2), 1, none), true);
  assert.equal(edgeLabelShown(geom(1, 2), QUIET_LABEL_ZOOM, none), true);
  // Below it, only edges touching a selected, hovered or focused room.
  const low = QUIET_LABEL_ZOOM - 0.01;
  assert.equal(edgeLabelShown(geom(1, 2), low, none), false);
  assert.equal(edgeLabelShown(geom(1, 2), 0.15, new Set([3])), false);
  assert.equal(edgeLabelShown(geom(1, 2), 0.15, new Set([1])), true);
  assert.equal(edgeLabelShown(geom(3, 2), 0.15, new Set([2])), true);
  // A label the geometry already folded into a sibling never shows.
  assert.equal(edgeLabelShown(geom(1, 2, false), 1, new Set([1])), false);
});

test("opposite exits between one pair of rooms keep their words apart at 100% and 80%", () => {
  // Rooms one layout cell apart (useRoomMap's CELL_W 220, CELL_H 190), stacked
  // and side by side; each pair has an exit both ways.
  const at: Record<number, { x: number; y: number }> = {
    1: { x: 0, y: 190 },
    16: { x: 0, y: 0 },
    2: { x: 220, y: 190 },
  };
  const edge = (from: number, to: number, label: string) =>
    ({ from, to, label, provenance: "static" }) as RoomGraphEdge;
  const geoms = edgeGeometry(
    [edge(1, 16, "top"), edge(16, 1, "bottom"), edge(1, 2, "right"), edge(2, 1, "left")],
    (room) => at[room]!,
  );
  // An exit word's box on screen: 11 px type (about 6.5 px a character, bold)
  // with its 4 px halo, drawn at a constant screen size, so in world units it
  // grows as the zoom falls. The text's middle sits 4 px above its baseline.
  const box = (i: number, zoom: number) => {
    const g = geoms[i]!;
    const w = (g.edge.label!.length * 6.5 + 4) / zoom;
    const h = 15 / zoom;
    return {
      x0: g.lx - w / 2,
      x1: g.lx + w / 2,
      y0: g.ly - 4 / zoom - h / 2,
      y1: g.ly - 4 / zoom + h / 2,
    };
  };
  const overlap = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  for (const zoom of [1, 0.8]) {
    assert.ok(!overlap(box(0, zoom), box(1, zoom)), `top/bottom overlap at ${zoom * 100}%`);
    assert.ok(!overlap(box(2, zoom), box(3, zoom)), `right/left overlap at ${zoom * 100}%`);
  }
  // Each word sits on its own side: nearer the room it leaves than the one it enters.
  for (const g of geoms) {
    const from = at[g.edge.from]!;
    const to = at[g.edge.to]!;
    const d = (p: { x: number; y: number }) => Math.hypot(g.lx - p.x - 64, g.ly - p.y - 59);
    assert.ok(d(from) < d(to), `${g.edge.label} sits nearer room ${g.edge.from}`);
  }
});

test("node captions resolve the same inferred room titles as other game surfaces", () => {
  assert.equal(
    nodeLabel({ room: 7 } as RoomGraphNode, { rooms: [{ room: 7, title: "Atrium" }] }),
    "Atrium · Room 7",
  );
});
