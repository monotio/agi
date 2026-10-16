import assert from "node:assert/strict";
import { it } from "node:test";
import { detectProfile, type ProfileId } from "../src/runtime/profile.ts";
import { SoundPlayback } from "../src/sound/sound.ts";

const commands = (sound: SoundPlayback): number[] =>
  sound.tick(true, 0).outputs.flatMap((event) => (event.kind === "psg" ? [...event.bytes] : []));

it("PC players send both zero tone bytes before a rest's attenuation", () => {
  for (const id of [
    "2.089",
    "2.230",
    "2.272",
    "2.411",
    "2.440",
    "2.917",
    "2.936",
    "3.002.086",
    "3.002.102",
    "3.002.149",
  ] as const) {
    // Every channel has a one-tick zero-tone rest, then a terminator.
    const payload = Uint8Array.of(8, 0, 8, 0, 8, 0, 8, 0, 1, 0, 0, 0, 0x9f, 255, 255);
    const sound = new SoundPlayback(detectProfile(new Map(), id), payload, 1);
    const attenuation =
      id === "2.917" || id === "2.936" || id.startsWith("3.")
        ? [0x9f, 0xbf, 0xdf, 0xff]
        : [0x9f, 0x9f, 0x9f, 0x9f];
    assert.deepEqual(
      commands(sound),
      attenuation.flatMap((byte) => [0, 0, byte]),
      id,
    );
  }
});

it("early PC terminators program their saved tone latch before silencing", () => {
  for (const id of ["2.089", "2.230", "2.272", "2.411", "2.440"] satisfies ProfileId[]) {
    const sound = new SoundPlayback(
      detectProfile(new Map(), id),
      Uint8Array.of(8, 0, 8, 0, 8, 0, 8, 0, 255, 255),
      1,
    );
    assert.deepEqual(
      commands(sound),
      [
        0x8f,
        0,
        0x9f,
        0xaf,
        0,
        0xbf,
        0xcf,
        0,
        0xdf,
        0xef,
        ...(id === "2.440" ? [] : [0]),
        0xff,
        0x9f,
        0xbf,
        0xdf,
        0xff,
      ],
      id,
    );
  }
});

it("IIgs fade sends SetSoundVolume steps before notes and restores the latch on completion", () => {
  const sound = new SoundPlayback(
    detectProfile(new Map(), "iigs-1.014"),
    Uint8Array.of(2, 0, 0, 0x90, 60, 64, 30, 0xfc),
    1,
  );
  sound.armFade(1);
  const first = sound.tick(true, 0).outputs;
  assert.deepEqual(first[0], { kind: "iigs", event: "system-volume", volume: 0xef });
  assert.equal(first[2]?.kind, "iigs");
  for (let tick = 2; tick <= 15; tick++)
    assert.deepEqual(sound.tick(true, 0).outputs, [
      { kind: "iigs", event: "system-volume", volume: 0xff - tick * 16 },
    ]);
  assert.deepEqual(sound.tick(true, 0), {
    outputs: [
      { kind: "iigs", event: "all-off" },
      { kind: "iigs", event: "system-volume", volume: 0xff },
    ],
    complete: true,
  });
});

it("early PC terminators pass through the same signed v23 conversion as notes", () => {
  for (const id of ["2.272", "2.411", "2.440"] as const) {
    const sound = new SoundPlayback(
      detectProfile(new Map(), id),
      Uint8Array.of(8, 0, 8, 0, 8, 0, 8, 0, 255, 255),
      1,
    );
    const writes = sound
      .tick(true, 255)
      .outputs.flatMap((event) => (event.kind === "psg" ? [...event.bytes] : []));
    assert.deepEqual(
      writes,
      [
        0x8f,
        0,
        0x9e,
        0xaf,
        0,
        0xbe,
        0xcf,
        0,
        0xde,
        0xef,
        ...(id === "2.440" ? [] : [0]),
        0xfe,
        0x9f,
        0xbf,
        0xdf,
        0xff,
      ],
      id,
    );
  }
});

