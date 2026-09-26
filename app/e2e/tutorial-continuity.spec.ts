import { expect, test } from "./test.ts";
import { isolateStorage, observe, openCardMenu, openGameOptions, textHook } from "./engineProbe.ts";
import { seedTutorial10, TUTORIAL_1_0 } from "./tutorialRelease.ts";

/**
 * A player who played the 1.0.0 tutorial keeps that save after 1.1.0 ships:
 * Home shows one tutorial card, for 1.1, whose ⋯ menu continues the stored
 * 1.0 copy, or removes it. A remix of the 1.0 copy keeps its own card. The
 * 1.0 copy is seeded from the released 1.0 Project download (tutorialRelease.ts).
 */
test.use({ viewport: { width: 1440, height: 900 } });

const REMIX = "remix-of-tutorial-1-0";

test("a stored 1.0 tutorial folds into the 1.1 card, whose menu resumes it without lessons", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await seedTutorial10(page, REMIX);
  await page.reload();

  const gallery = page.getByTestId("saved-game-gallery");
  const card = page.getByTestId("catalog-adventure-department");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("catalog-play-adventure-department")).toHaveText("Play now");
  await expect(gallery.getByTestId(`saved-game-card-${TUTORIAL_1_0}`)).toHaveCount(0);
  await expect(gallery.getByTestId(`saved-game-card-${REMIX}`)).toBeVisible();
  await expect(gallery.getByText("Adventure Department", { exact: true })).toHaveCount(1);

  // The card is the 1.1 release.
  await openCardMenu(page, "game-actions-adventure-department");
  const menu = page.getByRole("menu", { name: "Game actions", exact: true });
  await menu.getByRole("menuitem", { name: "Details…" }).click();
  const details = page.getByTestId("card-details");
  await expect(details).toContainText("1.1.0");
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();

  await openCardMenu(page, "game-actions-adventure-department");
  const resume = menu.getByTestId("continue-release-1.0.0");
  await expect(resume).toContainText("Continue your 1.0 save");
  await expect(resume).toContainText(/Room 1 · played/);
  await page.screenshot({ path: test.info().outputPath("home-continue-1-0.png") });

  await resume.click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await expect(page).toHaveURL(new RegExp(`#play/${TUTORIAL_1_0}$`));
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.lastGame"))).toBe(
    TUTORIAL_1_0,
  );

  // Its Help guide has no Studio lessons: the 1.1 lessons verify 1.1 resources.
  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-help-guide").click();
  const guide = page.getByTestId("help-guide");
  await expect(guide).toBeVisible();
  await observe(page, 20);
  await expect(guide.getByTestId("help-section-lessons")).toHaveCount(0);
});

test("the 1.1 card's menu removes the 1.0 save after a confirmation, leaving its remix", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await seedTutorial10(page, REMIX);
  await page.reload();
  const menu = page.getByRole("menu", { name: "Game actions", exact: true });
  const autosave = () =>
    page.evaluate((id) => localStorage.getItem(`monotio_agi.autosave.${id}`), TUTORIAL_1_0);
  expect(await autosave()).not.toBeNull();

  // Cancel keeps it.
  await openCardMenu(page, "game-actions-adventure-department");
  await menu.getByTestId("remove-release-1.0.0").click();
  const dialog = page.getByTestId("remove-release-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Remove your 1.0 save?");
  await expect(dialog).toContainText("Games you exported or downloaded as files are not affected.");
  await page.screenshot({ path: test.info().outputPath("home-remove-1-0.png") });
  await dialog.getByTestId("remove-release-cancel").click();
  await expect(dialog).toBeHidden();
  expect(await autosave()).not.toBeNull();

  await openCardMenu(page, "game-actions-adventure-department");
  await menu.getByTestId("remove-release-1.0.0").click();
  await dialog.getByTestId("remove-release-confirm").click();
  await expect(dialog).toBeHidden();
  await expect.poll(autosave).toBeNull();
  expect(
    await page.evaluate(async (id) => {
      const path = "/src/gameStorage.ts";
      const { loadAuthoredGame } = await import(path);
      return (await loadAuthoredGame(id)) !== null;
    }, TUTORIAL_1_0),
  ).toBe(false);

  // Both 1.0 items are gone; the remix keeps its card; the 1.1 card still plays.
  await openCardMenu(page, "game-actions-adventure-department");
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("continue-release-1.0.0")).toHaveCount(0);
  await expect(menu.getByTestId("remove-release-1.0.0")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(`saved-game-card-${REMIX}`)).toBeVisible();
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await expect(page).toHaveURL(/#play\/catalog-adventure-department-1\.1\.0$/);
});
