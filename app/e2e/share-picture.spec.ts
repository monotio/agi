import { readFile } from "node:fs/promises";
import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { enterCreateMode, isolateStorage, textHook, openWorldRoom } from "./engineProbe.ts";

/**
 * Share in Room Studio on the real app: the tutorial's room 2, the Sprite
 * Lab in its world plan, as a still (a compressed 640×400 PNG of the
 * 320×200 frame at 2×, its caption card drawn in the engine font) and as a
 * clip of the picture painting itself (video, where this browser can record
 * a canvas).
 */

async function openRoom2(page: Page): Promise<Locator> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  await openWorldRoom(panel, 2);
  await panel.getByTestId("world-open-studio").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

async function openShareMenu(page: Page, studio: Locator): Promise<Locator> {
  await studio.getByTestId("studio-share").click();
  const menu = page.getByTestId("studio-share-menu");
  await expect(menu).toContainText("Shares this draft as you see it, unkept changes included.");
  return menu;
}

/** RGB of the listed pixels of a PNG, decoded by the browser. */
async function pngPixels(
  page: Page,
  bytes: Buffer,
  points: readonly (readonly [number, number])[],
): Promise<{ width: number; height: number; rgb: number[][] }> {
  return page.evaluate(
    async ({ data, points }) => {
      const bitmap = await createImageBitmap(
        new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: "image/png" }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const { data: pixels } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const rgb = points.map(([x, y]) => {
        const at = (y * bitmap.width + x) * 4;
        return [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!];
      });
      return { width: bitmap.width, height: bitmap.height, rgb };
    },
    { data: bytes.toString("base64"), points },
  );
}

test("Share → Still downloads the finished room as a captioned 640×400 PNG", async ({ page }) => {
  const studio = await openRoom2(page);
  const menu = await openShareMenu(page, studio);
  await menu.getByTestId("studio-share-still").click();
  const dialog = page.getByTestId("studio-share-dialog");
  await expect(dialog).toContainText("adventure-department-sprite-lab.png");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByTestId("studio-share-download").click(),
  ]);
  expect(download.suggestedFilename()).toBe("adventure-department-sprite-lab.png");
  const bytes = await readFile((await download.path())!);
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // Deflated, not stored: the stored form of these 400 rows is 256 KB.
  expect(bytes.length).toBeLessThan(50_000);

  // The caption strip at 2×: the dark-grey rule on frame row 168 (y 336),
  // and the wordmark's cyan full stop, frame pixels 307-308 × 190-191.
  const { width, height, rgb } = await pngPixels(page, bytes, [
    [0, 336],
    [639, 337],
    [614, 380],
    [617, 383],
    [613, 380],
  ]);
  expect([width, height]).toEqual([640, 400]);
  expect(rgb).toEqual([
    [0x55, 0x55, 0x55],
    [0x55, 0x55, 0x55],
    [0x55, 0xff, 0xff],
    [0x55, 0xff, 0xff],
    [0, 0, 0],
  ]);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(studio).toBeVisible();
});

test("Share → Clip records the room painting itself as video", async ({ page }) => {
  const studio = await openRoom2(page);
  const type = await page.evaluate(() =>
    typeof MediaRecorder === "undefined"
      ? null
      : (["video/webm;codecs=vp9", "video/webm", "video/mp4"].find((t) =>
          MediaRecorder.isTypeSupported(t),
        ) ?? null),
  );
  let menu = await openShareMenu(page, studio);
  if (type === null) {
    await expect(menu.getByTestId("studio-share-clip")).toBeDisabled();
    await expect(menu).toContainText("This browser can't record video. The still works.");
    test.skip(true, "This browser has no MediaRecorder for canvas video.");
    return;
  }
  const dialog = page.getByTestId("studio-share-dialog");

  // Cancel stops the recording and closes the dialog.
  await menu.getByTestId("studio-share-clip").click();
  await expect(dialog.getByTestId("studio-share-progress")).toHaveText(/^Painting [1-9]\d*%…$/);
  await dialog.getByTestId("studio-share-cancel").click();
  await expect(dialog).toBeHidden();

  menu = await openShareMenu(page, studio);
  await menu.getByTestId("studio-share-clip").click();
  const extension = type.startsWith("video/mp4") ? "mp4" : "webm";
  await expect(dialog.getByTestId("studio-share-file")).toContainText(
    `adventure-department-sprite-lab.${extension}`,
    { timeout: 30_000 },
  );
  const recorded = await dialog
    .locator("video")
    .evaluate(async (video: HTMLVideoElement) => (await (await fetch(video.src)).blob()).type);
  expect(recorded).toBe(type.split(";")[0]);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByTestId("studio-share-download").click(),
  ]);
  expect(download.suggestedFilename()).toBe(`adventure-department-sprite-lab.${extension}`);
  const bytes = await readFile((await download.path())!);
  // A 7.5 s 960×600 clip is far more than a header.
  expect(bytes.length).toBeGreaterThan(50_000);
  if (extension === "webm") expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
});
