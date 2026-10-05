import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgiAudio } from "../src/audio/AgiAudio.ts";

// Logical ticks travel with the output; delivery time never invents note spacing.

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
    stops: [] as (number | undefined)[],
    connect() {},
    disconnect() {},
    start() {},
    stop(at?: number) {
      this.stops.push(at);
      this.stopped = true;
    },
  });
  const gains: (ReturnType<typeof node> & { gain: ReturnType<typeof params> })[] = [];
  const oscillators: (ReturnType<typeof node> & {
    frequency: ReturnType<typeof params>;
    type: string;
  })[] = [];
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
    createOscillator: () => {
      const oscillator = { ...node(), frequency: params(), type: "square" };
      oscillators.push(oscillator);
      return oscillator;
    },
    createBuffer: (_c: number, length: number, _r: number) => {
      const data = new Float32Array(length);
      return { data, length, getChannelData: () => data };
    },
    createBufferSource: () => ({ ...node(), buffer: null, loop: false, playbackRate: params() }),
    createChannelMerger: () => node(),
    createIIRFilter: () => node(),
    createBiquadFilter: () => ({ ...node(), type: "bandpass", Q: params(), frequency: params() }),
  };
  return {
    ctx,
    gains,
    oscillators,
    audio: new AgiAudio({ contextFactory: () => ctx as unknown as AudioContext }),
  };
}

describe("scheduled sound ticks", () => {
  it("four one-tick Paula notes delivered together occupy distinct scheduled times", () => {
    const { audio, gains } = context();
    // ticks 0..3 of one logical stream, all delivered before the next render.
    audio.output(
      { kind: "paula", channel: 0, period: 428, volume: 55 },
      { stream: "song", tick: 0 },
    );
    audio.output(
      { kind: "paula", channel: 0, period: 856, volume: 40 },
      { stream: "song", tick: 1 },
    );
    audio.output(
      { kind: "paula", channel: 0, period: 214, volume: 64 },
      { stream: "song", tick: 2 },
    );
    audio.output(
      { kind: "paula", channel: 0, period: 642, volume: 30 },
      { stream: "song", tick: 3 },
    );
    const times = gains[1]!.gain.values.map(([, at]) => at);
    const distinct = new Set(times);
    assert.equal(distinct.size, times.length, "every note needs its own scheduled instant");
  });
});

for (const kind of ["speaker", "psg", "paula", "iigs"] as const) {
  it(`${kind} groups same-tick writes and preserves tick spacing in a late batch`, () => {
    const { audio, ctx, gains } = context();
    const events =
      kind === "speaker"
        ? [{ kind, divisor: 2712 }]
        : kind === "psg"
          ? [{ kind, bytes: [0x85, 0x10, 0x90] }]
          : kind === "paula"
            ? [
                { kind, channel: 0, period: 428, volume: 55 },
                { kind, channel: 1, period: 856, volume: 40 },
              ]
            : [
                {
                  kind,
                  event: "note-on" as const,
                  voice: 0,
                  channel: 0,
                  note: 69,
                  volume: 127,
                  program: -1,
                },
                {
                  kind,
                  event: "note-on" as const,
                  voice: 1,
                  channel: 1,
                  note: 72,
                  volume: 127,
                  program: -1,
                },
              ];
    audio.outputTick({ stream: "song", tick: 0, outputs: events, complete: false });
    const initial = gains.slice(1).flatMap(({ gain }) => gain.values.map(([, at]) => at));
    const first = Math.max(...initial);
    audio.outputTick({ stream: "song", tick: 1, outputs: events, complete: false });
    const second = Math.max(...gains.flatMap(({ gain }) => gain.values.map(([, at]) => at)));
    assert.ok(Math.abs(second - first - 1 / 60) < 1e-10);
    if (kind === "paula")
      assert.equal(
        gains[1]!.gain.values.at(-1)![1],
        gains[2]!.gain.values.at(-1)![1],
        "volume writes share the register tick independently of sample reload",
      );
    if (kind === "iigs") {
      assert.equal(gains[1]!.gain.values.at(-1)![1], gains[2]!.gain.values.at(-1)![1]);
    }
    ctx.currentTime += 2;
    audio.outputTick({ stream: "song", tick: 2, outputs: events, complete: false });
    const late = Math.max(...gains.flatMap(({ gain }) => gain.values.map(([, at]) => at)));
    assert.ok(late >= ctx.currentTime);
    audio.outputTick({ stream: "song", tick: 3, outputs: events, complete: false });
    const next = Math.max(...gains.flatMap(({ gain }) => gain.values.map(([, at]) => at)));
    assert.ok(Math.abs(next - late - 1 / 60) < 1e-10);
  });
}

it("stop rejects retired output and a new stream gets its own anchor", () => {
  const { audio, ctx, gains } = context();
  const output = { kind: "speaker" as const, divisor: 2712 };
  audio.output(output, { stream: "old", tick: 100 });
  audio.stop();
  const count = gains.length;
  audio.output(output, { stream: "old", tick: 101 });
  assert.equal(gains.length, count);
  ctx.currentTime = 20;
  audio.output(output, { stream: "new", tick: 0 });
  assert.ok(gains.at(-1)!.gain.values.at(-1)![1] >= 20);
});

it("IIgs fallback note-off keeps its tick when completion retires the whole graph", () => {
  const { audio, oscillators } = context();
  audio.outputTick({
    stream: "iigs",
    tick: 0,
    complete: false,
    outputs: [
      { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 69, volume: 127, program: -1 },
      { kind: "iigs", event: "note-on", voice: 1, channel: 1, note: 72, volume: 127, program: -1 },
    ],
  });
  audio.outputTick({
    stream: "iigs",
    tick: 1,
    complete: false,
    outputs: [{ kind: "iigs", event: "note-off", voice: 0 }],
  });
  const off = oscillators[0]!.stops.at(-1)!;
  audio.outputTick({
    stream: "iigs",
    tick: 3,
    complete: true,
    outputs: [{ kind: "iigs", event: "all-off" }],
  });
  assert.equal(
    oscillators[0]!.stops.at(-1),
    off,
    "graph retirement must preserve the earlier note-off",
  );
  assert.ok(Math.abs(oscillators[1]!.stops.at(-1)! - off - 2 / 60) < 1e-10);
});
