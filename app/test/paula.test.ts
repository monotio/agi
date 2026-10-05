import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PaulaClock,
  paulaRcCoefficients,
  paulaCouplingCoefficients,
  PAULA_LED_FILTER,
} from "../src/audio/paula.ts";
import { boundaryMetrics, paulaReference } from "./offlineSpectrogram.ts";

test("boundary measurements detect a filtered level step and retain signed DC", () => {
  const r = Math.exp(-1 / 4.8); // A 0.1 ms exponential rounds the 0.3 level step.
  const samples = Array.from({ length: 4800 }, (_, i) =>
    i < 2400 ? -0.1 : 0.2 - 0.3 * r ** (i - 2400),
  );
  const metrics = boundaryMetrics(samples, 0.05);
  const expectedStep = 0.3 * (1 - (1 - r ** 96) / (96 * (1 - r)));
  assert.ok(Math.abs(metrics.step - expectedStep) < 1e-12);
  assert.ok(Math.abs(metrics.beforeMean + 0.1) < 1e-12);
  assert.ok(Math.abs(metrics.afterMean - (expectedStep - 0.1)) < 1e-12);
  assert.ok(Math.abs(metrics.maxJump - 0.3 * (1 - r)) < 1e-12);
  assert.ok(metrics.maxJump < 0.08 && metrics.step > 0.28);
  assert.ok(metrics.lowEnergy > 0);
  assert.ok(metrics.steadyLowEnergy < 1e-25);
});

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

test("Paula DMA off completes its low byte and holds it while the next activation reloads", () => {
  const clock = new PaulaClock();
  clock.write(3546.895, 2);
  // At 2.0042 byte 4 is high; byte 5 starts at 2.005, then idle at 2.006.
  const held = clock.disable(2.0042)!;
  assert.ok(Math.abs(held.at - 2.006) < 1e-12);
  assert.equal(held.byte, 5);
  assert.equal(clock.disable(2.01), null);
  assert.deepEqual(clock.write(3546.895, 3), { at: 3, byte: 0, restart: true });
});

test("a DMA re-enable before the word ends keeps the current sample phase", () => {
  const clock = new PaulaClock();
  clock.write(3546.895, 2);
  clock.disable(2.0042);
  const next = clock.write(3546.895, 2.0045);
  assert.equal(next.restart, false);
  assert.equal(next.byte, 5);
  assert.ok(Math.abs(next.at - 2.005) < 1e-12);
});

test("DMA cancelled before its first fetch retains the initial zero DAC", () => {
  const clock = new PaulaClock();
  clock.write(3546.895, 2);
  assert.deepEqual(clock.disable(1.99), { at: 1.99, byte: null });
  clock.write(3546.895, 3);
  assert.deepEqual(clock.disable(3), { at: 3, byte: null });
});

test("A500 coupling rejects DC with the schematic's 31.0387 ms decay", () => {
  const { feedforward: b, feedback: a } = paulaCouplingCoefficients(48000);
  // (1000+390)*(22+0.33) uF = 0.0310387 s; K = 2979.7152.
  assert.ok(Math.abs(b[0]! - 2979.7152 / 2980.7152) < 1e-12);
  assert.equal(b[1], -b[0]!);
  assert.ok(Math.abs(a[1]! - (1 - 2979.7152) / 2980.7152) < 1e-12);
  let y = b[0]!;
  for (let i = 1; i <= 1490; i++) y = -a[1]! * y;
  assert.ok(Math.abs(y - Math.exp(-1)) < 0.0003);
});

test("independent DAC reference holds signed bytes and keeps volume on DMA clear", () => {
  const pcm = paulaReference(
    [
      {
        stream: "test",
        tick: 0,
        complete: false,
        outputs: [{ kind: "paula", channel: 0, period: 3546.895, volume: 32 }],
      },
      {
        stream: "test",
        tick: 1,
        complete: true,
        outputs: [{ kind: "paula", channel: 0, period: null, volume: 0 }],
      },
    ],
    48000,
    0.08,
  )[0]!;
  // 1 kHz bytes; start at 2/60 s. At tick 1 the low byte is byte 17,
  // sample[1]=64. Idle holds 64/128 * 32/64 * 0.4 = 0.1.
  assert.equal(pcm[3000], Math.fround(0.1));
  assert.equal(pcm[3500], Math.fround(0.1));
  assert.equal(pcm[1600], 0);
});
