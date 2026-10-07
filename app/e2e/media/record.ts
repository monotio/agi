import { mkdirSync, writeFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { test } from "../test.ts";

/**
 * A short clip of the real app: the browser's own screencast frames, written
 * as PNGs at device pixels with their presentation times beside a
 * `frames.json` index; `crop` names the region of the page the clip shows:
 * an element, a rectangle in CSS pixels, or the whole viewport when null. scripts/capture-media.ts
 * resamples the frames to a fixed rate and encodes the GIF. Frames arrive
 * only when the page repaints, so a still screen costs nothing.
 */
export async function record(
  page: Page,
  name: string,
  crop: Locator | { x: number; y: number; width: number; height: number } | null,
  scene: () => Promise<void>,
): Promise<void> {
  const dir = test.info().outputPath(`${name}.frames`);
  mkdirSync(dir, { recursive: true });
  const session = await page.context().newCDPSession(page);
  const frames: { file: string; time: number }[] = [];
  const pending: Promise<unknown>[] = [];
  session.on("Page.screencastFrame", (frame) => {
    const file = `frame-${String(frames.length).padStart(5, "0")}.png`;
    frames.push({ file, time: frame.metadata.timestamp ?? Date.now() / 1000 });
    writeFileSync(`${dir}/${file}`, Buffer.from(frame.data, "base64"));
    pending.push(session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }));
  });
  const viewport = page.viewportSize()!;
  const box = crop && "boundingBox" in crop ? await crop.boundingBox() : crop;
  const region = box ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const scale = await page.evaluate(() => devicePixelRatio);
  await session.send("Page.startScreencast", {
    format: "png",
    maxWidth: viewport.width * scale,
    maxHeight: viewport.height * scale,
  });
  const start = Date.now() / 1000;
  await scene();
  const end = Date.now() / 1000;
  await session.send("Page.stopScreencast");
  await Promise.allSettled(pending);
  await session.detach();
  writeFileSync(
    `${dir}/frames.json`,
    JSON.stringify({ start, end, viewport, region, frames }, null, 2),
  );
}
