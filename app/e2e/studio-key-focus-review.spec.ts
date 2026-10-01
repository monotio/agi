import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { enterCreateMode, waitForRoom, openWorldRoom } from "./engineProbe.ts";

/**
 * Where the `?` key sheet hands focus back (UiDialog's returnFocus in
 * StudioKeySheet.vue). Opened by the status bar's Keys button, the sheet —
 * and the tour the sheet's Tour button relaunches — returns focus to that
 * button; Safari leaves a clicked button unfocused, so the button takes
 * focus at activation (RoomStudio.vue, sprite/SpriteStudio.vue). Opened by
 * the `?` key on the stage, the sheet returns to the stage. Esc on the tour
 * ends it and never reaches the Studio or the paused game beneath.
 * e2e/studio-tour.spec.ts holds the full tour; this spec reviews the focus
 * handoffs on both Studios.
 */
test.use({ viewport: { width: 1440, height: 900 } });

async function playTutorial(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await enterCreateMode(page);
}

async function openRoomStudio(page: Page): Promise<Locator> {
  const panel = page.getByTestId("world-panel");
  await openWorldRoom(panel, 1);
  await panel.getByTestId("world-open-studio").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

async function openSpriteStudio(page: Page): Promise<Locator> {
  const panel = page.getByTestId("world-panel");
  await openWorldRoom(panel, 1);
  await panel.getByTestId("world-open-sprite-0").click();
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  return studio;
}

/** The sheet opens, Esc puts it away, and focus lands on `back`. */
async function sheetRoundTrip(
  page: Page,
  studio: Locator,
  name: string,
  back: Locator,
): Promise<void> {
  const sheet = page.getByTestId("studio-key-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAccessibleName(`${name} keys`);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(back, "the sheet returns focus to what opened it").toBeFocused();
  await expect(studio, "Esc closes the sheet, never the Studio").toBeVisible();
}

/** The sheet's Tour replays the tour and Esc returns focus to `back`. */
async function tourRoundTrip(page: Page, studio: Locator, back: Locator): Promise<void> {
  const sheet = page.getByTestId("studio-key-sheet");
  await sheet.getByTestId("studio-key-sheet-tour").click();
  await expect(sheet).toBeHidden();
  const mark = page.getByTestId("studio-tour");
  await expect(mark).toBeVisible();
  await expect(mark.getByRole("button", { name: "Next" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(mark).toHaveCount(0);
  await expect(back, "the relaunched tour returns focus to the sheet's invoker").toBeFocused();
  await expect(studio).toBeVisible();
}

for (const studio of ["room", "sprite"] as const) {
  const name = studio === "room" ? "Room Studio" : "Sprite Studio";
  const open = studio === "room" ? openRoomStudio : openSpriteStudio;
  const stage = (root: Locator) =>
    studio === "room"
      ? root.getByRole("group", { name: /^Canvas/ })
      : root.getByTestId("sprite-stage");

  test(`${name}: a pointer-opened key sheet and its Tour return focus to the Keys button @webkit-desktop`, async ({
    page,
  }) => {
    await playTutorial(page);
    const root = await open(page);
    const keys = root.getByTestId("studio-keys-button");
    await keys.click();
    await sheetRoundTrip(page, root, name, keys);
    await keys.click();
    await tourRoundTrip(page, root, keys);
  });

  test(`${name}: ? on the stage opens the key sheet and Esc returns focus to the stage @webkit-desktop`, async ({
    page,
  }) => {
    await playTutorial(page);
    const root = await open(page);
    const canvas = stage(root);
    await canvas.focus();
    await page.keyboard.press("?");
    await sheetRoundTrip(page, root, name, canvas);
  });
}
