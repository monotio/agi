import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectProfile, type ProfileId } from "../src/runtime/profile.ts";
import { renderSoundPreview } from "../src/sound/preview.ts";

interface TestNote {
  duration: number;
  divisor: number;
  attenuation: number;
}

function sound(channels: readonly (readonly TestNote[])[]): Uint8Array {
  const encoded: number[][] = [];
  for (let channel = 0; channel < 4; channel++) {
    const bytes: number[] = [];
    for (const note of channels[channel] ?? []) {
      bytes.push(note.duration & 255, (note.duration >> 8) & 255);
      bytes.push(
        channel === 3 ? note.divisor & 15 : (note.divisor >> 4) & 0x3f,
        0x80 | (channel << 5) | (note.divisor & 15),
        0x90 | (channel << 5) | (note.attenuation & 15),
      );
    }
    bytes.push(255, 255);
    encoded.push(bytes);
  }
  const header: number[] = [];
  let offset = 8;
  for (const bytes of encoded) {
    header.push(offset & 255, offset >> 8);
    offset += bytes.length;
  }
  return Uint8Array.from([...header, ...encoded.flat()]);
}

function profile(id: ProfileId = "2.936") {
  return detectProfile(new Map(), id);
}

function pcm(wav: Uint8Array): Int16Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const samples = new Int16Array((wav.length - 44) / 2);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = view.getInt16(44 + index * 2, true);
  }
  return samples;
}

