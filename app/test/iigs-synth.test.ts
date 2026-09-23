import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IigsSynth, envelopePoints, levelAmplitude } from "../src/audio/iigsSynth.ts";
import type { IigsInstrument, IigsWave } from "../../src/sound/iigsBank.ts";

// docs/fidelity.md "IIgs sound": Note Synthesizer envelopes and DOC wave
// tables, with every expectation computed by hand.

const flat = (breakpoint: number, increment: number) => ({ breakpoint, increment });
const wave = (topKey: number, waveAddr: number, docMode: number, relPitch = 0): IigsWave => ({
  topKey,
  waveAddr,
  waveSize: 0, // T = 0: a 256-byte table
  docMode,
  relPitch,
});

/** Attack to 127 at increment 256, sustain, release to 0 at increment 128. */
const INSTRUMENT: IigsInstrument = {
  envelope: [
    flat(127, 256),
    flat(100, 0),
    flat(0, 128),
    ...Array.from({ length: 5 }, () => flat(0, 0)),
  ],
  releaseSegment: 2,
  priorityIncrement: 32,
  pitchBendRange: 2,
  vibratoDepth: 0,
  vibratoSpeed: 0,
  a: [wave(59, 0x10, 0x00), wave(127, 0x20, 0x02, 256)],
  b: [wave(127, 0x30, 0x01)],
};

describe("iigs envelopes", () => {
  it("levels are logarithmic: 16 steps per 6 dB below full scale", () => {
    assert.equal(levelAmplitude(127), 1);
    assert.equal(levelAmplitude(111), 0.5);
    assert.equal(levelAmplitude(0), 0);
  });

  it("segments ramp at increment/256 levels per 60 Hz update and stop at a sustain", () => {
    // 127 levels at 1 level per update: 127/60 s; segment 1 sustains.
    assert.deepEqual(envelopePoints(INSTRUMENT, 0, 0), {
      points: [
        [0, 0],
        [127 / 60, 127],
      ],
      sustained: true,
    });
    // The release from 127 at half a level per update: 254/60 s to silence.
    assert.deepEqual(envelopePoints(INSTRUMENT, 2, 127), {
      points: [
        [0, 127],
        [254 / 60, 0],
      ],
      sustained: false,
    });
  });
});

function fakeContext() {
  const param = () => ({
    value: 0,
    setValueAtTime(value: number) {
      this.value = value;
    },
    exponentialRampToValueAtTime(value: number) {
      this.value = value;
    },
    cancelScheduledValues() {},
  });
  const node = () => ({ connect() {}, disconnect() {}, stopped: false });
  const sources: {
    buffer: { data: Float32Array } | null;
    loop: boolean;
    playbackRate: ReturnType<typeof param>;
    stopped: boolean;
  }[] = [];
  const ctx = {
    currentTime: 0,
    createGain: () => ({ ...node(), gain: param() }),
    createBuffer: (_channels: number, length: number) => {
      const data = new Float32Array(length);
      return { data, length, getChannelData: () => data };
    },
    createBufferSource: () => {
      const source = {
        ...node(),
        buffer: null,
        loop: false,
        playbackRate: param(),
        start() {},
        stop() {
          this.stopped = true;
        },
      };
      sources.push(source);
      return source;
    },
  };
  return { ctx, sources };
}

function synth() {
  const doc = new Uint8Array(0x10000);
  doc.fill(0x90, 0x1000, 0x1100); // page $10: no zero, loops
  doc.fill(0xa0, 0x2000, 0x2100); // page $20: a zero at 100 halts it
  doc[0x2000 + 100] = 0;
  doc.fill(0xb0, 0x3000, 0x3100);
  const { ctx, sources } = fakeContext();
  const bank = { programs: [INSTRUMENT], defaultInstrument: INSTRUMENT };
  const instance = new IigsSynth(ctx as unknown as BaseAudioContext, {} as AudioNode, {
    doc,
    bank,
  });
  return { instance, sources };
}

describe("iigs synth voices", () => {
  it("picks the wave by top key, halts on a zero byte and skips a halted oscillator", () => {
    const { instance, sources } = synth();
    // Note 69 is above top key 59: the second A wave, page $20, one-shot,
    // relPitch +1 semitone. B is halted, so one source plays.
    instance.output({
      kind: "iigs",
      event: "note-on",
      voice: 0,
      channel: 0,
      note: 69,
      volume: 127,
      program: 0,
    });
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.buffer!.data.length, 100);
    assert.equal(sources[0]!.loop, false);
    // 256 * 440 * 2^(1/12) bytes per second over the 44,100 Hz buffer rate.
    assert.ok(Math.abs(sources[0]!.playbackRate.value - 2.7060753503090935) < 1e-12);
    // $A0 is 32 above the $80 centre: 0.25 full scale.
    assert.equal(sources[0]!.buffer!.data[0], 0.25);
  });

  it("loops a free-running table without a zero byte", () => {
    const { instance, sources } = synth();
    instance.output({
      kind: "iigs",
      event: "note-on",
      voice: 0,
      channel: 0,
      note: 50,
      volume: 127,
      program: 0,
    });
    assert.equal(sources[0]!.buffer!.data.length, 256);
    assert.equal(sources[0]!.loop, true);
    assert.ok(Math.abs(sources[0]!.playbackRate.value - 0.8523603241140174) < 1e-12);
  });

  it("note-off releases the voice and all-off silences every voice", () => {
    const { instance, sources } = synth();
    instance.output({
      kind: "iigs",
      event: "note-on",
      voice: 0,
      channel: 0,
      note: 50,
      volume: 127,
      program: 0,
    });
    instance.output({
      kind: "iigs",
      event: "note-on",
      voice: 1,
      channel: 0,
      note: 52,
      volume: 127,
      program: 0,
    });
    instance.output({ kind: "iigs", event: "note-off", voice: 0 });
    assert.equal(sources[0]!.stopped, true, "the release schedules the stop");
    assert.equal(sources[1]!.stopped, false);
    instance.output({ kind: "iigs", event: "all-off" });
    assert.equal(sources[1]!.stopped, true);
  });
});
