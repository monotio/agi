import assert from "node:assert/strict";
import { test } from "node:test";
import { crtStage, crtFramePoint } from "../src/three/crtAmount.ts";

test("CRT stages ease scanlines, light and glass in order", () => {
  for (const [amount, expected] of [
    [0, [0, 0, 0]],
    [0.15, [0.5, 0, 0]],
    [0.3, [1, 0, 0]],
    [0.5, [1, 0.5, 0]],
    [0.7, [1, 1, 0]],
    [0.85, [1, 1, 0.5]],
    [1, [1, 1, 1]],
  ] as const) {
    const actual = [crtStage(amount, 0, 0.3), crtStage(amount, 0.3, 0.7), crtStage(amount, 0.7, 1)];
    actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]!) < 1e-12));
  }
  assert.equal(crtStage(-1, 0, 0.3), 0);
  assert.equal(crtStage(2, 0.7, 1), 1);
  const epsilon = 1e-5;
  assert.ok(crtStage(epsilon, 0, 0.3) / epsilon < 0.001, "smooth start");
  assert.ok((1 - crtStage(0.3 - epsilon, 0, 0.3)) / epsilon < 0.001, "smooth end");
});

test("screen coordinates sample the same frame point as the glass shader", () => {
  // Screen (0.75, 0.8): centred coords (0.5, 0.6). Full glass scales
  // x by (1 + .6² × .035) × 1.04 × 1.08, y by (1 + .5² × .045) × 1.04 × 1.08.
  for (const amount of [0, 0.5])
    assert.deepEqual(crtFramePoint(0.75, 0.8, amount), { x: 240, y: 160 });
  const full = crtFramePoint(0.75, 0.8, 1)!;
  assert.ok(Math.abs(full.x - 250.9881856) < 1e-8);
  assert.ok(Math.abs(full.y - 168.15016) < 1e-8);
  assert.deepEqual(crtFramePoint(0.5, 0.5, 1), { x: 160, y: 100 });
  assert.equal(crtFramePoint(0, 0, 1), null, "glass border ignores clicks");
});

test("CRT defaults to Full while display fixtures can request a flat default", async () => {
  const { readCrtAmount } = await import("../src/settings/crtPreference.ts");
  const storage = (legacy: string | null = null) => {
    const values: Record<string, string> = legacy === null ? {} : { "monotio_agi.crt": legacy };
    return {
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => {
        values[key] = value;
      },
    };
  };
  assert.equal(readCrtAmount(storage()), 1);
  assert.equal(readCrtAmount(storage(), 0), 0);
  assert.equal(readCrtAmount(storage("on"), 0), 1);
  assert.equal(readCrtAmount(storage("off")), 0);
});
