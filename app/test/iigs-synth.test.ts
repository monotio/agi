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

  it("NoteOn advances immediately and sustain retains the clamped breakpoint volume", () => {
    const attack = envelopePoints(INSTRUMENT, 0, 0);
    assert.equal(attack.sustained, true);
    assert.deepEqual(attack.points[0], [0, 1]);
    assert.deepEqual(attack.points.at(-1), [126 / 60, 127]);
    assert.deepEqual(attack.levels.at(-1), [127 / 60, 127]);
    const release = envelopePoints(INSTRUMENT, 2, 127);
    assert.equal(release.sustained, false);
    assert.deepEqual(release.points[0], [0, 127]);
    assert.deepEqual(release.points.at(-1), [254 / 60, 0]);
    assert.equal(release.duration, 254 / 60);
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
    onended: (() => void) | null;
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
        onended: null as (() => void) | null,
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
  const { ctx, sources, gains } = fakeContext();
  const bank = { programs: [INSTRUMENT], defaultInstrument: INSTRUMENT };
  const instance = new IigsSynth(ctx as unknown as BaseAudioContext, {} as AudioNode, {
    doc,
    bank,
  });
  return { instance, sources, ctx, gains };
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
    const { instance, sources, gains } = synth();
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
    assert.deepEqual(
      gains[2]!.gain.writes.at(-1),
      [0, 2 / 60],
      "NoteOff arms the release before its falling updates",
    );
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

it("controller 7 leaves a released generator to its original envelope", () => {
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
  // The channel table was cleared by NoteOff. Controller 7 skips this
  // generator; its original volume 127 combines with level 91 (DOC byte 53).
  assert.deepEqual(
    gains[2]!.gain.writes.findLast(([, time]) => time === 3),
    [53 / 255, 3],
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
  const { instance, sources, gains } = synth();
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 50, volume: 127, program: 0 },
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
  // NoteOn writes level 1 immediately; tick one reaches level 2.
  // NoteOff's transition heartbeat holds that level; four falling updates
  // then reach zero. Quiet generators remain reusable without a fixed stop.
  assert.equal(gains[2]!.gain.writes.at(-1)![0], 0);
  assert.ok(Math.abs(gains[2]!.gain.writes.at(-1)![1] - (10 + 5 / 60)) < 1e-10);
});

it("an immediate reset cancels IIgs voices whose scheduled all-off has not sounded yet", () => {
  const { instance, sources } = synth();
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 50, volume: 127, program: 0 },
    10,
  );
  instance.output({ kind: "iigs", event: "all-off" }, 11);
  assert.equal(sources[0]!.stops.at(-1), 11);
  instance.stop();
  assert.equal(sources[0]!.stops.at(-1), 0);
});

it("a scheduled IIgs all-off also cuts off notes already in their release", () => {
  const { instance, sources, gains } = synth();
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 50, volume: 127, program: 0 },
    10,
  );
  instance.output({ kind: "iigs", event: "note-off", voice: 0 }, 11);
  assert.ok(gains[2]!.gain.writes.at(-1)![1] > 11.1);
  instance.output({ kind: "iigs", event: "all-off" }, 11.1);
  assert.equal(sources[0]!.stops.at(-1), 11.1);
});

it("TOOL025 applies the first attack update at NoteOn and clamps at its breakpoint", () => {
  const { ctx, gains } = fakeContext();
  const instrument = {
    ...INSTRUMENT,
    envelope: [
      flat(100, 16384),
      flat(100, 0),
      flat(0, 256),
      ...Array.from({ length: 5 }, () => flat(0, 0)),
    ],
  };
  const instance = new IigsSynth(ctx as unknown as BaseAudioContext, {} as AudioNode, {
    doc: new Uint8Array(0x10000).fill(0x90),
    bank: { programs: [instrument], defaultInstrument: instrument },
  });
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 50, volume: 127, program: 0 },
    10,
  );
  // First update: 0+64=64. The next update clamps to 100 and writes it;
  // the following zero-increment sustain leaves that DOC volume latched.
  assert.deepEqual(gains[2]!.gain.writes, [
    [0, 10],
    [docVolume(64, 127) / 255, 10],
    [docVolume(100, 127) / 255, 10 + 1 / 60],
  ]);
});

it("TOOL025 has fourteen generators and steals the oldest equal-priority note at the scheduled time", () => {
  const { instance, sources } = synth();
  for (let voice = 0; voice < 15; voice++)
    instance.output(
      { kind: "iigs", event: "note-on", voice, channel: 0, note: 50, volume: 127, program: 0 },
      10,
    );
  assert.deepEqual(sources[0]!.stops, [10]);
  assert.equal(sources.slice(1).filter((source) => source.stopped).length, 0);
});

