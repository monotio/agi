import { expect, test } from "./test.ts";

// The browser renders each lane to PCM. Delivery happens together; only the
// stream's logical tick controls the first nonzero sample of each note.
test("same-tick Paula voices start together and later ticks keep their 60 Hz spacing", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AgiAudio } = await import("/src/audio/AgiAudio.ts");
    const { deliverSoundTick } = await import("/src/audio/useAudioController.ts");
    const starts: number[] = [];
    for (const lane of [0, 1, 2]) {
      const context = new OfflineAudioContext(1, 4800, 48000);
      const audio = new AgiAudio({ contextFactory: () => context as unknown as AudioContext });
      for (let channel = 0; channel < 4; channel++) audio.setLaneAudible(channel, channel === lane);
      deliverSoundTick(audio, {
        stream: "browser-song",
        tick: 0,
        complete: false,
        outputs: [
          { kind: "paula", channel: 0, period: 428, volume: 64 },
          { kind: "paula", channel: 1, period: 428, volume: 64 },
        ],
      });
      deliverSoundTick(audio, {
        stream: "browser-song",
        tick: 1,
        complete: false,
        outputs: [{ kind: "paula", channel: 2, period: 428, volume: 64 }],
      });
      deliverSoundTick(audio, {
        stream: "browser-song",
        tick: 3,
        complete: true,
        outputs: [0, 1, 2].map((channel) => ({
          kind: "paula" as const,
          channel,
          period: null,
          volume: 0,
        })),
      });
      const buffer = await context.startRendering();
      const pcm = buffer.getChannelData(0);
      starts.push(pcm.findIndex((sample) => Math.abs(sample) > 1e-6));
      audio.stop();
    }
    return starts;
  });
  expect(result[0]).toBeGreaterThan(0);
  expect(result[1]).toBe(result[0]);
  expect(result[2]! - result[0]!).toBe(800); // 48,000 / 60
});

test("IIgs vibrato keeps its discrete cycle through a twelve-second sustain @webkit-desktop", async ({
  page,
}) => {
  await page.goto("/");
  const errors = await page.evaluate(async () => {
    const { IigsSynth } = await import("/src/audio/iigsSynth.ts");
    const byteRate = (offset: number) => {
      const pitch = (69 * 256 + offset) & 0x7fff & ~1;
      const frequency =
        Math.floor(20905.466 * 2 ** ((pitch % 3072) / 3072)) >> (10 - Math.floor(pitch / 3072));
      return ((7159090 / 8 / 34) * frequency) / 512 / 44100;
    };
    const ctx = new OfflineAudioContext(2, 12 * 48000, 48000);
    const merger = ctx.createChannelMerger(2);
    merger.connect(ctx.destination);
    const actual = ctx.createGain();
    actual.connect(merger, 0, 0);
    const doc = new Uint8Array(0x10000).fill(0x80);
    for (let i = 0; i < 256; i++)
      doc[i] = 128 + Math.round(100 * Math.sin((2 * Math.PI * i) / 256));
    const wave = { topKey: 127, waveAddr: 0, waveSize: 0, docMode: 0, relPitch: 0 };
    const instrument = {
      envelope: [
        { breakpoint: 127, increment: 32512 },
        ...Array.from({ length: 7 }, () => ({ breakpoint: 127, increment: 0 })),
      ],
      releaseSegment: 1,
      priorityIncrement: 0,
      pitchBendRange: 0,
      vibratoDepth: 66,
      vibratoSpeed: 64,
      a: [wave],
      b: [],
    };
    const synth = new IigsSynth(ctx, actual, {
      doc,
      bank: { programs: [instrument], defaultInstrument: instrument },
    });
    synth.output(
      { kind: "iigs", event: "note-on", voice: 0, channel: 0, note: 69, volume: 127, program: 0 },
      0,
    );
    synth.stop(12);
    const reference = ctx.createBufferSource();
    reference.buffer = ctx.createBuffer(1, 256, 44100);
    const data = reference.buffer.getChannelData(0);
    for (let i = 0; i < 256; i++) data[i] = (doc[i]! - 128) / 128;
    reference.loop = true;
    // TOOL025: phase 64 -> +32, 128 -> 0, 192 -> -34, 0 -> 0.
    const offsets = [32, 0, -34, 0];
    reference.playbackRate.setValueAtTime(byteRate(32), 0);
    for (let i = 1; i < 361; i++)
      reference.playbackRate.setValueAtTime(
        Math.fround(byteRate(offsets[i % 4]!)),
        (2 * i - 1) / 60,
      );
    const gain = ctx.createGain();
    gain.gain.value = 1 / 32;
    reference.connect(gain).connect(merger, 0, 1);
    reference.start(0);
    const rendered = await ctx.startRendering();
    const left = rendered.getChannelData(0),
      right = rendered.getChannelData(1);
    return [0, 10, 11].map((second) => {
      let error = 0;
      for (let i = second * 48000; i < (second + 1) * 48000; i++)
        error += (left[i]! - right[i]!) ** 2;
      return Math.sqrt(error / 48000);
    });
  });
  for (const error of errors) expect(error).toBeLessThan(0.0001);
});
