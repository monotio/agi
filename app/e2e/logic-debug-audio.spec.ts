import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import {
  blockProviders,
  continueRun,
  openLogicOne,
  openStudio,
  pauseToStop,
  prepareIsolatedPage,
  seedLocalProject,
  startDebugRun,
} from "./logicDebugShared.ts";

/**
 * The test run's private AgiAudio instance driven end to end against a
 * bounded AudioContext double installed before any app script runs: real
 * scheduling (channels, gains, oscillators) on `listen`, a worker-owned
 * suspend while a debug stop holds, a resume on continue, and close on end.
 * The stub records calls per context instance — the contexts the app created
 * are enumerable, so a stray second context or a close on the wrong owner
 * fails loudly.
 */

interface AudioStub {
  contexts: { calls: string[]; state: string }[];
}

async function audioStub(page: Page): Promise<AudioStub> {
  return page.evaluate(() => {
    const stub = (window as unknown as { __AGI_AUDIO_STUB__?: AudioStub }).__AGI_AUDIO_STUB__;
    if (!stub) throw new Error("audio stub not installed");
    return {
      contexts: stub.contexts.map((ctx) => ({ calls: [...ctx.calls], state: ctx.state })),
    };
  });
}

async function installAudioStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Ctx {
      calls: string[];
      state: string;
      suspend(): Promise<void>;
      resume(): Promise<void>;
      close(): Promise<void>;
    }
    const stub: { contexts: Ctx[] } = { contexts: [] };
    const CAP = 400;
    class Param {
      value = 0;
      calls: string[];
      name: string;
      constructor(calls: string[], name: string) {
        this.calls = calls;
        this.name = name;
      }
      private note(what: string, v: number): void {
        this.value = v;
        if (this.calls.length < CAP) this.calls.push(`${this.name}.${what}`);
      }
      setValueAtTime(v: number): void {
        this.note("set", v);
      }
      linearRampToValueAtTime(v: number): void {
        this.note("ramp", v);
      }
      cancelScheduledValues(): void {
        if (this.calls.length < CAP) this.calls.push(`${this.name}.cancel`);
      }
    }
    class Node {
      calls: string[];
      name: string;
      constructor(calls: string[], name: string) {
        this.calls = calls;
        this.name = name;
      }
      connect(): void {
        if (this.calls.length < CAP) this.calls.push(`${this.name}.connect`);
      }
      disconnect(): void {
        if (this.calls.length < CAP) this.calls.push(`${this.name}.disconnect`);
      }
    }
    class CtxImpl {
      calls: string[] = [];
      state = "running";
      currentTime = 0;
      sampleRate = 48000;
      destination = new Node(this.calls, "dest");
      private note(what: string): void {
        if (this.calls.length < CAP) this.calls.push(what);
      }
      createGain(): object {
        this.note("ctx.gain");
        const gain = Object.assign(new Node(this.calls, "gain"), {
          gain: new Param(this.calls, "gain.gain"),
        });
        return gain;
      }
      createOscillator(): object {
        this.note("ctx.osc");
        return Object.assign(new Node(this.calls, "osc"), {
          type: "",
          frequency: new Param(this.calls, "osc.freq"),
          start: () => this.note("osc.start"),
          stop: () => this.note("osc.stop"),
        });
      }
      createBuffer(_ch: number, len: number, rate: number): object {
        this.note("ctx.buffer");
        const data = new Float32Array(len);
        return { length: len, sampleRate: rate, getChannelData: () => data };
      }
      createBufferSource(): object {
        this.note("ctx.src");
        return Object.assign(new Node(this.calls, "src"), {
          buffer: null,
          loop: false,
          playbackRate: new Param(this.calls, "src.rate"),
          start: () => this.note("src.start"),
          stop: () => this.note("src.stop"),
        });
      }
      createBiquadFilter(): object {
        this.note("ctx.filter");
        return Object.assign(new Node(this.calls, "filter"), {
          type: "",
          Q: new Param(this.calls, "filter.q"),
          frequency: new Param(this.calls, "filter.freq"),
        });
      }
      suspend(): Promise<void> {
        this.state = "suspended";
        this.note("ctx.suspend");
        return Promise.resolve();
      }
      resume(): Promise<void> {
        this.state = "running";
        this.note("ctx.resume");
        return Promise.resolve();
      }
      close(): Promise<void> {
        this.state = "closed";
        this.note("ctx.close");
        return Promise.resolve();
      }
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    class StubbedAudioContext extends CtxImpl {
      constructor() {
        super();
        stub.contexts.push(this);
      }
    }
    (window as unknown as { __AGI_AUDIO_STUB__: object }).__AGI_AUDIO_STUB__ = stub;
    (window as unknown as { AudioContext: unknown }).AudioContext = StubbedAudioContext;
    (window as unknown as { webkitAudioContext: unknown }).webkitAudioContext = StubbedAudioContext;
  });
}

async function callsOf(page: Page, index: number): Promise<string[]> {
  const stub = await audioStub(page);
  return stub.contexts[index]?.calls ?? [];
}

test("the test run owns a private audio context: schedule, hold, resume, close", async ({
  page,
}) => {
  await installAudioStub(page);
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await seedLocalProject(page, "Audio lab");
  await page.reload();
  await openStudio(page, "Audio lab");
  await openLogicOne(page);
  const dock = await startDebugRun(page);
  await continueRun(page);

  // Audio is lazy: no context exists until the engine emits sound output.
  expect((await audioStub(page)).contexts).toHaveLength(0);

  // "listen" runs load.sound + sound(chime) — the real cue's tandy bytes
  // program oscillators, gains and the noise source on the private context.
  await page.getByTestId("debug-command-input").fill("listen");
  await page.getByTestId("debug-command-input").press("Enter");
  await expect.poll(async () => (await audioStub(page)).contexts.length).toBe(1);
  await expect
    .poll(async () => (await callsOf(page, 0)).includes("osc.start"), { timeout: 15_000 })
    .toBe(true);
  const scheduled = await callsOf(page, 0);
  expect(scheduled.some((c) => c === "ctx.gain")).toBe(true);
  expect(scheduled.some((c) => c === "gain.gain.set")).toBe(true);
  expect(scheduled.some((c) => c.startsWith("osc.freq"))).toBe(true);

  // A held debug stop suspends the context — the worker's debugger hold is
  // an owner, not a mute: the clock itself freezes.
  await pauseToStop(page);
  await expect
    .poll(async () => (await callsOf(page, 0)).includes("ctx.suspend"), { timeout: 15_000 })
    .toBe(true);
  await expect(dock.getByTestId("debug-audio-held")).toBeVisible();

  // Continuing releases the hold — the same context resumes.
  await continueRun(page);
  await expect
    .poll(async () => (await callsOf(page, 0)).includes("ctx.resume"), { timeout: 15_000 })
    .toBe(true);

  // Ending the run closes the private context exactly once — no second
  // context was ever created, and no other instance was touched.
  await dock.getByTestId("debug-end").click();
  await expect(dock.getByTestId("debug-phase")).toContainText("Ended");
  await expect
    .poll(async () => (await callsOf(page, 0)).includes("ctx.close"), { timeout: 15_000 })
    .toBe(true);
  expect((await audioStub(page)).contexts).toHaveLength(1);
  expect(providers.count()).toBe(0);
  expect(errors).toEqual([]);
});
