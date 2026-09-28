import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { enterCreateMode, isolateStorage, waitForRoom } from "./engineProbe.ts";

/**
 * Room Studio's Walk view in the tutorial, the small things: a test walk
 * from a start inside a wall names that start instead of where the engine
 * put ego, and Esc lets go of a selected door before it leaves Studio.
 */
test.use({ viewport: { width: 1440, height: 900 } });

/** Screenshots go here when set (the review set), else to the test's output. */
const SHOTS = process.env["AGI_WALK_SHOTS"];
const shot = (page: Page, name: string) =>
  page.screenshot({
    path: SHOTS ? `${SHOTS}/${name}.png` : test.info().outputPath(`${name}.png`),
  });

async function openTutorialStudio(page: Page, room: number): Promise<Locator> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId(`map-room-${room}`).click();
  await panel.getByTestId("world-open-studio").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await page.keyboard.press("3");
  return studio;
}

/** Click the centre of logical cell x,y of the (last) pane. */
async function clickCell(page: Page, x: number, y: number): Promise<void> {
  const box = (await page.locator(".studio-pane").last().boundingBox())!;
  const zoom = box.height / 168;
  await page.mouse.click(box.x + (x + 0.5) * 2 * zoom, box.y + (y + 0.5) * zoom);
}

test("a start inside a wall: the card names the asked start, not the room's entry", async ({
  page,
}) => {
  const studio = await openTutorialStudio(page, 1);
  await page.keyboard.press("t");
  // 80,60 is the gallery's back wall; the engine puts ego at the entry, 18,151.
  await clickCell(page, 80, 60);
  await clickCell(page, 78, 116);
  const card = studio.getByTestId("walk-result");
  await expect(card).toHaveAttribute("data-outcome", "start_blocked", { timeout: 30_000 });
  await expect(studio.getByTestId("walk-result-title")).toHaveText(
    "The start is not a spot the player can stand on",
  );
  await expect(studio.getByTestId("walk-result-place")).toHaveText("Asked start");
  await expect(studio.getByTestId("walk-result-end")).toHaveText("80,60");
  await expect(card).not.toContainText("Ended at");
  await expect(card).not.toContainText("18,151");
  // The engine's end is the room's entry spot, not a place the creator chose.
  await expect(studio.getByTestId("walk-play-here")).toHaveCount(0);
  await shot(page, "walk-start-blocked");
});

test("Esc with a door selected lets go of the door; the next Esc stays in Studio", async ({
  page,
}) => {
  const studio = await openTutorialStudio(page, 2);
  await studio.getByTestId("walk-door").filter({ hasText: "west edge" }).click();
  const editor = studio.getByTestId("door-editor");
  await expect(editor).toBeVisible();
  const outlined = studio.locator(".walk-overlay__door.is-selected");
  await expect(outlined).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(outlined).toHaveCount(0);
  await expect(studio.getByTestId("walk-door").filter({ hasText: "west edge" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(studio).toBeVisible();

  // Nothing is left to let go of: Esc stays in Studio, and the × returns to Create.
  await page.keyboard.press("Escape");
  await expect(studio).toBeVisible();
  await studio.getByTestId("studio-close").click();
  await expect(studio).toBeHidden();
});
