import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgiAudio, type AudioMode } from "../src/audio/AgiAudio.ts";
import { useAudioController } from "../src/audio/useAudioController.ts";

function context() {
  const params = () => ({
    value: 0,
    values: [] as [number, number][],
    setValueAtTime(value: number, at: number) {
      this.value = value;
      this.values.push([value, at]);
    },
  });
  const node = () => ({
    stopped: false,
    connect() {},
    disconnect() {},
    start() {},
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
  const ctx = {
    state: "running",
    currentTime: 12,
    sampleRate: 8000,
    destination: {},
    createGain: gain,
    createOscillator: oscillator,
    createBuffer: (_channels: number, length: number) => {
      const buffer = {
        data: new Float32Array(length),
        getChannelData() {
          return this.data;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createBufferSource: () => {
      const source: BufferSource = {
        ...node(),
        buffer: null,
        loop: false,
        playbackRate: params(),
      };
      bufferSources.push(source);
      return source;
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
    audio: new AgiAudio({ contextFactory: () => ctx as unknown as AudioContext }),
  };
}

describe("audio command backend", () => {
  it("uses speaker divisors and gates without an independent completion timer", () => {
    const { audio, gains, oscillators, ctx } = context();
    audio.output({ kind: "speaker", divisor: 2712 });
    assert.equal(audio.isPlaying, true);
    assert.equal(oscillators[0]!.frequency.value, 1193180 / 2712);
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
    assert.equal(oscillators[0]!.frequency.value, 99431.67 / 226);
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
    // Low divisor 1 gives 99431.67 Hz, which exceeds sampleRate/2 (4000 Hz in test context)
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
  it("renders paula events with the driver's tone sample and per-voice gains", () => {
    const { audio, gains, bufferSources } = context();
    audio.output({ kind: "paula", channel: 0, period: 760, volume: 55 });
    // PAL Paula clock / period is the byte rate; the source replays its
    // buffer against the context rate.
    assert.equal(bufferSources[0]!.playbackRate.value, 3546895 / 760 / 8000);
    assert.equal(bufferSources[0]!.loop, true);
    assert.equal(gains[1]!.gain.value, (55 / 64) * 0.4);
    // The tone voices loop the 8-byte h198 sample as signed PCM.
    const tone = bufferSources[0]!.buffer!;
    assert.deepEqual(
      [...tone.data],
      [0, 64, 127, 64, 0, -64, -127, -64].map((v) => v / 128),
    );
    // A tone voice event without the noise flag keeps the tone sample.
    audio.output({ kind: "paula", channel: 1, period: 1016, volume: 21 });
    assert.equal(bufferSources[1]!.buffer, tone);
    // The noise voice loops the 4,096-byte LFSR PCM; the first states are
    // 1 -> 0xca0 -> 0x650 -> 0x328 -> 0x194, stored low-byte first.
    audio.output({ kind: "paula", channel: 3, period: 0x800, volume: 64, noise: true });
    const noise = bufferSources[3]!.buffer!;
    assert.equal(noise.data.length, 4096);
    assert.deepEqual(
      [noise.data[0], noise.data[1], noise.data[2], noise.data[3]],
      [-0x60 / 128, 0x50 / 128, 0x28 / 128, -0x6c / 128],
    );
    assert.equal(bufferSources[3]!.playbackRate.value, 3546895 / 0x800 / 8000);
    assert.equal(gains[4]!.gain.value, 0.4);
    // Register values with bit 6 set are Paula's maximum: KQ2's signed
    // envelope writes 72, which renders like 64.
    audio.output({ kind: "paula", channel: 1, period: 1016, volume: 72 });
    assert.equal(gains[2]!.gain.value, 0.4);
    // A null period silences the voice without stopping its source.
    audio.output({ kind: "paula", channel: 0, period: null, volume: 0 });
    assert.equal(gains[1]!.gain.value, 0);
    assert.equal(bufferSources[0]!.stopped, false);
    audio.stop();
    assert.ok(bufferSources.every((source) => source.stopped));
  });
  it("renders iigs events with per-channel oscillators", () => {
    const { audio, gains, oscillators } = context();
    audio.setMode("iigs");
    // MIDI note 69 at full velocity and channel volume maps to A4 and the
    // channel's voice gain.
    audio.output({
      kind: "iigs",
      channel: 0,
      on: true,
      note: 69,
      velocity: 100,
      volume: 127,
      program: 0,
    });
    assert.equal(audio.isPlaying, true);
    assert.equal(oscillators[0]!.type, "triangle");
    assert.equal(oscillators[0]!.frequency.value, 440);
    assert.ok(gains[1]!.gain.value > 0, "note-on opens the channel gain");
    // A second channel is an independent voice.
    audio.output({
      kind: "iigs",
      channel: 2,
      on: true,
      note: 57,
      velocity: 64,
      volume: 127,
      program: 0,
    });
    assert.equal(oscillators[2]!.frequency.value, 220);
    // Note-off releases the voice without stopping the oscillator.
    audio.output({
      kind: "iigs",
      channel: 0,
      on: false,
      note: 69,
      velocity: 0,
      volume: 127,
      program: 0,
    });
    assert.equal(gains[1]!.gain.value, 0);
    assert.equal(oscillators[0]!.stopped, false);
    audio.stop();
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
    posted.length = 0;
    controller.setAudioMode("amiga");
    assert.deepEqual(posted, [], "the Amiga path is not a PC device selection");
    assert.equal(state.soundMode, "amiga");
    assert.equal(audio.currentMode, "amiga");
    // The IIgs path is profile-fixed too: no device operand is posted.
    controller.setAudioMode("iigs");
    assert.deepEqual(posted, [], "the IIgs path is not a PC device selection");
    assert.equal(audio.currentMode, "iigs");
    controller.setAudioMode("tandy");
    assert.deepEqual(posted, [{ type: "soundDevice", device: 1 }]);
  });
});
