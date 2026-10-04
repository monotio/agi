import { test, expect } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import type { HistoryBatch } from "../../src/agent/history.ts";

test(
  "a 1024-square trace keeps recording bounded through 30 seconds of play",
  { tag: "@perf" },
  async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await isolateStorage(page);
    await page.goto("/#create-adventure");
    await page
      .getByTestId("create-adventure-disclosure")
      .getByLabel("Name", { exact: true })
      .fill("Large image");
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByRole("button", { name: "Start building", exact: true }).click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await page.getByTestId("part-room:1:picture:1").click();
    await page.getByRole("button", { name: "Trace an image", exact: true }).click();
    await expect(page.getByTestId("image-reference")).toBeVisible();
    await page.evaluate(() => {
      const probe = window as unknown as {
        __AGI_PROJECT__: { getWorker(): Worker };
        __IMAGE_BATCHES__: { segment: string; size: number; documents: boolean }[];
      };
      probe.__IMAGE_BATCHES__ = [];
      probe.__AGI_PROJECT__
        .getWorker()
        .addEventListener(
          "message",
          (event: MessageEvent<{ type: string; batch: HistoryBatch }>) => {
            if (event.data.type !== "historyBatch") return;
            const batch = event.data.batch;
            probe.__IMAGE_BATCHES__.push({
              segment: batch.segment,
              size: JSON.stringify(batch).length,
              documents:
                batch.boot?.project?.documents.documents.some(
                  ({ key }) =>
                    !/^(logic|picture|view|sound):\d+$/.test(key) &&
                    !["words", "inventory", "bindings"].includes(key),
                ) ?? false,
            });
          },
        );
    });
    const rgba = new Uint8Array(1024 * 1024 * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set([0, 170, 0, 255], i);
    await page.getByTestId("image-file").setInputFiles({
      name: "large.png",
      mimeType: "image/png",
      buffer: Buffer.from(encodePngRgba(1024, 1024, rgba)),
    });
    await expect(page.getByTestId("trace-opacity")).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
        .getSession()
        .flush(),
    );
    await expect(page.getByTestId("workspace-saved")).toBeVisible();
    await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
    const batches = () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __IMAGE_BATCHES__: { segment: string; size: number; documents: boolean }[];
            }
          ).__IMAGE_BATCHES__,
      );
    await page.evaluate(() =>
      (window as unknown as { __AGI_PROJECT__: { getWorker(): Worker } }).__AGI_PROJECT__
        .getWorker()
        .postMessage({ type: "flush", id: 999001 }),
    );
    await expect.poll(async () => (await batches()).length).toBeGreaterThan(0);
    // Check the attachment admission before the timed play window.
    expect((await batches()).every((batch) => batch.size < 256 * 1024 && !batch.documents)).toBe(
      true,
    );
    await page.getByRole("radio", { name: "Play", exact: true }).click();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    async function metrics() {
      const response = await cdp.send("Performance.getMetrics");
      return Object.fromEntries(response.metrics.map((metric) => [metric.name, metric.value]));
    }
    const samples = [await metrics()];
    const cycleBefore = (await textHook(page)).cycle;
    for (let window = 0; window < 3; window++) {
      // Measure actual playing frames, rather than parking the page on a timer.
      const frames = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const start = performance.now();
            let frames = 0;
            function next() {
              frames++;
              if (performance.now() - start >= 10_000) resolve(frames);
              else requestAnimationFrame(next);
            }
            requestAnimationFrame(next);
          }),
      );
      expect(frames).toBeGreaterThan(100);
      await cdp.send("HeapProfiler.collectGarbage");
      samples.push(await metrics());
    }
    expect((await textHook(page)).cycle).toBeGreaterThan(cycleBefore + 100);
    await page.evaluate(() =>
      (window as unknown as { __AGI_PROJECT__: { getWorker(): Worker } }).__AGI_PROJECT__
        .getWorker()
        .postMessage({ type: "flush", id: 999002 }),
    );
    const recorded = await batches();
    expect(new Set(recorded.map((batch) => batch.segment)).size).toBeLessThanOrEqual(2);
    expect(recorded.length).toBeLessThan(30);
    expect(recorded.every((batch) => batch.size < 256 * 1024 && !batch.documents)).toBe(true);
    const cpu = samples
      .slice(1)
      .map((sample, index) => sample["TaskDuration"]! - samples[index]!["TaskDuration"]!);
    const heapGrowth = samples.at(-1)!["JSHeapUsedSize"]! - samples[0]!["JSHeapUsedSize"]!;
    expect(Math.max(...cpu), "main-thread CPU seconds per 10 seconds of play").toBeLessThan(5);
    expect(cpu[2]!, "CPU stays stable through the last play window").toBeLessThan(
      cpu[0]! * 2 + 0.5,
    );
    expect(heapGrowth, "retained main-thread heap growth over 30 seconds").toBeLessThan(
      16 * 1024 * 1024,
    );
    console.log(
      JSON.stringify({
        segments: new Set(recorded.map((batch) => batch.segment)).size,
        batches: recorded.length,
        maxBatch: Math.max(0, ...recorded.map((batch) => batch.size)),
        cpuSeconds: cpu,
        heapGrowth,
      }),
    );
  },
);
