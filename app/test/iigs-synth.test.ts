import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IigsSynth, envelopePoints, levelAmplitude, docVolume } from "../src/audio/iigsSynth.ts";
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
    writes: [] as [number, number][],
    setValueAtTime(value: number, at: number) {
      this.writes.push([value, at]);
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
    starts: number[];
    stops: number[];
  }[] = [];
  const gains: { gain: ReturnType<typeof param> }[] = [];
  const ctx = {
    currentTime: 0,
    createGain: () => {
      const gain = { ...node(), gain: param() };
      gains.push(gain);
      return gain;
    },
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
        starts: [] as number[],
        stops: [] as number[],
        start(at: number) {
          this.starts.push(at);
        },
        stop(at: number) {
          this.stops.push(at);
          this.stopped = true;
        },
      };
      sources.push(source);
      return source;
    },
  };
  return { ctx, sources, gains };
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
  return { instance, sources, ctx };
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
    // Note Synthesizer F=$048c; 7,159,090 / 8 / 34 scan Hz,
    // accumulator bits 16..9 for R=0,T=0, over the 44,100 Hz buffer.
    assert.ok(Math.abs(sources[0]!.playbackRate.value - 1.3568547145420669) < 1e-12);
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
    assert.ok(Math.abs(sources[0]!.playbackRate.value - 0.42663988446941276) < 1e-12);
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

it("DOC mix reserves full scale for 32 oscillators at maximum 8-bit volume", () => {
  const { ctx, gains } = fakeContext();
  new IigsSynth(ctx as unknown as BaseAudioContext, {} as AudioNode, {
    doc: new Uint8Array(0x10000),
    bank: { programs: [INSTRUMENT], defaultInstrument: INSTRUMENT },
  });
  // 32 time-multiplexed oscillators, sample magnitude 128, volume 255.
  // Our samples and volume are already divided by 128 and 255 respectively.
  assert.equal(gains[0]!.gain.value, 1 / 32);
  assert.equal(32 * (128 / 128) * (255 / 255) * gains[0]!.gain.value, 1);
  // Zero halts a DOC wave, leaving $01/$ff as its largest sounding samples.
  assert.equal(32 * (127 / 128) * gains[0]!.gain.value, 127 / 128);
});

it("note volume joins the envelope level before conversion to the DOC byte", () => {
  assert.equal(docVolume(127, 127), 255);
  assert.equal(docVolume(127, 111), 127);
  assert.equal(docVolume(111, 111), 63);
  assert.equal(docVolume(90, 96), 13);
  assert.equal(docVolume(0, 127), 1);
  // These five entries round one unit above the exponential floor.
  for (const [level, byte] of [
    [44, 7],
    [60, 14],
    [76, 28],
    [92, 56],
    [108, 112],
  ])
    assert.equal(docVolume(level!, 127), byte);
});

it("the B oscillator receives the pitch-add carry from A", () => {
  const { ctx, sources } = fakeContext();
  const doc = new Uint8Array(0x10000).fill(0x90);
  const w = { ...wave(127, 0x10, 0, -999), waveSize: 18 };
  const instrument = { ...INSTRUMENT, a: [w], b: [w] };
  const instance = new IigsSynth(ctx as unknown as BaseAudioContext, {} as AudioNode, {
    doc,
    bank: { programs: [instrument], defaultInstrument: instrument },
  });
  instance.output({
    kind: "iigs",
    event: "note-on",
    voice: 0,
    channel: 0,
    note: 72,
    volume: 127,
    program: 0,
  });
  // A: F=$0412, B: F=$0413; T=2,R=2 selects accumulator bit 9.
  assert.ok(Math.abs(sources[0]!.playbackRate.value - 1.2146414197189292) < 1e-12);
  assert.ok(Math.abs(sources[1]!.playbackRate.value - 1.2158071024633812) < 1e-12);
});

it("a note on a key-split boundary selects the following wave", () => {
  const { instance, sources } = synth();
  instance.output({
    kind: "iigs",
    event: "note-on",
    voice: 0,
    channel: 0,
    note: 59,
    volume: 127,
    program: 0,
  });
  assert.equal(sources[0]!.buffer!.data.length, 100);
});

it("DOC resolution and table size select the accumulator address bits independently", () => {
  const { ctx, sources } = fakeContext();
  const doc = new Uint8Array(0x10000).fill(0x90);
  const instrument = { ...INSTRUMENT, a: [{ ...wave(127, 0x10, 0), waveSize: 8 }], b: [] };
  const instance = new IigsSynth(ctx as unknown as BaseAudioContext, {} as AudioNode, {
    doc,
    bank: { programs: [instrument], defaultInstrument: instrument },
  });
  instance.output({
    kind: "iigs",
    event: "note-on",
    voice: 0,
    channel: 0,
    note: 50,
    volume: 127,
    program: 0,
  });
  // T=1,R=0 selects bit 8 as the low address bit, doubling the byte rate.
  assert.equal(sources[0]!.buffer!.data.length, 512);
  assert.ok(Math.abs(sources[0]!.playbackRate.value - 0.8532797689388255) < 1e-12);
});