it("early PC speaker rests compare the full control byte while common players use its attenuation", () => {
  const payload = Uint8Array.of(
    8,
    0,
    15,
    0,
    15,
    0,
    15,
    0,
    1,
    0,
    0x23,
    0x81,
    0xbf,
    255,
    255,
    255,
    255,
  );
  for (const id of ["2.089", "2.230", "2.272", "2.411", "2.440"] as const) {
    const sound = new SoundPlayback(detectProfile(new Map(), id), payload, 0);
    assert.deepEqual(sound.tick(true, 0).outputs, [{ kind: "speaker", divisor: 12 * 0x231 }]);
  }
  const sound = new SoundPlayback(detectProfile(new Map(), "2.936"), payload, 0);
  assert.deepEqual(sound.tick(true, 0).outputs, [{ kind: "speaker", divisor: null }]);
});

it("2.001 PC Speaker plays only channel 0 and completes on the next entry", () => {
  // Original 7473..7556 / 7607..766a: 12 * (0x23 * 16 + 1)
  // = 6732 = 0x1a4c (PIT bytes 4c 1a). Other tone pairs and
  // attenuation selectors are skipped; only the full 9f byte silences.
  const sound = new SoundPlayback(
    detectProfile(new Map(), "2.001"),
    Uint8Array.of(
      0x81,
      0x23,
      0x94,
      0xa2,
      0x15,
      0xb0,
      0xc3,
      0x16,
      0xd0,
      0xe4,
      0x17,
      0xf0,
      0,
      0,
      0x9e,
      0x9f,
      0,
    ),
    0,
  );
  assert.equal(sound.durationTicks, 4);
  assert.deepEqual(sound.tick(true, 255), {
    outputs: [{ kind: "speaker", divisor: 6732 }],
    complete: false,
  });
  const held = sound.snapshot();
  assert.deepEqual(sound.tick(true, 0), { outputs: [], complete: false });
  assert.deepEqual(sound.tick(true, 0), {
    outputs: [{ kind: "speaker", divisor: null }],
    complete: false,
  });
  assert.deepEqual(sound.tick(true, 0), {
    outputs: [{ kind: "speaker", divisor: null }],
    complete: true,
  });
  assert.deepEqual(sound.tick(true, 0), { outputs: [], complete: true });
  sound.restore(held);
  assert.deepEqual(sound.tick(true, 0), { outputs: [], complete: false });
});

it("2.001 PC Speaker consumes zero continuation bytes and gates zero divisors off", () => {
  // 81 00 => 12; 80 00 => speaker off; 8f 3f =>
  // 12 * 1023 = 12276 = 0x2ff4. Embedded pair zeros are not row ends.
  const sound = new SoundPlayback(
    detectProfile(new Map(), "2.001"),
    Uint8Array.of(0x81, 0, 0x90, 0, 0x80, 0, 0, 0x8f, 0x3f, 0),
    0,
  );
  for (const divisor of [12, null, 12276])
    assert.deepEqual(sound.tick(true, 0), {
      outputs: [{ kind: "speaker", divisor }],
      complete: false,
    });
  assert.deepEqual(sound.tick(true, 0), {
    outputs: [{ kind: "speaker", divisor: null }],
    complete: true,
  });
});

it("2.001 PC Speaker advances muted rows and gates completion silence with flag 9", () => {
  for (const payload of [Uint8Array.of(0x82, 2), new Uint8Array()]) {
    const sound = new SoundPlayback(detectProfile(new Map(), "2.001"), payload, 0);
    if (payload.length) assert.deepEqual(sound.tick(false, 0), { outputs: [], complete: false });
    assert.deepEqual(sound.tick(false, 0), { outputs: [], complete: true });
  }
  const sound = new SoundPlayback(detectProfile(new Map(), "2.001"), Uint8Array.of(0x82, 2), 0);
  // 12 * 34 = 408 = 0x0198, even without a final row terminator.
  assert.deepEqual(sound.tick(true, 0), {
    outputs: [{ kind: "speaker", divisor: 408 }],
    complete: false,
  });
  assert.deepEqual(sound.stop(), [{ kind: "speaker", divisor: null }]);
});
