import assert from "node:assert/strict";
import { test } from "node:test";
import { useNodeDrag } from "../src/world/useNodeDrag.ts";

test("a room drag belongs to its pointer and cancellation restores its original position", () => {
  const previews: number[][] = [];
  const writes: number[][] = [];
  const restored: number[][] = [];
  const drag = useNodeDrag({
    map: {
      previewNode: (...point) => previews.push(point),
      moveNode: (...point) => writes.push(point),
    },
    cancelPreview: (...point) => restored.push(point),
    positionOf: () => ({ x: 10, y: 20 }),
    takeViewport: () => {},
    select: () => {},
  });
  const event = (pointerId: number, clientX = 10, clientY = 20) =>
    ({
      pointerId,
      clientX,
      clientY,
      button: 0,
      buttons: 1,
      currentTarget: {
        setPointerCapture: () => {},
        ownerSVGElement: { createSVGPoint: () => ({ x: 0, y: 0 }), getScreenCTM: () => null },
      },
    }) as unknown as PointerEvent;
  drag.onNodePointerDown(event(1), 4);
  drag.onNodePointerMove(event(1, 30, 40));
  assert.deepEqual(previews, [[4, 30, 40]]);
  drag.onNodePointerDown(event(2), 4);
  drag.onNodePointerMove(event(2, 80, 90));
  drag.onNodePointerUp(event(2), 4);
  assert.deepEqual(previews, [[4, 30, 40]], "another finger cannot replace the active move");
  assert.equal(writes.length, 0);
  drag.onNodePointerCancel(event(2));
  assert.equal(restored.length, 0);
  drag.onNodePointerCancel(event(1));
  drag.onNodePointerUp(event(1), 4);
  assert.deepEqual(restored, [[4, 10, 20]]);
  assert.equal(writes.length, 0, "capture loss never saves a position");
  drag.onNodePointerDown(event(1), 4);
  drag.onNodePointerMove(event(1, 50, 60));
  drag.onNodePointerUp(event(1, 50, 60), 4);
  assert.deepEqual(writes, [[4, 50, 60]], "the next drag works");
});