it("DOC table size masks the low wave-pointer bits", () => {
  const { ctx, sources } = fakeContext();
  const doc = new Uint8Array(0x10000).fill(0x90);
  doc.fill(0xa0, 0x1200, 0x1300);
  // T=2 means 1,024 bytes: page $13 starts at $1000, not $1300.
  const instrument = { ...INSTRUMENT, a: [{ ...wave(127, 0x13, 0), waveSize: 18 }], b: [] };
  const instance = new IigsSynth(ctx as unknown as BaseAudioContext, {} as AudioNode, {
    doc,
    bank: { programs: [instrument], defaultInstrument: instrument },
  });
  instance.output({
    kind: "iigs",
    event: "note-on",
    voice: 0,
    channel: 0,
    note: 50,
    volume: 127,
    program: 0,
  });
  assert.equal(sources[0]!.buffer!.data[512], 0.25);
});

it("volume changes during release preserve the falling envelope", () => {
  const { ctx, gains } = fakeContext();
  const instance = new IigsSynth(ctx as unknown as BaseAudioContext, {} as AudioNode, {
    doc: new Uint8Array(0x10000).fill(0x90),
    bank: { programs: [INSTRUMENT], defaultInstrument: INSTRUMENT },
  });
  instance.output({
    kind: "iigs",
    event: "note-on",
    voice: 0,
    channel: 0,
    note: 50,
    volume: 127,
    program: 0,
  });
  instance.output({ kind: "iigs", event: "note-off", voice: 0 }, 2);
  instance.output({ kind: "iigs", event: "volume", channel: 0, volume: 111 }, 3);
  // Attack reached 120 at t=2. Release loses 30 levels in the next second.
  // Combined index 90 + 111 - 127 = 74 produces DOC volume 25.
  assert.deepEqual(
    gains[2]!.gain.writes.findLast(([, time]) => time === 3),
    [25 / 255, 3],
  );
});

it("uploading a sample refreshes a cached table that spans DOC page C0", () => {
  const { ctx, sources } = fakeContext();
  const instrument = { ...INSTRUMENT, a: [{ ...wave(127, 0x80, 0), waveSize: 56 }], b: [] };
  const instance = new IigsSynth(ctx as unknown as BaseAudioContext, {} as AudioNode, {
    doc: new Uint8Array(0x10000).fill(0x90),
    bank: { programs: [instrument], defaultInstrument: instrument },
  });
  const note = {
    kind: "iigs",
    event: "note-on",
    voice: 0,
    channel: 0,
    note: 50,
    volume: 127,
    program: 0,
  } as const;
  instance.output(note);
  assert.equal(sources[0]!.buffer!.data[0x4000], 0.125);
  const data = new Uint8Array(53);
  data[4] = 44; // PCM offset after the embedded instrument
  data[6] = 1; // one uploaded byte
  data[38] = 1; // one A wave
  data[40] = 127;
  data[41] = 0xc0;
  data[43] = 2; // one-shot
  data[52] = 0xa0;
  instance.output({ kind: "iigs", event: "sample", voice: 1, data });
  instance.output(note);
  // The 32 KiB table beginning at $8000 includes the uploaded byte at $C000.
  assert.equal(sources.at(-1)!.buffer!.data[0x4000], 0.25);
});

it("IIgs bank voices start, release and change volume at their supplied tick time", () => {
  const { instance, sources } = synth();
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 69, volume: 127, program: 0 },
    10,
  );
  instance.output(
    { kind: "iigs", event: "note-on", voice: 1, channel: 1, note: 72, volume: 127, program: 0 },
    10,
  );
  assert.deepEqual(
    sources.map((source) => source.starts),
    [[10], [10]],
  );
  assert.equal(sources[0]!.playbackRate.writes[0]![1], 10);
  instance.output({ kind: "iigs", event: "note-off", voice: 0 }, 10 + 1 / 60);
  // One attack update has raised the level to 1; release takes two updates.
  assert.ok(Math.abs(sources[0]!.stops.at(-1)! - (10 + 3 / 60 + 0.01)) < 1e-10);
});

it("an immediate reset cancels IIgs voices whose scheduled all-off has not sounded yet", () => {
  const { instance, sources } = synth();
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 69, volume: 127, program: 0 },
    10,
  );
  instance.output({ kind: "iigs", event: "all-off" }, 11);
  assert.equal(sources[0]!.stops.at(-1), 11);
  instance.stop();
  assert.equal(sources[0]!.stops.at(-1), 0);
});

it("a scheduled IIgs all-off also cuts off notes already in their release", () => {
  const { instance, sources } = synth();
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 69, volume: 127, program: 0 },
    10,
  );
  instance.output({ kind: "iigs", event: "note-off", voice: 0 }, 11);
  assert.ok(sources[0]!.stops.at(-1)! > 11.1);
  instance.output({ kind: "iigs", event: "all-off" }, 11.1);
  assert.equal(sources[0]!.stops.at(-1), 11.1);
});
