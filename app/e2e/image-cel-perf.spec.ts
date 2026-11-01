import { recordPerformance } from "./performanceTrend.ts";
import { DEADLINES } from "./deadlines.ts";
import { installPointerFrameMeasurement, measurePointerFrames } from "./gesturePerf.ts";
import { test, expect } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";

test("large image cel drags keep pointer work within a cel @perf", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(installPointerFrameMeasurement);
  await isolateStorage(page);
  await page.addInitScript(() => {
    const posts: { at: number; bytes: number[] | null }[] = [];
    Object.assign(window, { __framePosts: posts });
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      message: { type?: string; bytes?: Uint8Array | null },
      options?: StructuredSerializeOptions | Transferable[],
    ) {
      if (message.type === "imageEgoPreview")
        posts.push({ at: performance.now(), bytes: message.bytes ? [...message.bytes] : null });
      if (Array.isArray(options)) post.call(this, message, { transfer: options });
      else post.call(this, message, options);
    };
  });
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("part-view:0").click();
  await page.getByRole("button", { name: "Make cels from an image", exact: true }).click();
  const rgba = new Uint8Array(1024 * 1024 * 4).fill(255);
  for (let i = 0; i < 8; i++)
    for (let y = 100; y < 300; y++)
      for (let x = 20 + i * 125; x < 80 + i * 125; x++)
        rgba.set([170, 0, 0, 255], (y * 1024 + x) * 4);
  await page.getByTestId("image-file").setInputFiles({
    name: "large-sheet.png",
    mimeType: "image/png",
    buffer: Buffer.from(encodePngRgba(1024, 1024, rgba)),
  });
  await expect(page.getByTestId("image-cel")).toHaveCount(8, { timeout: DEADLINES.image });
  await page.getByRole("button", { name: "Pause animation", exact: true }).click();
  await page.getByTestId("image-preview-hero").click();
  const thumbnails = page.getByTestId("prepared-cel-thumbnail");
  const before = await thumbnails.evaluateAll((images) =>
    images.map((image) => (image as HTMLImageElement).src),
  );
  const cel = page.getByRole("button", { name: "Cel 1", exact: true });
  await cel.click({ position: { x: 10, y: 12 }, trial: true });
  const bounds = (await cel.boundingBox())!;
  await page.mouse.move(bounds.x + 10, bounds.y + 12);
  await page.mouse.down();
  const result = await page
    .getByTestId("image-cel")
    .first()
    .evaluate(async (box) => {
      const rect = box.getBoundingClientRect();
      const thumbnails = () =>
        [
          ...document.querySelectorAll<HTMLImageElement>('[data-testid="prepared-cel-thumbnail"]'),
        ].map((image) => image.src);
      const before = thumbnails();
      const batches = Array.from({ length: 12 }, (_, i) =>
        Array.from({ length: 8 }, (_, move) => ({
          x: rect.x + 10 + i + (move + 1) / 8,
          y: rect.y + 12,
        })),
      );
      return { batches, before };
    });
  const samples = await page
    .getByTestId("cel-sheet")
    .evaluate(measurePointerFrames, result.batches);
  expect(
    await thumbnails.evaluateAll((images) =>
      images.map((image) => (image as HTMLImageElement).src),
    ),
  ).toEqual(before);
  const dx = await page
    .getByTestId("image-cel")
    .first()
    .evaluate((box) => {
      const rect = box.getBoundingClientRect();
      const sheet = box.closest('[data-testid="cel-sheet"]')!;
      const event = (type: string, x: number) =>
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          button: 0,
          clientX: rect.x + x,
          clientY: rect.y + 12,
        });
      sheet.dispatchEvent(event("pointerup", 22));
      return Math.round(12 / (sheet.getBoundingClientRect().width / 1024));
    });
  await page.mouse.up();
  await recordPerformance("pointer-frames", { workMs: samples.map((sample) => sample.workMs) });
  expect(
    samples.map((sample) => sample.callbacks),
    "one callback for each burst of moves",
  ).toEqual(Array.from({ length: 12 }, () => 1));
  await expect(thumbnails.first()).not.toHaveAttribute("src", before[0]!);
  const after = await thumbnails.evaluateAll((images) =>
    images.map((image) => (image as HTMLImageElement).src),
  );
  expect(after.slice(1)).toEqual(before.slice(1));
  const posts = () =>
    page.evaluate(
      () =>
        (window as unknown as { __framePosts: { at: number; bytes: number[] | null }[] })
          .__framePosts,
    );
  await expect.poll(async () => (await posts()).length).toBe(2);
  const settledBytes = (await posts()).at(-1)!.bytes;
  const postsBeforeNudges = (await posts()).length;
  await cel.focus();
  for (let i = 0; i < dx; i++) await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < dx; i++) await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await posts()).length).toBeGreaterThan(postsBeforeNudges);
  await expect.poll(async () => (await posts()).at(-1)!.bytes).toEqual(settledBytes);
  expect(
    await thumbnails.evaluateAll((images) =>
      images.map((image) => (image as HTMLImageElement).src),
    ),
  ).toEqual(after);
  const times = (await posts()).map((post) => post.at);
  for (let i = 1; i < times.length; i++)
    expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(145);
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.screenshot({
      path: test.info().outputPath(`cels-${width}.png`),
      animations: "disabled",
    });
  }
});
