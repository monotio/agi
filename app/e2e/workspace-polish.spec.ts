import type { Page } from "@playwright/test";
import { test, expect } from "./test.ts";
import { isolateStorage, waitForRoom, workspaceUpdated } from "./engineProbe.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

async function start(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: width === 1063 ? 815 : width === 390 ? 844 : 900 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByTestId("local-create-submit").click();
  await waitForRoom(page, 1);
  await workspaceUpdated(page);
  if (width === 390) await page.getByTestId("workspace-parts").click();
}
async function picture(page: Page) {
  await page.getByTestId("part-room:1:picture:1").click();
  await expect(page.getByTestId("room-studio")).toBeVisible();
}
async function upload(page: Page) {
  const rgba = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++)
      rgba.set(
        y < 24 ? [0, 0, 170, 255] : x < 32 ? [0, 170, 0, 255] : [170, 0, 0, 255],
        (y * 64 + x) * 4,
      );
  await page.getByTestId("image-file").setInputFiles({
    name: "landscape.png",
    mimeType: "image/png",
    buffer: Buffer.from(encodePngRgba(64, 64, rgba)),
  });
  await expect(page.getByTestId("trace-opacity")).toBeVisible();
  await expect(
    page
      .getByTestId("image-reference")
      .getByRole("button", { name: "Bring in an image", exact: true }),
  ).toBeEnabled();
  await workspaceUpdated(page);
  if (page.viewportSize()!.width <= 600) {
    const edit = page.getByRole("button", { name: "Edit", exact: true });
    await expect(edit).toBeVisible();
    await edit.click();
  }
}
async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled" });
}
for (const width of [1063, 1440, 390]) {
  test(`workspace polish screenshots ${width}`, async ({ page }) => {
    await start(page, width);
    await shot(page, `parts-${width}`);
    await picture(page);
    await shot(page, `items-${width}`);
    await page.getByRole("button", { name: "Trace an image", exact: true }).click();
    await upload(page);
    await shot(page, `trace-${width}`);
    await page
      .getByTestId("workspace-editor")
      .getByRole("button", { name: "Generate", exact: true })
      .first()
      .click();
    await expect(page.getByTestId("generate-prompt")).toBeVisible();
    await shot(page, `generate-${width}`);
  });
  test(`walk status screenshots ${width}`, async ({ page }) => {
    await start(page, width);
    await picture(page);
    const studio = page.getByTestId("room-studio");
    await studio
      .getByRole("radiogroup", { name: "Lens", exact: true })
      .getByRole("radio", { name: "Priority", exact: true })
      .click();
    await studio
      .getByRole("radiogroup", { name: "Side panel", exact: true })
      .getByRole("radio", { name: "Inspector", exact: true })
      .click();
    await studio.locator('[data-role="test-walk"] button').first().click();
    for (const x of [80, 100]) {
      const box = (await studio.locator(".studio-pane").last().boundingBox())!;
      await page.mouse.click(
        box.x + ((x + 0.5) * box.width) / 160,
        box.y + (140.5 * box.height) / 168,
      );
    }
    await expect(studio.getByTestId("walk-result-title")).toBeVisible();
    await expect(studio.getByTestId("walk-result-title")).toHaveText("Reached");
    await shot(page, `walk-reached-${width}`);
    await studio.getByTestId("walk-clear").click();
    await shot(page, `walk-cleared-${width}`);
  });
}
test("Rename lives in a keyboard reachable row menu", async ({ page }) => {
  await start(page);
  const row = page.getByTestId("part-room:1:picture:1").locator("..");
  const menu = row.getByLabel("Actions for clearing_pic", { exact: true });
  const rename = row.getByRole("button", { name: /Rename/ });
  await expect(rename).toBeHidden();
  await page.getByTestId("part-room:1:picture:1").focus();
  await page.keyboard.press("Tab");
  await expect(menu).toBeVisible();
  await expect(menu).toBeFocused();
  await menu.press("Enter");
  await expect(rename).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(rename).toBeFocused();
  await rename.click();
  await expect(page.getByTestId("binding-details")).toBeVisible();
});
test("unused game state says nowhere yet", async ({ page }) => {
  await start(page);
  const row = page
    .getByTestId("parts-list")
    .getByRole("button", { name: "chime_done Flag 204", exact: true })
    .locator("..");
  await expect(row).toBeVisible();
  await expect(row).toContainText("Checked: nowhere yet");
  await expect(row).toContainText("Set: LOGIC 1");
});
for (const width of [1063, 1440])
  test(`Items has room for eight rows Side by side at ${width} @webkit-desktop`, async ({
    page,
  }) => {
    await start(page, width);
    await picture(page);
    const layout = page.getByTestId("workspace-layout");
    await expect(layout).toBeVisible();
    await layout.click();
    await expect(layout).toHaveAttribute("aria-pressed", "true");
    const scene = page.getByTestId("studio-scene");
    const row = scene.locator('[role="treeitem"][data-row]').first();
    await expect(scene).toBeVisible();
    await expect(row).toBeVisible();
    const list = scene.locator('[role="tree"]');
    expect((await list.boundingBox())!.height).toBeGreaterThanOrEqual(
      (await row.boundingBox())!.height * 8,
    );
  });
