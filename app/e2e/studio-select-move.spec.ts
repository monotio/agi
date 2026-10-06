import type { Locator, Page } from "@playwright/test";
import {
  enterCreateMode,
  openWorkspacePicture,
  textHook,
  workspaceUpdated,
} from "./engineProbe.ts";
import { expect, reviewShot, test } from "./test.ts";

/**
 * Selecting and moving in Room Studio's Select tool are separate gestures,
 * as in vector editors, on the bundled tutorial's gallery (PIC 1 of the
 * Adventure Department). Cells are hand-picked from its source
 * (games/adventure-department/sceneArt.ts): the upper walls own 40,20 and
 * 150,60 on the art plane, the text band 44,14 and the blank canvas 80,50.
 * The box 44,14..115,86 holds whole the mural frame (rect 47,24 112,79), the
 * canvas, the pencil sketch, the picture light (rect 63,19 96,21) and the
 * brass plaque (rect 72,81 87,84), and no other item; 111,85..159,118 holds
 * the restoration cart alone.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const FRAME = ["frame", "canvas", "sketch", "picture-light", "plaque"];

async function openGallery(page: Page, fixedZoom = false): Promise<Locator> {
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await enterCreateMode(page);
  await openWorkspacePicture(page, 1);
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await expect(studio.locator('[data-row="frame"]')).toHaveCount(1);
  if (fixedZoom) {
    const level = studio.locator(".studio-zoom__level");
    await expect(level).toBeVisible();
    await studio.getByRole("button", { name: "Zoom out", exact: true }).click();
    await expect(level).toHaveText("100%");
    await studio.getByRole("button", { name: "Zoom in", exact: true }).click();
    const focus = page.getByTestId("workspace-focus");
    await expect(focus).toBeVisible();
    await focus.click();
    await expect(level).toHaveText("200%");
  }
  return studio;
}

const pane = (page: Page) => page.locator(".studio-pane").last();

/** The screen point at the centre of logical cell x,y (off the picture too: the margin). */
async function cell(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await pane(page).boundingBox())!;
  const zoom = box.height / 168;
  return [box.x + (x + 0.5) * 2 * zoom, box.y + (y + 0.5) * zoom];
}

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 6 });
  await page.mouse.up();
}

const source = (page: Page): Promise<string> =>
  page.evaluate(() => window.__AGI_STUDIO__!.source());

const selectedRows = (studio: Locator) =>
  studio
    .locator('[role="treeitem"][aria-selected="true"]')
    .evaluateAll((list) => list.map((row) => row.getAttribute("data-row")));

const cursorAt = async (page: Page, x: number, y: number): Promise<string> => {
  await page.mouse.move(...(await cell(page, x, y)));
  return pane(page).evaluate((element) => getComputedStyle(element).cursor);
};

test("a plain drag off the selection draws a box that replaces it with the items wholly inside", async ({
  page,
}) => {
  const studio = await openGallery(page);
  const original = await source(page);
  // A click on the background selects it, as a click on any item does.
  await page.mouse.click(...(await cell(page, 40, 20)));
  expect(await selectedRows(studio)).toEqual(["walls"]);
  // A plain drag from the text band, an item not selected, draws a box.
  await page.mouse.move(...(await cell(page, 44, 14)));
  await page.mouse.down();
  await page.mouse.move(...(await cell(page, 115, 86)), { steps: 6 });
  await expect(studio.locator('[data-role="marquee"]')).toHaveCount(1);
  await reviewShot(page, "select-move-box");
  await page.mouse.up();
  await expect(studio.locator('[data-role="marquee"]')).toHaveCount(0);
  // The box replaces the selection: the walls and the band it started on are out.
  expect(await selectedRows(studio)).toEqual(FRAME);
  await workspaceUpdated(page);
  await expect.poll(() => source(page)).toBe(original);
  // A box that catches nothing clears the selection and says so.
  await drag(page, await cell(page, 150, 60), await cell(page, 155, 65));
  expect(await selectedRows(studio)).toEqual([]);
  await expect(studio.getByTestId("studio-notice")).toHaveText(
    "No item lies wholly inside the box.",
  );
  await expect.poll(() => source(page)).toBe(original);
});

