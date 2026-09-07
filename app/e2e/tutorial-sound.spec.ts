import { expect, test, type Page } from "@playwright/test";
import { isolateStorage, textHook } from "./engineProbe.ts";

interface TutorialAudioProbe {
  started: number[];
  active: number | null;
  outputs: number;
  contexts: AudioContext[];
}

async function audioState(page: Page) {
  return page.evaluate(() => {
    const probe = (window as Window & { tutorialAudio: TutorialAudioProbe }).tutorialAudio;
    return {
      started: probe.started,
      active: probe.active,
      outputs: probe.outputs,
      contextStates: probe.contexts.map((context) => context.state),
    };
  });
}

test("tutorial plays its opening and earned cues through the real sound worker and Web Audio", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.addInitScript(() => {
    const probe: TutorialAudioProbe = { started: [], active: null, outputs: 0, contexts: [] };
    (window as Window & { tutorialAudio: TutorialAudioProbe }).tutorialAudio = probe;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", ({ data }: MessageEvent) => {
          if (data.type === "sound") {
            probe.started.push(data.soundNum);
            probe.active = data.soundNum;
          }
          if (data.type === "stopSound") probe.active = null;
          if (data.type === "soundOutput") probe.outputs++;
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
  await command("pull lever");
  await expect.poll(async () => (await audioState(page)).started).toEqual([1, 2, 3]);
  await dismiss();
  await command("pull lever");
  await dismiss();
  expect((await audioState(page)).started).toEqual([1, 2, 3]);

  await command("east");
  await expect.poll(async () => (await textHook(page)).room).toBe(3);
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
