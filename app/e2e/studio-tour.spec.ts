import { expect, reviewShot, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { enterCreateMode, openGameOptions, waitForRoom, openWorldRoom } from "./engineProbe.ts";

/**
 * The Studios' first-run tour on the real app (useStudioTour.ts,
 * StudioTour.vue): three marks per Studio on the first open, Next, Next,
 * Done; Skip or Esc ends it; either marks that Studio seen for this viewer,
 * so reopening shows nothing, and the `?` sheet's Tour replays it. While a
 * lesson's Try this card is open the tour stays silent, the card's
 * "30-second tour" link starts it, and it marks nothing seen. Every mark sits
 * beside its chrome, clear of the picture and the cel, at 1440×900 and
 * 1024×600. Other specs start with the tour seen (test.ts); this one starts
 * fresh.
 */
test.use({ studioTour: "fresh", viewport: { width: 1440, height: 900 } });

const TOUR_KEY = "monotio_agi.studioTour";
const MURAL = "ad-gallery-recipe";

async function playTutorial(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await enterCreateMode(page);
}

async function openRoomStudio(page: Page, room = 1): Promise<Locator> {
  const panel = page.getByTestId("world-panel");
  await openWorldRoom(panel, room);
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

async function closeStudio(studio: Locator): Promise<void> {
  await studio.getByTestId("studio-close").click();
  await expect(studio).toBeHidden();
}

const storedTour = (page: Page): Promise<unknown> =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null") as unknown, TOUR_KEY);

/** The mark on screen, and its "n of 3". */
function tourMark(page: Page): Locator {
  return page.getByTestId("studio-tour");
}
async function expectMark(page: Page, step: number, title: string): Promise<Locator> {
  const mark = tourMark(page);
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAccessibleName(title);
  await expect(mark.getByTestId("studio-tour-step")).toHaveText(`${step} of 3`);
  return mark;
}

test("Room Studio: the first open shows mark 1, Next, Next, Done; reopening shows nothing; ? replays it @webkit-desktop", async ({
  page,
}) => {
  await playTutorial(page);
  expect(await storedTour(page)).toBeNull();
  let studio = await openRoomStudio(page);

  let mark = await expectMark(page, 1, "Lenses");
  await expect(mark).toHaveAttribute("role", "dialog");
  await expect(mark).toContainText("Press 1, 2, 3.");
  const next = mark.getByRole("button", { name: "Next" });
  await expect(next, "focus moves to the mark").toBeFocused();
  await next.click();
  await expectMark(page, 2, "Items");
  await expect(next).toBeFocused();
  // The keyboard works: Enter on the focused Next, and 2 goes to the mark, not the lens.
  await page.keyboard.press("2");
  await expect(
    studio.getByTestId("studio-lens").getByRole("radio", { name: /^Art/ }),
  ).toBeChecked();
  await page.keyboard.press("Enter");
  mark = await expectMark(page, 3, "Keep");
  await expect(mark.getByRole("button", { name: "Next" })).toHaveCount(0);
  const done = mark.getByRole("button", { name: "Done" });
  await expect(done).toBeFocused();
  await done.click();
  await expect(mark).toHaveCount(0);
  await expect(studio, "focus returns to Studio").toBeFocused();
  expect(await storedTour(page)).toEqual({ version: 1, seen: ["room"] });

  await closeStudio(studio);
  studio = await openRoomStudio(page, 2);
  await expect(tourMark(page), "the tour shows once per Studio").toHaveCount(0);
  await expect(studio).toBeFocused();

  // The ? sheet's Tour replays it from mark 1; Esc ends it where it started.
  const keys = studio.getByTestId("studio-keys-button");
  await keys.click();
  const sheet = page.getByTestId("studio-key-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByTestId("studio-key-sheet-tour").click();
  await expect(sheet).toBeHidden();
  mark = await expectMark(page, 1, "Lenses");
  await expect(mark.getByRole("button", { name: "Next" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(mark).toHaveCount(0);
  await expect(studio, "Esc ends the tour and leaves Studio open").toBeVisible();
  await expect(keys).toBeFocused();
  expect(await storedTour(page)).toEqual({ version: 1, seen: ["room"] });
});

test("Sprite Studio: Skip marks it seen, and reopening shows nothing", async ({ page }) => {
  await playTutorial(page);
  let studio = await openSpriteStudio(page);
  const mark = await expectMark(page, 1, "Loops and cels");
  await mark.getByRole("button", { name: "Next" }).click();
  await expectMark(page, 2, "Transparent");
  await mark.getByRole("button", { name: "Skip tour" }).click();
  await expect(mark).toHaveCount(0);
  await expect(studio).toBeFocused();
  expect(await storedTour(page)).toEqual({ version: 1, seen: ["sprite"] });

  await closeStudio(studio);
  studio = await openSpriteStudio(page);
  await expect(tourMark(page)).toHaveCount(0);
  // Room Studio keeps its own first run.
  await closeStudio(studio);
  await openRoomStudio(page);
  await expectMark(page, 1, "Lenses");
});

test("a lesson's Try this card keeps the tour silent; its 30-second tour link starts it and marks nothing seen", async ({
  page,
}) => {
  await playTutorial(page);
  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-help-guide").click();
  const guide = page.getByTestId("help-guide");
  await guide.getByTestId("help-section-lessons").click();
  await guide.getByTestId(`help-lesson-${MURAL}`).getByTestId("help-lesson-open").click();
  await expect(guide).toBeHidden();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  const card = studio.getByTestId("lesson-card");
  await expect(card).toBeVisible();
  await expect(tourMark(page)).toHaveCount(0);

  const link = card.getByTestId("lesson-card-tour");
  await expect(link).toHaveText("30-second tour");
  await link.click();
  const mark = await expectMark(page, 1, "Lenses");
  await mark.getByRole("button", { name: "Skip tour" }).click();
  await expect(mark).toHaveCount(0);
  await expect(link).toBeFocused();
  expect(await storedTour(page), "a lesson never marks the tour seen").toBeNull();

  // The first free visit gets the tour.
  await closeStudio(studio);
  await openRoomStudio(page, 2);
  await expectMark(page, 1, "Lenses");
});

/** The box of `mark` overlaps what shows of any canvas in `stage`: the picture or the cel. */
async function overlapsCanvas(mark: Locator, stage: Locator): Promise<string[]> {
  const box = (await mark.boundingBox())!;
  return stage.evaluate((element, box) => {
    const view = element.getBoundingClientRect();
    const hits: string[] = [];
    for (const canvas of element.querySelectorAll("canvas")) {
      const r = canvas.getBoundingClientRect();
      const x1 = Math.max(r.left, view.left, box.x);
      const y1 = Math.max(r.top, view.top, box.y);
      const x2 = Math.min(r.right, view.right, box.x + box.width);
      const y2 = Math.min(r.bottom, view.bottom, box.y + box.height);
      if (x2 > x1 && y2 > y1)
        hits.push(
          `${canvas.getAttribute("aria-label")}: ${Math.round(x2 - x1)}×${Math.round(y2 - y1)}`,
        );
    }
    return hits;
  }, box);
}

async function walkMarks(
  page: Page,
  stage: Locator,
  studio: "room" | "sprite",
  size: string,
): Promise<void> {
  const viewport = page.viewportSize()!;
  for (let step = 1; step <= 3; step++) {
    const mark = tourMark(page);
    await expect(mark.getByTestId("studio-tour-step")).toHaveText(`${step} of 3`);
    await expect(mark).toHaveAttribute("data-placed", "true");
    expect(await overlapsCanvas(mark, stage), `${studio} mark ${step} at ${size}`).toEqual([]);
    const box = (await mark.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await reviewShot(page, `${studio}-${size}-mark-${step}`);
    await mark.getByRole("button", { name: step === 3 ? "Done" : "Next" }).click();
  }
  await expect(tourMark(page)).toHaveCount(0);
}

for (const [width, height] of [
  [1440, 900],
  [1024, 600],
] as const) {
  test(`at ${width}×${height} every mark sits clear of the picture and the cel`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await playTutorial(page);
    const size = `${width}x${height}`;
    let studio = await openRoomStudio(page);
    await walkMarks(page, studio.getByRole("group", { name: /^Canvas/ }), "room", size);
    await closeStudio(studio);
    studio = await openSpriteStudio(page);
    await walkMarks(page, studio.getByTestId("sprite-stage"), "sprite", size);
  });
}
