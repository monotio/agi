import { expect, test } from "@playwright/test";

// Real-browser audition evidence: the service drives its own SoundPlayback
// into a private AgiAudio/AudioContext and must leave the gameplay instance —
// its context and its outstanding pause holds — alone. Timing is measured on
// the browsers' own clocks: scheduler cadence is asserted within honest
// bounds, never claimed as sample-exact. Synthetic SOUND bytes only.

const PROVIDER = /api\.openai\.com|api\.anthropic\.com/;

test("audition plays a native cue on its own context and preserves the game's hold @webkit-desktop", async ({
  page,
}) => {
  let providerCalls = 0;
  await page.route(PROVIDER, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  // Autoplay policies need a real gesture before the contexts are created.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const result = await page.evaluate(async () => {
    const { AgiAudio } = await import("/src/audio/AgiAudio.ts");
    const { SoundAudition } = await import("/src/audio/soundAudition.ts");
    const elapse = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const until = async (predicate: () => boolean, tries = 200) => {
      for (let i = 0; i < tries && !predicate(); i++) await elapse(20);
      return predicate();
    };
    const unhandled: string[] = [];
    const onRejection = (event: PromiseRejectionEvent) => unhandled.push(String(event.reason));
    window.addEventListener("unhandledrejection", onRejection);

    // A 90-tick note on lane 0 plus a noise voice on lanes 2+3 — ordinary
    // hand-encoded four-stream bytes.
    const tone = (channel: number, ticks: number, divisor: number, att: number) => [
      ticks & 255,
      ticks >> 8,
      (divisor >> 4) & 0x3f,
      0x80 | (channel << 5) | (divisor & 0xf),
      0x90 | (channel << 5) | att,
    ];
    const noise = (ticks: number, control: number, att: number) => [
      ticks & 255,
      ticks >> 8,
      control,
      0xe0 | control,
      0xf0 | att,
    ];
    const bytes = [0, 0, 0, 0, 0, 0, 0, 0];
    const lanes = [
      [...tone(0, 90, 226, 4), 0xff, 0xff],
      [0xff, 0xff],
      [...tone(2, 90, 300, 4), 0xff, 0xff],
      [...noise(90, 7, 4), 0xff, 0xff],
    ];
    for (let channel = 0; channel < 4; channel++) {
      bytes[channel * 2] = bytes.length & 255;
      bytes[channel * 2 + 1] = bytes.length >> 8;
      bytes.push(...lanes[channel]!);
    }
    const payload = new Uint8Array(bytes);

    // The "game" instance: its own context held frozen by a worker owner.
    const gameContext = new AudioContext();
    const gameAudio = new AgiAudio({ contextFactory: () => gameContext });
    gameAudio.output({ kind: "speaker", divisor: 2712 });
    gameAudio.setPauseOwner("worker", true);
    await until(() => gameContext.state === "suspended");
    const gameFrozenAt = gameContext.currentTime;

    // The private preview instance and its own context.
    const previewContext = new AudioContext();
    const previewAudio = new AgiAudio({ contextFactory: () => previewContext });
    const leaseLog = { acquires: 0, releases: 0 };
    const audition = new SoundAudition({
      audio: previewAudio,
      acquire: () => {
        leaseLog.acquires++;
        return {
          release: () => {
            leaseLog.releases++;
          },
        };
      },
    });

    // Measure wall-time event cadence: each notify while playing carries the
    // executed tick count, and each output stamps the context clock.
    const wakeTimes: number[] = [];
    const contextTimes: number[] = [];
    const original = previewAudio.outputTick.bind(previewAudio);
    previewAudio.outputTick = (packet) => {
      contextTimes.push(...packet.outputs.map(() => previewContext.currentTime));
      original(packet);
    };
    audition.subscribe((snapshot) => {
      if (snapshot.status === "playing") wakeTimes.push(performance.now());
    });
    audition.setTarget({
      projectId: "proj-1",
      documentId: "sound:7",
      revision: 3,
      payload,
      profileId: "2.936",
      device: 1,
    });
    const identity = audition.snapshot().target!;
    const startAt = performance.now();
    await audition.play();
    const done = await until(() => audition.snapshot().status === "complete", 400);
    const finishedAt = performance.now();
    const final = audition.snapshot();

    // Inter-tick gaps from the notify stream.
    const gaps = wakeTimes.slice(1).map((t, i) => t - wakeTimes[i]!);
    const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    const maxGap = gaps.length ? Math.max(...gaps) : 0;
    const minGap = gaps.length ? Math.min(...gaps) : 0;

    // The gameplay hold and context must be untouched by everything above.
    const gameState = {
      state: gameContext.state,
      drift: gameContext.currentTime - gameFrozenAt,
      paused: gameAudio.isPaused,
    };
    audition.stop();
    await audition.close();
    const afterClose = {
      previewState: previewContext.state,
      previewClosed: previewAudio.closed,
      gameState: { state: gameContext.state, drift: gameContext.currentTime - gameFrozenAt },
    };
    gameAudio.setPauseOwner("worker", false);
    await until(() => gameContext.state === "running");
    await gameAudio.close();
    window.removeEventListener("unhandledrejection", onRejection);
    return {
      done,
      final: {
        status: final.status,
        position: final.positionTicks,
        extent: final.playbackExtentTicks,
      },
      identity: {
        profileId: identity.profileId,
        device: identity.device,
        hash: identity.payloadHash,
      },
      authored: final.authoredExtentTicks,
      wallMs: finishedAt - startAt,
      wakeCount: wakeTimes.length,
      eventCount: contextTimes.length,
      timing: { meanGap, minGap, maxGap },
      contextLead: contextTimes.length ? contextTimes.at(-1)! - contextTimes[0]! : 0,
      leaseLog,
      gameState,
      afterClose,
      unhandled,
    };
  });
  expect(result.done, "the cue completed on the SoundPlayback stream").toBe(true);
  expect(result.final).toEqual({ status: "complete", position: 90, extent: 90 });
  expect(result.authored).toBe(90);
  expect(result.identity).toEqual({
    profileId: "2.936",
    device: 1,
    hash: result.identity.hash,
  });
  expect(result.leaseLog).toEqual({ acquires: 1, releases: 1 });
  // Scheduler honesty: the wall time covers ~1.5 s of ticks; per-wake gaps
  // average the 60 Hz grid under ordinary load, with any outlier bounded.
  expect(result.wallMs).toBeGreaterThan(1200);
  expect(result.wallMs).toBeLessThan(5000);
  expect(result.timing.meanGap).toBeGreaterThan(10);
  expect(result.timing.meanGap).toBeLessThan(30);
  expect(result.timing.maxGap).toBeLessThan(400);
  expect(result.eventCount).toBeGreaterThan(100);
  // The game's worker hold stayed frozen the whole audition: state suspended,
  // context clock unmoved, pause still held.
  expect(result.gameState).toEqual({ state: "suspended", drift: 0, paused: true });
  expect(result.afterClose).toEqual({
    previewState: "closed",
    previewClosed: true,
    gameState: { state: "suspended", drift: 0 },
  });
  expect(result.unhandled).toEqual([]);
  expect(providerCalls).toBe(0);
  console.log(
    `audition timing: wallMs=${result.wallMs.toFixed(0)} wakes=${result.wakeCount} ` +
      `mean=${result.timing.meanGap.toFixed(2)}ms min=${result.timing.minGap.toFixed(2)} ` +
      `max=${result.timing.maxGap.toFixed(2)} ctxSpan=${result.contextLead.toFixed(3)}s`,
  );
});

