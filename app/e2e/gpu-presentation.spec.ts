import { expect, test } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";
import { textHook } from "./engineProbe.ts";

// Use native WebGPU on macOS; CI also exercises the WebGL2 fallback.
test.use({ headless: process.platform !== "darwin" });

test("saved game keeps its message visible through resize, then changes rooms and draws ego", async ({
  page,
}) => {
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
  await page.evaluate(
    (filesBase64) => {
      localStorage.setItem(
        "monotio_agi.authored.presentation",
        JSON.stringify({
          slug: "presentation",
          title: "Saved adventure",
          authoredAt: "2026-01-01T00:00:00Z",
          provider: "stub",
          model: "local-playback",
          imported: true,
          filesBase64,
          words: [],
        }),
      );
    },
    Object.fromEntries(
      [...game.files].map(([name, data]) => [name, Buffer.from(data).toString("base64")]),
    ),
  );
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).modal).toBe("print");
  expect((await textHook(page)).room).toBe(0);
  await expect
    .poll(async () => (await textHook(page)).rows.join(" ").replace(/#/g, " ").replace(/\s+/g, " "))
    .toContain("Welcome to your saved adventure.");
  const gpu = page.getByTestId("gpu-canvas");
  await expect(gpu).toBeVisible();
  const coloredPixels = async () => {
    const png = await gpu.screenshot();
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
  };
  await expect.poll(coloredPixels).toBeGreaterThan(1000);
  await page.screenshot({ path: "test-results/gpu-opening-message.png" });
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
  await page.screenshot({ path: "test-results/gpu-message-room-arrival.png" });
});
