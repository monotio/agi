import { expect, test } from "@playwright/test";

test("a host stop cancels queued PSG volume writes while retaining the chip clock @webkit-desktop", async ({
  page,
}) => {
  await page.goto("/");
  const peak = await page.evaluate(async () => {
    const { AgiAudio } = await import("/src/audio/AgiAudio.ts");
    const context = new OfflineAudioContext(1, 4800, 48000);
    const audio = new AgiAudio({ contextFactory: () => context as unknown as AudioContext });
    audio.outputTick({
      stream: "restart",
      tick: 0,
      outputs: [{ kind: "psg", bytes: [0xe4, 0x90, 0xf0] }],
      complete: false,
    });
    // Register writes are queued 2 ticks ahead; restart can arrive before them.
    audio.finishSound();
    const rendered = await context.startRendering();
    let peak = 0;
    for (const sample of rendered.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
    audio.stop();
    return peak;
  });
  expect(peak).toBe(0);
});