test("Generate asks what the picture should show", async ({ page }) => {
  await start(page);
  await picture(page);
  await page.getByRole("button", { name: "Trace an image", exact: true }).click();
  await page
    .getByTestId("workspace-editor")
    .getByRole("button", { name: "Generate", exact: true })
    .first()
    .click();
  const prompt = page.getByLabel("What should it show?", { exact: true });
  await expect(prompt).toBeVisible();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByTestId("generate-size")).toBeVisible();
  const size = await page.getByTestId("generate-size").inputValue();
  const [w, h] = size.split("x").map(Number);
  expect(w!).toBeGreaterThan(h!);
});
async function cursor(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }).__AGI_PROJECT__
        .getSession()
        .capture().history.cursor,
  );
}
test("trace handles preview privately and Update makes each chosen History step with Reset and Undo", async ({
  page,
}) => {
  await start(page);
  await picture(page);
  await page.getByRole("button", { name: "Trace an image", exact: true }).click();
  await upload(page);
  const move = page.getByRole("button", { name: "Move trace", exact: true });
  const scale = page.getByRole("button", { name: "Scale trace", exact: true });
  await expect(move).toBeVisible();
  await expect(scale).toBeVisible();
  await expect(move.locator("svg")).toBeVisible();
  await expect(scale.locator("svg")).toBeVisible();
  const canvas = page.locator('[data-layer="art"] canvas');
  const sample = () =>
    canvas.evaluate((element) => {
      const c = element as HTMLCanvasElement;
      return [
        ...c
          .getContext("2d")!
          .getImageData(
            Math.floor((c.width * 80.5) / 160),
            Math.floor((c.height * 120.5) / 168),
            1,
            1,
          ).data,
      ];
    });
  const beforePixel = await sample();
  const before = await cursor(page);
  const box = (await move.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2 + 10, { steps: 5 });
  expect(await cursor(page)).toBe(before);
  await expect.poll(sample).not.toEqual(beforePixel);
  await page.mouse.up();
  expect(await cursor(page)).toBe(before);
  await expect(page.getByTestId("workspace-pending")).toBeVisible();
  await workspaceUpdated(page);
  await expect.poll(() => cursor(page)).not.toBe(before);
  const moved = await cursor(page);
  const corner = (await scale.boundingBox())!;
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width / 2 + 18, corner.y + corner.height / 2 + 8, {
    steps: 5,
  });
  expect(await cursor(page)).toBe(moved);
  await page.mouse.up();
  expect(await cursor(page)).toBe(moved);
  await expect(page.getByTestId("workspace-pending")).toBeVisible();
  await workspaceUpdated(page);
  await expect.poll(() => cursor(page)).not.toBe(moved);
  const scaled = await cursor(page);
  await scale.press("ArrowUp");
  expect(await cursor(page)).toBe(scaled);
  await expect(page.getByTestId("workspace-pending")).toBeVisible();
  await workspaceUpdated(page);
  await expect.poll(() => cursor(page)).not.toBe(scaled);
  const keyed = await cursor(page);
  await page.getByRole("button", { name: "Reset trace", exact: true }).click();
  await workspaceUpdated(page);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => cursor(page)).toBe(keyed);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => cursor(page)).toBe(scaled);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => cursor(page)).toBe(moved);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => cursor(page)).toBe(before);
});

test("Trace keeps Generate in the editor header", async ({ page }) => {
  await start(page);
  await picture(page);
  await page.getByRole("button", { name: "Trace an image", exact: true }).click();
  await expect(page.getByTestId("image-reference")).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate", exact: true })).toHaveCount(1);
});
test("PICTURE generation starts with a landscape size", async ({ page }) => {
  await start(page);
  await picture(page);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByTestId("generate-prompt")).toBeVisible();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByTestId("generate-size")).toBeVisible();
  const [width, height] = (await page.getByTestId("generate-size").inputValue())
    .split("x")
    .map(Number);
  expect(width!).toBeGreaterThan(height!);
});

test("VIEW keeps one Generate entry while its image panel is open", async ({ page }) => {
  await start(page);
  await page.getByTestId("part-view:0").click();
  await page.getByRole("button", { name: "Make cels from an image", exact: true }).click();
  const entry = page
    .getByTestId("workspace-editor")
    .getByRole("button", { name: "Generate", exact: true });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(
    page.getByLabel("What should the character look like?", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId("image-reference").getByRole("button", { name: "Generate", exact: true }),
  ).toHaveCount(1);
});
