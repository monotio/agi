import assert from "node:assert/strict";
import { test } from "node:test";
import { createSoundDocument } from "../src/sound/document.ts";
import { importMidi, exportMidi } from "../src/sound/midi.ts";
import { bentPitch, divisorPitch, exportedMidiNotes } from "./midiNotes.ts";

function vlq(n: number): number[] {
  const bytes = [n & 127];
  while ((n = Math.floor(n / 128))) bytes.unshift((n & 127) | 128);
  return bytes;
}
function smf(tracks: number[][], division = 480): Uint8Array {
  return Uint8Array.from([
    77,
    84,
    104,
    100,
    0,
    0,
    0,
    6,
    0,
    tracks.length > 1 ? 1 : 0,
    0,
    tracks.length,
    division >> 8,
    division & 255,
    ...tracks.flatMap((data) => [
      77,
      84,
      114,
      107,
      0,
      0,
      (data.length + 4) >> 8,
      (data.length + 4) & 255,
      ...data,
      0,
      255,
      47,
      0,
    ]),
  ]);
}

test("MIDI type 0 running status, velocity and tempo map become hand-computed SOUND bytes", () => {
  const doc = importMidi(
    smf([
      [
        0,
        255,
        81,
        3,
        7,
        161,
        32,
        0,
        144,
        69,
        127,
        ...vlq(480),
        255,
        81,
        3,
        15,
        66,
        64,
        ...vlq(480),
        128,
        69,
        0,
      ],
    ]),
  ).document;
  assert.deepEqual(
    [...doc.encode()],
    [8, 0, 15, 0, 17, 0, 19, 0, 90, 0, 15, 142, 144, 255, 255, 255, 255, 255, 255, 255, 255],
  );
  const running = importMidi(smf([[0, 144, 69, 64, ...vlq(480), 69, 0]])).document;
  assert.deepEqual([...running.encode().slice(8, 13)], [30, 0, 15, 142, 151]);
});

test("MIDI highest-note reduction resumes held notes, folds low pitches and maps channel 10 drums", () => {
  const result = importMidi(
    smf([
      [
        0,
        144,
        21,
        127,
        ...vlq(240),
        144,
        81,
        127,
        ...vlq(240),
        128,
        81,
        0,
        ...vlq(480),
        128,
        21,
        0,
      ],
      [0, 153, 38, 127, ...vlq(480), 137, 38, 0],
    ]),
  );
  assert.deepEqual(
    result.document.tracks()![0]!.map((n) => [n.durationTicks, n.data]),
    [
      [15, { kind: "tone", divisor: 1017, attenuation: 0 }],
      [15, { kind: "tone", divisor: 127, attenuation: 0 }],
      [30, { kind: "tone", divisor: 1017, attenuation: 0 }],
    ],
  );
  assert.deepEqual(result.document.tracks()![3]![0]!.data, {
    kind: "noise",
    control: 5,
    attenuation: 0,
  });
  assert.match(result.summary, /1 chord note shortened.*1 note moved up by octaves/);
});

test("MIDI selects the three busiest track/channel pairs deterministically", () => {
  const tracks = [60, 64, 67, 69].map((note, i) =>
    Array.from({ length: i + 1 }, () => [
      0,
      144 | i,
      note,
      127,
      ...vlq(480),
      128 | i,
      note,
      0,
    ]).flat(),
  );
  const result = importMidi(smf(tracks));
  assert.deepEqual(
    result.document
      .tracks()!
      .slice(0, 3)
      .map((t) => t.filter((n) => n.data.kind === "tone").length),
    [2, 3, 4],
  );
  assert.match(result.summary, /1 melody part omitted/);
});

test("MIDI export is type 1 with four named voice tracks and round trips musical values", () => {
  const doc = createSoundDocument()
    .insertEvent(0, 0, { ticks: 7, data: { kind: "rest" } })
    .insertEvent(0, 1, { ticks: 23, data: { kind: "tone", note: "A4", attenuation: 3 } })
    .insertEvent(2, 0, { ticks: 17, data: { kind: "tone", note: "C5", attenuation: 7 } })
    .insertEvent(3, 0, { ticks: 6, data: { kind: "noise", control: 2, attenuation: 5 } });
  const bytes = exportMidi(doc).bytes;
  assert.deepEqual([...bytes.slice(0, 14)], [77, 84, 104, 100, 0, 0, 0, 6, 0, 1, 0, 5, 0, 60]);
  assert.deepEqual(importMidi(bytes).document.encode(), doc.encode());
});

test("MIDI rejects malformed, unsupported and unbounded inputs", () => {
  assert.throws(() => importMidi(Uint8Array.from([77, 84, 104, 100])), /MIDI/);
  assert.throws(() => importMidi(smf([[0, 69, 127]])), /status/i);
  assert.throws(() => importMidi(smf([[0, 255, 81, 3, 0, 0, 0]])), /tempo/i);
  assert.throws(
    () => importMidi(smf([[0, 144, 69, 127, 255, 255, 255, 255, 0]])),
    /variable|delta/i,
  );
});

