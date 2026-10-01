import { expect, test } from "@playwright/test";

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
      // Real elapsed intervals are the input under test, not a readiness shortcut.
      const elapse = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const waitForState = async (state: "running" | "suspended") => {
        if (context.state === state) return;
        await new Promise<void>((resolve, reject) => {
          const changed = () => {
            if (context.state !== state) return;
            clearTimeout(timer);
            context.removeEventListener("statechange", changed);
            resolve();
          };
          const timer = setTimeout(() => {
            context.removeEventListener("statechange", changed);
            reject(new Error(`Audio context did not become ${state}.`));
          }, 10_000);
          context.addEventListener("statechange", changed);
        });
      };
      try {
        audio.output({ kind: "speaker", divisor: 2712 });
        await context.resume();
        const started = context.currentTime;
        await elapse(100);
        const playingAdvance = context.currentTime - started;
        audio.setPaused(true);
        await waitForState("suspended");
        if (late) {
          audio.output({ kind: "speaker", divisor: 1356 });
          await audio.resume();
        }
        const pausedAt = context.currentTime;
        await elapse(200);
        const paused = {
          state: context.state,
          advance: context.currentTime - pausedAt,
          gain: gains[0]!.gain.value,
          playing: audio.isPlaying,
        };
        audio.setPaused(false);
        await waitForState("running");
        const resumedAt = context.currentTime;
        await elapse(100);
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
