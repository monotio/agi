import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { soundFeedback } from "../src/agent/soundFeedback.ts";
import { buildSound } from "../src/agent/tools.ts";

function decodedRgb(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const colorType = png[25]!;
  let cursor = 8;
  let idat: Uint8Array | null = null;
  let palette: Uint8Array | null = null;
  while (cursor < png.length) {
    const length = view.getUint32(cursor);
    const type = String.fromCharCode(
      png[cursor + 4]!,
      png[cursor + 5]!,
      png[cursor + 6]!,
      png[cursor + 7]!,
    );
    if (type === "PLTE") palette = png.slice(cursor + 8, cursor + 8 + length);
    if (type === "IDAT") idat = png.slice(cursor + 8, cursor + 8 + length);
    cursor += 12 + length;
  }
  assert.ok(idat);
  const rows = new Uint8Array(inflateSync(idat));
  const rgb = new Uint8Array(width * height * 3);
  const sourceStride = colorType === 3 ? width : width * 3;
  for (let y = 0; y < height; y++) {
    const row = y * (sourceStride + 1);
    assert.equal(rows[row], 0, `row ${y} uses the expected no-filter encoding`);
    if (colorType === 3) {
      assert.ok(palette);
      for (let x = 0; x < width; x++) {
        const source = rows[row + 1 + x]! * 3;
        rgb.set(palette.subarray(source, source + 3), (y * width + x) * 3);
      }
    } else {
      rgb.set(rows.subarray(row + 1, row + 1 + sourceStride), y * width * 3);
    }
  }
  return { width, height, rgb };
}

