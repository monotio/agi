import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgiAudio } from "../src/audio/AgiAudio.ts";

// Temporary RED probe for the scheduled-renderer milestone: four logical
// one-tick Paula notes delivered in one batch must occupy distinct scheduled
// times. The arrival-time renderer programs every change at currentTime.

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
    start() {},
    stop() {
      this.stopped = true;
    },
  });
  const gains: (ReturnType<typeof node> & { gain: ReturnType<typeof params> })[] = [];
  const ctx = {
    state: "running",
    currentTime: 12,
    sampleRate: 48000,
    destination: {},
    createGain: () => {
      const gain = { ...node(), gain: params() };
      gains.push(gain);
      return gain;
    },
    createOscillator: () => ({ ...node(), frequency: params(), type: "square" }),
    createBuffer: (_c: number, length: number, _r: number) => {
      const data = new Float32Array(length);
      return { data, getChannelData: () => data };
    },
    createBufferSource: () => ({ ...node(), buffer: null, loop: false, playbackRate: params() }),
    createBiquadFilter: () => ({ ...node(), type: "bandpass", Q: params(), frequency: params() }),
  };
  return {
    ctx,
    gains,
    audio: new AgiAudio({ contextFactory: () => ctx as unknown as AudioContext }),
  };
}

describe("arrival-time defect probe", () => {
  it("four one-tick Paula notes delivered together occupy distinct scheduled times", () => {
    const { audio, gains } = context();
    // ticks 0..3 of one logical stream, all delivered before the next render.
    audio.output({ kind: "paula", channel: 0, period: 428, volume: 55 });
    audio.output({ kind: "paula", channel: 0, period: 856, volume: 40 });
    audio.output({ kind: "paula", channel: 0, period: 214, volume: 64 });
    audio.output({ kind: "paula", channel: 0, period: 642, volume: 30 });
    const times = gains[1]!.gain.values.map(([, at]) => at);
    const distinct = new Set(times);
    assert.equal(distinct.size, times.length, "every note needs its own scheduled instant");
  });
});
