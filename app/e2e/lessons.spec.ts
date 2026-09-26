import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { buildTutorial } from "../../games/adventure-department/game.ts";
import { TUTORIAL_PICTURES } from "../../games/adventure-department/sceneArt.ts";
import { openContainer } from "../../src/container/container.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { compileEditDocument } from "../../src/studio/editValidation.ts";
import { parsePictureDocument } from "../../src/studio/pictureDocument.ts";
import { openSprite } from "../../src/studio/sprite/spriteDocument.ts";
import { createPictureSurface } from "../../src/types.ts";
import {
  enterCreateMode,
  isolateStorage,
  observe,
  openGameOptions,
  textHook,
} from "./engineProbe.ts";
import { seedTutorial10 } from "./tutorialRelease.ts";

/**
 * The tutorial's Studio lessons on the real app (games/adventure-department/
 * lessons.ts): the Help guide lists one per exhibit, each opens its Studio on
 * the resource behind it with a "Try this" card, and a Keep that meets its
 * challenge earns a badge. Edits go through the Studio UI: nudges from the
 * Scene list, a pencil in Sprite Studio, a rect in the Depth lens. The
 * lessons verify 1.1.0's resources, so a game derived from 1.0.0 has none.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const TUTORIAL = openContainer(new Map(Object.entries(buildTutorial().files)));
const PIC_3 = TUTORIAL.getResource("picture", 3)!;
const PIC_4 = TUTORIAL.getResource("picture", 4)!;
const VIEW_2 = TUTORIAL.getResource("view", 2)!;
const MURAL = "ad-gallery-recipe";
const MIRROR = "ad-lab-mirror";
const DEPTH = "ad-archive-depth";

const planes = (bytes: Uint8Array) => {
  const surface = createPictureSurface();
  renderPicture(bytes, surface);
  return surface;
};
const studioBytes = async (page: Page): Promise<Uint8Array> =>
  Uint8Array.from(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()]));
const spriteBytes = async (page: Page): Promise<Uint8Array> =>
  Uint8Array.from(await page.evaluate(() => [...window.__AGI_SPRITE__!.bytes()]));
const storedBadges = async (page: Page): Promise<string[]> =>
  JSON.parse((await page.evaluate(() => localStorage.getItem("monotio_agi.lessons"))) ?? "{}")
    .completed ?? [];
const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

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

async function openLesson(page: Page, id: string): Promise<void> {
  const guide = await openLessons(page);
  await guide.getByTestId(`help-lesson-${id}`).getByTestId("help-lesson-open").click();
  await expect(guide).toBeHidden();
}

/** The screen point at the centre of logical cell x,y of the (last) pane. */
async function cell(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await page.locator(".studio-pane").last().boundingBox())!;
  const zoom = box.height / 168;
  return [box.x + (x + 0.5) * 2 * zoom, box.y + (y + 0.5) * zoom];
}

/** Select a Scene list object and nudge it right by `steps` pixels from the canvas. */
async function nudge(page: Page, studio: Locator, row: string, steps: number): Promise<void> {
  await studio.locator(`[data-row="${row}"]`).click();
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  for (let i = 0; i < steps; i++) await page.keyboard.press("ArrowRight");
}

async function keep(studio: Locator, notice: string): Promise<void> {
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
  await expect(studio.getByTestId("studio-notice")).toHaveText(notice);
}

