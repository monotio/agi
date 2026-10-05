import { test, expect } from "./test.ts";
import { isolateStorage, textHook, workspaceUpdated } from "./engineProbe.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";

test.use({ viewport: { width: 1440, height: 900 } });

async function start(page: Page) {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Tracing proof");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("part-room:1:picture:1").click();
  await expect(page.getByTestId("room-studio")).toHaveClass(/is-live-game/);
}
async function upload(page: Page) {
  const rgba = new Uint8Array(160 * 168 * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([255, 0, 0, 255], i);
  await page.getByTestId("image-file").setInputFiles({
    name: "red.png",
    mimeType: "image/png",
    buffer: Buffer.from(encodePngRgba(160, 168, rgba)),
  });
  await expect(page.getByTestId("trace-opacity")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
          ).__AGI_PROJECT__
            .getSession()
            .workingSnapshot()
            .read("images")?.content,
      ),
    )
    .toContain("red.png");
  await expect(
    page
      .getByTestId("image-reference")
      .getByRole("button", { name: "Bring in an image", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
}
function pixel(page: Page) {
  return page.locator('[data-layer="art"] canvas').evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const rgba = [
      ...canvas
        .getContext("2d")!
        .getImageData(
          Math.floor((canvas.width * 80.5) / 160),
          Math.floor((canvas.height * 10.5) / 168),
          1,
          1,
        ).data,
    ];
    if (rgba[3] === 0) {
      const colour = window.__AGI_FRAME__?.()?.visual[10 * 160 + 80];
      // The accepted sky remains on the engine surface under the transparent editing layer.
      return colour === 9 ? [85, 85, 255, 255] : rgba;
    }
    return rgba;
  });
}
function shot(page: Page, name: string) {
  return page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled" });
}
test("reference snaps to EGA and blends above Starter art while placement follows Undo and History", async ({
  page,
}) => {
  await start(page);
  await expect.poll(() => pixel(page)).toEqual([85, 85, 255, 255]);
  await shot(page, "picture-normal");
  await page.getByRole("button", { name: "Trace an image", exact: true }).click();
  await upload(page);
  await shot(page, "picture-trace");
  await page.getByTestId("trace-opacity").fill("1");
  await expect.poll(() => pixel(page)).toEqual([170, 0, 0, 255]);
  await workspaceUpdated(page);
  await page.getByTestId("trace-opacity").fill("0.6");
  // EGA red at 60% over sky blue: 170*.6 + 85*.4 = 136.
  await expect.poll(() => pixel(page)).toEqual([136, 34, 102, 255]);
  await workspaceUpdated(page);
  const front = await page.evaluate(
    () =>
      (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
        .getSession()
        .capture().history.cursor!,
  );
  await page.getByRole("checkbox", { name: "Behind art", exact: true }).check();
  await expect.poll(() => pixel(page)).toEqual([85, 85, 255, 255]);
  await workspaceUpdated(page);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Behind art", exact: true })).not.toBeChecked();
  await expect.poll(() => pixel(page)).toEqual([136, 34, 102, 255]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("trace-opacity")).toHaveValue("1");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Behind art", exact: true })).toBeChecked();
  await page.evaluate(async (id) => {
    await (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__
      .getSession()
      .restore(id);
  }, front);
  await expect(page.getByRole("checkbox", { name: "Behind art", exact: true })).not.toBeChecked();
  await expect(page.getByTestId("trace-opacity")).toHaveValue("0.6");
  await expect.poll(() => pixel(page)).toEqual([136, 34, 102, 255]);
  await page
    .getByTestId("image-reference")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await page.getByRole("button", { name: "Trace an image", exact: true }).click();
  await expect(page.getByTestId("trace-opacity")).toHaveValue("0.6");
  await expect(page.getByRole("checkbox", { name: "Behind art", exact: true })).not.toBeChecked();
  await shot(page, "picture-history");
});
test("Trace and Generate retain the PICTURE split and canvas size", async ({ page }) => {
  await start(page);
  const studio = page.getByTestId("room-studio");
  const editor = page.getByTestId("workspace-editor");
  const canvas = page.locator('[data-layer="art"] canvas');
  const normalEditor = (await editor.boundingBox())!;
  const normalCanvas = (await canvas.boundingBox())!;
  await page.getByRole("button", { name: "Trace an image", exact: true }).click();
  await upload(page);
  await shot(page, "picture-layout");
  await expect(studio).toHaveClass(/is-live-game/);
  expect((await editor.boundingBox())!.width).toBe(normalEditor.width);
  expect((await editor.boundingBox())!.x).toBe(normalEditor.x);
  expect((await canvas.boundingBox())!.width).toBe(normalCanvas.width);
  expect((await canvas.boundingBox())!.height).toBe(normalCanvas.height);
  await page
    .getByTestId("image-reference")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByTestId("generate-prompt")).toBeVisible();
  expect((await canvas.boundingBox())!.width).toBe(normalCanvas.width);
  expect((await canvas.boundingBox())!.height).toBe(normalCanvas.height);
  await shot(page, "picture-generate");
});
