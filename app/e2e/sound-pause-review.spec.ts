import type * as BrowserSignals from "./browserSignals.ts";
import { expect, test } from "./test.ts";

// This exercises the real Web Audio adapter. Autoplay admission is a separate
// browser policy; these checks measure the app's own pause contract.
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

for (const lateOutput of [false, true]) {
  test(`audio pause freezes playback time${lateOutput ? " despite output and an unlock request" : ""}`, async ({
    page,
  }) => {
    let providerCalls = 0;
    await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
      providerCalls++;
      return route.abort();
    });
    await page.goto("/");
    const result = await page.evaluate(async (late) => {
      const adapterPath = "/src/audio/AgiAudio.ts";
      const { AgiAudio } = await import(adapterPath);
      const context = new AudioContext();
      const gains: GainNode[] = [];
      const createGain = context.createGain.bind(context);
      context.createGain = () => {
        const node = createGain();
        gains.push(node);
        return node;
      };
      const audio = new AgiAudio({ contextFactory: () => context });
      const signalsPath = "/e2e/browserSignals.ts";
      const { audioElapsed, audioState, audioWitness }: typeof BrowserSignals = await import(
        /* @vite-ignore */ signalsPath
      );
      try {
        audio.output({ kind: "speaker", divisor: 2712 });
        await context.resume();
        const started = context.currentTime;
        await audioElapsed(context, 0.1);
        const playingAdvance = context.currentTime - started;
        audio.setPaused(true);
        await audioState(context, "suspended", 10_000);
        if (late) {
          audio.output({ kind: "speaker", divisor: 1356 });
          await audio.resume();
        }
        const pausedAt = context.currentTime;
        await audioWitness(0.2);
        const paused = {
          state: context.state,
          advance: context.currentTime - pausedAt,
          gain: gains[0]!.gain.value,
          playing: audio.isPlaying,
        };
        audio.setPaused(false);
        await audioState(context, "running", 10_000);
        const resumedAt = context.currentTime;
        await audioElapsed(context, 0.1);
        const resumed = {
          state: context.state,
          advance: context.currentTime - resumedAt,
          gain: gains[0]!.gain.value,
        };
        return { playingAdvance, paused, resumed };
      } finally {
        audio.stop();
        await context.close();
      }
    }, lateOutput);
    expect(result.playingAdvance).toBeGreaterThan(0.04);
    // A suspended context can retain the preceding rendered AudioParam value.
    // The freeze contract is that its clock stops, preserving scheduled sound.
    expect(result.paused.playing).toBe(true);
    expect(result.paused.state).toBe("suspended");
    expect(result.paused.advance).toBe(0);
    expect(result.resumed.state).toBe("running");
    expect(result.resumed.advance).toBeGreaterThan(0.04);
    expect(result.resumed.gain).toBe(0.5);
    expect(providerCalls).toBe(0);
  });
}
