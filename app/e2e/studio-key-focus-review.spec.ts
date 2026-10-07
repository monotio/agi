import type { Locator, Page } from "@playwright/test";
import {
  enterCreateMode,
  openWorkspacePicture,
  openWorkspaceView,
  waitForRoom,
} from "./engineProbe.ts";
import { expect, test } from "./test.ts";

/**
 * A key sheet returns focus to its invoker: the Keys button or the canvas.
 * Its Escape stays inside the dialog while the same game continues running.
 */
test.use({ viewport: { width: 1440, height: 900 } });

async function playTutorial(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await enterCreateMode(page);
}

async function openRoomStudio(page: Page): Promise<Locator> {
  await openWorkspacePicture(page, 1);
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

async function openSpriteStudio(page: Page): Promise<Locator> {
  await openWorkspaceView(page, 0);
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

for (const studio of ["room", "sprite"] as const) {
  const name = studio === "room" ? "PICTURE" : "VIEW editor";
  const open = studio === "room" ? openRoomStudio : openSpriteStudio;
  const stage = (root: Locator) =>
    studio === "room"
      ? root.getByRole("group", { name: /^Canvas/ })
      : root.getByTestId("sprite-stage");

  test(`${name}: ? on the stage opens the key sheet and Esc returns focus to the stage @webkit-desktop`, async ({
    page,
  }) => {
    await playTutorial(page);
    const root = await open(page);
    const keys = page.getByTestId("workspace-keys");
    await keys.click();
    await sheetRoundTrip(page, root, name, keys);
    const canvas = stage(root);
    await canvas.focus();
    await page.keyboard.press("?");
    await sheetRoundTrip(page, root, name, canvas);
  });
}