test("type 1 conductor tempo changes govern every track and the last tick-zero tempo wins", () => {
  const result = importMidi(
    smf([
      [0, 255, 81, 3, 15, 66, 64, 0, 255, 81, 3, 7, 161, 32],
      [...vlq(480), 144, 69, 127, ...vlq(480), 128, 69, 0],
    ]),
  );
  assert.equal(result.tempo, 120);
  assert.deepEqual(
    [...result.document.encode().slice(8, 18)],
    [30, 0, 0, 128, 159, 30, 0, 15, 142, 144],
  );
});

test("export and reimport retain empty voices and trailing rests", () => {
  const doc = createSoundDocument()
    .insertEvent(0, 0, { ticks: 12, data: { kind: "rest" } })
    .insertEvent(2, 0, { ticks: 17, data: { kind: "tone", note: "A4", attenuation: 3 } })
    .insertEvent(2, 1, { ticks: 9, data: { kind: "rest" } });
  assert.deepEqual(importMidi(exportMidi(doc).bytes).document.encode(), doc.encode());
});

const BEND_RANGE_RPN = [0, 177, 101, 0, 0, 177, 100, 0, 0, 177, 6, 2, 0, 177, 38, 0];

test("MIDI export keeps a tune's tuning: note names follow the shared offset and bends play the divisor pitch", () => {
  // A tune about 45 cents sharp of A440, the way King's Quest I's theme is.
  // Rounding each divisor on its own would scatter neighbours a semitone
  // apart; the shared offset keeps B4 D5 A5 B5 D6, and bends keep the pitch.
  // Divisor pitches: 71.425, 74.409, 81.429, 83.347 and 86.409 semitones from
  // MIDI 0, so the shared offset is their mean distance above the nearest
  // semitone, 0.404 = 40 cents.
  const divisors = [221, 186, 124, 111, 93];
  let doc = createSoundDocument();
  divisors.forEach((divisor, index) => {
    doc = doc.insertEvent(1, index, { ticks: 10, data: { kind: "tone", divisor, attenuation: 2 } });
  });
  const exported = exportMidi(doc);
  assert.equal(exported.tuningCents, 40);
  assert.deepEqual(exported.warnings, []);
  const notes = exportedMidiNotes(exported.bytes);
  assert.deepEqual(
    notes.map((n) => [n.track, n.note]),
    [71, 74, 81, 83, 86].map((note) => [2, note]),
  );
  // Voice 2 declares a two-semitone bend range right after its name.
  const name = [0, 255, 3, 7, ...[..."Voice 2"].map((c) => c.charCodeAt(0))];
  const at = [...exported.bytes].findIndex((_, i) =>
    name.every((byte, j) => exported.bytes[i + j] === byte),
  );
  assert.ok(at > 0);
  assert.deepEqual(
    [...exported.bytes.subarray(at + name.length, at + name.length + 16)],
    BEND_RANGE_RPN,
  );
  // Each wheel position restores the divisor frequency within a cent.
  notes.forEach((n, index) => {
    assert.ok(Math.abs(100 * (bentPitch(n) - divisorPitch(divisors[index]!))) < 1, `note ${index}`);
  });
  // Re-importing honours the bends: the same divisors come back.
  assert.deepEqual(
    importMidi(exported.bytes)
      .document.tracks()![1]!
      .map((e) => (e.data.kind === "tone" ? e.data.divisor : e.data.kind)),
    divisors,
  );
});

test("MIDI export writes near-A440 notes with small bends and raw events as silence with a warning", () => {
  const doc = createSoundDocument()
    .insertEvent(0, 0, { ticks: 23, data: { kind: "tone", note: "A4", attenuation: 3 } })
    .insertEvent(0, 1, {
      ticks: 7,
      data: { kind: "raw", toneLow: 1, toneHigh: 0x9f, control: 0x9f },
    })
    .insertEvent(0, 2, { ticks: 11, data: { kind: "tone", note: "A5", attenuation: 3 } });
  const exported = exportMidi(doc);
  assert.ok(Math.abs(exported.tuningCents) <= 2);
  assert.deepEqual(exported.warnings, [
    "1 event holds raw bytes instead of a note, so it is silent in the MIDI file.",
  ]);
  const notes = exportedMidiNotes(exported.bytes);
  assert.deepEqual(
    notes.map((n) => [n.track, n.note]),
    [
      [1, 69],
      [1, 81],
    ],
  );
  for (const n of notes)
    assert.ok(Math.abs(n.wheel - 8192) < 100, "the chip's A sits within 2 cents");
  // The raw event's time is kept as silence: 23 ticks, 7 rest, 11 ticks.
  assert.deepEqual(
    importMidi(exported.bytes)
      .document.tracks()![0]!
      .map((e) => [e.data.kind, e.durationTicks]),
    [
      ["tone", 23],
      ["rest", 7],
      ["tone", 11],
    ],
  );
});

test("an opaque sound document refuses MIDI export in plain words", () => {
  const opaque = { tracks: () => null } as unknown as Parameters<typeof exportMidi>[0];
  assert.throws(() => exportMidi(opaque), /no notes to write as MIDI/);
});
