import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgiAudio } from "../src/audio/AgiAudio.ts";

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
  const ctx = {
    state: "running",
    currentTime: 12,
    sampleRate: 8000,
    destination: {},
    createGain: gain,
    createOscillator: oscillator,
    createBuffer: (_channels: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => ({ ...node(), buffer: null, loop: false, playbackRate: params() }),
    createBiquadFilter: () => ({ ...node(), type: "bandpass", Q: params(), frequency: params() }),
    resume: async () => {},
  };
  return {
    ctx,
    gains,
    oscillators,
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
});
