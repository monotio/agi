import { test, expect } from "./test.ts";
import type { Page } from "@playwright/test";
import { textHook } from "./engineProbe.ts";
import { decodePng } from "../../scripts/png.ts";

async function play(page: Page, full = false): Promise<void> {
  if (full) {
    await page.addInitScript(() => {
      if (
        localStorage.getItem("monotio_agi.crtAmount") === null &&
        localStorage.getItem("monotio_agi.crt") === null
      )
        localStorage.setItem("monotio_agi.crtAmount", "1");
    });
  }
  await page.goto("/");
  // Observe the actual uniform through the public stage property; keep this
  // probe in the test rather than adding a browser-only production API.
  await page.evaluate(async () => {
    const { AgiStage } = await import("/src/three/AgiStage.ts");
    const descriptor = Object.getOwnPropertyDescriptor(AgiStage.prototype, "crtAmount")!;
    Object.defineProperty(AgiStage.prototype, "crtAmount", {
      ...descriptor,
      set(value: number) {
        descriptor.set!.call(this, value);
        (window as unknown as { crtStage: unknown }).crtStage = this;
      },
    });
  });
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect(page.getByTestId("gpu-canvas")).toBeVisible();
}

async function uniformAmount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { crtStage: { crtAmount: number } }).crtStage.crtAmount,
  );
}

async function reloadGame(page: Page): Promise<void> {
  await page.reload();
  const game = page.getByTestId("gpu-canvas");
  const play = page.getByTestId("catalog-play-adventure-department");
  await expect(game.or(play).filter({ visible: true })).toBeVisible();
  if (await play.isVisible()) await play.click();
  await expect(game).toBeVisible();
}

async function settings(page: Page) {
  await page.getByTestId("settings-menu").click();
  const slider = page.getByRole("slider", { name: "CRT", exact: true });
  await expect(slider).toBeVisible();
  return slider;
}

test("CRT steps preview their uniform live, support keys and persist after reload", async ({
  page,
}) => {
  await play(page, true);
  const slider = await settings(page);
  await expect(slider).toHaveValue("1");
  await slider.focus();
  await slider.press("Home");
  const labels = ["Off", "25%", "50%", "75%", "Full"];
  for (let step = 0; step <= 4; step++) {
    if (step) await slider.press("ArrowRight");
    await expect(slider).toHaveValue(String(step / 4));
    await expect(slider).toHaveAttribute("aria-valuetext", labels[step]!);
    const label = page.getByTestId("crt-value");
    await expect(label).toBeVisible();
    await expect(label).toHaveText(labels[step]!);
    await expect.poll(() => uniformAmount(page)).toBe(step / 4);
  }
  await slider.press("ArrowLeft");
  await slider.press("ArrowDown");
  await expect(slider).toHaveValue("0.5");
  await expect.poll(() => uniformAmount(page)).toBe(0.5);
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.crtAmount"))).toBe("0.5");
  await reloadGame(page);
  const restored = await settings(page);
  await expect(restored).toHaveValue("0.5");
  await restored.press("End");
  await expect(restored).toHaveValue("1");
});

for (const legacy of ["off", "on"]) {
  test(`CRT migrates the old ${legacy} preference`, async ({ page }) => {
    await page.addInitScript((value) => {
      if (!localStorage.getItem("monotio_agi.crt")) localStorage.setItem("monotio_agi.crt", value);
    }, legacy);
    await play(page);
    const slider = await settings(page);
    const amount = legacy === "on" ? "1" : "0";
    await expect(slider).toHaveValue(amount);
    expect(await page.evaluate(() => localStorage.getItem("monotio_agi.crtAmount"))).toBe(amount);
    expect(await page.evaluate(() => localStorage.getItem("monotio_agi.crt"))).toBe(legacy);
    await slider.fill("0.25");
    await reloadGame(page);
    await expect(await settings(page)).toHaveValue("0.25");
  });
}

