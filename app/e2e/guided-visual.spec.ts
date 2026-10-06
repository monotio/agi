import type { Page, Locator } from "@playwright/test";
import { test, expect } from "./test.ts";
import {
  isolateStorage,
  openLibraryActions,
  savedGameCard,
  workspaceUpdated,
  textHook,
} from "./engineProbe.ts";
import { workspaceDocument } from "./workspaceShared.ts";
import { decodePng } from "../../scripts/png.ts";

async function start(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await page.evaluate(async () => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    await prepareLocalProject({ title: "Sunny clearing", kind: "starter" }).save();
  });
  await page.reload();
  await openLibraryActions(page, savedGameCard(page, "Sunny clearing"));
  await page.getByTestId("edit-library-game").click();
  await expect(page.getByTestId("workspace-add")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
}
async function open(page: Page, name: string) {
  if (page.viewportSize()!.width <= 600) {
    const edit = page.getByRole("button", { name: "Edit", exact: true });
    if (await edit.isVisible()) await edit.click();
  }
  await page.getByTestId("workspace-add").click();
  await page.getByRole("menuitem", { name, exact: true }).click();
  await expect(page.getByRole("menu")).toBeHidden();
  const form = page.getByTestId("workspace-guided-form");
  await expect(form).toBeVisible();
  return form;
}
async function parts(page: Page): Promise<void> {
  const show = page.getByTestId("workspace-show-game");
  if (await show.isVisible()) await show.click();
  if (!(await page.getByTestId("parts-list").isVisible()))
    await page.getByRole("button", { name: "Parts", exact: true }).click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
}
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: test.info().outputPath(`${name}-after.png`),
    animations: "disabled",
  });
}
async function messagePixels(preview: Locator): Promise<void> {
  await expect(preview).toBeVisible();
  await preview.scrollIntoViewIfNeeded();
  expect((await preview.boundingBox())!.width).toBeLessThanOrEqual(480);
  await expect(preview).toHaveAttribute("data-ready", "true");
  await expect
    .poll(async () => {
      const { rgba } = decodePng(await preview.screenshot());
      let white = 0;
      for (let index = 0; index < rgba.length; index += 4)
        if (rgba[index]! > 235 && rgba[index + 1]! > 235 && rgba[index + 2]! > 235) white++;
      return white;
    })
    .toBeGreaterThan(1000);
}

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test(`guided visual sentences and dock placement at ${width} @webkit-desktop`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await start(page);
    const before = await workspaceDocument(page, "logic:1");
    let form = await open(page, "Place hero");
    await shot(page, `${width}-Place-hero`);
    await form.getByRole("button", { name: "Drag to place", exact: true }).click();
    const overlay = page.getByTestId("guided-placement");
    await expect(overlay).toBeVisible();
    await overlay.hover({ position: { x: 4, y: 4 } });
    const box = (await overlay.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.65);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * (90.85 / 160), box.y + box.height * (148.85 / 200), {
      steps: 4,
    });
    await page.mouse.up();
    await shot(page, `${width}-Hero-drag`);
    await overlay.getByRole("button", { name: "Done", exact: true }).click();
    await expect(form).toBeVisible();
    const code = form.getByTestId("guided-code-preview");
    await expect(code).toBeVisible();
    await expect(code).toContainText("position(o0, 90, 140)");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(form).toBeHidden();
    await workspaceUpdated(page);
    expect(await workspaceDocument(page, "logic:1")).toContain("position(o0, 90, 140)");
    await page.getByTestId("workspace-undo").click();
    await workspaceUpdated(page);
    expect(await workspaceDocument(page, "logic:1")).toBe(before);

    form = await open(page, "Answer a sentence");
    await form.getByLabel("When the player types…", { exact: true }).fill("look at sun");
    await form
      .getByLabel("The game says…", { exact: true })
      .fill("The sun shines above the clearing.");
    const preview = form.getByRole("img", { name: "Game message preview" });
    await expect(preview).toBeVisible();
    await messagePixels(preview);
    await shot(page, `${width}-Response`);
    await form.getByRole("button", { name: "Cancel", exact: true }).click();

    form = await open(page, "Add a room");
    await form.getByLabel("Room name", { exact: true }).fill("Moonlit grove");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(form).toBeHidden();
    await workspaceUpdated(page);
    await parts(page);
    await page.getByTestId("part-room:1:logic").click();
    form = await open(page, "Door");
    await form
      .getByRole("group", { name: "Destination room", exact: true })
      .getByRole("button", { name: /Moonlit grove/ })
      .click();
    await form.getByRole("button", { name: "Drag a door box", exact: true }).click();
    await expect(overlay).toBeVisible();
    await overlay.hover({ position: { x: 4, y: 4 } });
    const doorBox = (await overlay.boundingBox())!;
    await page.mouse.move(
      doorBox.x + doorBox.width * (128.85 / 160),
      doorBox.y + doorBox.height * (120.85 / 200),
    );
    await page.mouse.down();
    await page.mouse.move(doorBox.x + doorBox.width * 0.99, doorBox.y + doorBox.height * 0.8, {
      steps: 4,
    });
    await page.mouse.up();
    await shot(page, `${width}-Door-drag`);
    await overlay.getByRole("button", { name: "Done", exact: true }).click();
    await expect(form).toBeVisible();
    await form.getByRole("button", { name: "and arrive here", exact: true }).click();
    await expect(overlay).toBeVisible();
    await expect(overlay.getByRole("img", { name: "Destination room", exact: true })).toBeVisible();
    await overlay.focus();
    await page.keyboard.press("ArrowLeft");
    await overlay.getByRole("button", { name: "Done", exact: true }).click();
    await expect(form).toBeVisible();
    await shot(page, `${width}-Door`);
    const doorPreview = form.getByTestId("guided-code-preview");
    await expect(doorPreview).toBeVisible();
    await expect(doorPreview).toContainText("new.room(2)");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(form).toBeHidden();
    await workspaceUpdated(page);
    // Arrival starts at its own position (80,140); ArrowLeft moves it one cell.
    expect(await workspaceDocument(page, "logic:2")).toContain("position(o0, 79, 140)");
    await page.getByTestId("workspace-undo").click();
    await workspaceUpdated(page);
    expect(await workspaceDocument(page, "logic:1")).toBe(before);

    form = await open(page, "Play a sound when…");
    await form.getByLabel("When the player types…", { exact: true }).fill("ring the bell");
    await form.getByRole("button", { name: "Discovery", exact: true }).click();
    await shot(page, `${width}-Play-sound`);
    await form.getByRole("button", { name: "Add", exact: true }).scrollIntoViewIfNeeded();
    await expect(form.getByRole("button", { name: "Add", exact: true })).toBeVisible();
    await shot(page, `${width}-Play-sound-code`);
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await parts(page);
    await page.getByTestId("part-words").click();
    const words = page.getByTestId("workspace-words-editor").filter({ visible: true });
    await expect(words).toBeVisible();
    await words.getByLabel("A sentence a player might type").fill("look at sun");
    await words.getByRole("button", { name: "Teach “sun”…", exact: true }).click();
    const teach = words.getByRole("form", { name: "Teach sun", exact: true });
    await expect(teach).toBeVisible();
    await teach
      .getByLabel("The game says…", { exact: true })
      .fill("The sun shines above the clearing.");
    await messagePixels(teach.getByRole("img", { name: "Game message preview" }));
    await shot(page, `${width}-Teach`);
    await teach.getByRole("button", { name: "Add", exact: true }).scrollIntoViewIfNeeded();
    await expect(teach.getByRole("button", { name: "Add", exact: true })).toBeVisible();
    await shot(page, `${width}-Teach-code`);
    await parts(page);
    await page.getByTestId("part-sound:1").click();
    const sound = page.getByTestId("workspace-sound").filter({ visible: true });
    await expect(sound).toBeVisible();
    await sound.getByRole("button", { name: "Choose preset", exact: true }).click();
    const recipes = sound.getByRole("group", { name: "New sound from a recipe", exact: true });
    await expect(recipes).toBeVisible();
    await expect(recipes).toContainText("Adds a new SOUND to your game");
    await shot(page, `${width}-Sound-preset`);
  });
}

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test(`message preview with WebGL2 unavailable at ${width} @webkit-desktop`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        ...args: Parameters<typeof original>
      ) {
        if (args[0] === "webgl2" && this.getAttribute("aria-label") === "Game message preview")
          return null;
        return original.apply(this, args);
      } as typeof original;
    });
    await start(page);
    const form = await open(page, "Answer a sentence");
    await form
      .getByLabel("The game says…", { exact: true })
      .fill("The sun shines above the clearing.");
    const preview = form.getByRole("img", { name: "Game message preview" });
    await expect(preview).toBeVisible();
    await preview.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath(`${width}-fallback.png`),
      animations: "disabled",
    });
    await messagePixels(preview);
    await form.getByLabel("The game says…", { exact: true }).fill("Hello from your game.");
    await messagePixels(preview);
  });
}

