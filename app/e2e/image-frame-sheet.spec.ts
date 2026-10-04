import { test, expect } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import { buildView, parseView, type BuildViewInput } from "../../src/view/view.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import type { Page } from "@playwright/test";

async function projectView(page: Page) {
  return page.evaluate(() => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    return {
      content: (() => {
        const content = session.model.capture().read("view:0")!.content;
        return typeof content === "string" ? content : [...content];
      })(),
      commits: session.capture().history.commits.length,
    };
  });
}
test("mark, resize and paint frames before one exact VIEW commit", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Sheet proof");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("part-view:0").click();
  await page.getByRole("button", { name: "Make cels from an image", exact: true }).click();
  const rgba = new Uint8Array(32 * 16 * 4);
  for (let y = 2; y < 10; y++)
    for (let x = 2; x < 8; x++) {
      rgba.set([170, 0, 0, 255], (y * 32 + x) * 4);
      rgba.set([0, 170, 0, 255], (y * 32 + x + 16) * 4);
    }
  await page.getByTestId("image-file").setInputFiles({
    name: "walk.png",
    mimeType: "image/png",
    buffer: Buffer.from(encodePngRgba(32, 16, rgba)),
  });
  await expect(page.getByTestId("image-frame")).toHaveCount(2);
  await page.getByRole("button", { name: "Frame 1", exact: true }).click();
  await page.keyboard.press("Delete");
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("image-frame")).toHaveCount(0);
  const sheet = page.getByTestId("frame-sheet");
  async function drag(x: number, y: number, endX: number, endY: number) {
    const bounds = (await sheet.boundingBox())!;
    await page.mouse.move(bounds.x + (x * bounds.width) / 32, bounds.y + (y * bounds.height) / 16);
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + (endX * bounds.width) / 32,
      bounds.y + (endY * bounds.height) / 16,
      { steps: 8 },
    );
    await page.mouse.up();
  }
  await drag(2, 2, 8, 10);
  await drag(18, 2, 24, 10);
  await expect(page.getByTestId("image-frame")).toHaveCount(2);
  const right = page.getByRole("button", { name: "Resize frame 2 east", exact: true });
  const handle = (await right.boundingBox())!;
  const bounds = (await sheet.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2 + (bounds.width * 2) / 32,
    handle.y + handle.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  await page.getByRole("button", { name: "Frame 2", exact: true }).focus();
  await page.keyboard.press("1");
  await expect(page.getByTestId("frame-summary")).toBeVisible();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 2 · 8 × 8 at 18, 2");
  await expect(
    page.getByRole("option", { name: "Walk left · loop 1 (mirrors walk right)", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Frame 1", exact: true }).click();
  await expect(page.getByTestId("frame-summary")).toBeVisible();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 1 · 6 × 8 at 2, 2");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.getByTestId("frame-summary")).toBeVisible();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 1 · 6 × 8 at 9, 2");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByTestId("frame-summary")).toBeVisible();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 1 · 7 × 8 at 2, 2");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("0");
  await drag(5, 6, 7, 6);
  await expect(page.getByTestId("frame-summary")).toBeVisible();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 1 · 6 × 8 at 4, 2");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Frame 2", exact: true })).toBeFocused();
  await page.keyboard.press("1");
  const strip = page.getByRole("group", { name: "Frame order: drag thumbnails to reorder" });
  await strip
    .getByRole("button", { name: "Select frame 2 in order strip", exact: true })
    .dragTo(strip.getByRole("button", { name: "Select frame 1 in order strip", exact: true }));
  await expect(page.getByTestId("frame-summary")).toBeVisible();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 1 · 8 × 8 at 18, 2");
  await strip
    .getByRole("button", { name: "Select frame 1 in order strip", exact: true })
    .dragTo(strip.getByRole("button", { name: "Select frame 2 in order strip", exact: true }));
  await expect(page.getByTestId("frame-summary")).toBeVisible();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 2 · 8 × 8 at 18, 2");
  await page.getByRole("button", { name: "Frame 1", exact: true }).click();
  await page.getByLabel("Cel height", { exact: true }).fill("8");
  await page.getByLabel("Cel height", { exact: true }).press("Tab");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.getByTestId("frame-summary").click();
  await expect(page.getByLabel("Selected frame x", { exact: true })).toHaveValue("2");
  await page.getByTestId("frame-summary").click();
  // Declining replacement preserves both hand-marked crops.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: "Find frames again", exact: true }).click();
  await expect(page.getByTestId("image-frame")).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath("cels-1440.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: test.info().outputPath("cels-1280.png"), animations: "disabled" });
  const before = await projectView(page);
  await page.getByTestId("image-add-cels").click();
  await expect(page.getByTestId("image-status")).toBeVisible();
  await expect(page.getByTestId("image-status")).toHaveText("Added 2 cels");
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
  const after = await projectView(page);
  expect(after.commits).toBe(before.commits + 1);
  const input = parseView(
    typeof before.content === "string"
      ? buildView(JSON.parse(before.content))
      : Uint8Array.from(before.content),
  );
  const loops = input.loops.map((loop) => ({ cels: loop.cels.map((cel) => ({ ...cel })) }));
  loops[0]!.cels.push({
    width: 6,
    height: 8,
    transparentColor: 0,
    mirrored: false,
    pixels: new Uint8Array(48).fill(4),
  });
  loops[1]!.cels.push({
    width: 8,
    height: 8,
    transparentColor: 0,
    mirrored: false,
    pixels: Uint8Array.from(Array.from({ length: 8 }, () => [2, 2, 2, 2, 2, 2, 0, 0]).flat()),
  });
  expect(after.content).toEqual([
    ...buildView({ loops, ...(input.description ? { description: input.description } : {}) }),
  ]);
  const bytes = Uint8Array.from(after.content as number[]);
  const table = new DataView(bytes.buffer);
  for (const [loop, width, run] of [
    [0, 6, 0x46],
    [1, 8, 0x26],
  ]) {
    const offset = table.getUint16(5 + loop! * 2, true);
    const last = bytes[offset]! - 1;
    const cel = offset + table.getUint16(offset + 1 + last * 2, true);
    expect([...bytes.slice(cel, cel + 19)]).toEqual([
      width,
      8,
      loop! << 4,
      ...Array.from({ length: 8 }, () => [run, 0]).flat(),
    ]);
  }
  const view = parseView(bytes);
  expect([...view.loops[0]!.cels.at(-1)!.pixels]).toEqual(new Array(48).fill(4));
  expect([...view.loops[1]!.cels.at(-1)!.pixels]).toEqual(
    Array.from({ length: 8 }, () => [2, 2, 2, 2, 2, 2, 0, 0]).flat(),
  );
  await expect(page.getByRole("option", { name: "Walk left · loop 1", exact: true })).toHaveCount(
    1,
  );
  await page.getByLabel("Frame finding options", { exact: true }).click();
  await page.getByLabel("Grid", { exact: true }).check();
  await page.getByLabel("Grid frame count", { exact: true }).fill("2");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Find frames again", exact: true }).click();
  await expect(page.getByTestId("image-frame")).toHaveCount(2);
  await expect(page.getByTestId("frame-summary")).toBeVisible();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 1 · 16 × 16 at 0, 0");
  expect((await projectView(page)).commits).toBe(after.commits);
});

