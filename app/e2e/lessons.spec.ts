import type { Locator, Page } from "@playwright/test";
import { buildTutorial } from "../../games/adventure-department/game.ts";
import { TUTORIAL_PICTURES } from "../../games/adventure-department/sceneArt.ts";
import { openContainer } from "../../src/container/container.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { compileEditDocument } from "../../src/studio/editValidation.ts";
import { parsePictureDocument } from "../../src/studio/pictureDocument.ts";
import { createPictureSurface } from "../../src/types.ts";
import { openSprite } from "../../src/view/spriteDocument.ts";
import {
  closeWorkspaceEditor,
  enterCreateMode,
  isolateStorage,
  observe,
  openGameOptions,
  waitForRoom,
  workspaceSaved,
} from "./engineProbe.ts";
import { expect, test } from "./test.ts";
import { seedTutorial10 } from "./tutorialRelease.ts";

/** Help opens each tutorial lesson resource in the workspace; edits retain native semantics. */
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
const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

async function playTutorial(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
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

test("the Help guide lists the three lessons and opens the mural PICTURE", async ({ page }) => {
  await playTutorial(page);
  const guide = await openLessons(page);
  await expect(guide.getByTestId("help-section-lessons")).toHaveText("Adventure Department");
  await expect(guide.locator('[data-testid^="help-lesson-ad-"]')).toHaveCount(3);
  for (const [id, title] of [
    [MURAL, "PICTURE steps"],
    [MIRROR, "VIEW loops"],
    [DEPTH, "Depth"],
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
  // The sun three pixels east: one object, and nothing outside it.
  await nudge(page, studio, "sun", 3);
  await workspaceSaved(page);
  expect(await studioBytes(page)).not.toEqual(PIC_4);
  await closeWorkspaceEditor(page);
  await expect(studio).toBeHidden();
});

test("the VIEW lesson opens its resource and repainting a mirror preserves its source loop", async ({
  page,
}) => {
  await playTutorial(page);
  await openLesson(page, MIRROR);
  const studio = page.getByTestId("sprite-studio");
  await expect(studio).toBeVisible();
  expect(await spriteBytes(page)).toEqual(VIEW_2);
  await expect(page.getByTestId("project-tab-view:2")).toHaveAttribute("aria-selected", "true");
  await expect(studio.getByTestId("sprite-loop-1-mirror")).toHaveText(/mirrors 0/);
  await studio.locator('[data-loop="1"][data-cel="0"]').click();
  // One pencil pixel at the keyboard cursor (the cel's centre) of that cel.
  const original = openSprite(VIEW_2, DEFAULT_V2_PROFILE);
  const cel = original.loops[1]!.cels[0]!;
  const centre = cel.pixels[(cel.height >> 1) * cel.width + (cel.width >> 1)];
  const colour = [4, 2].find((value) => value !== centre && value !== cel.transparent)!;
  await studio.locator(`[data-colour="${colour}"]`).click();
  await studio.getByTestId("sprite-stage").focus();
  await page.keyboard.press("b");
  // As in sprite-studio.spec.ts: the first Space puts the pen down at the
  // keyboard cursor (painting that cell), the second lifts it and the stroke commits.
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  await workspaceSaved(page);
  const edited = openSprite(await spriteBytes(page), DEFAULT_V2_PROFILE);
  expect(edited.loops[1]!.alias).toBeNull();
  expect(edited.loops[0]!.cels.map((c) => [...c.pixels])).toEqual(
    original.loops[0]!.cels.map((c) => [...c.pixels]),
  );
  await workspaceSaved(page);
  await shot(page, "lessons-view-edited");
});

test("the Depth lesson opens the archive and a mid-order edit preserves the barrier", async ({
  page,
}) => {
  await playTutorial(page);
  await openLesson(page, DEPTH);
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  expect(await studioBytes(page)).toEqual(PIC_3);
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("2");
  // 2. The ghost behind the counter: its verdict shows, with nothing over it.
  const probe = studio.getByTestId("studio-probe-toggle");
  await probe.click();
  const handle = studio.getByTestId("ghost-probe-handle");
  await expect(handle).toBeVisible();
  const grip = (await handle.boundingBox())!;
  const zoom = (await page.locator(".studio-pane").last().boundingBox())!.height / 168;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 30 * zoom, {
    steps: 8,
  });
  await page.mouse.up();
  const verdict = studio.locator('[data-role="ghost-verdict"]');
  await expect(verdict).toContainText("Behind Counter depth");
  await expect(studio.getByTestId("ghost-probe")).toHaveAttribute("data-verdict", "behind");
  await shot(page, "lessons-archive-ghost-behind");
  await probe.click();
  await expect(handle).toHaveCount(0);

  const shipped = parsePictureDocument(TUTORIAL_PICTURES[3]!).document;
  const counter = shipped.items.find(({ id }) => id === "counter-depth")!;
  const drawn = compileEditDocument(shipped, DEFAULT_V2_PROFILE).spans.filter(
    ({ line }) => line < counter.closeLine,
  ).length;
  await studio.locator('[data-row="counter-depth"]').click();
  await page.getByTestId("workspace-focus").click();
  const canvas = studio.getByRole("group", { name: /^Canvas/ });
  await canvas.focus();
  await page.keyboard.press("Home");
  for (let index = 0; index < drawn; index++) await page.keyboard.press(".");
  await page.keyboard.press("r");
  await expect(studio.getByTestId("studio-insert-at")).toHaveText(`After step ${drawn}`);
  await studio.getByTestId("studio-tool-filled").check();
  await studio.locator('.workspace-palette [data-colour="11"]').click();
  await page.mouse.move(...(await cell(page, 38, 84)));
  await page.mouse.down();
  await page.mouse.move(...(await cell(page, 53, 120)), { steps: 6 });
  await page.mouse.up();
  await workspaceSaved(page);
  const before = planes(PIC_3);
  const after = planes(await studioBytes(page));
  expect(after.visual).toEqual(before.visual);
  expect(after.priority[100 * 160 + 45]).toBe(11);
  expect(after.priority[121 * 160 + 45], "the stand's barrier stays on top").toBe(0);
  await workspaceSaved(page);
  await shot(page, "lessons-archive-saved");
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
  await waitForRoom(page, 1, { coldBoot: true });
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
