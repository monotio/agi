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
  it("preserves original signed-byte adjustment and device-2 overflow writes", () => {
    // Independently executed first-tick port bytes; see docs/fidelity.md,
    // original sound player audit. High v23 values may select another register.
    const vectors = [
      [1, 0, 127, 0x9f],
      [1, 0, 128, 0x90],
      [1, 0, 250, 0xfa],
      [1, 0, 255, 0xff],
      [1, 7, 127, 0x94],
      [1, 8, 250, 0x90],
      [2, 0, 128, 0x92],
      [2, 0, 250, 0xfc],
      [2, 0, 255, 0x91],
      [2, 14, 127, 0x9d],
      [2, 14, 128, 0x9e],
      [2, 8, 250, 0x92],
      [2, 15, 255, 0x9f],
    ] as const;
    for (const profile of ["2.917", "2.936", "3.002.102", "3.002.149"] as const)
      for (const [device, base, adjustment, expected] of vectors) {
        const sound = player(profile, device, 120, 0x90 | base);
        assert.equal(
          bytes(sound.tick(true, adjustment).outputs)[2],
          expected,
          `${profile}: device ${device}, base ${base}, v23 ${adjustment}`,
        );
      }
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

describe("amiga paula family (docs/fidelity.md, original Amiga sound player)", () => {
  const amiga = (data: Uint8Array, device = 1, profile: ProfileId = "amiga-2.316"): SoundPlayback =>
    new SoundPlayback(detectProfile(new Map(), profile), data, device);
  const paula = (outputs: ReturnType<SoundPlayback["tick"]>["outputs"]) =>
    outputs.filter((event) => event.kind === "paula");

  it("decodes tone notes into Paula periods and 0..64 volumes", () => {
    // Channel 0 note: duration 2, tone 0x0123 -> divisor 0x231 -> period 4*561,
    // attenuation 4; channels 1..3 point at the terminator.
    const sound = amiga(payload(2, 0x94));
    // The decode tick also runs the envelope: table[0] = 2 -> attenuation
    // 4+2=6 -> volume ((15-6)<<6)/15 = 38.
    assert.deepEqual(sound.tick(true, 0).outputs, [
      { kind: "paula", channel: 0, period: 4 * 0x231, volume: 38 },
      { kind: "paula", channel: 1, period: null, volume: 0 },
      { kind: "paula", channel: 2, period: null, volume: 0 },
      { kind: "paula", channel: 3, period: null, volume: 0 },
    ]);
    // table[1] = 1 -> attenuation 4+1=5 -> volume ((15-5)<<6)/15 = 42.
    assert.deepEqual(sound.tick(true, 0).outputs, [
      { kind: "paula", channel: 0, period: 4 * 0x231, volume: 42 },
    ]);
    // Termination silences the channel and completes the sound.
    const last = sound.tick(true, 0);
    assert.deepEqual(last.outputs, [
      { kind: "paula", channel: 0, period: null, volume: 0 },
      { kind: "paula", channel: 0, period: null, volume: 0 },
      { kind: "paula", channel: 1, period: null, volume: 0 },
      { kind: "paula", channel: 2, period: null, volume: 0 },
      { kind: "paula", channel: 3, period: null, volume: 0 },
    ]);
    assert.equal(last.complete, true);
    assert.deepEqual(sound.stop(), []);
  });

  it("applies the h198 envelope as offsets from the note's attenuation, then holds", () => {
    // Attenuation 0, 120-tick note: tick t applies table[t-1] (61 deltas),
    // tick 62 reads the 0x80 sentinel and the last volume holds.
    const sound = amiga(payload(120, 0x90));
    const expected = new Map<number, number>([
      [1, 55], // att 0+2 -> (13*64)/15
      [2, 59], // att 0+1 -> (14*64)/15
      [3, 64], // att 0+0 -> full volume
      [7, 59], // att 0+1
      [11, 55], // att 0+2
      [19, 51], // att 0+3 -> (12*64)/15
      [26, 46], // att 0+4
      [31, 42], // att 0+5
      [36, 38], // att 0+6
      [41, 34], // att 0+7
      [46, 29], // att 0+8
      [51, 25], // att 0+9
      [56, 21], // att 0+10
      [61, 17], // att 0+11 -> (4*64)/15
      [62, 17], // sentinel: the envelope holds, it does not reset
      [80, 17],
    ]);
    for (let tick = 1; tick <= 80; tick++) {
      const out = paula(sound.tick(true, 0).outputs);
      const want = expected.get(tick);
      if (want !== undefined) assert.equal(out[0]!.volume, want, `tick ${tick}`);
    }
  });

  it("maps the noise control's type bits to fixed periods on the noise voice", () => {
    const data = payload(2, 0xf0);
    data[0] = 15; // channels 0..2 terminate immediately
    data[6] = 8; // channel 3 holds the note
    data[10] = 0;
    data[11] = 0xe2; // noise control: type 2 -> period 0x800
    const sound = amiga(data);
    assert.deepEqual(sound.tick(true, 0).outputs, [
      { kind: "paula", channel: 0, period: null, volume: 0 },
      { kind: "paula", channel: 1, period: null, volume: 0 },
      { kind: "paula", channel: 2, period: null, volume: 0 },
      { kind: "paula", channel: 3, period: 0x800, volume: 55, noise: true },
    ]);
    // The noise channel shares the envelope tick while its cursor is alive.
    assert.deepEqual(sound.tick(true, 0).outputs, [
      { kind: "paula", channel: 3, period: 0x800, volume: 59, noise: true },
    ]);
    for (const [type, period] of [
      [0xe0, 0x200],
      [0xe1, 0x400],
      [0xe3, 0x800],
    ] as const) {
      const d = payload(2, 0xf0);
      d[0] = 15;
      d[6] = 8;
      d[10] = 0;
      d[11] = type;
      const out = paula(amiga(d).tick(true, 0).outputs);
      assert.equal(out[3]!.period, period, `type byte ${type.toString(16)}`);
    }
  });

  it("runs the noise channel's envelope cursor once and never resets it per note", () => {
    // Noise note 1 (duration 70) exhausts the table; note 2 decodes with the
    // dead cursor, so its attenuation plays without an envelope offset.
    const data = Uint8Array.of(
      18,
      0,
      18,
      0,
      18,
      0,
      8,
      0,
      70,
      0,
      0,
      0xe0,
      0xf0,
      5,
      0,
      0,
      0xe0,
      0xf0,
      255,
      255,
    );
    const sound = amiga(data);
    let out: ReturnType<typeof paula> = [];
    for (let tick = 1; tick <= 70; tick++) out = paula(sound.tick(true, 0).outputs);
    assert.equal(out[0]!.volume, 17, "the held envelope value at the hold point");
    // Note 2 starts at tick 71: no cursor reset -> plain volume for att 0.
    assert.deepEqual(paula(sound.tick(true, 0).outputs), [
      { kind: "paula", channel: 3, period: 0x200, volume: 64, noise: true },
    ]);
    assert.equal(paula(sound.tick(true, 0).outputs)[0]!.volume, 64);
  });

  it("restarts the tone envelope at every note on the tone channels", () => {
    // Two consecutive channel-0 notes, attenuation 0.
    const data = Uint8Array.of(
      8,
      0,
      18,
      0,
      18,
      0,
      18,
      0,
      2,
      0,
      0x23,
      0x81,
      0x90,
      2,
      0,
      0x24,
      0x82,
      0x90,
      255,
      255,
    );
    const sound = amiga(data);
    assert.equal(paula(sound.tick(true, 0).outputs)[0]!.volume, 55);
    assert.equal(paula(sound.tick(true, 0).outputs)[0]!.volume, 59);
    // Second note decodes on tick 3: the envelope restarts at table[0].
    const out = paula(sound.tick(true, 0).outputs);
    assert.equal(out[0]!.period, 4 * 0x242);
    assert.equal(out[0]!.volume, 55, "the second note applies table[0] again");
  });

  it("keeps all four voices regardless of the device operand", () => {
    for (const device of [0, 1, 8]) {
      const out = amiga(payload(2, 0x94), device).tick(true, 0).outputs;
      assert.equal(out.length, 4, `device ${device} still drives four voices`);
    }
  });

  it("silences every channel when sound is disabled", () => {
    assert.deepEqual(amiga(payload(2, 0x94)).tick(false, 0).outputs, [
      { kind: "paula", channel: 0, period: null, volume: 0 },
      { kind: "paula", channel: 1, period: null, volume: 0 },
      { kind: "paula", channel: 2, period: null, volume: 0 },
      { kind: "paula", channel: 3, period: null, volume: 0 },
    ]);
  });
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
