import { recordPerformance } from "./performanceTrend.ts";
import { DEADLINES } from "./deadlines.ts";
import { test, expect } from "./test.ts";
import { start, open } from "./pictureWorkspaceShared.ts";
import { installPointerFrameMeasurement, measurePointerFrames } from "./gesturePerf.ts";
import { buildView, parseView } from "../../src/view/view.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

test("fast strokes on a large cel keep every pixel within a frame @perf", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(installPointerFrameMeasurement);
  await start(page);
  const bytes = buildView({
    loops: [
      {
        cels: [
          {
            width: 160,
            height: 168,
            transparentColor: 15,
            pixels: new Uint8Array(160 * 168).fill(15),
          },
        ],
      },
    ],
  });
  await page.evaluate(
    async (bytes) => {
      const session = (
        window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
      ).__AGI_PROJECT__.getSession();
      const result = await session.submit({
        proposal: session.model.propose(session.model.capture(), "Large cel", [
          { key: "view:8", content: Uint8Array.from(bytes) },
        ]),
        label: "Large cel",
        origin: "logic",
        author: "creator",
      });
      if (result.status !== "committed") throw new Error(result.status);
    },
    [...bytes],
  );
  await open(page, "part-view:8");
  const canvas = page.getByTestId("view-canvas");
  await expect(canvas).toHaveAttribute("data-width", "160", { timeout: DEADLINES.editor });
  await canvas.scrollIntoViewIfNeeded();
  const rect = (await canvas.boundingBox())!;
  const point = (x: number, y: number) => ({
    x: rect.x + ((x + 0.5) * rect.width) / 160,
    y: rect.y + ((y + 0.5) * rect.height) / 168,
  });
  await page.mouse.move(point(1, 1).x, point(1, 1).y);
  await page.mouse.down();
  const batches = Array.from({ length: 12 }, (_, row) =>
    Array.from({ length: 8 }, (_, i) => point(row % 2 ? 145 - i * 20 : 5 + i * 20, 2 + row)),
  );
  const samples = await canvas.evaluate(measurePointerFrames, batches);
  await recordPerformance("pointer-frames", { workMs: samples.map((sample) => sample.workMs) });
  expect(
    samples.map((sample) => sample.callbacks),
    "one callback for each burst of moves",
  ).toEqual(Array.from({ length: 12 }, () => 1));
  const end = point(145, 13);
  await canvas.dispatchEvent("pointerup", { pointerId: 1, clientX: end.x, clientY: end.y });
  await page.mouse.up();
  const result = parseView(
    Uint8Array.from(await page.evaluate(() => [...window.__AGI_VIEW__!.bytes()])),
  ).loops[0]!.cels[0]!;
  const colour = result.pixels[2 * 160 + 10]!;
  expect(colour).not.toBe(15);
  for (let y = 2; y < 14; y++)
    for (let x = 5; x <= 145; x++) expect(result.pixels[y * 160 + x]).toBe(colour);
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({
      path: test.info().outputPath(`view-stroke-${width}.png`),
      animations: "disabled",
    });
  }
});
