import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { booterSoundRows, SoundPlayback } from "../src/sound/sound.ts";
import { buildSound } from "../src/agent/tools.ts";
import { detectProfile, type ProfileId } from "../src/runtime/profile.ts";

function payload(duration = 2, control = 0x94): Uint8Array {
  return Uint8Array.of(
    8,
    0,
    15,
    0,
    15,
    0,
    15,
    0,
    duration & 255,
    duration >> 8,
    0x23,
    1,
    control,
    255,
    255,
    255,
    255,
  );
}
function player(
  profile: ProfileId = "2.936",
  device = 1,
  duration = 2,
  control = 0x94,
): SoundPlayback {
  return new SoundPlayback(detectProfile(new Map(), profile), payload(duration, control), device);
}
const bytes = (outputs: ReturnType<SoundPlayback["tick"]>["outputs"]): number[] =>
  outputs.flatMap((event) => (event.kind === "psg" ? [...event.bytes] : []));

describe("sound playback clock and profiles", () => {
  it("reads on tick one and completes at the terminator, independently of frame pacing", () => {
    const sound = player("2.936", 0);
    assert.deepEqual(sound.tick(true, 0), {
      outputs: [{ kind: "speaker", divisor: 12 * (0x23 * 16 + 1) }],
      complete: false,
    });
    assert.deepEqual(sound.tick(true, 0), { outputs: [], complete: false });
    assert.deepEqual(sound.tick(true, 0), {
      outputs: [{ kind: "speaker", divisor: null }],
      complete: true,
    });
    assert.deepEqual(sound.stop(), []);
  });
  it("wraps zero duration through 65536 ticks and honors f9 immediately", () => {
    const sound = player("2.936", 0, 0);
    assert.equal(sound.durationTicks, 65536, "decoded length counts a zero duration as 65536");
    assert.equal(sound.tick(true, 0).complete, false);
    for (let i = 0; i < 65535; i++) assert.equal(sound.tick(true, 0).complete, false);
    assert.equal(sound.tick(true, 0).complete, true);
    const gated = player("2.936", 0);
    assert.deepEqual(gated.tick(false, 0), {
      outputs: [{ kind: "speaker", divisor: null }],
      complete: true,
    });
    assert.deepEqual(gated.tick(true, 0), { outputs: [], complete: true });
  });
  it("selects channel count using the version's device-8 rule", () => {
    const data = payload();
    data[0] = 15;
    data[2] = 8;
    const early = new SoundPlayback(detectProfile(new Map(), "2.440"), data, 8);
    const later = new SoundPlayback(detectProfile(new Map(), "2.936"), data, 8);
    assert.equal(early.tick(true, 0).complete, false);
    assert.equal(later.tick(true, 0).complete, true);
    assert.equal(early.tick(true, 0).complete, false);
    assert.equal(early.tick(true, 0).complete, true);
  });
  it("emits early profile tone bytes and exact control-byte attenuation variants", () => {
    const expected: [ProfileId, number[]][] = [
      ["2.089", [1, 0x23, 0x97]],
      ["2.230", [1, 0x23, 0x97]],
      ["2.272", [1, 0x23, 0x99]],
      ["2.411", [1, 0x23, 0x96]],
      ["2.440", [1, 0x23, 0x96]],
    ];
    for (const [profile, commands] of expected) {
      const sound = player(profile, 2);
      assert.deepEqual(
        bytes(sound.tick(true, 2).outputs).slice(0, commands.length),
        commands,
        profile,
      );
      assert.deepEqual(sound.tick(true, 2).outputs, [], `${profile} has no inter-event envelope`);
    }
    assert.equal(bytes(player("2.272", 1, 2, 0x14).tick(true, 0).outputs)[2], 15);
  });
  it("applies common signed envelopes, live global adjustment and device-2 gain rule", () => {
    const sound = player("2.936", 2, 100);
    assert.deepEqual(bytes(sound.tick(true, 0).outputs).slice(0, 3), [1, 0x23, 0x94]);
    assert.deepEqual(bytes(sound.tick(true, 3).outputs), [0x96]);
    const held = player("2.936", 1, 100, 0x90);
    let current: number[] = [];
    for (let tick = 0; tick < 68; tick++) current = bytes(held.tick(true, 0).outputs);
    assert.deepEqual(current, [0x9d]);
    assert.deepEqual(bytes(held.tick(true, 1).outputs), [0x9e]);
  });
  it("leaves noise envelopes disabled and silences each terminated channel", () => {
    const data = payload(2, 0xf4);
    data[0] = 15;
    data[6] = 8;
    const sound = new SoundPlayback(detectProfile(new Map(), "2.936"), data, 2);
    assert.deepEqual(bytes(sound.tick(true, 0).outputs), [0x9f, 0xbf, 0xdf, 1, 0x23, 0xf6]);
    assert.deepEqual(bytes(sound.tick(true, 1).outputs), [0xf7]);
    assert.deepEqual(bytes(sound.tick(true, 0).outputs), [0xff, 0x9f, 0xbf, 0xdf, 0xff]);
  });
  it("suppresses the second noise byte only in the later command profiles", () => {
    const data = payload();
    data[11] = 0xe2;
    const early = new SoundPlayback(detectProfile(new Map(), "2.411"), data, 1);
    const later = new SoundPlayback(detectProfile(new Map(), "2.440"), data, 1);
    assert.deepEqual(bytes(early.tick(true, 0).outputs).slice(0, 3), [0xe2, 0x23, 0x94]);
    assert.deepEqual(bytes(later.tick(true, 0).outputs).slice(0, 2), [0xe2, 0x94]);
  });
  it("authors tone latch/channel bits and noise control bytes that survive raw command playback", () => {
    const data = buildSound(
      [226, 0x123, 0x345, 6].map((freqDivisor) => ({
        notes: [{ freqDivisor, duration: 2, attenuation: 4 }],
      })),
    );
    assert.deepEqual(
      Array.from(data),
      [
        8, 0, 15, 0, 22, 0, 29, 0, 2, 0, 14, 0x82, 0x94, 255, 255, 2, 0, 0x12, 0xa3, 0xb4, 255, 255,
        2, 0, 0x34, 0xc5, 0xd4, 255, 255, 2, 0, 6, 0xe6, 0xf4, 255, 255,
      ],
    );
    const sound = new SoundPlayback(detectProfile(new Map(), "2.936"), data, 1);
    assert.deepEqual(
      bytes(sound.tick(true, 0).outputs),
      [0x82, 14, 0x92, 0xa3, 0x12, 0xb2, 0xc5, 0x34, 0xd2, 0xe6, 0xf4],
    );
    const zeroNoise = buildSound([
      { notes: [] },
      { notes: [] },
      { notes: [] },
      { notes: [{ freqDivisor: 0, duration: 2, attenuation: 4 }] },
    ]);
    assert.equal(
      zeroNoise[zeroNoise.length - 3],
      0xf4,
      "noise control zero is audible, not a rest",
    );
  });
  it("suppresses frequency divisor writes for rest notes where tone is zero", () => {
    const data = payload(2, 0x9f);
    data[10] = 0;
    data[11] = 0;
    const sound = new SoundPlayback(detectProfile(new Map(), "2.936"), data, 1);
    assert.deepEqual(bytes(sound.tick(true, 0).outputs), [0x9f, 0xbf, 0xdf, 0xff]);
  });
});

