import assert from "node:assert/strict";
import { test } from "node:test";
import { CycleClock, TIMER_INCREMENT_MS } from "../src/runtime/cycleClock.ts";

test("v10 waits for the specified number of 50ms timer increments", () => {
  assert.equal(TIMER_INCREMENT_MS, 50);
  for (const delay of [1, 2, 4, 255]) {
    const clock = new CycleClock(0);
    assert.equal(clock.poll(delay * 50 - 0.1, delay), false);
    assert.equal(clock.poll(delay * 50, delay), true);
    assert.equal(clock.poll(delay * 50, delay), false);
    assert.equal(clock.poll(delay * 100, delay), true);
  }
});

test("fractional timer phase survives polling jitter while the pacing counter clears", () => {
  const clock = new CycleClock(0);
  assert.equal(clock.poll(16, 2), false);
  assert.equal(clock.poll(99, 2), false);
  assert.equal(clock.poll(112, 2), true);
  assert.equal(clock.poll(199, 2), false);
  assert.equal(clock.poll(200, 2), true);
  assert.equal(clock.poll(299, 2), false);
  assert.equal(clock.poll(301, 2), true);
});

test("late callbacks produce one cycle and clear surplus pacing increments", () => {
  const clock = new CycleClock(0);
  assert.equal(clock.poll(1000, 2), true);
  assert.equal(clock.poll(1000, 2), false);
  assert.equal(clock.poll(1050, 2), false);
  assert.equal(clock.poll(1100, 2), true);
});

test("authoring pauses and reset discard elapsed pacing without catch-up", () => {
  const clock = new CycleClock(0);
  assert.equal(clock.poll(75, 2), false);
  assert.equal(clock.poll(80, 2, true), false);
  assert.equal(clock.poll(10000, 2, true), false);
  assert.equal(clock.poll(10020, 2), false);
  assert.equal(clock.poll(10119, 2), false);
  assert.equal(clock.poll(10120, 2), true);
  clock.reset(20000);
  assert.equal(clock.poll(20099, 2), false);
  assert.equal(clock.poll(20100, 2), true);
});

test("delay zero adds no pacing wait and changing delay uses the current accumulated counter", () => {
  const clock = new CycleClock(0);
  assert.equal(clock.poll(0, 0), true);
  assert.equal(clock.poll(50, 4), false);
  assert.equal(clock.poll(99, 4), false);
  assert.equal(clock.poll(100, 2), true);
  assert.equal(clock.poll(100, 0, true), false);
});

test("invalid clocks and delays fail early; backward observations cannot manufacture timer increments", () => {
  assert.throws(() => new CycleClock(NaN), /finite/);
  const clock = new CycleClock(100);
  assert.equal(clock.poll(90, 1), false);
  assert.equal(clock.poll(140, 1), false);
  assert.equal(clock.poll(150, 1), true);
  for (const delay of [-1, 1.5, 256, NaN]) assert.throws(() => clock.poll(200, delay), /delay/);
  assert.throws(() => clock.poll(Infinity, 1), /finite/);
});
