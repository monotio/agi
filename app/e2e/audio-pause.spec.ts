import type * as BrowserSignals from "./browserSignals.ts";
import { expect, test } from "./test.ts";

// Real Web Audio evidence for the pause contract: a pause must freeze the
// AudioContext clock — scheduled one-shots and envelope ramps hold mid-flight
// and continue from that point on release — where a muted gain cannot stop
// time. @webkit-desktop admits the same checks to the desktop WebKit project.
// Use a real gesture so the same audio checks run in Chromium and WebKit.

test("pause freezes scheduled playback; release continues it from that point @webkit-desktop", async ({
  page,
}) => {
  let providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const result = await page.evaluate(async () => {
    const { AgiAudio } = await import("/src/audio/AgiAudio.ts");
    const context = new AudioContext();
    const audio = new AgiAudio({ contextFactory: () => context });
    const signalsPath = "/e2e/browserSignals.ts";
    const { audioElapsed, audioState, audioWitness, waitForSignal }: typeof BrowserSignals =
      await import(/* @vite-ignore */ signalsPath);
    try {
      audio.output({ kind: "speaker", divisor: 2712 });
      await context.resume();
      const startAt = context.currentTime;
      // Start the sample and ramp after context startup has completed.
      // A one-shot sample and an envelope ramp scheduled against context time.
      const shot = context.createBuffer(
        1,
        Math.floor(context.sampleRate * 0.3),
        context.sampleRate,
      );
      const source = context.createBufferSource();
      source.buffer = shot;
      let ended = false;
      source.onended = () => {
        ended = true;
      };
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(1, startAt);
      envelope.gain.linearRampToValueAtTime(0, startAt + 0.3);
      envelope.connect(context.destination);
      source.connect(context.destination);
      source.start(startAt);
      await audioElapsed(context, 0.08);
      const playingAt = context.currentTime;
      audio.setPaused(true);
      await audioState(context, "suspended");
      const pausedAt = context.currentTime;
      const rampAtPause = envelope.gain.value;
      await audioWitness(0.4); // an independent clock passes the sample's length
      const frozen = {
        state: context.state,
        drift: context.currentTime - pausedAt,
        ended,
        ramp: rampAtPause,
      };
      audio.setPaused(false);
      const ranOut = await waitForSignal(
        () => ended,
        (check) => {
          source.addEventListener("ended", check);
          return () => source.removeEventListener("ended", check);
        },
        1200,
      );
      return {
        playingAdvance: playingAt - startAt,
        frozen,
        ended,
        ranOut,
        // Context seconds the same source needed after release: what was left
        // of its 0.3 s, not the wall time that passed while it was frozen.
        afterRelease: context.currentTime - pausedAt,
        resumed: context.state,
      };
    } finally {
      audio.stop();
      await context.close();
    }
  });
  expect(result.playingAdvance).toBeGreaterThan(0.04);
  expect(result.frozen.state).toBe("suspended");
  expect(result.frozen.drift).toBe(0);
  expect(result.frozen.ended, "the one-shot must not finish while frozen").toBe(false);
  expect(result.frozen.ramp).toBeGreaterThan(0);
  expect(result.frozen.ramp).toBeLessThan(1);
  expect(result.ranOut, "the same source runs out after release").toBe(true);
  expect(result.resumed).toBe("running");
  expect(result.afterRelease).toBeLessThan(0.29);
  expect(result.afterRelease).toBeGreaterThan(0.1);
  expect(providerCalls).toBe(0);
});

test("a pause before the first context, an unlock request, and a named owner @webkit-desktop", async ({
  page,
}) => {
  let providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const result = await page.evaluate(async () => {
    const { AgiAudio } = await import("/src/audio/AgiAudio.ts");
    let context: AudioContext | null = null;
    let suspensionSettled = false;
    const suspension = Promise.withResolvers<void>();
    const audio = new AgiAudio({
      contextFactory: () => {
        const ctx = new AudioContext();
        const suspend = ctx.suspend.bind(ctx);
        ctx.suspend = async () => {
          await suspend();
          suspensionSettled = true;
          suspension.resolve();
        };
        context = ctx;
        return ctx;
      },
    });
    const signalsPath = "/e2e/browserSignals.ts";
    const { audioElapsed, audioState, audioWitness, waitForSignal }: typeof BrowserSignals =
      await import(/* @vite-ignore */ signalsPath);
    try {
      // The pause predates the context; the first output creates it frozen.
      audio.setPaused(true);
      audio.output({ kind: "speaker", divisor: 2712 });
      const ctx = context!;
      // WebKit initially reports suspended, then starts the context. Observe
      // the app's completed suspension rather than that provisional state.
      await waitForSignal(
        () => suspensionSettled && ctx.state === "suspended",
        (check) => {
          void suspension.promise.then(check);
          ctx.addEventListener("statechange", check);
          return () => ctx.removeEventListener("statechange", check);
        },
        1200,
      );
      const frozenAt = ctx.currentTime;
      await audioWitness(0.15);
      const firstContext = { state: ctx.state, drift: ctx.currentTime - frozenAt };
      // The user-gesture unlock must not lift the outstanding pause.
      await audio.resume();
      await audioWitness(0.08);
      const afterUnlock = { state: ctx.state, drift: ctx.currentTime - frozenAt };
      // A named owner holds across the ambient channel's release.
      audio.setPauseOwner("worker", true);
      audio.setPaused(false);
      await audioWitness(0.15);
      const ownerHeld = { state: ctx.state, drift: ctx.currentTime - frozenAt };
      // Late output during the hold does not lift it either.
      audio.output({ kind: "speaker", divisor: 1356 });
      await audioWitness(0.08);
      const stillHeld = { state: ctx.state, drift: ctx.currentTime - frozenAt };
      audio.setPauseOwner("worker", false);
      await audioState(ctx, "running");
      const resumedAt = ctx.currentTime;
      await audioElapsed(ctx, 0.15);
      return {
        firstContext,
        afterUnlock,
        ownerHeld,
        stillHeld,
        released: { state: ctx.state, advance: ctx.currentTime - resumedAt },
      };
    } finally {
      audio.stop();
      await (context as AudioContext | null)?.close();
    }
  });
  expect(result.firstContext).toEqual({ state: "suspended", drift: 0 });
  expect(result.afterUnlock).toEqual({ state: "suspended", drift: 0 });
  expect(result.ownerHeld).toEqual({ state: "suspended", drift: 0 });
  expect(result.stillHeld.state).toBe("suspended");
  expect(result.stillHeld.drift).toBe(0);
  expect(result.released.state).toBe("running");
  expect(result.released.advance).toBeGreaterThan(0.04);
  expect(providerCalls).toBe(0);
});
