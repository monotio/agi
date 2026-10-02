import { test, expect } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import { buildView, parseView } from "../../src/view/view.ts";
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
  await page.getByRole("button", { name: "Loop 1 Left", exact: true }).click();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 2, loop 1, 8 by 8 at 18, 2");
  await expect(
    page.getByText("Loop 1 is a mirror loop of loop 0. Adding cels gives it its own cels."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Frame 1", exact: true }).click();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 1, loop 0, 6 by 8 at 2, 2");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 1, loop 0, 6 by 8 at 9, 2");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 1, loop 0, 7 by 8 at 2, 2");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("0");
  await drag(5, 6, 7, 6);
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 1, loop 0, 6 by 8 at 4, 2");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Frame 2", exact: true })).toBeFocused();
  await page.keyboard.press("1");
  const strip = page.getByRole("group", { name: "Frame order: drag thumbnails to reorder" });
  await strip
    .getByRole("button", { name: "Select frame 2 in order strip", exact: true })
    .dragTo(strip.getByRole("button", { name: "Select frame 1 in order strip", exact: true }));
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 1, loop 1, 8 by 8 at 18, 2");
  await strip
    .getByRole("button", { name: "Select frame 1 in order strip", exact: true })
    .dragTo(strip.getByRole("button", { name: "Select frame 2 in order strip", exact: true }));
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 2, loop 1, 8 by 8 at 18, 2");
  await page.getByRole("button", { name: "Frame 1", exact: true }).click();
  await page.getByRole("button", { name: "Lock frame size", exact: true }).click();
  await page.getByRole("button", { name: "Frame 2", exact: true }).click();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 2, loop 1, 6 by 8 at 18, 2");
  await page.getByRole("button", { name: "Lock frame size", exact: true }).click();
  await page.getByRole("button", { name: "Frame 2", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowRight");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 2, loop 1, 8 by 8 at 18, 2");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.getByTestId("image-reference").getByText("Details", { exact: true }).click();
  await expect(page.getByLabel("Selected frame x", { exact: true })).toHaveValue("18");
  await expect(
    page.getByTestId("image-reference").getByLabel("Cel width", { exact: true }),
  ).toHaveValue("8");
  await page.getByTestId("image-reference").getByText("Details", { exact: true }).click();
  // Suggestions preserve both hand-marked crops.
  await page.getByRole("button", { name: "Find frames", exact: true }).click();
  await expect(page.getByTestId("image-frame")).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath("cels-1440.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: test.info().outputPath("cels-1280.png"), animations: "disabled" });
  const before = await projectView(page);
  await page.getByTestId("image-add-cels").click();
  await expect(page.getByTestId("image-status")).toHaveText("Added 2 cels");
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
  await expect(
    page.getByText("Loop 1 is a mirror loop of loop 0. Adding cels gives it its own cels."),
  ).toHaveCount(0);
  await page.getByLabel("Frame detection", { exact: true }).selectOption("grid");
  await page.getByLabel("Grid frame count", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Find frames", exact: true }).click();
  await expect(page.getByTestId("image-frame")).toHaveCount(2);
  await page.getByLabel("Replace edited frames", { exact: true }).check();
  await page.getByRole("button", { name: "Find frames", exact: true }).click();
  await expect(page.getByTestId("frame-summary")).toHaveText("Frame 1, loop 1, 16 by 16 at 0, 0");
  expect((await projectView(page)).commits).toBe(after.commits);
});