it("runtime playback bounds damaged channels while keeping valid notes and completion timing", () => {
  // An original synthetic sound: channel 0 is complete, channel 1 has an
  // incomplete event, channel 2 points outside, and channel 3 points into the header.
  const data = Uint8Array.of(8, 0, 15, 0, 99, 0, 0, 0, 2, 0, 0x23, 1, 0x94, 255, 255, 3, 0, 0x12);
  const profile = detectProfile(new Map(), "2.936");
  const speaker = new SoundPlayback(profile, data, 0);
  assert.deepEqual(speaker.tick(true, 0), {
    outputs: [{ kind: "speaker", divisor: 12 * (0x23 * 16 + 1) }],
    complete: false,
  });
  assert.equal(speaker.tick(true, 0).complete, false);
  assert.equal(speaker.tick(true, 0).complete, true);
  const completeWarnings: string[] = [];
  new SoundPlayback(profile, payload(), 1, (message) => {
    completeWarnings.push(message);
  });
  assert.deepEqual(completeWarnings, []);
  const warnings: string[] = [];
  const four = new SoundPlayback(profile, data, 1, (message) => {
    warnings.push(message);
  });
  assert.equal(
    warnings.some((message) => message.includes("channel 0")),
    false,
  );
  assert.equal(four.durationTicks, 2, "damaged channels contribute no ticks to the decoded length");
  assert.equal(four.tick(true, 0).complete, false);
  assert.equal(four.tick(true, 0).complete, false);
  assert.equal(four.tick(true, 0).complete, true);
  const missing = new SoundPlayback(profile, Uint8Array.of(1, 2), 1);
  assert.equal(missing.tick(true, 0).complete, true);
});