test("audition pause suspends its context, seek stays silent, close during settle is safe @webkit-desktop", async ({
  page,
}) => {
  let providerCalls = 0;
  await page.route(PROVIDER, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  const result = await page.evaluate(async () => {
    const { AgiAudio } = await import("/src/audio/AgiAudio.ts");
    const { SoundAudition } = await import("/src/audio/soundAudition.ts");
    const elapse = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const until = async (predicate: () => boolean, tries = 200) => {
      for (let i = 0; i < tries && !predicate(); i++) await elapse(20);
      return predicate();
    };
    const unhandled: string[] = [];
    const onRejection = (event: PromiseRejectionEvent) => unhandled.push(String(event.reason));
    window.addEventListener("unhandledrejection", onRejection);

    const tone = (channel: number, ticks: number, divisor: number, att: number) => [
      ticks & 255,
      ticks >> 8,
      (divisor >> 4) & 0x3f,
      0x80 | (channel << 5) | (divisor & 0xf),
      0x90 | (channel << 5) | att,
    ];
    const bytes = [0, 0, 0, 0, 0, 0, 0, 0];
    const lanes = [
      [...tone(0, 240, 226, 4), 0xff, 0xff],
      [0xff, 0xff],
      [0xff, 0xff],
      [0xff, 0xff],
    ];
    for (let channel = 0; channel < 4; channel++) {
      bytes[channel * 2] = bytes.length & 255;
      bytes[channel * 2 + 1] = bytes.length >> 8;
      bytes.push(...lanes[channel]!);
    }
    const payload = new Uint8Array(bytes);

    const context = new AudioContext();
    const audio = new AgiAudio({ contextFactory: () => context });
    const audition = new SoundAudition({ audio, acquire: () => ({ release: () => {} }) });
    audition.setTarget({
      projectId: "proj-1",
      documentId: "sound:7",
      revision: 4,
      payload,
      profileId: "2.936",
      device: 1,
    });
    await audition.play();
    await until(() => audition.snapshot().positionTicks >= 20);

    // Pause suspends the private context outright — a gain mute could not
    // freeze scheduled work the way the suspended clock does.
    audition.pause();
    const suspended = await until(() => context.state === "suspended");
    const frozenAt = context.currentTime;
    await elapse(200);
    const pausedState = { state: context.state, drift: context.currentTime - frozenAt };
    await audition.resume();
    const resumed = await until(() => context.state === "running");
    const positionAtResume = audition.snapshot().positionTicks;

    // Seek is silent reconstruction, then live playback continues.
    const sought = await audition.seek(60);
    const seekState = { status: sought.status, position: sought.positionTicks };
    await until(() => audition.snapshot().positionTicks > 62);
    const afterSeek = audition.snapshot().positionTicks;

    // close() during an in-flight suspend must not resurrect or reject.
    audition.pause();
    const closing = audition.close();
    await closing;
    const closedState = {
      audioClosed: audio.closed,
      ctxState: context.state,
      snapshot: audition.snapshot().status,
    };
    window.removeEventListener("unhandledrejection", onRejection);
    return {
      suspended,
      pausedState,
      resumed,
      positionAtResume,
      seekState,
      afterSeek,
      closedState,
      unhandled,
    };
  });
  expect(result.suspended).toBe(true);
  expect(result.pausedState).toEqual({ state: "suspended", drift: 0 });
  expect(result.resumed).toBe(true);
  expect(result.positionAtResume).toBeGreaterThanOrEqual(20);
  expect(result.seekState).toEqual({ status: "playing", position: 60 });
  expect(result.afterSeek).toBeGreaterThan(62);
  expect(result.closedState).toEqual({
    audioClosed: true,
    ctxState: "closed",
    snapshot: "idle",
  });
  expect(result.unhandled).toEqual([]);
  expect(providerCalls).toBe(0);
});
