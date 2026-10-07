import { expect, test } from "./test.ts";
import { decodePng } from "../../scripts/png.ts";

test("CRT preserves every frame edge and all four corner cells", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { AgiStage } = await import("/src/three/AgiStage.ts");
    const canvas = document.createElement("canvas");
    canvas.dataset["testid"] = "crt-frame";
    canvas.style.cssText = "position:fixed;inset:0;width:1280px;height:800px;z-index:9999";
    document.body.append(canvas);
    const stage = await AgiStage.create(canvas);
    if (!stage) throw new Error("GPU stage unavailable");
    const frame = new Uint8Array(320 * 200 * 4);
    for (let y = 0; y < 200; y++)
      for (let x = 0; x < 320; x++) {
        // 8×8 corner cells: red, green, blue, yellow. Cyan and magenta
        // fill the first and last text rows; white fills the picture edges.
        const colour =
          y < 8
            ? x < 8
              ? [255, 0, 0]
              : x >= 312
                ? [0, 255, 0]
                : [0, 255, 255]
            : y >= 192
              ? x < 8
                ? [0, 0, 255]
                : x >= 312
                  ? [255, 255, 0]
                  : [255, 0, 255]
              : [255, 255, 255];
        frame.set([...colour, 255], (y * 320 + x) * 4);
      }
    stage.crtAmount = 1;
    stage.render(frame, true);
  });
  const canvas = page.getByTestId("crt-frame");
  const png = await canvas.screenshot({ path: test.info().outputPath("crt-frame.png") });
  const { width, height, rgba } = decodePng(png);
  // The 4% glass border leaves the frame inside the rounded face. Invert
  // the specified tube bows (3.5% / 4.5%) to locate source pixel centres.
  // These expectations use constants, independent of the shader graph.
  for (let y = 0; y < 200; y++)
    for (let x = 0; x < 320; x++) {
      if (x !== 0 && x !== 319 && y !== 0 && y !== 7 && y !== 192 && y !== 199) continue;
      const tx = ((2 * (x + 0.5)) / 320 - 1) / (1.08 * 1.04);
      const ty = ((2 * (y + 0.5)) / 200 - 1) / (1.08 * 1.04);
      let cx = tx,
        cy = ty;
      for (let iteration = 0; iteration < 10; iteration++) {
        cx = tx / (1 + 0.035 * cy * cy);
        cy = ty / (1 + 0.045 * cx * cx);
      }
      const px = Math.floor(((cx + 1) * width) / 2);
      const py = Math.floor(((cy + 1) * height) / 2);
      const at = (py * width + px) * 4;
      const expected =
        y < 8
          ? x < 8
            ? [1, 0, 0]
            : x >= 312
              ? [0, 1, 0]
              : [0, 1, 1]
          : y >= 192
            ? x < 8
              ? [0, 0, 1]
              : x >= 312
                ? [1, 1, 0]
                : [1, 0, 1]
            : [1, 1, 1];
      for (let channel = 0; channel < 3; channel++) {
        const value = rgba[at + channel]!;
        if (expected[channel])
          expect(value, `frame (${x},${y}) channel ${channel}`).toBeGreaterThan(150);
        // At a cell boundary the Gaussian beam and glass scatter can mix
        // up to 30% linear light (~149 sRGB) from the neighbouring white row.
        else expect(value, `frame (${x},${y}) channel ${channel}`).toBeLessThan(150);
      }
    }
});

test("initial 640 by 400 stage matches its canvas backing store", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { AgiStage } = await import("/src/three/AgiStage.ts");
    const canvas = document.createElement("canvas");
    canvas.dataset["testid"] = "initial-stage";
    canvas.width = 960;
    canvas.height = 600;
    canvas.style.cssText = "position:fixed;inset:0;width:640px;height:400px;z-index:9999";
    document.body.append(canvas);
    const stage = await AgiStage.create(canvas);
    if (!stage) throw new Error("GPU stage unavailable");
    const frame = new Uint8Array(320 * 200 * 4);
    for (let y = 0; y < 200; y++)
      for (let x = 0; x < 320; x++)
        frame.set([x < 160 ? 255 : 0, y < 100 ? 255 : 0, 80, 255], (y * 320 + x) * 4);
    stage.crtAmount = 1;
    stage.render(frame, true);
  });
  const canvas = page.getByTestId("initial-stage");
  await expect(canvas).toBeVisible();
  for (const viewport of [
    { width: 1063, height: 815 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.screenshot({
      path: test.info().outputPath(`initial-stage-${viewport.width}.png`),
      scale: "css",
    });
  }
  expect(await canvas.evaluate((node: HTMLCanvasElement) => [node.width, node.height])).toEqual([
    640, 400,
  ]);
});
