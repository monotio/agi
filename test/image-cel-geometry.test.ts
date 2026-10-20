import { test } from "node:test";
import assert from "node:assert/strict";
import {
  drawCelRegion,
  moveCelRegion,
  resizeCelRegion,
  orderCelBoxes,
  reorderCelBoxes,
  assignCelLoop,
  lockFrameSizes,
  mergeCelSuggestions,
  type CelBox,
} from "../src/creative/imageCelGeometry.ts";

const sheet = { width: 40, height: 24 };
function box(id: string, x = 0, y = 0): CelBox {
  return {
    id,
    edited: false,
    region: { x, y, width: 6, height: 12 },
    width: 6,
    height: 12,
    loop: 0,
  };
}
test("drawing snaps to pixels and nearby cel sizes, in either direction", () => {
  assert.deepEqual(drawCelRegion({ x: 21.6, y: 0.2 }, { x: 27.2, y: 11.3 }, sheet, [box("a")]), {
    x: 22,
    y: 0,
    width: 6,
    height: 12,
  });
  assert.deepEqual(drawCelRegion({ x: 9.1, y: 15.2 }, { x: -1, y: 2.2 }, sheet, []), {
    x: 0,
    y: 2,
    width: 9,
    height: 13,
  });
  assert.deepEqual(moveCelRegion(box("a").region, 99.2, -3, sheet), {
    x: 34,
    y: 0,
    width: 6,
    height: 12,
  });
});
test("edge and corner resizing keep opposite edges fixed and stay inside the sheet", () => {
  const region = box("a", 10, 6).region;
  assert.deepEqual(resizeCelRegion(region, "nw", 3.2, 2.1, sheet, []), {
    x: 13,
    y: 8,
    width: 3,
    height: 10,
  });
  assert.deepEqual(resizeCelRegion(region, "e", 99, 0, sheet, []), {
    x: 10,
    y: 6,
    width: 30,
    height: 12,
  });
  assert.deepEqual(resizeCelRegion(region, "w", 99, 0, sheet, []), {
    x: 15,
    y: 6,
    width: 1,
    height: 12,
  });
  assert.deepEqual(resizeCelRegion(region, "se", 0.6, -0.7, sheet, [box("b")]), region);
});
test("locked cel size applies to all boxes, keeping each crop inside the sheet", () => {
  const boxes = [box("a"), box("b", 34, 12)];
  const next = lockFrameSizes(boxes, { width: 8, height: 14 }, sheet);
  assert.deepEqual(
    next.map((f) => f.region),
    [
      { x: 0, y: 0, width: 8, height: 14 },
      { x: 32, y: 10, width: 8, height: 14 },
    ],
  );
  assert.deepEqual(
    next.map((f) => [f.width, f.height, f.edited]),
    [
      [8, 14, true],
      [8, 14, true],
    ],
  );
  assert.equal(boxes[1]!.region.x, 34);
});
test("default reading order and explicit reorder retain identities and loop assignments", () => {
  const boxes = [box("c", 0, 12), box("b", 12, 0), box("a")];
  const ordered = orderCelBoxes(boxes);
  assert.deepEqual(
    ordered.map((f) => f.id),
    ["a", "b", "c"],
  );
  const next = reorderCelBoxes(ordered, "c", "a");
  assert.deepEqual(
    next.map((f) => f.id),
    ["c", "a", "b"],
  );
  const painted = assignCelLoop(next, ["c", "b"], 7);
  assert.deepEqual(
    painted.map((f) => f.loop),
    [7, 0, 7],
  );
  assert.deepEqual(
    next.map((f) => f.loop),
    [0, 0, 0],
  );
  assert.throws(() => assignCelLoop(next, ["a"], 8), /loop/i);
});
test("finding cels keeps edited boxes and replaces only untouched suggestions", () => {
  const edited = { ...box("edited", 22), edited: true, loop: 1 };
  const next = mergeCelSuggestions([box("old"), edited], [box("new"), box("overlap", 22)]);
  assert.deepEqual(
    next.map((f) => f.id),
    ["new", "edited"],
  );
  assert.equal(next[1], edited);
  assert.deepEqual(
    mergeCelSuggestions([edited], [box("new")], true).map((f) => f.id),
    ["new"],
  );
});

test("figures with uneven tops keep left-to-right order within each row", () => {
  const boxes = [box("c", 20, 2), box("a", 0, 5), box("b", 10, 3), box("d", 0, 18)];
  assert.deepEqual(
    orderCelBoxes(boxes).map((f) => f.id),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(
    mergeCelSuggestions([], boxes, true).map((f) => f.id),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(
    boxes.map((f) => f.id),
    ["c", "a", "b", "d"],
  );
});

test("found figures share the smallest crop size that contains each figure", async () => {
  const { linkFoundCels } = await import("../src/creative/imageCelGeometry.ts");
  const boxes = [
    { ...box("a"), height: 24 },
    { ...box("b", 10, 4), region: { x: 10, y: 4, width: 8, height: 14 }, height: 24 },
    { ...box("edge", 34, 12), height: 24 },
  ];
  const linked = linkFoundCels(boxes, sheet);
  assert.deepEqual(
    linked.map((f) => f.region),
    [
      { x: 0, y: 0, width: 8, height: 14 },
      { x: 10, y: 4, width: 8, height: 14 },
      { x: 32, y: 10, width: 8, height: 14 },
    ],
  );
  assert.deepEqual(
    linked.map((f) => [f.width, f.height, f.linked, f.edited]),
    [
      [14, 24, true, false],
      [14, 24, true, false],
      [14, 24, true, false],
    ],
  );
  for (const [i, f] of linked.entries()) {
    const figure = boxes[i]!.region;
    assert.ok(f.region.x <= figure.x && f.region.y <= figure.y);
    assert.ok(f.region.x + f.region.width >= figure.x + figure.width);
    assert.ok(f.region.y + f.region.height >= figure.y + figure.height);
  }
  assert.equal(boxes[0]!.region.width, 6);
});