function pixel(rgb: Uint8Array, width: number, x: number, y: number): number[] {
  return [...rgb.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
}

function fixture(): Uint8Array {
  return buildSound([
    {
      notes: [
        { freqDivisor: 226, duration: 30, attenuation: 0 },
        { note: "rest", duration: 30, attenuation: 15 },
        { freqDivisor: 380, duration: 60, attenuation: 3 },
      ],
    },
    { notes: [{ note: "E4", duration: 30, attenuation: 2 }] },
    { notes: [] },
    {
      notes: [
        { freqDivisor: 0, duration: 30, attenuation: 4 },
        { freqDivisor: 3, duration: 30, attenuation: 5 },
        { freqDivisor: 7, duration: 30, attenuation: 15 },
      ],
    },
  ]);
}

test("music feedback reports raw events, hand-computed onsets, pitch, rests, and beats", () => {
  const feedback = soundFeedback(fixture(), {
    num: 7,
    channel: null,
    offset: 0,
    limit: 16,
    tempo: 120,
    representation: "music",
  });

  assert.deepEqual(feedback.channels, [
    { channel: 0, label: "tone 1", notes: 3, durationTicks: 120, durationSeconds: 2 },
    { channel: 1, label: "tone 2", notes: 1, durationTicks: 30, durationSeconds: 0.5 },
    { channel: 2, label: "tone 3", notes: 0, durationTicks: 0, durationSeconds: 0 },
    { channel: 3, label: "noise", notes: 3, durationTicks: 90, durationSeconds: 1.5 },
  ]);
  assert.equal(feedback.totalNotes, 7);

  const a4 = feedback.events[0]!;
  assert.deepEqual(
    {
      channel: a4.channel,
      index: a4.index,
      tone: a4.tone,
      control: a4.control,
      freqDivisor: a4.freqDivisor,
      duration: a4.duration,
      attenuation: a4.attenuation,
      rest: a4.rest,
      noteName: a4.noteName,
      midiNote: a4.midiNote,
      startTick: a4.startTick,
      endTick: a4.endTick,
      startSeconds: a4.startSeconds,
      durationSeconds: a4.durationSeconds,
      volume: a4.volume,
      startBeat: a4.startBeat,
      durationBeats: a4.durationBeats,
    },
    {
      channel: 0,
      index: 0,
      tone: 0x820e,
      control: 0x90,
      freqDivisor: 226,
      duration: 30,
      attenuation: 0,
      rest: false,
      noteName: "A4",
      midiNote: 69,
      startTick: 0,
      endTick: 30,
      startSeconds: 0,
      durationSeconds: 0.5,
      volume: 15,
      startBeat: 0,
      durationBeats: 1,
    },
  );
  assert.ok(Math.abs(a4.frequencyHz! - 439.963) < 0.001);
  assert.ok(Math.abs(a4.centsOffset!) < 0.2);

  assert.deepEqual(
    {
      rest: feedback.events[1]!.rest,
      noteName: feedback.events[1]!.noteName,
      midiNote: feedback.events[1]!.midiNote,
      startTick: feedback.events[1]!.startTick,
      endTick: feedback.events[1]!.endTick,
    },
    { rest: true, noteName: null, midiNote: null, startTick: 30, endTick: 60 },
  );
  assert.equal(feedback.events[2]!.startTick, 60);
  assert.equal(feedback.events[3]!.startTick, 0, "each channel has its own onset timeline");

  const periodicHigh = feedback.events[4]!;
  assert.deepEqual(
    {
      tone: periodicHigh.tone,
      freqDivisor: periodicHigh.freqDivisor,
      noiseSelector: periodicHigh.noiseSelector,
      noise: periodicHigh.noise,
      rest: periodicHigh.rest,
      volume: periodicHigh.volume,
      frequencyHz: periodicHigh.frequencyHz,
    },
    {
      tone: null,
      freqDivisor: null,
      noiseSelector: 0,
      noise: "periodic-high",
      rest: false,
      volume: 11,
      frequencyHz: null,
    },
    "noise selector zero is audible when attenuation is below 15",
  );
  assert.equal(feedback.events[5]!.noise, "periodic-tone3-clock");
  assert.equal(feedback.events[5]!.startBeat, 1);
  assert.equal(feedback.events[5]!.durationBeats, 1);
  assert.equal(feedback.events[6]!.noise, "white-tone3-clock");
  assert.equal(feedback.events[6]!.rest, true);
});

test("paging retains full-channel onsets and unknown tempo omits beat fields", () => {
  const channelPage = soundFeedback(fixture(), {
    num: 7,
    channel: 0,
    offset: 2,
    limit: 1,
    representation: "music",
  });
  assert.equal(channelPage.totalNotes, 3);
  assert.deepEqual(
    {
      index: channelPage.events[0]!.index,
      startTick: channelPage.events[0]!.startTick,
      endTick: channelPage.events[0]!.endTick,
    },
    { index: 2, startTick: 60, endTick: 120 },
  );
  assert.equal("startBeat" in channelPage.events[0]!, false);
  assert.equal("durationBeats" in channelPage.events[0]!, false);

  const allChannelsPage = soundFeedback(fixture(), {
    num: 7,
    channel: null,
    offset: 3,
    limit: 1,
    representation: "sound",
    tempo: 120,
  });
  assert.deepEqual(
    {
      channel: allChannelsPage.events[0]!.channel,
      index: allChannelsPage.events[0]!.index,
      startTick: allChannelsPage.events[0]!.startTick,
    },
    { channel: 1, index: 0, startTick: 0 },
    "all-channel paging stays channel-major without borrowing the prior channel onset",
  );
  assert.equal("noteName" in allChannelsPage.events[0]!, false);
  assert.equal("midiNote" in allChannelsPage.events[0]!, false);
  assert.equal("centsOffset" in allChannelsPage.events[0]!, false);
  assert.equal("startBeat" in allChannelsPage.events[0]!, false);
  assert.match(allChannelsPage.image.caption, /pulse \/ noise sound timeline/i);
  assert.match(allChannelsPage.image.caption, /log frequency range 50-5000 Hz/i);

  const silentDivisor = soundFeedback(
    buildSound([
      { notes: [{ freqDivisor: 0, duration: 5, attenuation: 0 }] },
      { notes: [] },
      { notes: [] },
      { notes: [] },
    ]),
    { num: 8, channel: 0, offset: 0, limit: 1, representation: "sound" },
  ).events[0]!;
  assert.deepEqual(
    {
      rest: silentDivisor.rest,
      attenuation: silentDivisor.attenuation,
      volume: silentDivisor.volume,
    },
    { rest: true, attenuation: 15, volume: 0 },
  );
});

test("the bounded piano roll aligns time and pitch and includes concurrent unpaged voices", () => {
  const samePitch = buildSound([
    { notes: [{ freqDivisor: 226, duration: 30, attenuation: 0 }] },
    { notes: [{ freqDivisor: 226, duration: 30, attenuation: 2 }] },
    { notes: [{ note: "E4", duration: 30, attenuation: 3 }] },
    { notes: [{ freqDivisor: 0, duration: 30, attenuation: 4 }] },
  ]);
  const feedback = soundFeedback(samePitch, {
    num: 7,
    channel: 0,
    offset: 0,
    limit: 1,
    tempo: 120,
    representation: "music",
  });
  assert.deepEqual(feedback.preview, {
    startTick: 0,
    endTick: 30,
    startSeconds: 0,
    endSeconds: 0.5,
    truncated: false,
    truncatedBefore: false,
    truncatedAfter: false,
    width: 800,
    height: 400,
  });
  assert.match(feedback.image.caption, /0\.00.*0\.50 seconds.*event 1 of 1/i);
  const { width, height, rgb } = decodedRgb(feedback.image.png);
  assert.deepEqual([width, height], [800, 400]);

  // Plot x=96..779 spans ticks 0..30. The visible tones dynamically select
  // MIDI 48..72; A4 is y=85 with channel stripes on either side of that pitch.
  assert.deepEqual(pixel(rgb, width, 400, 81), [56, 189, 248], "paged tone 1 A4 is cyan");
  assert.deepEqual(
    pixel(rgb, width, 400, 85),
    [192, 132, 252],
    "simultaneous tone 2 A4 remains visible instead of overwriting tone 1",
  );
  assert.deepEqual(
    pixel(rgb, width, 400, 351),
    [74, 222, 128],
    "concurrent audible noise occupies its separate lane",
  );
});

test("the music pitch window expands to show tones above a conventional piano", () => {
  const high = buildSound([
    { notes: [{ freqDivisor: 2, duration: 30, attenuation: 0 }] },
    { notes: [] },
    { notes: [] },
    { notes: [] },
  ]);
  const feedback = soundFeedback(high, {
    num: 11,
    channel: null,
    offset: 0,
    limit: 1,
    representation: "music",
  });
  assert.equal(feedback.events[0]!.midiNote, 151);
  assert.match(feedback.image.caption, /pitch range C10-C12/i);
  const { width, rgb } = decodedRgb(feedback.image.png);
  assert.deepEqual(pixel(rgb, width, 400, 101), [56, 189, 248]);
});

test("preview duration is capped instead of compressing a long effect into one image", () => {
  const long = buildSound([
    { notes: [{ freqDivisor: 226, duration: 65534, attenuation: 0 }] },
    { notes: [] },
    { notes: [] },
    { notes: [] },
  ]);
  const feedback = soundFeedback(long, {
    num: 9,
    channel: null,
    offset: 0,
    limit: 1,
    representation: "sound",
  });
  assert.equal(feedback.preview.startSeconds, 0);
  assert.equal(feedback.preview.endSeconds, 20);
  assert.equal(feedback.preview.truncatedAfter, true);
  assert.match(feedback.image.caption, /preview capped at 20\.00 seconds/i);
  assert.throws(
    () =>
      soundFeedback(new Uint8Array(65_536), {
        num: 10,
        channel: null,
        offset: 0,
        limit: 1,
        representation: "sound",
      }),
    /payload exceeds 65535 bytes/i,
  );
});
