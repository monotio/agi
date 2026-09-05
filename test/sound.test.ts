import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSound } from "../src/sound/sound.ts";
import { buildSound } from "../src/agent/tools.ts";

describe("sound resource decoder", () => {
  it("rejects invalid payloads with length < 8", () => {
    assert.throws(() => parseSound(new Uint8Array(5)), /invalid sound payload: length 5 < 8/i);
  });

  it("rejects channel offset out of bounds", () => {
    const data = new Uint8Array([0xff, 0x00, 0x08, 0x00, 0x08, 0x00, 0x08, 0x00]);
    assert.throws(() => parseSound(data), /channel offset 255 exceeds payload size/i);
  });

  it("parses empty channels with immediate terminators (0xffff)", () => {
    // 8-byte header + 2-byte terminator (0xffff) for each channel pointing to offset 8
    const data = new Uint8Array([
      8,
      0, // ch 0 -> 8
      8,
      0, // ch 1 -> 8
      8,
      0, // ch 2 -> 8
      8,
      0, // ch 3 -> 8
      0xff,
      0xff, // terminator
    ]);
    const sound = parseSound(data);
    assert.equal(sound.channels.length, 4);
    for (let i = 0; i < 4; i++) {
      assert.equal(sound.channels[i]!.channelIndex, i);
      assert.equal(sound.channels[i]!.notes.length, 0);
      assert.equal(sound.channels[i]!.totalDuration, 0);
    }
    assert.equal(sound.duration, 0);
    assert.equal(sound.durationSeconds, 0);
  });

  it("parses authentic multi-note channels with accurate frequencies and volume", () => {
    // Build a sound with 2 notes in channel 0:
    // Note 1: A4 (divisor 226, freq ~440.0Hz), duration 30 ticks, attenuation 0 (full volume)
    // Note 2: C4 (divisor 380, freq ~261.66Hz), duration 60 ticks, attenuation 2 (~-4dB)
    // Channel 1: rest (divisor 0, attenuation 15), duration 90 ticks
    const binary = buildSound([
      {
        notes: [
          { note: "A4", duration: 30, attenuation: 0 },
          { note: "C4", duration: 60, attenuation: 2 },
        ],
      },
      {
        notes: [{ note: "rest", duration: 90, attenuation: null }],
      },
      { notes: [] },
      { notes: [] },
    ]);

    const sound = parseSound(binary);
    assert.equal(sound.channels.length, 4);

    const ch0 = sound.channels[0]!;
    assert.equal(ch0.notes.length, 2);
    assert.equal(ch0.totalDuration, 90);

    const n1 = ch0.notes[0]!;
    assert.equal(n1.duration, 30);
    assert.equal(n1.freqDivisor, 226);
    // 99431.67 / 226 = 439.963 Hz ~ 440 Hz
    assert.ok(Math.abs(n1.frequency - 440) < 0.2);
    assert.equal(n1.attenuation, 0);
    assert.equal(n1.volume, 1.0);

    const n2 = ch0.notes[1]!;
    assert.equal(n2.duration, 60);
    assert.equal(n2.freqDivisor, 380);
    // 99431.67 / 380 = 261.662 Hz ~ 261.66 Hz
    assert.ok(Math.abs(n2.frequency - 261.66) < 0.2);
    assert.equal(n2.attenuation, 2);
    assert.ok(n2.volume > 0 && n2.volume < 1.0);

    const ch1 = sound.channels[1]!;
    assert.equal(ch1.notes.length, 1);
    const nRest = ch1.notes[0]!;
    assert.equal(nRest.duration, 90);
    assert.equal(nRest.attenuation, 15);
    assert.equal(nRest.volume, 0.0);
    assert.equal(nRest.frequency, 0.0);

    // Total duration is max of channels = 90 ticks = 1.5 seconds at 60 ticks/s
    assert.equal(sound.duration, 90);
    assert.equal(sound.durationSeconds, 1.5);
  });
});