test("CRT Off renders exactly the flat material's pixels and reuses the shader", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(async () => {
    const { AgiStage } = await import("/src/three/AgiStage.ts");
    const canvas = document.createElement("canvas");
    canvas.dataset["testid"] = "crt-flat";
    canvas.style.cssText = "position:fixed;inset:0;width:1280px;height:800px;z-index:9999";
    document.body.append(canvas);
    const stage = await AgiStage.create(canvas);
    if (!stage) throw new Error("GPU stage unavailable");
    const frame = new Uint8Array(320 * 200 * 4);
    for (let y = 0; y < 200; y++)
      for (let x = 0; x < 320; x++)
        frame.set([(x % 16) * 17, (y % 16) * 17, ((x + y) % 16) * 17, 255], (y * 320 + x) * 4);
    // Directly select the existing flat material as the independent reference.
    const internals = stage as unknown as { quad: { material: unknown }; flatMaterial: unknown };
    internals.quad.material = internals.flatMaterial;
    stage.render(frame, true);
    (window as unknown as { crtStage: unknown }).crtStage = stage;
  });
  const canvas = page.getByTestId("crt-flat");
  await expect(canvas).toBeVisible();
  // WebKit's compositor may still show the page under a newly mounted
  // WebGL canvas. Establish a hand-computed source pixel before comparing.
  const readyPixel = async () => {
    await page.evaluate(() =>
      (window as unknown as { crtStage: { flush(): void } }).crtStage.flush(),
    );
    const image = decodePng(await canvas.screenshot());
    const at = (162 * image.width + 162) * 4;
    return [...image.rgba.subarray(at, at + 3)];
  };
  await expect.poll(readyPixel).toEqual([136, 136, 0]);
  const flat = decodePng(
    await canvas.screenshot({ path: test.info().outputPath("flat-reference.png") }),
  );
  const versions = await page.evaluate(() => {
    const stage = (
      window as unknown as {
        crtStage: {
          crtAmount: number;
          crtMaterial: { version: number };
          quad: { material: unknown };
          flatMaterial: unknown;
        };
      }
    ).crtStage;
    const version = stage.crtMaterial.version;
    if (stage.crtAmount !== 1) throw new Error("Initial CRT uniform must be Full");
    for (const amount of [0.25, 0.5, 0.75, 1, 0]) {
      stage.crtAmount = amount;
      if (stage.crtAmount !== amount) throw new Error("CRT amount must update its uniform");
      if (amount > 0 && stage.quad.material === stage.flatMaterial)
        throw new Error("Positive amounts must use the CRT material");
    }
    return {
      before: version,
      after: stage.crtMaterial.version,
      flat: stage.quad.material === stage.flatMaterial,
    };
  });
  expect(versions).toEqual({ before: versions.before, after: versions.before, flat: true });
  await expect.poll(readyPixel).toEqual([136, 136, 0]);
  const off = decodePng(await canvas.screenshot({ path: test.info().outputPath("crt-off.png") }));
  expect(Buffer.from(off.rgba).equals(Buffer.from(flat.rgba))).toBe(true);
});

test("CRT screenshots show every step and Settings fits each screen", async ({
  page,
  browserName,
}) => {
  const sizes =
    browserName === "webkit"
      ? [{ width: 390, height: 844 }]
      : [
          { width: 1063, height: 815 },
          { width: 1440, height: 900 },
        ];
  await play(page, true);
  for (const size of sizes) {
    await page.setViewportSize(size);
    const slider = await settings(page);
    for (const amount of [0, 0.25, 0.5, 0.75, 1]) {
      await slider.fill(String(amount));
      await expect.poll(() => uniformAmount(page)).toBe(amount);
      await page.screenshot({
        path: test.info().outputPath(`after-${size.width}-${amount}.png`),
        animations: "disabled",
      });
    }
    const box = (await slider.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    await slider.press("Escape");
    await expect(slider).toBeHidden();
  }
});