test("white sheet finds tight linked figures and adds exact prepared cels", async ({ page }) => {
  await page.addInitScript(() => {
    window.addEventListener("error", (event) => {
      if (event.message.includes("ResizeObserver"))
        document.documentElement.dataset["resizeError"] = event.message;
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("part-view:0").click();
  await page.getByRole("button", { name: "Make cels from an image", exact: true }).click();
  const width = 256,
    height = 128;
  const rgba = new Uint8Array(width * height * 4).fill(255);
  const xs = [12, 68, 135, 221];
  for (const x of xs)
    for (let y = 24; y < 72; y++)
      for (let dx = 0; dx < 12; dx++) rgba.set([170, 0, 0, 255], (y * width + x + dx) * 4);
  await page.getByTestId("image-file").setInputFiles({
    name: "walk-sheet.png",
    mimeType: "image/png",
    buffer: Buffer.from(encodePngRgba(width, height, rgba)),
  });
  await expect(page.getByTestId("image-frame")).toHaveCount(4);
  await expect(page.getByTestId("frame-summary")).toBeVisible();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 1 · 12 × 48 at 12, 24");
  await expect(
    page.getByRole("switch", { name: "Background is see-through", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("button", { name: "See-through colour", exact: true }),
  ).toHaveAttribute("title", "White is see-through");
  await expect(page.getByRole("button", { name: "Link selected frame" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Link selected frame" })).toHaveText(
    "⛓ 4 frames · same size",
  );
  await page.getByRole("button", { name: "Frame 1", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowRight");
  for (let i = 0; i < 4; i++) {
    await page.getByRole("button", { name: `Frame ${i + 1}`, exact: true }).focus();
    await expect(page.getByTestId("frame-summary")).toBeVisible();
    await expect(page.getByTestId("frame-summary")).toHaveText(
      `Frame ${i + 1} · 13 × 48 at ${xs[i]}, 24`,
    );
  }
  await page.getByRole("button", { name: "Frame 1", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowLeft");
  const edge = (await page
    .getByRole("button", { name: "Resize frame 1 east", exact: true })
    .boundingBox())!;
  const sheet = (await page.getByTestId("frame-sheet").boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    edge.x + edge.width / 2 + (4 * sheet.width) / width,
    edge.y + edge.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  for (let i = 0; i < 4; i++) {
    await page.getByRole("button", { name: `Frame ${i + 1}`, exact: true }).focus();
    await expect(page.getByTestId("frame-summary")).toBeVisible();
    await expect(page.getByTestId("frame-summary")).toHaveText(
      `Frame ${i + 1} · 16 × 48 at ${xs[i]}, 24`,
    );
  }
  await page.getByRole("button", { name: "Link selected frame" }).click();
  await expect(page.getByRole("button", { name: "Link selected frame" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Link selected frame" })).toHaveText(
    "Frame 4 unlinked",
  );
  await page.getByRole("button", { name: "Frame 4", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByTestId("frame-summary")).toBeVisible();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 4 · 17 × 48 at 221, 24");
  await page.getByRole("button", { name: "Link selected frame" }).click();
  await page.getByLabel("Cel height", { exact: true }).fill("24");
  await page.getByLabel("Cel height", { exact: true }).press("Tab");
  await page.getByRole("button", { name: "Select frame 4 in order strip", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByTestId("frame-summary")).toBeVisible();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 3 · 16 × 48 at 221, 24");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByTestId("frame-summary")).toBeVisible();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 2 · 16 × 48 at 221, 24");
  await page.keyboard.press("Alt+ArrowRight");
  await page.keyboard.press("Alt+ArrowRight");
  const thumbnails = await page.getByTestId("prepared-cel-thumbnail").evaluateAll((images) =>
    images.map((element) => {
      const image = element as HTMLImageElement;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d")!.drawImage(image, 0, 0);
      return {
        width: canvas.width,
        height: canvas.height,
        pixels: [...canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data],
      };
    }),
  );
  expect(thumbnails).toHaveLength(4);
  for (const cel of thumbnails) {
    expect([cel.width, cel.height]).toEqual([8, 24]);
    expect(cel.pixels).toEqual(
      Array.from({ length: 24 }, () => [
        ...Array.from({ length: 6 }, () => [170, 0, 0, 255]).flat(),
        ...new Array(8).fill(0),
      ]).flat(),
    );
  }
  await page.screenshot({
    path: test.info().outputPath("cels-calm-1440.png"),
    animations: "disabled",
  });
  const before = await projectView(page);
  await page.getByTestId("image-add-cels").click();
  await expect(page.getByTestId("image-status")).toBeVisible();
  await expect(page.getByTestId("image-status")).toHaveText("Added 4 cels");
  const after = await projectView(page);
  expect(after.commits).toBe(before.commits + 1);
  const original = parseView(
    typeof before.content === "string"
      ? buildView(JSON.parse(before.content))
      : Uint8Array.from(before.content),
  );
  const source: BuildViewInput =
    typeof before.content === "string"
      ? JSON.parse(before.content)
      : {
          loops: original.loops.map((loop) => ({
            cels: loop.cels.map((cel) => ({
              width: cel.width,
              height: cel.height,
              transparentColor: cel.transparentColor,
              pixels: cel.pixels,
            })),
          })),
        };
  const loops = source.loops.map((loop) => ({ ...loop, cels: [...(loop.cels ?? [])] }));
  loops[0]!.cels.push(
    ...Array.from({ length: 4 }, () => ({
      width: 8,
      height: 24,
      transparentColor: 15,
      mirrored: false,
      pixels: Uint8Array.from(Array.from({ length: 24 }, () => [4, 4, 4, 4, 4, 4, 15, 15]).flat()),
    })),
  );
  expect(after.content).toEqual([
    ...buildView({ loops, ...(original.description ? { description: original.description } : {}) }),
  ]);
  const bytes = Uint8Array.from(after.content as number[]);
  const table = new DataView(bytes.buffer);
  const offset = table.getUint16(5, true);
  for (let i = bytes[offset]! - 4; i < bytes[offset]!; i++) {
    const start = offset + table.getUint16(offset + 1 + i * 2, true);
    expect([...bytes.slice(start, start + 51)]).toEqual([
      8,
      24,
      0x8f,
      ...Array.from({ length: 24 }, () => [0x46, 0]).flat(),
    ]);
  }
  const generate = page
    .getByTestId("workspace-editor")
    .getByRole("button", { name: "Generate", exact: true });
  await expect(generate).toBeVisible();
  await generate.click();
  await page.getByTestId("generate-prompt").fill("Four walk frames on white");
  await expect(page.getByTestId("frame-sheet")).toBeHidden();
  await expect(page.getByTestId("generate-model")).toBeHidden();
  await expect(page.getByTestId("generate-review")).toBeVisible();
  await expect(page.getByTestId("generate-review")).toHaveText("Generate");
  await page.getByTestId("generate-options").click();
  await expect(page.getByTestId("generate-model")).toBeVisible();
  await page.getByRole("button", { name: "Make cels from an image", exact: true }).click();
  await expect(page.getByTestId("frame-sheet")).toBeVisible();
  await expect(page.getByTestId("frame-summary")).toBeVisible();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 4 · 16 × 48 at 221, 24");
  expect((await projectView(page)).commits).toBe(after.commits);
  await page.getByTestId("part-room:1:picture:1").click();
  await expect(page.getByRole("button", { name: "Trace an image", exact: true })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-resize-error");
});
