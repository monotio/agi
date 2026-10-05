import { test } from "node:test";
import assert from "node:assert/strict";
import { PaulaClock, paulaRcCoefficients, PAULA_LED_FILTER } from "../src/audio/paula.ts";

// Hand-computed sample boundaries at a 1000 Hz byte rate.
test("Paula DMA starts at byte zero and held DMA preserves phase through register writes", () => {
  const clock = new PaulaClock();
  assert.deepEqual(clock.write(3546.895, 2), { at: 2, byte: 0, restart: true });
  const next = clock.write(7093.79, 2.0032);
  assert.ok(Math.abs(next.at - 2.004) < 1e-12);
  assert.equal(next.byte, 4);
  assert.equal(next.restart, false);
  const held = clock.write(7093.79, 2.009);
  assert.ok(Math.abs(held.at - 2.01) < 1e-12);
  assert.equal(held.byte, 7);
  clock.disable();
  assert.deepEqual(clock.write(3546.895, 3), { at: 3, byte: 0, restart: true });
});

test("A500 RC coefficients preserve DC and attenuate high frequencies with one pole", () => {
  const { feedforward: b, feedback: a } = paulaRcCoefficients(48000);
  // Bilinear transform of R=360 ohm, C=0.1 uF: K=2*48000*R*C=3.456.
  assert.ok(Math.abs(b[0]! - 1 / 4.456) < 1e-12);
  assert.equal(b[0], b[1]);
  assert.ok(Math.abs(a[1]! - (1 - 3.456) / 4.456) < 1e-12);
  assert.ok(Math.abs((b[0]! + b[1]!) / (1 + a[1]!) - 1) < 1e-12);
  // The nominal Sallen-Key pole is 3091 Hz, with Q about 0.6602.
  assert.ok(Math.abs(PAULA_LED_FILTER.frequency - 3091) < 1);
  assert.ok(Math.abs(PAULA_LED_FILTER.q - 0.6602) < 0.0001);
});