test("message preview draws a fallback when the renderer fails after WebGL2 starts", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1063, height: 815 });
  await page.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (
      this: WebGL2RenderingContext,
      ...args: Parameters<typeof original>
    ) {
      const canvas = this.canvas as HTMLCanvasElement;
      if (canvas.getAttribute?.("aria-label") === "Game message preview")
        throw new Error("Renderer initialization failed");
      return original.apply(this, args);
    } as typeof original;
  });
  await start(page);
  const form = await open(page, "Answer a sentence");
  await form
    .getByLabel("The game says…", { exact: true })
    .fill("The sun shines above the clearing.");
  const preview = form.getByRole("img", { name: "Game message preview" }).filter({ visible: true });
  await expect(preview).toBeVisible();
  await preview.scrollIntoViewIfNeeded();
  await messagePixels(preview);
  expect(errors).toEqual([]);
});

test("message preview draws a fallback when drawing throws", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.compileShader;
    WebGL2RenderingContext.prototype.compileShader = function (
      this: WebGL2RenderingContext,
      ...args: Parameters<typeof original>
    ) {
      const canvas = this.canvas as HTMLCanvasElement;
      if (canvas.getAttribute?.("aria-label") === "Game message preview")
        throw new Error("Preview shader compile failed");
      return original.apply(this, args);
    };
  });
  await start(page);
  const form = await open(page, "Answer a sentence");
  await form.getByLabel("The game says…", { exact: true }).fill("Hello from your game.");
  const preview = form.getByRole("img", { name: "Game message preview" });
  await messagePixels(preview);
  const first = decodePng(await preview.screenshot()).rgba;
  await form
    .getByLabel("The game says…", { exact: true })
    .fill("The sun shines above the clearing.");
  await messagePixels(preview);
  expect(decodePng(await preview.screenshot()).rgba).not.toEqual(first);
  expect(errors).toEqual([]);
});