function energy(samples: Int16Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

function average(samples: Int16Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample;
  return samples.length ? sum / samples.length : 0;
}

describe("offline AGI sound preview", () => {
  it("writes an exact mono PCM16 RIFF header and matching data length", () => {
    const preview = renderSoundPreview(
      sound([[{ duration: 60, divisor: 226, attenuation: 0 }]]),
      profile(),
    );
    const view = new DataView(preview.wav.buffer, preview.wav.byteOffset, preview.wav.byteLength);
    assert.equal(new TextDecoder().decode(preview.wav.subarray(0, 4)), "RIFF");
    assert.equal(view.getUint32(4, true), preview.wav.length - 8);
    assert.equal(new TextDecoder().decode(preview.wav.subarray(8, 12)), "WAVE");
    assert.equal(new TextDecoder().decode(preview.wav.subarray(12, 16)), "fmt ");
    assert.equal(view.getUint32(16, true), 16);
    assert.equal(view.getUint16(20, true), 1);
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint32(24, true), 24000);
    assert.equal(view.getUint32(28, true), 48000);
    assert.equal(view.getUint16(32, true), 2);
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(new TextDecoder().decode(preview.wav.subarray(36, 40)), "data");
    assert.equal(view.getUint32(40, true), 48000);
    assert.equal(preview.wav.length, 48044);
    assert.equal(preview.durationSeconds, 1);
    assert.equal(preview.totalDurationSeconds, 1);
    assert.equal(preview.truncated, false);
  });

  it("renders rests as signed zero and treats raw duration zero as 65536 ticks", () => {
    const silent = renderSoundPreview(
      sound([[{ duration: 60, divisor: 0, attenuation: 15 }]]),
      profile(),
    );
    assert.ok(pcm(silent.wav).every((sample) => sample === 0));

    const long = renderSoundPreview(
      sound([[{ duration: 0, divisor: 226, attenuation: 0 }]]),
      profile(),
      { durationSeconds: 0.05 },
    );
    assert.equal(long.wav.length, 44 + 1200 * 2);
    assert.equal(long.totalDurationSeconds, 65536 / 60);
    assert.equal(long.truncated, true);
    assert.ok(energy(pcm(long.wav)) > 1000);
  });

  it("produces a deterministic, centered square tone at the PIT-derived frequency", () => {
    const payload = sound([[{ duration: 60, divisor: 226, attenuation: 0 }]]);
    const first = renderSoundPreview(payload, profile());
    const second = renderSoundPreview(payload, profile());
    assert.deepEqual(first.wav, second.wav);
    const samples = pcm(first.wav);
    let transitions = 0;
    let sum = 0;
    for (let index = 1; index < samples.length; index++) {
      if (samples[index - 1]! < 0 !== samples[index]! < 0) transitions++;
      sum += samples[index]!;
    }
    assert.ok(Math.abs(transitions / 2 - 440) < 2);
    assert.ok(energy(samples) > 1500);
    assert.ok(Math.abs(sum / samples.length) < 100);
    assert.ok(samples.every((sample) => Math.abs(sample) < 32767));
  });

  it("renders deterministic audible and distinct periodic and white noise", () => {
    const periodic = renderSoundPreview(
      sound([[], [], [], [{ duration: 30, divisor: 0, attenuation: 0 }]]),
      profile(),
    );
    const white = renderSoundPreview(
      sound([[], [], [], [{ duration: 30, divisor: 4, attenuation: 0 }]]),
      profile(),
    );
    const periodicPcm = pcm(periodic.wav);
    const whitePcm = pcm(white.wav);
    assert.ok(energy(periodicPcm) > 1000);
    assert.ok(energy(whitePcm) > 1000);
    assert.ok(Math.abs(average(periodicPcm)) < 100);
    assert.ok(Math.abs(average(whitePcm)) < 100);
    assert.notDeepEqual(periodic.wav, white.wav);
    assert.deepEqual(
      white.wav,
      renderSoundPreview(
        sound([[], [], [], [{ duration: 30, divisor: 4, attenuation: 0 }]]),
        profile(),
      ).wav,
    );

    const loud = pcm(
      renderSoundPreview(
        sound([
          [{ duration: 30, divisor: 226, attenuation: 0 }],
          [{ duration: 30, divisor: 380, attenuation: 0 }],
          [{ duration: 30, divisor: 500, attenuation: 0 }],
          [{ duration: 30, divisor: 4, attenuation: 0 }],
        ]),
        profile(),
      ).wav,
    );
    assert.ok(loud.every((sample) => Math.abs(sample) < 32767));
  });

  it("caps long preview windows and sanitizes unbounded option values", () => {
    const payload = sound([[{ duration: 0, divisor: 226, attenuation: 0 }]]);
    const capped = renderSoundPreview(payload, profile(), {
      startSeconds: Number.POSITIVE_INFINITY,
      durationSeconds: 999,
    });
    assert.equal(capped.startSeconds, 0);
    assert.equal(capped.durationSeconds, 30);
    assert.equal(capped.wav.length, 44 + 30 * 24000 * 2);
    assert.equal(capped.truncated, true);
    assert.ok(capped.warnings.some((warning) => /startSeconds.*finite/i.test(warning)));
    assert.ok(capped.warnings.some((warning) => /durationSeconds.*30/i.test(warning)));

    const emptyWindow = renderSoundPreview(payload, profile(), {
      startSeconds: 999,
      durationSeconds: 0,
    });
    assert.equal(emptyWindow.startSeconds, 300);
    assert.equal(emptyWindow.durationSeconds, 0);
    assert.equal(emptyWindow.wav.length, 44);
    assert.ok(emptyWindow.warnings.some((warning) => /startSeconds.*300/i.test(warning)));
  });

  it("pre-rolls playback and oscillator state before rendering an offset", () => {
    const payload = sound([
      [
        { duration: 30, divisor: 226, attenuation: 1 },
        { duration: 30, divisor: 380, attenuation: 3 },
      ],
    ]);
    const full = renderSoundPreview(payload, profile());
    const offset = renderSoundPreview(payload, profile(), {
      startSeconds: 0.625,
      durationSeconds: 0.25,
    });
    assert.equal(offset.startSeconds, 0.625);
    assert.equal(offset.durationSeconds, 0.25);
    assert.equal(offset.truncated, true);
    assert.deepEqual(offset.wav.subarray(44), full.wav.subarray(44 + 15000 * 2, 44 + 21000 * 2));
  });

  it("honors device voice count and profile-generated attenuation commands", () => {
    const payload = sound([
      [{ duration: 60, divisor: 0, attenuation: 15 }],
      [{ duration: 60, divisor: 226, attenuation: 4 }],
    ]);
    const speaker = renderSoundPreview(payload, profile(), { device: "pc-speaker" });
    const common = renderSoundPreview(payload, profile(), { device: "tandy" });
    const early = renderSoundPreview(payload, profile("2.440"), { device: "tandy" });
    assert.equal(energy(pcm(speaker.wav)), 0, "speaker preview uses only channel zero");
    assert.ok(energy(pcm(common.wav).subarray(0, 400)) > energy(pcm(early.wav)) * 1.3);
    assert.notDeepEqual(common.wav, early.wav);
  });
});
