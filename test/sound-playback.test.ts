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
      { kind: "paula", channel: 3, period: 0x800, volume: 55 },
    ]);
    // The noise channel shares the envelope tick while its cursor is alive.
    assert.deepEqual(sound.tick(true, 0).outputs, [
      { kind: "paula", channel: 3, period: 0x800, volume: 59 },
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
      { kind: "paula", channel: 3, period: 0x200, volume: 64 },
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

  it("never reads the volume-adjustment variable", () => {
    // GR h197 holds no v23 access: the same note plays identically at any v23.
    for (const adjustment of [0, 5, 200]) {
      const sound = amiga(payload(2, 0x94));
      assert.equal(paula(sound.tick(true, adjustment).outputs)[0]!.volume, 38);
      assert.equal(paula(sound.tick(true, adjustment).outputs)[0]!.volume, 42);
    }
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

describe("amiga 2.082 driver family (docs/fidelity.md, original Amiga sound player)", () => {
  const old = (data: Uint8Array, device = 1): SoundPlayback =>
    new SoundPlayback(detectProfile(new Map(), "amiga-2.082"), data, device);
  const paula = (outputs: ReturnType<SoundPlayback["tick"]>["outputs"]) =>
    outputs.filter((event) => event.kind === "paula");

  it("emits on the decode tick only, with 16x the note divisor as the period", () => {
    // Channel 0: duration 2, tone 0x0123 -> divisor 0x231 -> period 16*0x231;
    // attenuation 4 -> volume ((15-4)<<6)/15 = 46. Channels 1..3 terminate on
    // the same tick.
    const sound = old(payload(2, 0x94));
    assert.deepEqual(sound.tick(true, 0).outputs, [
      { kind: "paula", channel: 0, period: 16 * 0x231, volume: 46, driver: "2.082" },
      { kind: "paula", channel: 1, period: null, volume: 0, driver: "2.082" },
      { kind: "paula", channel: 2, period: null, volume: 0, driver: "2.082" },
      { kind: "paula", channel: 3, period: null, volume: 0, driver: "2.082" },
    ]);
    // No envelope pass: the held note emits nothing on the second tick.
    assert.deepEqual(sound.tick(true, 0).outputs, []);
    // The terminator silences the channel, then completion silences every
    // voice the host may have left sounding.
    const last = sound.tick(true, 0);
    assert.deepEqual(last.outputs, [
      { kind: "paula", channel: 0, period: null, volume: 0, driver: "2.082" },
      { kind: "paula", channel: 0, period: null, volume: 0, driver: "2.082" },
      { kind: "paula", channel: 1, period: null, volume: 0, driver: "2.082" },
      { kind: "paula", channel: 2, period: null, volume: 0, driver: "2.082" },
      { kind: "paula", channel: 3, period: null, volume: 0, driver: "2.082" },
    ]);
    assert.equal(last.complete, true);
    assert.deepEqual(sound.stop(), []);
  });

  it("subtracts the volume-adjustment variable before scaling, floored at 0", () => {
    // adjustment 2: atten 4-2 -> ((15-2)<<6)/15 = 55.
    assert.equal(paula(old(payload(2, 0x94)).tick(true, 2).outputs)[0]!.volume, 55);
    // adjustment 5 >= atten 4: the driver zeroes the attenuation -> 64.
    assert.equal(paula(old(payload(2, 0x94)).tick(true, 5).outputs)[0]!.volume, 64);
    // A rest (tone 0, atten 15) writes period 0 with ((15-10)<<6)/15 = 21.
    const rest = payload(2, 0x9f);
    rest[10] = 0;
    rest[11] = 0;
    assert.deepEqual(paula(old(rest).tick(true, 5).outputs)[0], {
      kind: "paula",
      channel: 0,
      period: 0,
      volume: 21,
      driver: "2.082",
    });
  });

  it("maps the noise control type to its fixed periods", () => {
    const data = payload(2, 0xf0);
    data[0] = 15;
    data[6] = 8;
    data[10] = 0;
    data[11] = 0xe1; // noise control: type 1 -> period 3
    const out = paula(old(data).tick(true, 0).outputs);
    assert.deepEqual(out[3], { kind: "paula", channel: 3, period: 3, volume: 64, driver: "2.082" });
    for (const [type, period] of [
      [0xe0, 6],
      [0xe2, 1],
      [0xe3, 1],
    ] as const) {
      const d = payload(2, 0xf0);
      d[0] = 15;
      d[6] = 8;
      d[10] = 0;
      d[11] = type;
      const next = paula(old(d).tick(true, 0).outputs);
      assert.equal(next[3]!.period, period, `type byte ${type.toString(16)}`);
    }
  });
});

describe("amiga kq2 envelope (docs/fidelity.md, original Amiga sound player)", () => {
  it("applies KQ2's signed attack curve instead of the 2.202 decay table", () => {
    // The 2.176 data hunk's envelope opens at -2 (louder than the note's
    // attenuation), where the 2.202+ table opens at +2.
    const kq2 = new SoundPlayback(detectProfile(new Map(), "amiga-2.176"), payload(2, 0x90), 1);
    const sq2 = new SoundPlayback(detectProfile(new Map(), "amiga-2.202"), payload(2, 0x90), 1);
    // atten 0 + (-2) clamps to 0 -> 64 on KQ2; atten 0+2 -> 55 on SQ2.
    const kq2out = kq2.tick(true, 0).outputs;
    assert.equal(kq2out[0]!.kind === "paula" && kq2out[0]!.volume, 64);
    const sq2out = sq2.tick(true, 0).outputs;
    assert.equal(sq2out[0]!.kind === "paula" && sq2out[0]!.volume, 55);
  });

  it("writes the attack's volumes at period 0 for a rest", () => {
    // Tone 0, atten 15: 15-2, 15-3, 15-2, 15-1 -> volumes 8, 12, 8, 4, then 0.
    const rest = payload(8, 0x9f);
    rest[10] = 0;
    rest[11] = 0;
    const kq2 = new SoundPlayback(detectProfile(new Map(), "amiga-2.176"), rest, 1);
    const voice0 = () =>
      kq2.tick(true, 0).outputs.find((e) => e.kind === "paula" && e.channel === 0);
    for (const volume of [8, 12, 8, 4, 0])
      assert.deepEqual(voice0(), { kind: "paula", channel: 0, period: 0, volume });
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

describe('apple iigs stream family (docs/fidelity.md "IIgs sound")', () => {
  const iigs = (data: Uint8Array): SoundPlayback =>
    new SoundPlayback(detectProfile(new Map(), "iigs-1.014"), data, 1);

  // Hand-computed heartbeat timing (seg3+0x1dcd): an event runs exactly its
  // timing byte's value in ticks after the previous event, and events behind
  // zero timing bytes run in the same tick. The stream starts after the type
  // word, so `[02 00]` is followed directly by the first timing byte.
  const T2 = Uint8Array.of(
    ...[0x02, 0x00],
    ...[0x00, 0xc0, 0x05], // tick 1: program 5
    ...[0x03, 0x90, 0x40, 0x64], // tick 4: note-on 64
    ...[0x05, 0x80, 0x40, 0x00], // tick 9: note-off 64
    ...[0x07, 0xfc], // tick 16: end
  );
  const ALL_OFF = { kind: "iigs", event: "all-off" } as const;

  /** Outputs by tick until completion, with the completing tick. */
  const run = (
    sound: SoundPlayback,
    limit = 2000,
  ): { byTick: Map<number, unknown[]>; end: number } => {
    const byTick = new Map<number, unknown[]>();
    for (let tick = 1; tick <= limit; tick++) {
      const { outputs, complete } = sound.tick(true, 0);
      if (outputs.length > 0) byTick.set(tick, outputs);
      if (complete) return { byTick, end: tick };
    }
    throw new Error("sound did not complete");
  };

  it("runs each event its timing byte's ticks after the previous one", () => {
    const { byTick, end } = run(iigs(T2));
    assert.deepEqual(
      [...byTick],
      [
        [1, [ALL_OFF]],
        [
          4,
          [
            {
              kind: "iigs",
              event: "note-on",
              voice: 0,
              channel: 0,
              note: 64,
              volume: 127,
              program: 5,
            },
          ],
        ],
        [9, [{ kind: "iigs", event: "note-off", voice: 0 }]],
        [16, [ALL_OFF]],
      ],
    );
    assert.equal(end, 16);
  });

  it("chains zero-delay events in one tick and keeps running status per channel", () => {
    const { byTick, end } = run(
      iigs(
        Uint8Array.of(
          ...[0x02, 0x00],
          ...[0x00, 0x90, 0x3c, 0x40], // tick 1: note-on 60 (voice 0)
          ...[0x00, 0x3e, 0x40], // tick 1: running status, note-on 62 (voice 1)
          ...[0x02, 0x3c, 0x00], // tick 3: velocity 0 releases voice 0
          ...[0x01, 0xb1, 0x07, 0x50], // tick 4: channel 1 volume 80
          ...[0x00, 0xc1, 0x0a], // tick 4: channel 1 program 10
          ...[0x00, 0x91, 0x40, 0x20], // tick 4: note-on 64 at volume 80 (voice 2)
          ...[0x03, 0xfc], // tick 7: end
        ),
      ),
    );
    const on = (voice: number, channel: number, note: number, volume: number, program: number) => ({
      kind: "iigs",
      event: "note-on",
      voice,
      channel,
      note,
      volume,
      program,
    });
    assert.deepEqual(
      [...byTick],
      [
        [1, [ALL_OFF, on(0, 0, 60, 127, -1), on(1, 0, 62, 127, -1)]],
        [3, [{ kind: "iigs", event: "note-off", voice: 0 }]],
        [4, [{ kind: "iigs", event: "volume", channel: 1, volume: 80 }, on(2, 1, 64, 80, 10)]],
        [7, [ALL_OFF]],
      ],
    );
    assert.equal(end, 7);
  });

  it("0xf8 waits 255 ticks and 0xfc ends the sound", () => {
    // Tick 1 stores 255; the trailing 5 is read on tick 256; the note plays
    // on tick 261 and the terminator after a zero delay in the same tick.
    const { byTick, end } = run(
      iigs(Uint8Array.of(0x02, 0x00, 0xf8, 0x05, 0x90, 0x3c, 0x40, 0x00, 0xfc)),
    );
    assert.deepEqual([...byTick.keys()], [1, 261]);
    assert.equal(end, 261);
  });

  it("any controller sets the note volume; only controller 7 re-levels sounding notes", () => {
    const { byTick } = run(
      iigs(Uint8Array.of(0x02, 0x00, 0x00, 0xb0, 0x0a, 0x30, 0x00, 0x90, 0x3c, 0x40, 0x00, 0xfc)),
    );
    assert.deepEqual(byTick.get(1), [
      ALL_OFF,
      { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 60, volume: 48, program: -1 },
      ALL_OFF,
    ]);
  });

  it("an unhandled class leaves its data bytes to the timing state", () => {
    // 0xa0 has no handler: the next byte (2) is read as a timing byte.
    const { byTick, end } = run(
      iigs(Uint8Array.of(0x02, 0x00, 0x00, 0xa0, 0x02, 0x90, 0x3c, 0x40, 0x00, 0xfc)),
    );
    assert.deepEqual([...byTick.keys()], [1, 3]);
    assert.equal(end, 3);
  });

  /**
   * A type-1 resource: semitone, volume, wave offset 44, byte count, then a
   * 44-byte instrument whose first A wave (at +32) has the given size byte
   * and DOC mode, then the PCM.
   */
  const sample = (
    semitone: number,
    pcm: readonly number[],
    wave: { size: number; mode: number } = { size: 0x2d, mode: 0x02 },
  ): Uint8Array => {
    const instrument = new Array<number>(44).fill(0);
    instrument[34] = wave.size;
    instrument[35] = wave.mode;
    return Uint8Array.of(
      ...[0x01, 0x00],
      ...[semitone, 0x00, 0x7f, 0x00, 0x2c, 0x00, pcm.length & 0xff, pcm.length >> 8],
      ...instrument,
      ...pcm,
    );
  };

  it("a type-1 sample completes when the oscillator reaches its zero byte", () => {
    // Semitone 57 is 220 Hz: 256 * 220 = 56,320 bytes per second, 938.67 per
    // tick. 1,000 bytes before the zero halt in the second tick.
    const payload = sample(57, [...new Array<number>(1000).fill(0x80), 0x00]);
    const { byTick, end } = run(iigs(payload));
    assert.deepEqual(byTick.get(1), [
      ALL_OFF,
      { kind: "iigs", event: "sample", voice: 0, data: payload.subarray(2) },
    ]);
    assert.deepEqual(byTick.get(2), [ALL_OFF]);
    assert.equal(end, 2);
  });

  it("an early zero byte halts the sample before its byte count", () => {
    // 10 bytes at 938.67 per tick halt within the first tick.
    const { end } = run(
      iigs(
        sample(57, [
          ...new Array<number>(10).fill(0x80),
          0x00,
          ...new Array<number>(2000).fill(0x80),
          0x00,
        ]),
      ),
    );
    assert.equal(end, 1);
  });

  it("a one-shot sample without a zero byte halts at the end of its table", () => {
    // Size byte 0x12 is T = 2: a 1,024-byte table, 1.09 ticks at 938.67 bytes per tick.
    const { end } = run(
      iigs(sample(57, new Array<number>(1024).fill(0x80), { size: 0x12, mode: 0x02 })),
    );
    assert.equal(end, 2);
  });

  it("a free-running sample without a zero byte loops until stopped", () => {
    const sound = iigs(sample(57, new Array<number>(1024).fill(0x80), { size: 0x12, mode: 0x00 }));
    for (let tick = 0; tick < 1000; tick++) assert.equal(sound.tick(true, 0).complete, false);
    assert.deepEqual(sound.stop(), [ALL_OFF]);
  });

  it("completes immediately on a truncated resource", () => {
    const empty = iigs(new Uint8Array(0));
    assert.equal(empty.tick(true, 0).complete, true);
  });

  it("the fade watchdog completes an armed sound on the pacing schedule", () => {
    // fade.sound/fade.sound.v arm the heartbeat watchdog (docs/fidelity.md
    // "Apple IIgs sound fade"): a latched 0xff budget steps down 0x10 at each
    // pace expiry, checked before the decrement, so pace 2 completes on the
    // sixteenth expiry — heartbeat 32 — well before the stream's deltas end.
    // The stream below holds four 255-tick waits in delta position.
    const sound = iigs(Uint8Array.of(0x02, 0x00, 0xf8, 0xf8, 0xf8, 0xf8, 0x01, 0xfc));
    sound.armFade(2);
    for (let beat = 1; beat < 32; beat++)
      assert.equal(sound.tick(true, 0).complete, false, `heartbeat ${beat}`);
    assert.equal(sound.tick(true, 0).complete, true);
  });

  it("a zero fade pace completes on the next heartbeat and disarms on stop", () => {
    const sound = iigs(Uint8Array.of(0x02, 0x00, 0xf8, 0xf8, 0xf8, 0xf8, 0x01, 0xfc));
    sound.armFade(0);
    assert.equal(sound.tick(true, 0).complete, true);
    // Completion restores the disarmed state (the original's $df = 0xffff),
    // so a snapshot carries no watchdog.
    assert.equal(sound.snapshot().fade, null);
  });

  it("re-arming updates the pace without relatching the volume budget", () => {
    const sound = iigs(Uint8Array.of(0x02, 0x00, 0xf8, 0xf8, 0xf8, 0xf8, 0xf8, 0x01, 0xfc));
    sound.armFade(1);
    // Ten heartbeats at pace 1: ten expiries, budget 0xff -> 0x5f.
    for (let t = 0; t < 10; t++) assert.equal(sound.tick(true, 0).complete, false);
    // Re-arming preserves the stepped budget: five more expiries reach 0x0f,
    // the sixth finds it below 0x10 — six beats, not sixteen.
    sound.armFade(1);
    for (let t = 0; t < 5; t++) assert.equal(sound.tick(true, 0).complete, false);
    assert.equal(sound.tick(true, 0).complete, true);
  });

  it("a restored stream continues on the same ticks and stops with AllNotesOff", () => {
    const sound = iigs(T2);
    for (let t = 0; t < 5; t++) sound.tick(true, 0);
    const restored = iigs(T2);
    restored.restore(sound.snapshot());
    // Ticks 6..9: the note-off arrives on tick 9, four heartbeats on.
    for (let t = 6; t < 9; t++) assert.deepEqual(restored.tick(true, 0).outputs, []);
    assert.deepEqual(restored.tick(true, 0).outputs, [
      { kind: "iigs", event: "note-off", voice: 0 },
    ]);
    assert.deepEqual(restored.stop(), [ALL_OFF]);
  });

  it("snapshot and restore preserve the fade watchdog", () => {
    const payload = Uint8Array.of(0x02, 0x00, 0xf8, 0xf8, 0xf8, 0xf8, 0x01, 0xfc);
    const sound = iigs(payload);
    sound.armFade(2);
    sound.tick(true, 0);
    const saved = iigs(payload);
    saved.restore(sound.snapshot());
    // The restored countdown and budget finish the same schedule: 31 more
    // heartbeats then completion on the 32nd.
    for (let beat = 2; beat < 32; beat++)
      assert.equal(saved.tick(true, 0).complete, false, `heartbeat ${beat}`);
    assert.equal(saved.tick(true, 0).complete, true);
  });
});
