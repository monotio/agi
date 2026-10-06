import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PsgNoise, PsgNoiseClock, type PsgChip } from "../src/sound/psgNoise.ts";
import { PSG_BASE_FREQ, SoundPlayback } from "../src/sound/sound.ts";
import { PROFILES } from "../src/runtime/profile.ts";

function bits(chip: PsgChip, control: number, count: number): number[] {
  const noise = new PsgNoise(chip);
  noise.write(control);
  const result = [noise.output];
  while (result.length < count) result.push(noise.shift());
  return result;
}

describe("PSG noise bits", () => {
  // Index 0 is the held output at reset. TI feedback is b[n-15] XOR b[n-14].
  // The 76496 has two output stages: its seed arrives at index 16, then 30,31,
  // 44,46. The original 76489 has no output stages, so these arrive two earlier.
  for (const [chip, ones] of [
    ["sn76489", [14, 28, 29, 42, 44]],
    ["sn76496", [16, 30, 31, 44, 46]],
  ] as const) {
    it(`${chip} white feedback has the hand-computed first 48 bits`, () => {
      const expected = Array.from({ length: 48 }, (_, n) =>
        (ones as readonly number[]).includes(n) ? 1 : 0,
      );
      // The original 76489 negates the output voltage.
      assert.deepEqual(
        bits(chip, 4, 48),
        expected.map((bit) => (chip === "sn76489" && bit !== 0 ? -bit : bit)),
      );
    });
  }
  // NCR: b[n] = 1 XOR b[n-15] XOR b[n-11]. Seed at 15; 16..25 are 1;
  // 26..29 are 0; 30..36 are 1; 37..44 are 0; 45..47 are 1.
  for (const chip of ["ncr8496", "pssj3"] as const) {
    it(`${chip} white XNOR has the hand-computed first 48 bits`, () => {
      const ones = [
        15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47,
      ];
      assert.deepEqual(
        bits(chip, 4, 48),
        Array.from({ length: 48 }, (_, n) =>
          ones.includes(n) ? (chip === "ncr8496" ? -1 : 1) : 0,
        ),
      );
    });
  }
  for (const [chip, first, sign] of [
    ["sn76489", 14, -1],
    ["sn76496", 16, 1],
    ["ncr8496", 15, -1],
    ["pssj3", 15, 1],
  ] as const) {
    for (const rate of [0, 1, 2, 3]) {
      it(`${chip} periodic mode, rate ${rate}, circulates a single bit every 15 shifts`, () => {
        assert.deepEqual(
          bits(chip, rate, 64),
          Array.from({ length: 64 }, (_, n) => (n >= first && (n - first) % 15 === 0 ? sign : 0)),
        );
      });
    }
    it(`${chip} resets on the chip's noise writes`, () => {
      const noise = new PsgNoise(chip);
      noise.write(4);
      for (let n = 0; n < first; n++) noise.shift();
      assert.equal(noise.output, sign);
      noise.write(4);
      // Register reset leaves the output flip-flop held until the next shift.
      assert.equal(noise.output, sign);
      assert.equal(noise.shift(), chip === "sn76489" || chip === "sn76496" ? 0 : sign);
      noise.write(5); // Rate-only write has the same variant-specific reset rule.
      assert.equal(noise.shift(), chip === "sn76489" || chip === "sn76496" ? 0 : sign);
      noise.write(1); // White to periodic resets all variants.
      assert.equal(noise.shift(), 0);
      noise.write(4); // Periodic to white also resets all variants.
      assert.equal(noise.shift(), 0);
    });
  }
});

describe("PSG noise clock", () => {
  it("uses clock/512, /1024, /2048 and tone-2's complete period", () => {
    const clock = new PsgNoiseClock("ncr8496", 0);
    for (const rate of [0, 1, 2]) {
      clock.write(rate, 0);
      assert.equal(clock.shiftHz, (PSG_BASE_FREQ * 32) / (512 << rate));
    }
    clock.write(3, 0);
    clock.tone2(100, 0);
    assert.equal(clock.shiftHz, (PSG_BASE_FREQ * 32) / 3200);
    clock.tone2(200, 0);
    assert.equal(clock.shiftHz, (PSG_BASE_FREQ * 32) / 6400);
    clock.tone2(0, 0);
    assert.equal(clock.shiftHz, (PSG_BASE_FREQ * 32) / (32 * 1024));
  });
  it("rate changes retain the pending shift and apply the new period after it", () => {
    const clock = new PsgNoiseClock("ncr8496", 0);
    const first = 512 / (PSG_BASE_FREQ * 32);
    const change = clock.write(1, first / 2)!;
    assert.equal(change.at, first);
    assert.equal(change.index, 1);
    const next = clock.write(2, first * 1.5)!;
    assert.ok(Math.abs(next.at - 3 * first) < 1e-15);
    assert.equal(next.index, 2);
  });
  it("TI repeats reset the sequence; NCR rate writes keep its shifted position", () => {
    const at = (10.5 * 512) / (PSG_BASE_FREQ * 32);
    assert.equal(new PsgNoiseClock("sn76496", 0).write(0, at)!.index, 1);
    assert.equal(new PsgNoiseClock("ncr8496", 0).write(1, at)!.index, 11);
    assert.equal(new PsgNoiseClock("ncr8496", 0).write(4, at)!.index, 1);
  });
});

it("profiles carry their representative hardware on noise control writes", () => {
  const payload = Uint8Array.of(
    8,
    0,
    10,
    0,
    12,
    0,
    14,
    0,
    255,
    255,
    255,
    255,
    255,
    255,
    2,
    0,
    0,
    0xe4,
    0xf0,
    255,
    255,
  );
  for (const [id, chip] of [
    ["2.001", "sn76496"],
    ["2.089", "sn76496"],
    ["2.230", "sn76496"],
    ["2.272", "sn76496"],
    ["2.411", "sn76496"],
    ["2.440", "sn76496"],
    ["2.917", "ncr8496"],
    ["2.936", "ncr8496"],
    ["3.002.102", "ncr8496"],
  ] as const) {
    const profile = PROFILES[id];
    assert.equal(profile.psgNoise, chip);
    const resource = id === "2.001" ? Uint8Array.of(0xe4, 0) : payload;
    const event = new SoundPlayback(profile, resource, 1)
      .tick(true, 0)
      .outputs.find((event) => event.kind === "psg" && event.bytes[0] === 0xe4);
    assert.ok(event?.kind === "psg");
    assert.equal(event.chip, chip);
  }
});
