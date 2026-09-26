import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { buildTutorial } from "../../games/adventure-department/game.ts";
import { openContainer } from "../../src/container/container.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { createPictureSurface } from "../../src/types.ts";
import { enterCreateMode, isolateStorage, openGameOptions, textHook } from "./engineProbe.ts";

/**
 * Studio lessons on the real app: the tutorial's Help guide lists them, each
 * opens its Studio on its resource with a "Try this" card, and a Keep that
 * meets the challenge earns a badge the next page load still shows. The
 * lessons are the temporary demo set (src/lessons/demoLessons.ts): PIC 1's
 * challenge wants a change to the art, VIEW 0's a change to loop 0.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const TUTORIAL = openContainer(new Map(Object.entries(buildTutorial().files)));
const PIC_1 = TUTORIAL.getResource("picture", 1)!;
const VIEW_0 = TUTORIAL.getResource("view", 0)!;
const GALLERY = "ad-demo-gallery-art";
const APPRENTICE = "ad-demo-apprentice-flipbook";

const visual = (bytes: Uint8Array): Uint8Array => {
  const surface = createPictureSurface();
  renderPicture(bytes, surface);
  return surface.visual;
};
const studioBytes = async (page: Page): Promise<Uint8Array> =>
  Uint8Array.from(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()]));
const spriteBytes = async (page: Page): Promise<Uint8Array> =>
  Uint8Array.from(await page.evaluate(() => [...window.__AGI_SPRITE__!.bytes()]));
const storedBadges = (page: Page): Promise<string | null> =>
  page.evaluate(() => localStorage.getItem("monotio_agi.lessons"));

async function playTutorial(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
}

async function openLessons(page: Page): Promise<Locator> {
  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-help-guide").click();
  const guide = page.getByTestId("help-guide");
  await guide.getByTestId("help-section-lessons").click();
  await expect(guide.getByTestId("help-topics-lessons")).toBeVisible();
  return guide;
}

/** The screen point at the centre of logical cell x,y of the (last) pane. */
async function cell(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await page.locator(".studio-pane").last().boundingBox())!;
  const zoom = box.height / 168;
  return [box.x + (x + 0.5) * 2 * zoom, box.y + (y + 0.5) * zoom];
}

test("a lesson opens its Studio with a Try this card, and its challenge earns a badge", async ({
  page,
}) => {
  await playTutorial(page);
  let guide = await openLessons(page);
  await expect(guide.getByTestId("help-section-lessons")).toHaveText(
    "Adventure Department: under the hood",
  );
  const gallery = guide.getByTestId(`help-lesson-${GALLERY}`);
  await expect(gallery.getByRole("heading")).toContainText("The gallery's recipe");
  await expect(gallery.getByTestId("help-lesson-badge")).toHaveText("Not yet done");
  await expect(guide.getByTestId(`help-lesson-${APPRENTICE}`)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("lessons-help.png") });

  // Open in Studio from Play: Create, Room Studio on PIC 1, the card docked.
  await gallery.getByTestId("help-lesson-open").click();
  await expect(guide).toBeHidden();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await expect(page).toHaveURL(/#create\//);
  expect(await studioBytes(page)).toEqual(PIC_1);
  const card = studio.getByTestId("lesson-card");
  await expect(card).toContainText("The gallery's recipe");
  await expect(card).toContainText("Change something the player sees in the gallery");
  await page.screenshot({ path: test.info().outputPath("lessons-card.png") });

  // A barrier line in the Walk lens changes priority only: kept, with the hint and no badge.
  await page.keyboard.press("3");
  await page.keyboard.press("l");
  await page.mouse.click(...(await cell(page, 20, 150)));
  await page.mouse.click(...(await cell(page, 100, 150)));
  await page.keyboard.press("Enter");
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  expect(visual(await studioBytes(page))).toEqual(visual(PIC_1));
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
  await expect(studio.getByTestId("studio-notice")).toHaveText(
    "Kept PIC 1. The art looks the same: in the Art lens (1), draw or move something the player sees.",
  );
  await expect(card.getByTestId("lesson-card-verdict")).toContainText("The art looks the same");
  expect(await storedBadges(page)).toBeNull();

  // A filled rect in the Art lens changes what the player sees: the challenge is met.
  await page.keyboard.press("1");
  await page.keyboard.press("r");
  await studio.getByTestId("studio-tool-filled").check();
  await page.mouse.move(...(await cell(page, 20, 120)));
  await page.mouse.down();
  await page.mouse.move(...(await cell(page, 40, 140)), { steps: 6 });
  await page.mouse.up();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  expect(visual(await studioBytes(page))).not.toEqual(visual(PIC_1));
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-notice")).toHaveText(
    "Kept PIC 1. Challenge complete: The gallery's recipe.",
  );
  await expect(card.getByTestId("lesson-card-verdict")).toHaveText(
    "Challenge complete: The gallery's recipe.",
  );
  expect(JSON.parse((await storedBadges(page))!)).toEqual({ version: 1, completed: [GALLERY] });

  await studio.getByTestId("studio-close").click();
  await expect(studio).toHaveCount(0);
  guide = await openLessons(page);
  await expect(
    guide.getByTestId(`help-lesson-${GALLERY}`).getByTestId("help-lesson-badge"),
  ).toHaveText("✓ Done");
  await expect(
    guide.getByTestId(`help-lesson-${APPRENTICE}`).getByTestId("help-lesson-badge"),
  ).toHaveText("Not yet done");
  await page.screenshot({ path: test.info().outputPath("lessons-badge.png") });

  // The next page load resumes the remix the Keep forked, and still shows the badge.
  await page.reload();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  guide = await openLessons(page);
  await expect(
    guide.getByTestId(`help-lesson-${GALLERY}`).getByTestId("help-lesson-badge"),
  ).toHaveText("✓ Done");
});

test("a sprite lesson opens Sprite Studio on its view, and its card folds away for good", async ({
  page,
}) => {
  await playTutorial(page);
  await enterCreateMode(page);
  const guide = await openLessons(page);
  await guide.getByTestId(`help-lesson-${APPRENTICE}`).getByTestId("help-lesson-open").click();
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  expect(await spriteBytes(page)).toEqual(VIEW_0);
  await expect(studio.getByTestId("sprite-bytes")).toContainText("VIEW 0");
  const card = studio.getByTestId("lesson-card");
  await expect(card).toContainText("The apprentice's flipbook");

  await card.getByTestId("lesson-card-hide").click();
  await expect(card).toHaveCount(0);
  await expect(studio.getByTestId("lesson-card-show")).toBeVisible();

  // Opened from the lesson again, the card stays folded until it is shown.
  await studio.getByTestId("studio-close").click();
  await expect(studio).toHaveCount(0);
  await (
    await openLessons(page)
  )
    .getByTestId(`help-lesson-${APPRENTICE}`)
    .getByTestId("help-lesson-open")
    .click();
  await expect(studio.getByTestId("lesson-card-show")).toBeVisible();
  await studio.getByTestId("lesson-card-show").click();
  await expect(studio.getByTestId("lesson-card")).toBeVisible();

  // Opened from the World panel, no lesson rides along.
  await studio.getByTestId("studio-close").click();
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId("map-room-1").click();
  await panel.getByTestId("world-open-studio").click();
  await expect(page.getByTestId("room-studio")).toBeVisible();
  await expect(page.getByTestId("lesson-card")).toHaveCount(0);
  await expect(page.getByTestId("lesson-card-show")).toHaveCount(0);
});
