import assert from "node:assert/strict";
import { test } from "node:test";
import { SoundClock } from "../src/soundClock.ts";

test("sound time advances at 60Hz independently of interpreter callback cadence", () => {
  const clock = new SoundClock(0);
  assert.equal(clock.advance(10), 0);
  assert.equal(clock.advance(20), 1);
  assert.equal(clock.advance(100), 5);
  assert.equal(clock.advance(1000), 54);
});

test("a delayed host wait catches up every elapsed sound tick without double counting", () => {
  const clock = new SoundClock(20);
  assert.equal(clock.advance(1020), 60);
  assert.equal(clock.advance(1020), 0);
  assert.equal(clock.advance(1520), 30);
});

test("intentional authoring pauses discard elapsed time and retain the fractional tick", () => {
  const clock = new SoundClock(0);
  assert.equal(clock.advance(10), 0);
  assert.equal(clock.advance(5010, true), 0);
  assert.equal(clock.advance(5020), 1);
  assert.equal(clock.advance(5030), 0);
});

test("reboot resets sound timing and fractional ticks", () => {
  const clock = new SoundClock(0);
  clock.advance(10);
  clock.reset(1000);
  assert.equal(clock.advance(1010), 0);
  assert.equal(clock.advance(1020), 1);
});
