import { test, expect } from "./test.ts";
import { start, open } from "./pictureWorkspaceShared.ts";
import { workspaceDocument } from "./workspaceShared.ts";

test("hero placement saves its released position and abandons a cancelled drag @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-room:1:logic");
  await page.getByTestId("workspace-update-menu").click();
  await page.getByRole("menuitem", { name: "New launch…" }).click();
  await page.getByTestId("launch-add-row-menu").click();
  await page.getByRole("menuitem", { name: "Hero position", exact: true }).click();
  const canvas = page.getByLabel("Room picture hero position", { exact: true });
  await expect(canvas).toBeVisible();
  await canvas.scrollIntoViewIfNeeded();
  const rect = (await canvas.boundingBox())!;
  const point = (x: number, y: number) => ({
    x: rect.x + (x * rect.width) / 160,
    y: rect.y + (y * rect.height) / 168,
  });
  const before = await workspaceDocument(page, "world");
  await page.mouse.move(point(30, 100).x, point(30, 100).y);
  await page.mouse.down();
  await canvas.dispatchEvent("pointercancel", { pointerId: 9 });
  await page.mouse.move(point(90, 120).x, point(90, 120).y, { steps: 8 });
  expect(await workspaceDocument(page, "world")).toBe(before);
  await page.mouse.up();
  await expect
    .poll(
      async () => JSON.parse(await workspaceDocument(page, "world")).launches["1"].entries[0].hero,
    )
    .toEqual({ x: 90, y: 120 });
  const settled = await workspaceDocument(page, "world");
  await page.mouse.down();
  await page.mouse.move(point(110, 130).x, point(110, 130).y, { steps: 8 });
  await canvas.dispatchEvent("lostpointercapture", { pointerId: 1 });
  await page.mouse.up();
  expect(await workspaceDocument(page, "world")).toBe(settled);
});

test("a sound drag that returns before a frame keeps the note @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-sound:1");
  await page.getByTestId("workspace-focus").click();
  const panel = page.getByTestId("workspace-sound").filter({ visible: true });
  await panel.getByLabel("Snap", { exact: true }).selectOption("8");
  const grid = panel.getByTestId("sound-grid");
  await expect(grid).toBeVisible();
  // Focusing the tall canvas can scroll it in WebKit; measure after focus.
  await grid.focus();
  const point = () =>
    grid.evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.x + ((64 + 8 * 26 + 4) * rect.width) / parseFloat(canvas.style.width),
        y: rect.y + ((24 + 12 * 20 + 10) * rect.height) / parseFloat(canvas.style.height),
        step: (26 * rect.width) / parseFloat(canvas.style.width),
      };
    });
  const first = await point();
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await grid.dispatchEvent("pointercancel", { pointerId: 9 });
  await page.mouse.move(first.x + 3 * first.step, first.y, { steps: 4 });
  await page.mouse.up();
  // Drawing the first note can reflow the grid; hit the same cell in its current position.
  const { x, y } = await point();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await grid.evaluate(
    (element, { x, y }) => {
      for (const [type, clientX] of [
        ["pointermove", x + 40],
        ["pointermove", x],
        ["pointerup", x],
      ] as const)
        element.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 1,
            button: 0,
            buttons: 1,
            clientX,
            clientY: y,
          }),
        );
    },
    { x, y },
  );
  await page.mouse.up();
  const empty = await point();
  await page.mouse.move(empty.x + 12 * empty.step, empty.y);
  await page.mouse.down();
  await grid.dispatchEvent("lostpointercapture", { pointerId: 1 });
  await page.mouse.up();
  await panel.getByRole("button", { name: "Tracker", exact: true }).click();
  await expect(panel.getByLabel("Voice 1, tick 300, note", { exact: true })).toHaveCount(0);
  await expect(panel.getByLabel("Voice 1, tick 120, note", { exact: true })).toHaveValue("C5");
  await expect(panel.getByLabel("Voice 1, tick 120, length in ticks", { exact: true })).toHaveValue(
    "15",
  );
});

test("cancelling the draw-order drag keeps its last picture @webkit-desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-room:1:picture:1");
  const slider = page.getByRole("slider", { name: "Draw order", exact: true });
  await expect(slider).toBeVisible();
  const rect = (await slider.boundingBox())!;
  await page.mouse.move(rect.x + rect.width * 0.6, rect.y + rect.height / 2);
  await page.mouse.down();
  const before = await slider.getAttribute("aria-valuenow");
  expect(Number(before)).toBeGreaterThan(0);
  await slider.dispatchEvent("lostpointercapture", { pointerId: 1, clientX: 0, clientY: 0 });
  await slider.dispatchEvent("pointermove", {
    pointerId: 1,
    clientX: rect.x + rect.width,
    clientY: rect.y,
  });
  await slider.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await expect(slider).toHaveAttribute("aria-valuenow", before!);
  await page.mouse.up();
});

test("another pointer cannot drop a figure's queued move or cancel its drag @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-room:8:picture:8");
  const studio = page.getByTestId("room-studio").filter({ visible: true });
  await studio.getByRole("slider", { name: "Views", exact: true }).evaluate((element) => {
    (element as HTMLInputElement).value = "100";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const figure = studio.locator('[data-object="0"]');
  await expect(figure).toHaveAttribute("data-x", "60");
  const rect = (await figure.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await figure.evaluate(async (element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        clientX: rect.x + rect.width / 2 + 30,
        clientY: rect.y + rect.height / 2,
      }),
    );
    element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 9 }));
    element.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 9 }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await expect(figure).not.toHaveAttribute("data-x", "60");
  await figure.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await expect(figure).toHaveAttribute("data-x", "60");
});

test("another pointer cannot drop a trace's queued move @webkit-desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await open(page, "part-room:1:picture:1");
  await page.getByRole("button", { name: "Trace an image", exact: true }).click();
  const { encodePngRgba } = await import("../../src/creative/composite.ts");
  const rgba = new Uint8Array(8 * 8 * 4);
  for (let y = 2; y < 6; y++)
    for (let x = 2; x < 6; x++) rgba.set([170, 0, 0, 255], (y * 8 + x) * 4);
  await page.getByTestId("image-file").setInputFiles({
    name: "trace.png",
    mimeType: "image/png",
    buffer: Buffer.from(encodePngRgba(8, 8, rgba)),
  });
  const handle = page.getByRole("button", { name: "Move trace", exact: true });
  await expect(handle).toBeVisible();
  const art = page
    .getByTestId("room-studio")
    .filter({ visible: true })
    .locator('.studio-pane[data-layer="art"] canvas')
    .first();
  const before = await art.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  const rect = (await handle.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await handle.evaluate(async (element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        clientX: rect.x + rect.width / 2 + 40,
        clientY: rect.y + rect.height / 2,
      }),
    );
    element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 9 }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(await art.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(
    before,
  );
  await handle.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await expect
    .poll(() => art.evaluate((element) => (element as HTMLCanvasElement).toDataURL()))
    .toBe(before);
});