it("controller 7 writes the DOC byte directly for a channel generator", () => {
  const { ctx, gains } = fakeContext();
  const instance = new IigsSynth(ctx as unknown as BaseAudioContext, {} as AudioNode, {
    doc: new Uint8Array(0x10000).fill(0x90),
    bank: { programs: [INSTRUMENT], defaultInstrument: INSTRUMENT },
  });
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 50, volume: 127, program: 0 },
    0,
  );
  instance.output({ kind: "iigs", event: "volume", channel: 0, volume: 80 }, 1.1);
  assert.deepEqual(gains[2]!.gain.writes.at(-1), [80 / 255, 1.1]);
});

it("duplicate pitch releases the highest generator slot and the next allocation reuses its lower priority", () => {
  const { instance, sources } = synth();
  for (let voice = 0; voice < 14; voice++)
    instance.output(
      { kind: "iigs", event: "note-on", voice, channel: 0, note: 50, volume: 127, program: 0 },
      10,
    );
  // SQ2's per-channel generator table is searched from slot 14 down to 0.
  // The request id is deliberately the oldest: the original uses slot 13.
  instance.output({ kind: "iigs", event: "note-off", voice: 0, channel: 0, note: 50 }, 10 + 1 / 60);
  assert.equal(sources[0]!.stopped, false);
  assert.equal(
    sources[13]!.stopped,
    false,
    "release programs the envelope rather than fixing an irrevocable source stop",
  );
  instance.output(
    { kind: "iigs", event: "note-on", voice: 14, channel: 1, note: 51, volume: 127, program: 0 },
    10 + 1 / 60,
  );
  assert.equal(sources[13]!.stops.at(-1), 10 + 1 / 60);
  assert.equal(sources[0]!.stopped, false);
});

it("a raw controller write lasts until the next envelope update even when its DOC byte repeats", () => {
  const { ctx, gains } = fakeContext();
  const slow = {
    ...INSTRUMENT,
    envelope: [flat(100, 1), flat(100, 0), ...Array.from({ length: 6 }, () => flat(0, 0))],
  };
  const instance = new IigsSynth(ctx as unknown as BaseAudioContext, {} as AudioNode, {
    doc: new Uint8Array(0x10000).fill(0x90),
    bank: { programs: [slow], defaultInstrument: slow },
  });
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 50, volume: 127, program: 0 },
    0,
  );
  instance.output({ kind: "iigs", event: "volume", channel: 0, volume: 80 }, 1 / 120);
  assert.deepEqual(
    gains[2]!.gain.writes.findLast(([, at]) => at === 1 / 60),
    [1 / 255, 1 / 60],
  );
});

it("DOC one-shot completion leaves its Note Synthesizer generator allocated until the envelope ends", () => {
  const { instance, sources } = synth();
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 69, volume: 127, program: 0 },
    0,
  );
  instance.output(
    { kind: "iigs", event: "note-on", voice: 1, channel: 1, note: 50, volume: 127, program: 0 },
    1,
  );
  assert.deepEqual(
    sources[0]!.stops,
    [],
    "the second allocation takes free slot 1 rather than recycling the halted slot 0",
  );
});

it("releasing a finite contour can replace its early stop with a longer release", () => {
  const { ctx, gains } = fakeContext();
  const finite = {
    ...INSTRUMENT,
    releaseSegment: 3,
    envelope: [
      flat(127, 32512),
      flat(0, 32512),
      flat(0, 0),
      flat(0, 128),
      ...Array.from({ length: 4 }, () => flat(0, 0)),
    ],
  };
  const instance = new IigsSynth(ctx as unknown as BaseAudioContext, {} as AudioNode, {
    doc: new Uint8Array(0x10000).fill(0x90),
    bank: { programs: [finite], defaultInstrument: finite },
  });
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 50, volume: 127, program: 0 },
    0,
  );
  instance.output({ kind: "iigs", event: "note-off", voice: 0 }, 0);
  assert.equal(gains[2]!.gain.writes.at(-1)![0], 0);
  assert.ok(gains[2]!.gain.writes.at(-1)![1] > 4);
  assert.deepEqual(
    gains[2]!.gain.writes.findLast(([, at]) => at === 1 / 60),
    [244 / 255, 1 / 60],
  );
});

it("retiring a scheduled bank graph disconnects it after its last oscillator ends", () => {
  const { instance, sources } = synth();
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 50, volume: 127, program: 0 },
    10,
  );
  let disposed = false;
  instance.dispose(11, () => {
    disposed = true;
  });
  assert.equal(disposed, false);
  assert.equal(sources[0]!.stops.at(-1), 11);
  sources[0]!.onended!();
  assert.equal(disposed, true);
});

