import { cacheGame, openDeveloperActivity, openGameOptions, openInspector } from "./engineProbe.ts";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { testProjectId } from "../test/identity.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";
import { textHook } from "./engineProbe.ts";

/** A small saved game: a blue picture, an opening message, then room 1 with ego. */
async function openSavedAdventure(page: Page): Promise<void> {
  const game = createContainer();
  game.putResource("picture", 1, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
    set(f200); assignn(v60, 1); load.pic(v60); draw.pic(v60); show.pic();
    print("Welcome to your saved adventure.");
    new.room(1);
  } call.v(v0); return;`,
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource(
    "view",
    0,
    buildView({
      loops: [{ cels: [{ width: 4, height: 8, pixels: Array<number>(32).fill(14) }] }],
    }),
  );
  game.putResource(
    "logic",
    1,
    assembleLogic(
      `
    if (isset(f5)) {
      assignn(v60,1); load.pic(v60); draw.pic(v60); show.pic();
      load.view(0); animate.obj(o0); set.view(o0,0); position(o0,80,140);
      draw(o0); stop.cycling(o0);
    } return;`,
      { dictionary: new Map() },
    ).payload,
  );
  await page.goto("/");
  await cacheGame(page, {
    projectId: testProjectId("presentation"),
    title: "Saved adventure",
    provider: "stub",
    model: "local-playback",
    imported: true,
    roomGeneration: false,
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
}

/** Pixels of the visible game picture that read as the room's blue. */
async function bluePixels(page: Page, surface: Locator): Promise<number> {
  const png = await surface.screenshot();
  return page.evaluate(
    async (bytes) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: "image/png" }),
      );
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let blue = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (
          pixels[i + 2]! > 30 &&
          pixels[i + 2]! > pixels[i]! * 2 &&
          pixels[i + 2]! > pixels[i + 1]! * 2
        )
          blue++;
      return blue;
    },
    [...png],
  );
}

test("saved game keeps its message visible through resize, then changes rooms and draws ego", async ({
  page,
}) => {
  await openSavedAdventure(page);
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).modal).toBe("print");
  expect((await textHook(page)).room).toBe(0);
  await expect
    .poll(async () => (await textHook(page)).rows.join(" ").replace(/#/g, " ").replace(/\s+/g, " "))
    .toContain("Welcome to your saved adventure.");
  const gpu = page.getByTestId("gpu-canvas");
  await expect(gpu).toBeVisible();
  const coloredPixels = () => bluePixels(page, gpu);
  await expect.poll(coloredPixels).toBeGreaterThan(1000);
  await page.screenshot({ path: test.info().outputPath("gpu-opening-message.png") });
  await page.setViewportSize({ width: 800, height: 720 });
  await expect.poll(coloredPixels).toBeGreaterThan(1000);
  expect((await textHook(page)).modal).toBe("print");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>("[data-testid='game-canvas']")!;
        return Array.from(canvas.getContext("2d")!.getImageData(160, 148, 1, 1).data);
      }),
    )
    .toEqual([255, 255, 85, 255]);
  await expect.poll(coloredPixels).toBeGreaterThan(1000);
  await page.screenshot({ path: test.info().outputPath("gpu-message-room-arrival.png") });

  // The stepped control previews while the game remains visible.
  await page.getByTestId("settings-menu").click();
  const crtSlider = page.getByRole("slider", { name: "CRT", exact: true });
  await expect(crtSlider).toBeVisible();
  await crtSlider.fill("1");
  await expect(crtSlider).toHaveValue("1");
  await expect.poll(coloredPixels).toBeGreaterThan(1000);
  await crtSlider.press("Home");
  await expect(crtSlider).toHaveValue("0");
  await expect.poll(coloredPixels).toBeGreaterThan(1000);
});

/**
 * Count the page's WebGL 2 contexts that are still alive. Chrome keeps at most
 * sixteen and silently drops the oldest beyond that, so a game page must hold
 * one, whatever number of games the player has opened.
 */
async function countGpuContexts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const contexts: WebGL2RenderingContext[] = [];
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args: Parameters<typeof getContext>
    ) {
      const context = getContext.apply(this, args);
      if (args[0] === "webgl2" && context && !contexts.includes(context as WebGL2RenderingContext))
        contexts.push(context as WebGL2RenderingContext);
      return context;
    } as typeof getContext;
    (window as unknown as { liveGpuContexts: () => number }).liveGpuContexts = () =>
      contexts.filter((context) => !context.isContextLost()).length;
  });
}

function liveGpuContexts(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as { liveGpuContexts: () => number }).liveGpuContexts(),
  );
}

test("opening games again and again keeps the picture drawn on one GPU context", async ({
  page,
}) => {
  await countGpuContexts(page);
  await openSavedAdventure(page);
  const gpu = page.getByTestId("gpu-canvas");
  const openedPicture = async () => {
    await expect(gpu).toBeVisible();
    await expect.poll(() => bluePixels(page, gpu)).toBeGreaterThan(1000);
    await expect.poll(() => liveGpuContexts(page)).toBe(1);
  };
  // Leaving to the library and resuming mounts a fresh game screen each time.
  for (let opening = 0; opening < 3; opening++) {
    await page.getByTestId("btn-resume-cached").click();
    await openedPicture();
    await page.getByTestId("btn-exit").click();
    await expect(page.getByTestId("btn-resume-cached")).toBeVisible();
  }
  // Start over boots the game again from inside it.
  await page.getByTestId("btn-resume-cached").click();
  await openedPicture();
  for (let restart = 0; restart < 2; restart++) {
    await expect.poll(async () => (await textHook(page)).modal).toBe("print");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await openGameOptions(page, "settings-menu");
    await page.getByTestId("btn-start-over").click();
    await expect.poll(async () => (await textHook(page)).room).toBe(0);
    await openedPicture();
  }
});

test("a lost GPU context leaves the flat picture, and the next game gets the stage back", async ({
  page,
}) => {
  await openSavedAdventure(page);
  await page.getByTestId("btn-resume-cached").click();
  const gpu = page.getByTestId("gpu-canvas");
  const flat = page.getByTestId("game-canvas");
  await expect(gpu).toBeVisible();
  await expect.poll(() => bluePixels(page, gpu)).toBeGreaterThan(1000);

  await gpu.evaluate((canvas: HTMLCanvasElement) =>
    canvas.getContext("webgl2")!.getExtension("WEBGL_lose_context")!.loseContext(),
  );
  await expect(flat).toBeVisible();
  await expect(gpu).toBeHidden();
  await expect.poll(() => bluePixels(page, flat)).toBeGreaterThan(1000);
  // The game plays on: the message closes and the next room draws.
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect.poll(() => bluePixels(page, flat)).toBeGreaterThan(1000);

  await page.getByTestId("btn-exit").click();
  await page.getByTestId("btn-resume-cached").click();
  await expect(gpu).toBeVisible();
  await expect(flat).toBeHidden();
  await expect.poll(() => bluePixels(page, gpu)).toBeGreaterThan(1000);
});
