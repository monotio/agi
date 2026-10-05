import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgiAudio, type AudioMode } from "../src/audio/AgiAudio.ts";
import {
  nextAudioMode,
  soundChipLabel,
  soundFamily,
  useAudioController,
} from "../src/audio/useAudioController.ts";

function context() {
  const params = () => ({
    value: 0,
    values: [] as [number, number][],
    setValueAtTime(value: number, at: number) {
      this.value = value;
      this.values.push([value, at]);
    },
    exponentialRampToValueAtTime(value: number, at: number) {
      this.value = value;
      this.values.push([value, at]);
    },
    cancelScheduledValues() {},
  });
  const node = () => ({
    stopped: false,
    connect() {},
    disconnect() {},
    starts: [] as number[][],
    start(...args: number[]) {
      this.starts.push(args);
    },
    stop() {
      this.stopped = true;
    },
  });
  type Gain = ReturnType<typeof node> & { gain: ReturnType<typeof params> };
  const gains: Gain[] = [];
  function gain(): Gain {
    const result = { ...node(), gain: params() };
    gains.push(result);
    return result;
  }
  type Oscillator = ReturnType<typeof node> & {
    frequency: ReturnType<typeof params>;
    type: string;
  };
  const oscillators: Oscillator[] = [];
  function oscillator(): Oscillator {
    const result = { ...node(), frequency: params(), type: "square" };
    oscillators.push(result);
    return result;
  }
  const buffers: { data: Float32Array; getChannelData(): Float32Array }[] = [];
  type BufferSource = ReturnType<typeof node> & {
    buffer: { data: Float32Array } | null;
    loop: boolean;
    playbackRate: ReturnType<typeof params>;
  };
  const bufferSources: BufferSource[] = [];
  const iirs: { b: number[]; a: number[] }[] = [];
  const ctx = {
    state: "running",
    currentTime: 12,
    sampleRate: 8000,
    destination: {},
    createGain: gain,
    createOscillator: oscillator,
    createBuffer: (_channels: number, length: number) => {
      const buffer = {
        length,
        data: new Float32Array(length),
        getChannelData() {
          return this.data;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createBufferSource: () => {
      // Web Audio throws InvalidStateError when a set buffer is reassigned.
      let assigned: { data: Float32Array } | null = null;
      const source: BufferSource = {
        ...node(),
        get buffer() {
          return assigned;
        },
        set buffer(value) {
          if (assigned !== null) throw new Error("InvalidStateError: buffer already set");
          assigned = value;
        },
        loop: false,
        playbackRate: params(),
      };
      bufferSources.push(source);
      return source;
    },
    createChannelMerger: () => node(),
    createIIRFilter: (b: number[], a: number[]) => {
      iirs.push({ b, a });
      return node();
    },
    createBiquadFilter: () => ({ ...node(), type: "bandpass", Q: params(), frequency: params() }),
    resume: async () => {},
  };
  return {
    ctx,
    gains,
    oscillators,
    buffers,
    bufferSources,
    iirs,
    audio: new AgiAudio({ contextFactory: () => ctx as unknown as AudioContext }),
  };
}

describe("audio command backend", () => {
  it("uses speaker divisors and gates without an independent completion timer", () => {
    const { audio, gains, oscillators, ctx } = context();
    audio.output({ kind: "speaker", divisor: 2712 });
    assert.equal(audio.isPlaying, true);
    // PIT 1,193,180 Hz / 2,712; the PSG has a separate clock.
    assert.ok(Math.abs(oscillators[0]!.frequency.value - 439.9631268436578) < 1e-10);
    assert.equal(gains[1]!.gain.value, 0.4);
    ctx.currentTime = 13;
    audio.output({ kind: "speaker", divisor: null });
    assert.equal(gains[1]!.gain.value, 0);
    assert.equal(audio.isPlaying, true, "only the engine's stop completes playback");
    audio.stop();
    assert.equal(audio.isPlaying, false);
    assert.equal(oscillators[0]!.stopped, true);
  });
  it("applies latched PSG tone data and channel attenuation commands exactly once", () => {
    const { audio, gains, oscillators } = context();
    audio.output({ kind: "psg", bytes: [0x82, 0x0e, 0x94, 0xb6, 0xd7, 0xf8] });
    // PSG 3,579,545 Hz / 32 / 226, from the Tandy hardware clock.
    assert.ok(Math.abs(oscillators[0]!.frequency.value - 494.9592090707965) < 1e-10);
    assert.equal(gains[1]!.gain.value, Math.pow(10, -4 / 10) * 0.25);
    assert.equal(gains[2]!.gain.value, Math.pow(10, -6 / 10) * 0.25);
    assert.equal(gains[3]!.gain.value, Math.pow(10, -7 / 10) * 0.25);
    assert.equal(gains[4]!.gain.value, Math.pow(10, -8 / 10) * 0.25);
    audio.output({ kind: "psg", bytes: [0x9f] });
    assert.equal(gains[1]!.gain.value, 0, "15 means silence, not a small audible gain");
    assert.notEqual(gains[2]!.gain.value, 0, "another active channel is untouched");
    audio.output({ kind: "psg", bytes: [0x9f, 0xbf, 0xdf, 0xff] });
    assert.ok(gains.slice(1).every((node) => node.gain.value === 0));
  });
  it("keeps mute and user volume separate from game attenuation", () => {
    const { audio, gains } = context();
    audio.output({ kind: "psg", bytes: [0x90] });
    audio.setVolume(0.7);
    audio.setMuted(true);
    assert.equal(gains[0]!.gain.value, 0);
    assert.equal(gains[1]!.gain.value, 0.25);
    audio.output({ kind: "psg", bytes: [0x98] });
    audio.setMuted(false);
    assert.equal(gains[0]!.gain.value, 0.7);
    assert.equal(gains[1]!.gain.value, Math.pow(10, -8 / 10) * 0.25);
  });
  it("pauses audible output without losing channel state or mute preference", () => {
    const { audio, gains, oscillators } = context();
    audio.output({ kind: "psg", bytes: [0x94] });
    audio.setPaused(true);
    assert.equal(gains[0]!.gain.value, 0);
    assert.equal(oscillators[0]!.stopped, false);
    audio.setMuted(true);
    audio.setPaused(false);
    assert.equal(gains[0]!.gain.value, 0);
    audio.setMuted(false);
    assert.equal(gains[0]!.gain.value, 0.5);
    assert.equal(gains[1]!.gain.value, Math.pow(10, -4 / 10) * 0.25);
  });
  it("stops and cleans up all active nodes cleanly on stop()", () => {
    const { audio, oscillators } = context();
    audio.output({ kind: "psg", bytes: [0x82, 0x0e, 0x90] });
    assert.equal(audio.isPlaying, true);
    assert.equal(oscillators[0]!.stopped, false);
    audio.stop();
    assert.equal(audio.isPlaying, false);
    assert.equal(oscillators[0]!.stopped, true);
    // Safe and idempotent to call multiple times
    audio.stop();
    assert.equal(audio.isPlaying, false);
  });
  it("clamps ultrasonic intermediate divisors to Nyquist limit to avoid Web Audio warnings", () => {
    const { audio, oscillators, ctx } = context();
    // Divisor 1 gives 111860.78125 Hz, above sampleRate/2 (4000 Hz in this context).
    audio.output({ kind: "psg", bytes: [0x81] });
    assert.equal(oscillators[0]!.frequency.value, ctx.sampleRate / 2);
  });
  it("ignores data bytes sent while attenuation or noise registers are latched", () => {
    const { audio, gains } = context();
    // Latch channel 0 attenuation to 15 (silence)
    audio.output({ kind: "psg", bytes: [0x9f] });
    assert.equal(gains[1]!.gain.value, 0);
    // Send stray data bytes 0x00 without bit 7 set
    audio.output({ kind: "psg", bytes: [0x00, 0x00] });
    // Channel 0 must remain silent (not corrupted to gain 0.25 / attenuation 0)
    assert.equal(gains[1]!.gain.value, 0);
  });
  it("starts Paula DMA at the programmed rate and resets phase after DMA off", () => {
    const { audio, bufferSources } = context();
    audio.output(
      { kind: "paula", channel: 0, period: 760, volume: 55 },
      { stream: "dma", tick: 0 },
    );
    assert.deepEqual(bufferSources[0]!.starts, [[12 + 2 / 60, 0]]);
    assert.equal(
      bufferSources[0]!.playbackRate.values[0]![1],
      12,
      "constant rate is installed before the start quantum",
    );
    assert.deepEqual(bufferSources[1]!.starts, [], "unprogrammed DMA stays off");
    audio.output(
      { kind: "paula", channel: 0, period: null, volume: 0 },
      { stream: "dma", tick: 1 },
    );
    assert.equal(bufferSources[0]!.stopped, true);
    audio.output(
      { kind: "paula", channel: 0, period: 760, volume: 55 },
      { stream: "dma", tick: 2 },
    );
    assert.deepEqual(bufferSources.at(-1)!.starts, [[12 + 4 / 60, 0]]);
  });
  it("retains PAL Paula volume and the low byte after DMA off, with AC coupling on the output", () => {
    const { audio, gains, bufferSources, ctx, iirs } = context();
    audio.setAmigaRegion("pal");
    audio.output({ kind: "paula", channel: 0, period: 3546.895, volume: 32 });
    ctx.currentTime = 12.0042;
    audio.output({ kind: "paula", channel: 0, period: null, volume: 0 });
    assert.equal(gains[1]!.gain.value, 0.2, "DMA clear writes no AUDxVOL");
    const held = bufferSources.at(-1)!;
    assert.deepEqual([...held.buffer!.data], [-0.5], "byte 5 is -64/128");
    assert.ok(Math.abs(held.starts[0]![0]! - 12.006) < 1e-12);
    assert.equal(iirs.length, 2);
    assert.equal(iirs[1]!.b[0]! + iirs[1]!.b[1]!, 0, "output coupling rejects DC");
  });
  it("keeps the Paula latch and filter graph across completed SOUND streams", () => {
    const { audio, gains, bufferSources } = context();
    audio.outputTick({
      stream: "a",
      tick: 0,
      outputs: [{ kind: "paula", channel: 0, period: 3546.895, volume: 32 }],
      complete: false,
    });
    audio.outputTick({
      stream: "a",
      tick: 1,
      outputs: [{ kind: "paula", channel: 0, period: null, volume: 0 }],
      complete: true,
    });
    const held = bufferSources.at(-1)!;
    assert.equal(held.stopped, false);
    assert.equal(
      audio.isPlaying,
      false,
      "completion ends the logical sound while the DAC retains its level",
    );
    audio.outputTick({
      stream: "b",
      tick: 0,
      outputs: [{ kind: "paula", channel: 0, period: 3546.895, volume: 16 }],
      complete: false,
    });
    assert.equal(gains.length, 5, "the existing channel gains and filters carry capacitor state");
    assert.equal(held.stopped, true);
    audio.stop();
    assert.ok(bufferSources.every((source) => source.stopped));
  });
  it("serves the worker's stop marker while keeping Paula output and retiring the stream", () => {
    const { audio, gains, bufferSources } = context();
    audio.outputTick({
      stream: "a",
      tick: 0,
      outputs: [{ kind: "paula", channel: 0, period: 3546.895, volume: 32 }],
      complete: false,
    });
    audio.output({ kind: "paula", channel: 0, period: null, volume: 0 });
    audio.finishSound();
    const held = bufferSources.at(-1)!;
    assert.equal(held.stopped, false);
    assert.equal(audio.isPlaying, false);
    audio.outputTick({
      stream: "a",
      tick: 1,
      outputs: [{ kind: "paula", channel: 0, period: 500, volume: 64 }],
      complete: false,
    });
    assert.equal(gains[1]!.gain.value, 0.2, "retired output stays rejected");
    audio.outputTick({
      stream: "b",
      tick: 0,
      outputs: [{ kind: "paula", channel: 0, period: 3546.895, volume: 16 }],
      complete: false,
    });
    assert.equal(gains.length, 5);
    audio.stop();
    assert.ok(bufferSources.every((source) => source.stopped));
  });
  it("uses NTSC by default and switches active Paula voices to PAL without restarting", () => {
    const { audio, bufferSources } = context();
    audio.output({ kind: "paula", channel: 0, period: 1000, volume: 32 });
    // 3,579.545 bytes/s, eight bytes per tone: 447.443125 Hz.
    assert.equal(bufferSources[0]!.playbackRate.value, 14.31818);
    const source = bufferSources[0]!;
    audio.setAmigaRegion("pal");
    // 3,546.895 bytes/s: 443.361875 Hz; the same source keeps playing.
    assert.equal(source.playbackRate.value, 14.18758);
    assert.equal(source.stopped, false);
    assert.equal(source.starts.length, 1);
    audio.output({ kind: "paula", channel: 1, period: 2000, volume: 32 });
    assert.equal(bufferSources[1]!.playbackRate.value, 7.09379);
    audio.setAmigaRegion("ntsc");
    assert.equal(source.playbackRate.value, 14.31818);
    assert.equal(bufferSources[1]!.playbackRate.value, 7.15909);
  });
  it("renders paula events with the driver's tone sample and per-voice gains", () => {
    const { audio, gains, bufferSources } = context();
    audio.output({ kind: "paula", channel: 0, period: 760, volume: 55 });
    // NTSC Paula clock / period is the byte rate; the source replays its
    // buffer against the context rate.
    assert.equal(bufferSources[0]!.playbackRate.value, ((3579545 / 760) * 32) / 8000);
    assert.equal(bufferSources[0]!.loop, true);
    assert.equal(gains[1]!.gain.value, (55 / 64) * 0.4);
    // The tone voices loop the 8-byte h198 sample as signed PCM.
    const tone = bufferSources[0]!.buffer!;
    assert.deepEqual(
      [...tone.data],
      [0, 64, 127, 64, 0, -64, -127, -64].flatMap((v) => Array<number>(32).fill(v / 128)),
    );
    // Every tone voice loops the same tone sample.
    audio.output({ kind: "paula", channel: 1, period: 1016, volume: 21 });
    assert.equal(bufferSources[1]!.buffer, tone);
    // The noise voice loops the 4,096-byte LFSR PCM; the first states are
    // 1 -> 0xca0 -> 0x650 -> 0x328 -> 0x194, stored low-byte first.
    audio.output({ kind: "paula", channel: 3, period: 0x800, volume: 64 });
    const noise = bufferSources[3]!.buffer!;
    assert.equal(noise.data.length, 4096 * 32);
    assert.deepEqual(
      [noise.data[0], noise.data[32], noise.data[64], noise.data[96]],
      [-0x60 / 128, 0x50 / 128, 0x28 / 128, -0x6c / 128],
    );
    assert.equal(bufferSources[3]!.playbackRate.value, ((3579545 / 0x800) * 32) / 8000);
    assert.equal(gains[4]!.gain.value, 0.4);
    // A rest writes AUDxPER 0 with a nonzero volume (KQ2's attack gives 8):
    // the voice keeps its volume while its zero period counts 65536 clocks.
    audio.output({ kind: "paula", channel: 1, period: 0, volume: 8 });
    assert.equal(gains[2]!.gain.value, (8 / 64) * 0.4);
    assert.equal(bufferSources.at(-1)!.playbackRate.value, ((3579545 / 65536) * 32) / 8000);
    // The engine's terminator and stop() events carry no noise flag; the
    // noise voice keeps its buffer (Web Audio cannot reassign one).
    audio.output({ kind: "paula", channel: 3, period: null, volume: 0 });
    assert.equal(bufferSources[3]!.buffer, noise);
    assert.equal(gains[4]!.gain.value, 0.4);
    // A null period disables DMA and stops the source.
    audio.output({ kind: "paula", channel: 0, period: null, volume: 0 });
    assert.equal(gains[1]!.gain.value, (55 / 64) * 0.4);
    assert.equal(bufferSources[0]!.stopped, true);
    audio.stop();
    assert.ok(bufferSources.every((source) => source.stopped));
  });
  it("renders the 2.082 driver's own buffers and clamps its sub-DMA periods", () => {
    const { audio, gains, bufferSources } = context();
    audio.output({ kind: "paula", channel: 0, period: 760, volume: 55 });
    assert.equal(bufferSources[0]!.buffer!.data.length, 8 * 32);
    // A 2.082 event rebuilds the voices with the 4-byte square and the
    // 1,024-byte noise PCM instead of reassigning buffers.
    audio.output({ kind: "paula", channel: 3, period: 3, volume: 64, driver: "2.082" });
    assert.ok(bufferSources.slice(0, 4).every((source) => source.stopped));
    assert.deepEqual(
      [...bufferSources[4]!.buffer!.data],
      [0, -1, 0, -1].flatMap((v) => Array<number>(32).fill(v)),
    );
    assert.equal(bufferSources[7]!.buffer!.data.length, 0x400 * 32);
    // Periods below Paula's DMA minimum render at the 124-clock limit.
    assert.equal(bufferSources[7]!.playbackRate.value, ((3579545 / 124) * 32) / 8000);
    assert.equal(gains[8]!.gain.value, 0.4);
    // The terminator keeps the 2.082 voices.
    audio.output({ kind: "paula", channel: 3, period: null, volume: 0, driver: "2.082" });
    assert.equal(bufferSources.length, 9);
    assert.equal(gains[8]!.gain.value, 0.4);
  });
  it("renders iigs notes as triangles when the game lacks its IIgs sound files", () => {
    const { audio, oscillators } = context();
    audio.output({
      kind: "iigs",
      event: "note-on",
      voice: 0,
      channel: 0,
      note: 69,
      volume: 127,
      program: 0,
    });
    assert.equal(audio.isPlaying, true);
    assert.equal(oscillators[0]!.type, "triangle");
    assert.equal(oscillators[0]!.frequency.value, 440);
    // Voices are independent: a second note gets its own oscillator.
    audio.output({
      kind: "iigs",
      event: "note-on",
      voice: 1,
      channel: 2,
      note: 57,
      volume: 127,
      program: 0,
    });
    assert.equal(oscillators[1]!.frequency.value, 220);
    audio.output({ kind: "iigs", event: "note-off", voice: 0 });
    assert.equal(oscillators[0]!.stopped, true);
    assert.equal(oscillators[1]!.stopped, false);
    audio.output({ kind: "iigs", event: "all-off" });
    assert.ok(oscillators.every((osc) => osc.stopped));
  });
});

describe("audio mode selection", () => {
  it("posts the device operand only for the PC sound families", () => {
    const { audio } = context();
    const state = { soundMode: "tandy" as AudioMode, soundMuted: false };
    const posted: unknown[] = [];
    const controller = useAudioController(audio, state, (msg) => posted.push(msg));
    controller.setAudioMode("pc-speaker");
    assert.deepEqual(posted, [{ type: "soundDevice", device: 0 }]);
    assert.equal(audio.currentMode, "pc-speaker");
    posted.length = 0;
    controller.setAudioMode("tandy");
    assert.deepEqual(posted, [{ type: "soundDevice", device: 1 }]);
  });
  it("derives the fixed sound family from the profile's sound driver", () => {
    assert.equal(soundFamily(null), "pc");
    assert.equal(soundFamily("2.917"), "pc");
    assert.equal(soundFamily("amiga-2.316"), "amiga");
    assert.equal(soundFamily("amiga-2.176"), "amiga");
    // SQ1's older driver is still Paula.
    assert.equal(soundFamily("amiga-2.082"), "amiga");
    assert.equal(soundFamily("iigs-1.014"), "iigs");
    assert.equal(soundFamily("not-a-profile"), "pc");
  });
  it("cycles only the PC chips and labels the fixed families", () => {
    assert.equal(nextAudioMode("tandy"), "pc-speaker");
    assert.equal(nextAudioMode("pc-speaker"), "tandy");
    assert.equal(soundChipLabel("pc", "tandy"), "Tandy 4-Voice");
    assert.equal(soundChipLabel("pc", "pc-speaker"), "PC Speaker");
    // The PC preference does not leak into a fixed family's label.
    assert.equal(soundChipLabel("amiga", "pc-speaker"), "Amiga Paula");
    assert.equal(soundChipLabel("iigs", "pc-speaker"), "Apple IIgs Ensoniq");
  });
});
