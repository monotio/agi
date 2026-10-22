import assert from "node:assert/strict";
import { test } from "node:test";
import { frameTask } from "../src/ui/frameTask.ts";

test("a gesture applies its latest position once per frame and flushes its final position", () => {
  let callback: FrameRequestCallback | undefined;
  let requests = 0;
  const task = frameTask(
    (next) => {
      callback = next;
      return ++requests;
    },
    () => {
      callback = undefined;
    },
  );
  const positions: number[] = [];
  task.schedule(() => positions.push(1));
  task.schedule(() => positions.push(2));
  assert.equal(requests, 1);
  assert.equal(positions.length, 0);
  callback!(0);
  assert.deepEqual(positions, [2]);
  task.schedule(() => positions.push(3));
  task.flush();
  assert.deepEqual(positions, [2, 3]);
  task.schedule(() => positions.push(4));
  task.cancel();
  assert.equal(callback, undefined);
  assert.deepEqual(positions, [2, 3]);
});

test("live previews publish at most every 150 ms and include the settled value", async (t) => {
  const { throttleTask } = await import("../src/ui/frameTask.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const task = throttleTask(150);
  const posts: number[] = [];
  task.schedule(() => posts.push(1));
  now = 20;
  task.schedule(() => posts.push(2));
  now = 40;
  task.schedule(() => posts.push(3));
  t.mock.timers.tick(0);
  assert.deepEqual(posts, [1]);
  now = 150;
  t.mock.timers.tick(130);
  assert.deepEqual(posts, [1, 3]);
  now = 170;
  task.schedule(() => posts.push(4));
  task.cancel();
  now = 300;
  t.mock.timers.tick(150);
  assert.deepEqual(posts, [1, 3]);
});

test("a stopped preview restarts immediately", async (t) => {
  const { throttleTask } = await import("../src/ui/frameTask.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => 0);
  const task = throttleTask(150);
  let posts = 0;
  task.schedule(() => posts++);
  task.reset();
  task.schedule(() => posts++);
  assert.equal(posts, 2);
});

test("captured gestures ignore other pointers and discard queued work when the handle disappears", async () => {
  const { pointerFrame } = await import("../src/ui/frameTask.ts");
  let callback: FrameRequestCallback | undefined;
  let cancelled = 0;
  const task = pointerFrame(
    () => cancelled++,
    (next) => {
      callback = next;
      return 1;
    },
    () => {
      callback = undefined;
    },
  );
  const captures = new Set<number>();
  const target = {
    setPointerCapture: (id: number) => captures.add(id),
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => captures.delete(id),
  };
  const event = (pointerId: number) =>
    ({ pointerId, currentTarget: target }) as unknown as PointerEvent;
  let position = 0;
  assert.equal(task.begin(event(1)), true);
  assert.equal(task.begin(event(2)), false);
  task.schedule(event(1), () => (position = 1));
  task.schedule(event(2), () => (position = 2));
  task.cancel(event(2));
  callback!(0);
  assert.equal(position, 1);
  task.schedule(event(1), () => (position = 3));
  task.cancel();
  assert.equal(cancelled, 1);
  assert.equal(callback, undefined);
  assert.equal(captures.size, 0);
  assert.equal(task.begin(event(2)), true);
  task.schedule(event(2), () => (position = 4));
  task.finish(event(2));
  assert.equal(position, 4);
});
