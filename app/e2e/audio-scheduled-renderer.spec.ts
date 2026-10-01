import { expect, test } from "@playwright/test";

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