describe("pc booter 2.001 row streams", () => {
  it("splits payload into zero-terminated rows, keeping empty and unterminated rows", () => {
    assert.deepEqual(booterSoundRows(Uint8Array.of(0x80, 0x02, 0, 0, 0x9f, 0)), [
      [0x80, 0x02],
      [],
      [0x9f],
    ]);
    assert.deepEqual(booterSoundRows(Uint8Array.of(0x80, 0x02)), [[0x80, 0x02]]);
    assert.deepEqual(booterSoundRows(new Uint8Array(0)), []);
  });

  it("emits one row per tick and completes at payload exhaustion", () => {
    const profile = detectProfile(new Map(), "2.001");
    const payload = Uint8Array.of(0x80, 0x02, 0, 0, 0x9f, 0);
    const sound = new SoundPlayback(profile, payload, 1);
    assert.equal(sound.durationTicks, 3);
    assert.deepEqual(sound.tick(true, 0), {
      outputs: [{ kind: "psg", bytes: [0x80, 0x02] }],
      complete: false,
    });
    assert.deepEqual(sound.tick(true, 0), { outputs: [], complete: false });
    assert.deepEqual(sound.tick(true, 0), {
      outputs: [
        { kind: "psg", bytes: [0x9f] },
        { kind: "psg", bytes: [0x9f, 0xbf, 0xdf, 0xff] },
      ],
      complete: true,
    });
    assert.deepEqual(sound.tick(true, 0), { outputs: [], complete: true });
  });

  it("silences the chip immediately when sound is disabled", () => {
    const profile = detectProfile(new Map(), "2.001");
    const sound = new SoundPlayback(profile, Uint8Array.of(0x80, 0x02, 0, 0x9f, 0), 1);
    assert.deepEqual(sound.tick(false, 0), {
      outputs: [{ kind: "psg", bytes: [0x9f, 0xbf, 0xdf, 0xff] }],
      complete: true,
    });
  });

  it("snapshots and restores the row position", () => {
    const profile = detectProfile(new Map(), "2.001");
    const payload = Uint8Array.of(0x80, 0x02, 0, 0x84, 0, 0x9f, 0);
    const sound = new SoundPlayback(profile, payload, 1);
    sound.tick(true, 0);
    const restored = new SoundPlayback(profile, payload, 1);
    restored.restore(sound.snapshot());
    assert.deepEqual(bytes(restored.tick(true, 0).outputs), [0x84]);
    assert.equal(restored.tick(true, 0).complete, true);
  });
});
