import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeLabel } from "../src/world/graphGeometry.ts";
import type { RoomGraphNode } from "../../src/agent/roomMap.ts";

/** The caption strip is one line inside the node; 18 characters fill it. */
const FITS = 18;

const node = (room: number, title?: string): RoomGraphNode =>
  ({ room, ...(title === undefined ? {} : { title }) }) as RoomGraphNode;

test("a node caption names the room and never overflows the node, ellipsis included", () => {
  assert.equal(nodeLabel(node(4)), "Room 4");
  assert.equal(nodeLabel(node(3, "The Vault")), "3 · The Vault");
  for (const [room, title] of [
    [1, "Picture Gallery"],
    [1, "Picture Gallery of the Old Masters"],
    [140, "Inside the Great Hall of the Castle"],
    [12, "The Hall   with trailing space"],
  ] as const) {
    const label = nodeLabel(node(room, title));
    assert.ok(label.length <= FITS, `"${label}" is ${label.length} characters`);
    assert.ok(label.startsWith(`${room} · `), label);
  }
  assert.equal(nodeLabel(node(1, "Picture Gallery of the Old Masters")), "1 · Picture Galle…");
  // The cut never leaves a space before the ellipsis.
  assert.ok(!/\s…$/.test(nodeLabel(node(12, "The Hall   with trailing space"))));
});
