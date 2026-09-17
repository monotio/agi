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
    // Held ticks reuse the stored envelope value without v23 — the executed
    // originals never re-apply it once the envelope holds (docs/fidelity.md).
    assert.deepEqual(bytes(held.tick(true, 1).outputs), [0x9d]);
  });
  it("leaves noise envelopes disabled and silences each terminated channel", () => {
    const data = payload(2, 0xf4);
    data[0] = 15;
    data[6] = 8;
    const sound = new SoundPlayback(detectProfile(new Map(), "2.936"), data, 2);
    assert.deepEqual(bytes(sound.tick(true, 0).outputs), [0x9f, 0xbf, 0xdf, 1, 0x23, 0xf6]);
    // The noise channel has no active envelope, so v23 never reaches it;
    // the device-2 gain stage still applies (docs/fidelity.md, sound audit).
    assert.deepEqual(bytes(sound.tick(true, 1).outputs), [0xf6]);
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

describe("the measured envelope tables (docs/fidelity.md, sound player audit)", () => {
  /**
   * The executed attenuation column for device 1, base attenuation 0, a
   * 120-tick note and v23=3 — tick → attenuation, per build.
   */
  const EXPECTED: Record<string, [number, number][]> = {
    "2.917": [
      [7, 4],
      [11, 5],
      [30, 8],
      [60, 14],
      [67, 15],
      [68, 13],
      [77, 13],
      [78, 13],
    ],
    "3.002": [
      [7, 3],
      [11, 4],
      [30, 6],
      [60, 12],
      [67, 14],
      [68, 14],
      [77, 15],
      [78, 13],
    ],
  };

  it("2.917-family profiles follow KQ1's 68-entry envelope", () => {
    for (const id of ["2.917", "2.936"] as const) {
      const sound = player(id, 1, 120, 0x90);
      const at = new Map(EXPECTED["2.917"]!);
      for (let tick = 1; tick <= 78; tick++) {
        const out = bytes(sound.tick(true, 3).outputs);
        const want = at.get(tick);
        if (want !== undefined) assert.equal(out.at(-1), 0x90 | want, `${id} tick ${tick}`);
      }
    }
  });

  it("3.002.102 and 3.002.149 follow the measured 78-entry v3 envelope", () => {
    for (const id of ["3.002.102", "3.002.149"] as const) {
      const sound = player(id, 1, 120, 0x90);
      const at = new Map(EXPECTED["3.002"]!);
      for (let tick = 1; tick <= 78; tick++) {
        const out = bytes(sound.tick(true, 3).outputs);
        const want = at.get(tick);
        if (want !== undefined) assert.equal(out.at(-1), 0x90 | want, `${id} tick ${tick}`);
      }
    }
  });

  it("the envelope-free noise channel emits its byte without v23", () => {
    // Executed on all three originals: duration 2, tone 0xe001, control 0xf0,
    // v23=3 emits attenuation 0xf0 — never 0xf3.
    const data = payload(2, 0xf0);
    data[0] = 15; // channels 0..2 point at the terminator
    data[6] = 8; // channel 3 (noise) holds the note
    data[10] = 0x01;
    data[11] = 0xe0;
    for (const id of ["2.917", "3.002.102", "3.002.149"] as const) {
      const sound = new SoundPlayback(detectProfile(new Map(), id), data, 1);
      assert.deepEqual(bytes(sound.tick(true, 3).outputs), [0x9f, 0xbf, 0xdf, 0xe0, 0xf0], id);
    }
  });

  it("snapshot/restore crosses the hold boundaries and emits the resumed stream", () => {
    for (const id of ["2.917", "3.002.149"] as const) {
      const continuous = player(id, 1, 120, 0x90);
      const out: number[][] = [];
      for (let t = 0; t < 80; t++) out.push(bytes(continuous.tick(true, 3).outputs));
      for (const atTick of [67, 68, 77, 78]) {
        const snapshotAt = player(id, 1, 120, 0x90);
        for (let t = 0; t < atTick - 1; t++) snapshotAt.tick(true, 3);
        const resumed = player(id, 1, 120, 0x90);
        resumed.restore(snapshotAt.snapshot());
        for (let t = atTick; t <= 80; t++) {
          assert.deepEqual(
            bytes(resumed.tick(true, 3).outputs),
            out[t - 1]!,
            `${id} resumed at ${atTick}, tick ${t}`,
          );
        }
      }
    }
  });

  it("snapshot bounds follow the selected table, not a shared constant", () => {
    // A v3 envelope index past the 2.917 hold (>= 68) is valid state under a
    // v3 profile and out of range under 2.917.
    const v3 = player("3.002.149", 1, 120, 0x90);
    for (let t = 0; t < 72; t++) v3.tick(true, 3);
    const snap = v3.snapshot();
    const index = snap.channels[0]!.envelopeIndex;
    assert.ok(index >= 68 && index < 78, `index ${index} sits in v3-only range`);
    player("3.002.149", 1, 120, 0x90).restore(snap);
    assert.throws(
      () => player("2.917", 1, 120, 0x90).restore(snap),
      /outside the current resource/,
    );
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
