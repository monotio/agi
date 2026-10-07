import { expect, test, type Page } from "@playwright/test";
import { isolateStorage, textHook } from "./engineProbe.ts";
import type { WorkerQueryFn } from "../src/worker/workerProtocol.ts";

interface TutorialAudioProbe {
  started: number[];
  active: number | null;
  outputs: number;
  contexts: AudioContext[];
}

async function audioState(page: Page) {
  return page.evaluate(() => {
    const probe = (window as Window & { tutorialAudio?: TutorialAudioProbe }).tutorialAudio;
    if (!probe) throw new Error("The audio probe was not installed");
    return {
      started: probe.started,
      active: probe.active,
      outputs: probe.outputs,
      contextStates: probe.contexts.map((context) => context.state),
    };
  });
}

/** Query the worker directly: room text can arrive before the position heartbeat. */
async function tutorialState(page: Page) {
  return page.evaluate(async () => {
    const api = (window as unknown as { __AGI_PROJECT__: { query: WorkerQueryFn } })
      .__AGI_PROJECT__;
    const state = await api.query("state");
    if (!state) throw new Error("The tutorial is not running");
    const objects = await api.query("objects");
    const lever = objects.find((object) => object.num === 2);
    return {
      room: state.room,
      x: state.egoX,
      y: state.egoY,
      direction: state.egoDirection,
      stopped: state.egoDirection === 0,
      inReach: state.egoX >= 26 && state.egoX <= 56 && state.egoY >= 112 && state.egoY <= 167,
      parsedWords: state.parsedWords,
      parsedCommand: state.parsedWordTexts,
      lastInputLine: state.lastInputLine,
      repaired: state.flags[31],
      leverCel: lever?.cel,
      leverCycling: lever?.cycling,
    };
  });
}

test("tutorial plays its opening and earned cues through the real sound worker and Web Audio", async ({
  page,
}, testInfo) => {
  const cpuRate = Number(process.env["AGI_TUTORIAL_CPU_RATE"] ?? 1);
  if (cpuRate !== 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  }
  await isolateStorage(page);
  await page.addInitScript(() => {
    const probe: TutorialAudioProbe = { started: [], active: null, outputs: 0, contexts: [] };
    Object.assign(window, { tutorialAudio: probe });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", ({ data }: MessageEvent) => {
          if (data.type === "sound") {
            probe.started.push(data.soundNum);
            probe.active = data.soundNum;
          }
          if (data.type === "stopSound" || (data.type === "soundTick" && data.complete))
            probe.active = null;
          if (data.type === "soundOutput") probe.outputs++;
          if (data.type === "soundTick") probe.outputs += data.outputs.length;
        });
      }
    };
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        probe.contexts.push(this);
      }
    };
  });
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect.poll(async () => (await audioState(page)).started).toEqual([1]);
  await expect.poll(async () => (await audioState(page)).contextStates).toContain("running");
  await expect.poll(async () => (await audioState(page)).outputs).toBeGreaterThan(0);
  const before = await textHook(page);
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(before.egoX);
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await audioState(page)).active).toBeNull();
  expect((await textHook(page)).modal).toBeNull();

  const command = async (text: string) => {
    await page.getByTestId("input-line").fill(text);
    await page.getByTestId("input-line").press("Enter");
  };
  const dismiss = async () => {
    await expect.poll(async () => (await textHook(page)).modal).not.toBeNull();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  };
  // The mural is painted from in front of the frame, so walk over first.
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThanOrEqual(60);
  await page.keyboard.press("ArrowRight");
  await command("paint mural");
  await expect.poll(async () => (await audioState(page)).started).toEqual([1, 2]);
  await expect.poll(async () => (await textHook(page)).modal).not.toBeNull();
  await expect.poll(async () => (await audioState(page)).active).toBeNull();
  await dismiss();
  await command("paint mural");
  await dismiss();
  expect((await audioState(page)).started).toEqual([1, 2]);

  await command("east");
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  // Wait for the lab's doorway in worker state before starting the walk.
  await expect
    .poll(() => tutorialState(page))
    .toMatchObject({ room: 2, x: 18, y: 151, stopped: true });
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => (await tutorialState(page)).x, { intervals: [20] })
    .toBeGreaterThanOrEqual(28);
  await page.keyboard.press("ArrowRight");
  // The queued stop must take effect inside the lever's reach (x 26-56).
  await expect
    .poll(() => tutorialState(page), { intervals: [20] })
    .toMatchObject({ room: 2, stopped: true, inReach: true });
  const beforeLever = await tutorialState(page);
  expect(beforeLever).toMatchObject({ room: 2, stopped: true, inReach: true });
  await command("pull lever");
  await expect.poll(async () => (await textHook(page)).modal).not.toBeNull();
  const evidence = {
    cpuRate,
    beforeLever,
    afterLever: await tutorialState(page),
    text: await textHook(page),
    audio: await audioState(page),
  };
  await testInfo.attach("lever-evidence", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
  await expect.poll(async () => (await audioState(page)).started).toEqual([1, 2, 3]);
  await dismiss();
  await command("pull lever");
  await dismiss();
  expect((await audioState(page)).started).toEqual([1, 2, 3]);

  await command("east");
  await expect.poll(async () => (await textHook(page)).room).toBe(3);
  // Felix is fixed at his counter (x 50-125): step over from the doorway.
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () => (await textHook(page)).egoX, { intervals: [20] })
    .toBeGreaterThanOrEqual(52);
  await page.keyboard.press("ArrowRight");
  await command("fix priority");
  await expect.poll(async () => (await audioState(page)).started).toEqual([1, 2, 3, 2]);
  await expect.poll(async () => (await textHook(page)).modal).not.toBeNull();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("graduated");
  await dismiss();
  await command("west");
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await command("west");
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  expect((await audioState(page)).started).toEqual([1, 2, 3, 2]);
});
