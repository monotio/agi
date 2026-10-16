import { expect, test } from "./test.ts";
import { isolateStorage, openGameOptions, surfaceBox, waitForRoom } from "./engineProbe.ts";

test.use({ gpuStage: true });

for (const viewport of [
  { width: 1063, height: 815 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  const phone = viewport.width === 390;
  test(`${viewport.width}: BIOS text and monitor shape preserve the Play controls ${phone ? "@phone" : "@webkit-desktop"}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await isolateStorage(page);
    if (phone)
      await page.addInitScript(() => localStorage.setItem("monotio_agi.touchControls", "on"));
    await page.goto("/");
    await page.getByTestId("catalog-play-adventure-department").click();
    await waitForRoom(page, 1, { coldBoot: true });
    // S is hand-transcribed from the BIOS graphics typeface, with eight rows
    // and an eight-pixel advance. This checks the browser's composed pixels.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const frame = window.__AGI_FRAME__?.();
          const canvas = document.querySelector<HTMLCanvasElement>("[data-testid='game-canvas']");
          if (!frame || !canvas) return false;
          let cell = -1;
          for (let i = 0; i < 40; i++)
            if (frame.text[i * 2] === 83) {
              cell = i;
              break;
            }
          if (cell < 0) return false;
          const pixels = canvas.getContext("2d")!.getImageData(cell * 8, 0, 8, 8).data;
          const rows = [0x3c, 0x66, 0x70, 0x38, 0x0e, 0x66, 0x3c, 0];
          const attr = frame.text[cell * 2 + 1]!;
          const ega = [0, 170, 0, 170, 0, 170, 0, 170, 85, 255, 85, 255, 85, 255, 85, 255];
          for (let y = 0; y < 8; y++)
            for (let x = 0; x < 8; x++) {
              const colour = rows[y]! & (128 >> x) ? attr & 15 : attr >> 4;
              // Blue component distinguishes black and white in the status bar.
              if (pixels[(y * 8 + x) * 4 + 2] !== ega[colour]) return false;
            }
          return true;
        }),
      )
      .toBe(true);
    await openGameOptions(page, "settings-menu");
    await page.getByTestId("toggle-original-aspect").click();
    await page.keyboard.press("Escape");
    await expect
      .poll(async () => {
        const b = await surfaceBox(page);
        return b.width / b.height;
      })
      .toBeCloseTo(4 / 3, 2);
    if (phone) {
      const pad = page.getByTestId("touch-controls");
      await expect(pad).toBeVisible();
      for (const name of ["Walk north", "Walk south", "Enter", "Esc", "Space"]) {
        const button = pad.getByRole("button", { name, exact: true });
        await expect(button).toBeInViewport({ ratio: 1 });
        const box = (await button.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }
    await page.screenshot({
      path: test.info().outputPath(`pc-${viewport.width}.png`),
      fullPage: true,
    });
  });
}