it("reusing a host voice handle replaces its previous oscillator pair", () => {
  const { instance, sources } = synth();
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 50, volume: 127, program: 0 },
    0,
  );
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 52, volume: 127, program: 0 },
    1,
  );
  assert.equal(sources[0]!.stops.at(-1), 1);
  instance.stop(2);
  assert.equal(sources[1]!.stops.at(-1), 2);
});

it("NoteOn and odd 60 Hz heartbeats step TOOL025 vibrato on both oscillators across NoteOff", () => {
  // TOOL025+0686..0749 with SQ2 program 16's vibratoDepth=66, vibratoSpeed=25:
  // step 0 (at=0, phase=25):     lfo[25]=105, 105+66-128=43,  vol[43]=6  -> +12
  // step 1 (at=1/60, phase=50):  lfo[50]=121, 121+66-128=59,  vol[59]=13 -> +26
  // step 2 (at=3/60, phase=75):  lfo[75]=120, 120+66-128=58,  vol[58]=12 -> +24
  // step 3 (at=5/60, phase=100): lfo[100]=106, 106+66-128=44, vol[44]=7  -> +14
  // step 4 (at=7/60, phase=125): lfo[125]=54,  54+66-128=-8   (bmi)      ->   0
  // step 5 (at=9/60, phase=150): lfo[150^255=105]=102, 102+66-128=40, vol[40]=5, eor #$ffff; asl a -> -12
  const { ctx, sources } = fakeContext();
  const vibratoInst: IigsInstrument = {
    ...INSTRUMENT,
    vibratoDepth: 66,
    vibratoSpeed: 25,
    releaseSegment: 2,
    b: [wave(127, 0x30, 0x00)],
    envelope: [
      flat(127, 32512),
      flat(0, 32512),
      flat(0, 2048),
      ...Array.from({ length: 5 }, () => flat(0, 0)),
    ],
  };
  const instance = new IigsSynth(ctx as unknown as BaseAudioContext, {} as AudioNode, {
    doc: new Uint8Array(0x10000).fill(0x90),
    bank: { programs: [vibratoInst], defaultInstrument: vibratoInst },
  });
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 50, volume: 127, program: 0 },
    0,
  );
  // Release at 0 replaces the 1-tick contour with a 16-tick release without resetting vibrato phase.
  instance.output({ kind: "iigs", event: "note-off", voice: 0 }, 0);
  const scanHz = 7159090 / 8 / 34;
  const expectedRate = (offset: number) => {
    const pitch = (50 * 256 + offset) & 0x7fff & ~1;
    const freq =
      Math.floor(20905.466 * 2 ** ((pitch % 3072) / 3072)) >> (10 - Math.floor(pitch / 3072));
    return (scanHz * freq) / 512 / 44100;
  };
  const expectedOffsets: [number, number][] = [
    [0, 12],
    [1 / 60, 26],
    [3 / 60, 24],
    [5 / 60, 14],
    [7 / 60, 0],
    [9 / 60, -12],
  ];
  for (const [carrier, modulation] of [
    [sources[0]!, sources[1]!],
    [sources[2]!, sources[3]!],
  ]) {
    assert.equal(carrier.playbackRate.writes[1]![0], expectedRate(12));
    assert.deepEqual(carrier.playbackRate.writes.at(-1), [0, 1 / 60]);
    assert.deepEqual(modulation.starts, [1 / 60]);
    for (const [i, [, offset]] of expectedOffsets.slice(1).entries())
      assert.equal(modulation.buffer!.data[i * 1470], Math.fround(expectedRate(offset)));
    assert.deepEqual(modulation.stops, [], "NoteOff keeps the same vibrato cycle");
  }
});

it("sustained vibrato loops through phase wrap beyond ten seconds and stops with its voice", () => {
  const { ctx, sources } = fakeContext();
  const instrument: IigsInstrument = { ...INSTRUMENT, vibratoDepth: 66, vibratoSpeed: 25 };
  const instance = new IigsSynth(ctx as unknown as BaseAudioContext, {} as AudioNode, {
    doc: new Uint8Array(0x10000).fill(0x90),
    bank: { programs: [instrument], defaultInstrument: instrument },
  });
  instance.output(
    { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 50, volume: 127, program: 0 },
    0,
  );
  const modulation = sources.find((source) => source.starts[0] === 1 / 60);
  assert.ok(modulation, "a looping control signal continues without a scheduling deadline");
  assert.equal(modulation.loop, true);
  assert.equal(
    modulation.buffer!.data.length,
    256 * 1470,
    "speed 25 returns to the same phase after 256 updates",
  );
  assert.notEqual(modulation.buffer!.data[0], modulation.buffer!.data[4 * 1470]);
  instance.stop(12);
  assert.equal(modulation.stops.at(-1), 12);
});