test("dragging the selection moves it as one step, and the cursor says which drag moves @webkit-desktop", async ({
  page,
}) => {
  const studio = await openGallery(page);
  const original = await source(page);
  expect(await cursorAt(page, 150, 60)).toBe("default");
  await drag(page, await cell(page, 44, 14), await cell(page, 115, 86));
  expect(await selectedRows(studio)).toEqual(FRAME);
  expect(await cursorAt(page, 80, 50)).toBe("move");
  expect(await cursorAt(page, 150, 60)).toBe("default");
  // From the canvas, 3 right: every selected item moves.
  await drag(page, await cell(page, 80, 50), await cell(page, 83, 50));
  await workspaceUpdated(page);
  const moved = await source(page);
  expect(moved).toContain("rect 50,24 115,79");
  expect(moved).toContain("rect 75,81 90,84");
  expect(await selectedRows(studio)).toEqual(FRAME);
  await reviewShot(page, "select-move-moved");
  await page.getByTestId("workspace-undo").click();
  await expect.poll(() => source(page)).toBe(original);
  // The drawing tools keep the crosshair.
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("l");
  expect(await cursorAt(page, 150, 60)).toBe("crosshair");
});

test("at 200% a drag on the small plaque in Select moves the whole item, not a point", async ({
  page,
}) => {
  const studio = await openGallery(page, true);
  // 640 CSS px across 160 columns: 200%, where the plaque's point handles would cover it.
  expect((await pane(page).boundingBox())!.width).toBe(640);
  await page.mouse.click(...(await cell(page, 76, 82)));
  expect(await selectedRows(studio)).toEqual(["plaque"]);
  await expect(studio.locator("[data-handle]")).toHaveCount(0);
  // From 76,82, beside the plaque's point 74,82: 3 right moves every line of it.
  await drag(page, await cell(page, 76, 82), await cell(page, 79, 82));
  await workspaceUpdated(page);
  const moved = await source(page);
  expect(moved).toContain("rect 75,81 90,84");
  expect(moved).toContain("line 77,82 81,82");
  expect(moved).toContain("line 77,83 86,83");
});

test("a drag toward the edge stops at it and is kept; one past the edge says which item is there", async ({
  page,
}) => {
  const studio = await openGallery(page);
  await drag(page, await cell(page, 44, 14), await cell(page, 115, 86));
  expect(await selectedRows(studio)).toEqual(FRAME);
  // 100 rows up: the picture light's top row, 19, stops the selection after 19.
  await drag(page, await cell(page, 80, 50), await cell(page, 80, -50));
  await workspaceUpdated(page);
  expect(await source(page)).toContain("rect 47,5 112,60");
  expect(await source(page)).toContain("rect 63,0 96,2");
  // At the edge, a drag further up goes nowhere and names the item there.
  await drag(page, await cell(page, 80, 31), await cell(page, 80, 26));
  await expect(studio.getByTestId("studio-notice")).toHaveText(
    "Picture light is at the picture's top edge. Move it inward.",
  );
  await workspaceUpdated(page);
  expect(await source(page)).toContain("rect 63,0 96,2");
});

test("the margin around the picture is empty canvas: a click clears, a drag draws a box @webkit-desktop", async ({
  page,
}) => {
  const studio = await openGallery(page, true);
  const box = (await pane(page).boundingBox())!;
  await page.mouse.click(...(await cell(page, 40, 20)));
  expect(await selectedRows(studio)).toEqual(["walls"]);
  await page.mouse.click(box.x - 12, box.y + box.height / 2);
  expect(await selectedRows(studio)).toEqual([]);
  // From above the picture: the box starts at row 0.
  const [x44] = await cell(page, 44, 0);
  await drag(page, [x44, box.y - 10], await cell(page, 115, 86));
  expect(await selectedRows(studio)).toEqual(FRAME);
  // Shift adds, from the right of the picture: the box ends at column 159.
  const [, y85] = await cell(page, 0, 85);
  await page.keyboard.down("Shift");
  await drag(page, [box.x + box.width + 12, y85], await cell(page, 111, 118));
  await page.keyboard.up("Shift");
  expect((await selectedRows(studio)).sort()).toEqual([...FRAME, "cart"].sort());
  await workspaceUpdated(page);
});
