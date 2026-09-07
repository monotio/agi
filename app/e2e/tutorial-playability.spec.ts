import { expect, test, type Page } from "@playwright/test";
import { isolateStorage, textHook, waitForCycles } from "./engineProbe.ts";

test("tutorial walking speed commands change movement without a modal", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);

  const measure = async (speed: string | null): Promise<number> => {
    if (speed !== null) await command(page, speed);
    await waitForCycles(page, 2);
    expect((await textHook(page)).modal, `${speed ?? "default"} must not open a dialog`).toBeNull();
    await page.getByTestId("input-line").focus();
    await page.keyboard.press("ArrowRight");
    await waitForCycles(page, 2);
    const before = await textHook(page);
    await expect
      .poll(async () => (await textHook(page)).cycle, { intervals: [20] })
      .toBeGreaterThanOrEqual(before.cycle + 32);
    const after = await textHook(page);
    await page.keyboard.press("ArrowRight");
    await waitForCycles(page, 2);
    expect(after.room).toBe(1);
    return (after.egoX - before.egoX) / (after.cycle - before.cycle);
  };

  // One native logic cycle is 50ms; normal is 5 one-pixel steps per 8 cycles.
  expect(await measure(null)).toBeCloseTo(0.625, 1);
  expect(await measure("fast")).toBeCloseTo(1, 1);
  expect(await measure("slow")).toBeCloseTo(0.5, 1);
  expect(await measure("normal")).toBeCloseTo(0.625, 1);
});

async function command(page: Page, value: string): Promise<void> {
  await page.getByTestId("input-line").fill(value);
  await page.getByTestId("input-line").press("Enter");
}

async function leverPixels(page: Page): Promise<{
  hash: number;
  brightRed: number;
  redCenterX: number;
}> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-testid='game-canvas']")!;
    const pixels = canvas.getContext("2d")!.getImageData(58, 84, 40, 30).data;
    let hash = 0;
    let brightRed = 0;
    let redX = 0;
    for (let pixel = 0; pixel < pixels.length; pixel += 4) {
      const r = pixels[pixel]!;
      const g = pixels[pixel + 1]!;
      const b = pixels[pixel + 2]!;
      hash = (hash * 31 + r * 65536 + g * 256 + b) | 0;
      if (r > 220 && g > 30 && g < 130 && b < 130) {
        brightRed++;
        redX += (pixel / 4) % 40;
      }
    }
    return { hash, brightRed, redCenterX: brightRed === 0 ? -1 : redX / brightRed };
  });
}

test("tutorial walls and three exhibits work through the real browser controls", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.setViewportSize({ width: 1000, height: 820 });
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("ArrowUp");
  await waitForCycles(page, 55);
  expect((await textHook(page)).egoY).toBe(126);
  await page.keyboard.press("ArrowUp");
  // The mural is painted from in front of the frame, so walk over first.
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThanOrEqual(60);
  await page.keyboard.press("ArrowRight");
  await command(page, "paint mural");
  await expect.poll(async () => (await textHook(page)).modal).not.toBeNull();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await waitForCycles(page, 2);
  await page.screenshot({ path: test.info().outputPath("gallery.png"), fullPage: true });

  await command(page, "east");
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await waitForCycles(page, 2);
  const leverBefore = await leverPixels(page);
  expect(leverBefore.brightRed).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath("lab-lever-before.png"), fullPage: true });
  await command(page, "pull lever");
  let leverDuring = leverBefore;
  await expect
    .poll(
      async () => {
        const hook = await textHook(page);
        const pixels = await leverPixels(page);
        if (hook.modal === null && pixels.hash !== leverBefore.hash) leverDuring = pixels;
        return hook.modal === null && pixels.hash !== leverBefore.hash;
      },
      { timeout: 5_000, intervals: [50] },
    )
    .toBe(true);
  expect(leverDuring.brightRed).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath("lab-lever-during.png"), fullPage: true });
  await expect.poll(async () => (await textHook(page)).modal).not.toBeNull();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await waitForCycles(page, 4);
  const leverAfter = await leverPixels(page);
  expect(leverAfter.hash).not.toBe(leverBefore.hash);
  expect(leverAfter.brightRed).toBeGreaterThan(0);
  expect(leverAfter.redCenterX).toBeGreaterThan(leverBefore.redCenterX + 12);
  await page.screenshot({ path: test.info().outputPath("lab-lever-after.png"), fullPage: true });

  await command(page, "east");
  await expect.poll(async () => (await textHook(page)).room).toBe(3);
  await waitForCycles(page, 2);
  await page.screenshot({ path: test.info().outputPath("archive-before.png"), fullPage: true });
  await command(page, "fix priority");
  await expect.poll(async () => (await textHook(page)).modal).not.toBeNull();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("priority");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("graduated");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await waitForCycles(page, 2);
  await page.screenshot({ path: test.info().outputPath("archive-after.png"), fullPage: true });
});
