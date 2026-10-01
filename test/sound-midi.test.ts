import assert from "node:assert/strict";
import { test } from "node:test";
import { createSoundDocument } from "../src/sound/document.ts";
import { importMidi, exportMidi } from "../src/sound/midi.ts";

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
    [8, 0, 15, 0, 17, 0, 19, 0, 90, 0, 14, 130, 144, 255, 255, 255, 255, 255, 255, 255, 255],
  );
  const running = importMidi(smf([[0, 144, 69, 64, ...vlq(480), 69, 0]])).document;
  assert.deepEqual([...running.encode().slice(8, 13)], [30, 0, 14, 130, 151]);
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
      [15, { kind: "tone", divisor: 904, attenuation: 0 }],
      [15, { kind: "tone", divisor: 113, attenuation: 0 }],
      [30, { kind: "tone", divisor: 904, attenuation: 0 }],
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
  const bytes = exportMidi(doc);
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
    [30, 0, 0, 128, 159, 30, 0, 14, 130, 144],
  );
});

test("export and reimport retain empty voices and trailing rests", () => {
  const doc = createSoundDocument()
    .insertEvent(0, 0, { ticks: 12, data: { kind: "rest" } })
    .insertEvent(2, 0, { ticks: 17, data: { kind: "tone", note: "A4", attenuation: 3 } })
    .insertEvent(2, 1, { ticks: 9, data: { kind: "rest" } });
  assert.deepEqual(importMidi(exportMidi(doc)).document.encode(), doc.encode());
});