test("the Help guide lists the three lessons; the mural wants one object changed", async ({
  page,
}) => {
  await playTutorial(page);
  const guide = await openLessons(page);
  await expect(guide.getByTestId("help-section-lessons")).toHaveText("Adventure Department");
  await expect(guide.locator('[data-testid^="help-lesson-ad-"]')).toHaveCount(3);
  for (const [id, title] of [
    [MURAL, "The mural is a recipe"],
    [MIRROR, "One robot, two directions"],
    [DEPTH, "Depth decides who is in front"],
  ] as const) {
    const lesson = guide.getByTestId(`help-lesson-${id}`);
    await expect(lesson.getByRole("heading")).toContainText(title);
    await expect(lesson.getByTestId("help-lesson-badge")).toHaveText("Not yet done");
  }
  await shot(page, "lessons-help");

  // The Help action opens the overlay itself, PIC 4, not the gallery's first picture.
  await guide.getByTestId(`help-lesson-${MURAL}`).getByTestId("help-lesson-open").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await expect(page).toHaveURL(/#create\//);
  expect(await studioBytes(page)).toEqual(PIC_4);
  await expect(studio).toHaveAttribute("aria-label", "Room Studio: PIC 4");
  const card = studio.getByTestId("lesson-card");
  await expect(card).toContainText("The mural is a recipe");
  await expect(card).toContainText("Change the sun");
  await shot(page, "lessons-card-mural");

  // The sun three pixels east: one object, and nothing outside it.
  await nudge(page, studio, "sun", 3);
  await keep(studio, "Kept PIC 4. Challenge complete: The mural is a recipe.");
  await expect(card.getByTestId("lesson-card-verdict")).toHaveText(
    "Challenge complete: The mural is a recipe.",
  );
  expect(await storedBadges(page)).toEqual([MURAL]);

  // The cottage too: two objects since the lesson opened, so the hint names both.
  await nudge(page, studio, "cottage", 1);
  await keep(
    studio,
    "Kept PIC 4. You changed 2 objects (Sun, Cottage). Change just one, like Sun.",
  );
  expect(await storedBadges(page)).toEqual([MURAL]);

  await studio.getByTestId("studio-close").click();
  await expect(studio).toHaveCount(0);
  await expect(
    (await openLessons(page)).getByTestId(`help-lesson-${MURAL}`).getByTestId("help-lesson-badge"),
  ).toHaveText("✓ Done");
});

test("the robot lesson wants only the left facing repainted, and its card folds away", async ({
  page,
}) => {
  await playTutorial(page);
  await openLesson(page, MIRROR);
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  expect(await spriteBytes(page)).toEqual(VIEW_2);
  await expect(studio.getByTestId("sprite-bytes")).toContainText("VIEW 2");
  await expect(studio.getByTestId("sprite-loop-1-mirror")).toHaveText(/mirror of 0/);
  const card = studio.getByTestId("lesson-card");
  await expect(card).toContainText("One robot, two directions");
  await shot(page, "lessons-card-robot");

  // One pencil pixel at the keyboard cursor (the cel's centre) of loop 1, cel 0.
  const original = openSprite(VIEW_2, DEFAULT_V2_PROFILE);
  const cel = original.loops[1]!.cels[0]!;
  const centre = cel.pixels[(cel.height >> 1) * cel.width + (cel.width >> 1)];
  const colour = [4, 2].find((value) => value !== centre && value !== cel.transparent)!;
  await studio.locator(`[data-colour="${colour}"]`).click();
  await studio.locator('[data-loop="1"][data-cel="0"]').click();
  await studio.getByTestId("sprite-stage").focus();
  await page.keyboard.press("b");
  // As in sprite-studio.spec.ts: the first Space puts the pen down at the
  // keyboard cursor (painting that cell), the second lifts it and the stroke commits.
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  const edited = openSprite(await spriteBytes(page), DEFAULT_V2_PROFILE);
  expect(edited.loops[1]!.alias).toBeNull();
  expect(edited.loops[0]!.cels.map((c) => [...c.pixels])).toEqual(
    original.loops[0]!.cels.map((c) => [...c.pixels]),
  );
  await keep(studio, "Kept VIEW 2. Challenge complete: One robot, two directions.");
  expect(await storedBadges(page)).toEqual([MIRROR]);

  await card.getByTestId("lesson-card-hide").click();
  await expect(card).toHaveCount(0);
  await expect(studio.getByTestId("lesson-card-show")).toBeVisible();
  // Opened from the lesson again, the card stays folded until it is shown.
  await studio.getByTestId("studio-close").click();
  await expect(studio).toHaveCount(0);
  await openLesson(page, MIRROR);
  await expect(studio.getByTestId("lesson-card-show")).toBeVisible();
  await studio.getByTestId("lesson-card-show").click();
  await expect(studio.getByTestId("lesson-card")).toBeVisible();
  await studio.getByTestId("studio-close").click();

  // From the World panel, room 1 offers both pictures it draws; no lesson rides along.
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId("map-room-1").click();
  await expect(panel.getByTestId("world-open-studio")).toHaveText("Open PIC 1");
  await shot(page, "world-panel-room-pictures");
  await panel.getByTestId("world-open-studio-4").click();
  const room = page.getByTestId("room-studio");
  await expect(room).toBeVisible();
  expect(await studioBytes(page)).toEqual(PIC_4);
  await expect(page.getByTestId("lesson-card")).toHaveCount(0);
  await expect(page.getByTestId("lesson-card-show")).toHaveCount(0);
});

test("the archive lesson wants a depth-only rect on the ledger stand", async ({ page }) => {
  await playTutorial(page);
  await openLesson(page, DEPTH);
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  expect(await studioBytes(page)).toEqual(PIC_3);
  await expect(studio.getByTestId("lesson-card")).toContainText("Depth decides who is in front");
  await shot(page, "lessons-card-archive");

  // The playhead just after Counter depth, so the walk barriers drawn later stay on top.
  const shipped = parsePictureDocument(TUTORIAL_PICTURES[3]!).document;
  const counter = shipped.items.find(({ id }) => id === "counter-depth")!;
  const drawn = compileEditDocument(shipped, DEFAULT_V2_PROFILE).spans.filter(
    ({ line }) => line < counter.closeLine,
  ).length;
  await page.keyboard.press("2");
  const playhead = studio.getByRole("slider", { name: "Draw order playhead" });
  await playhead.focus();
  await page.keyboard.press("Home");
  for (let i = 0; i < Math.floor(drawn / 10); i++) await page.keyboard.press("PageUp");
  for (let i = 0; i < drawn % 10; i++) await page.keyboard.press("ArrowRight");
  await expect(playhead).toHaveAttribute("aria-valuenow", String(drawn));

  await page.keyboard.press("r");
  await expect(studio.getByTestId("studio-insert-at")).toContainText(`after step ${drawn} of`);
  await studio.getByTestId("studio-tool-filled").check();
  const values = studio.getByTestId("studio-current-values");
  await values.getByTestId("studio-value-priority").click();
  await values.locator('[role="radio"][data-value="11"]').click();
  await expect(values.getByTestId("studio-value-priority")).toHaveAttribute("data-value", "11");
  await page.mouse.move(...(await cell(page, 38, 84)));
  await page.mouse.down();
  await page.mouse.move(...(await cell(page, 53, 120)), { steps: 6 });
  await page.mouse.up();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  const before = planes(PIC_3);
  const after = planes(await studioBytes(page));
  expect(after.visual).toEqual(before.visual);
  expect(after.priority[100 * 160 + 45]).toBe(11);
  expect(after.priority[121 * 160 + 45], "the stand's barrier stays on top").toBe(0);
  await keep(studio, "Kept PIC 3. Challenge complete: Depth decides who is in front.");
  expect(await storedBadges(page)).toEqual([DEPTH]);
});

test("a game derived from the 1.0.0 tutorial shows no lesson section", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await seedTutorial10(page, "remix-of-tutorial-1-0");
  await page.reload();
  await page
    .getByTestId("saved-game-card-remix-of-tutorial-1-0")
    .getByTestId("btn-resume-cached")
    .click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await expect(page).toHaveURL(/remix-of-tutorial-1-0$/);
  await enterCreateMode(page);
  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-help-guide").click();
  const guide = page.getByTestId("help-guide");
  await expect(guide).toBeVisible();
  // A set would load within frames; give it the time, then check none did.
  await observe(page, 20);
  await expect(guide.getByTestId("help-section-lessons")).toHaveCount(0);
});
