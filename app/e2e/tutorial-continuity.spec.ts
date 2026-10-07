import { expect, test } from "./test.ts";
import {
  isolateStorage,
  observe,
  openCardMenu,
  openGameOptions,
  openLibraryActions,
  openSavedGameDetails,
  savedGameCard,
  waitForRoom,
} from "./engineProbe.ts";
import { seedTutorial10, seedTutorial11, TUTORIAL_1_0, TUTORIAL_1_1 } from "./tutorialRelease.ts";

/**
 * A player who played the 1.0.0 tutorial keeps it after later releases ship: the
 * Tutorial card is the current catalog release only, and the stored 1.0 copy
 * is an ordinary saved-game card titled with its release, "Adventure
 * Department 1.0". A remix of the 1.0 copy keeps its own card. The 1.0 copy
 * is seeded from the released 1.0 Project download (tutorialRelease.ts).
 */
test.use({ viewport: { width: 1440, height: 900 } });

const REMIX = "remix-of-tutorial-1-0";
const OLDER_TITLE = "Adventure Department 1.0";

test("a stored 1.0 tutorial is its own saved-game card that resumes the 1.0 copy", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await seedTutorial10(page, REMIX);
  await page.reload();

  const gallery = page.getByTestId("saved-game-gallery");
  const tutorial = page.getByTestId("catalog-adventure-department");
  await expect(tutorial).toBeVisible();
  await expect(tutorial.getByTestId("catalog-play-adventure-department")).toHaveText("Play");

  // The 1.0 copy is an ordinary saved-game card named for its release; the
  // remix keeps its own card.
  const older = savedGameCard(page, OLDER_TITLE);
  await expect(older).toBeVisible();
  await expect(older).toHaveAttribute("data-testid", `saved-game-card-${TUTORIAL_1_0}`);
  await expect(older.getByTestId("btn-resume-cached")).toHaveText("Resume");
  const remix = savedGameCard(page, "Adventure Department Remix");
  await expect(remix).toBeVisible();

  // Older archives without a stored preview show their monogram on Home.
  for (const card of [older, remix]) {
    await expect(
      card
        .getByTestId("library-thumbnail")
        .or(card.getByTestId("thumbnail-placeholder"))
        .or(card.locator(".game-card__monogram")),
    ).toBeVisible();
    await expect(card.locator(".game-card__monogram")).toBeVisible();
  }
  await expect(gallery.getByText("Adventure Department", { exact: true })).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("home-older-release.png") });

  // The Tutorial card is the current release; its ⋯ menu carries no 1.0 items.
  await openCardMenu(page, "game-actions-adventure-department");
  const menu = page.getByRole("menu", { name: "Game actions", exact: true });
  await expect(menu.getByRole("menuitem", { name: /1\.0/ })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Details…" }).click();
  const details = page.getByTestId("card-details");
  await expect(details).toContainText("1.2.0");
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();

  // The 1.0 card's ordinary ⋯ menu reports the stored release.
  const olderDetails = await openSavedGameDetails(older);
  await expect(olderDetails).toContainText("1.0.0");
  await page.keyboard.press("Escape");

  // Resuming the 1.0 card resumes the stored copy, not the catalog release.
  await older.getByTestId("btn-resume-cached").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await expect(page).toHaveURL(new RegExp(`#play/${TUTORIAL_1_0}$`));
  expect(
    await page.evaluate(() => localStorage.getItem("monotio_agi.resumeTarget")?.split(":")[1]),
  ).toBe(TUTORIAL_1_0);

  // Its Help guide has no Studio lessons: the 1.1 lessons verify 1.1 resources.
  await openGameOptions(page, "help-menu");
  await page.getByTestId("btn-help-guide").click();
  const guide = page.getByTestId("help-guide");
  await expect(guide).toBeVisible();
  await observe(page, 20);
  await expect(guide.getByTestId("help-section-lessons")).toHaveCount(0);
});

test("the 1.0 card removes through the normal saved-game menu, leaving remix and tutorial", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await seedTutorial10(page, REMIX);
  await page.reload();

  const older = savedGameCard(page, OLDER_TITLE);
  const autosave = () =>
    page.evaluate((id) => localStorage.getItem(`monotio_agi.autosave.${id}`), TUTORIAL_1_0);
  expect(await autosave()).not.toBeNull();

  // The standard saved-game menu: rename, details and a single Remove item.
  await openLibraryActions(page, older);
  const menu = page.getByRole("menu", { name: "Game actions", exact: true });
  await expect(menu.getByTestId("rename-game")).toBeVisible();
  await expect(menu.getByTestId("remove-library-game")).toBeVisible();
  await menu.getByTestId("remove-library-game").click();
  await older.getByTestId("remove-game-confirm").click();
  await expect(older).toHaveCount(0);
  await expect.poll(autosave).toBeNull();
  expect(
    await page.evaluate(async (id) => {
      const path = "/src/project/gameStorage.ts";
      const { loadAuthoredGame } = await import(path);
      return (await loadAuthoredGame(id)) !== null;
    }, TUTORIAL_1_0),
  ).toBe(false);

  // The remix keeps its card; the Tutorial card still plays the current release.
  await expect(savedGameCard(page, "Adventure Department Remix")).toBeVisible();
  const tutorial = page.getByTestId("catalog-adventure-department");
  await expect(tutorial).toBeVisible();
  await tutorial.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await expect(page).toHaveURL(/#play\/catalog-adventure-department-1\.2\.0$/);
});

test("a 1.0 copy without an autosave still reads as played, and an imported 1.0 download keeps its release name", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await seedTutorial10(page);
  // A 1.0 player whose copy kept its room journal but no autosave.
  await page.evaluate(async (id) => {
    localStorage.removeItem(`monotio_agi.autosave.${id}`);
    const path = "/src/world/roomMapStore.ts";
    const { writeMapSidecar } = await import(path);
    const journal = [1, 2].map((to, i) => ({
      seq: i + 1,
      session: 1,
      from: i === 0 ? null : 1,
      to,
      cause: i === 0 ? "boot" : "edge",
      ...(i === 0 ? {} : { edge: "right" }),
      cycle: i + 1,
      resourceSet: "tutorial-1.0@0",
    }));
    writeMapSidecar(localStorage, id, {
      journal,
      discovered: { rooms: { "1": 1, "2": 1 }, edges: [] },
      layout: {},
      notes: {},
      edgeNotes: {},
    });
  }, TUTORIAL_1_0);
  await page.reload();
  const older = savedGameCard(page, OLDER_TITLE);
  await expect(older.locator(".game-card__meta")).toHaveText("Played before · last in room 2");
  await expect(older.getByTestId("btn-resume-cached")).toHaveText("Play");

  // The released 1.0 Project download added again with Add game is the same
  // release: its card keeps the release name beside the stored copy.
  await page.getByTestId("game-zip-input").setInputFiles("test/formats/project-v1.zip");
  await expect(page.getByTestId("game-import-ready")).toContainText(
    "Added another copy of Adventure Department to your library, with its saved progress, map and history.",
  );
  await expect(savedGameCard(page, OLDER_TITLE)).toHaveCount(2);
  // "Adventure Department" alone is the Tutorial card, the current release.
  await expect(
    page.getByTestId("saved-game-gallery").getByText("Adventure Department", { exact: true }),
  ).toHaveCount(1);
});

test("a 1.1 player's copy and progress stay readable while the 1.2 tutorial starts fresh", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const autosave = await seedTutorial11(page);
  await page.reload();

  // The 1.1 copy is an ordinary saved-game card named for its release.
  const older = savedGameCard(page, "Adventure Department 1.1");
  await expect(older).toBeVisible();
  await expect(older).toHaveAttribute("data-testid", `saved-game-card-${TUTORIAL_1_1}`);

  // 1.1.0 stored its autosave at the unscoped address: Earlier progress reads it.
  const details = await openSavedGameDetails(older);
  await expect(details).toContainText("1.1.0");
  const section = details.getByTestId("earlier-progress");
  await expect(
    section.getByTestId("earlier-row").filter({ hasText: "Adventure Department 1.1" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // The Tutorial card plays the 1.2 release from its first room.
  await page.getByTestId("catalog-play-adventure-department").click();
  await waitForRoom(page, 1, { coldBoot: true });
  await expect(page).toHaveURL(/#play\/catalog-adventure-department-1\.2\.0$/);
  // The 1.1 progress stays where 1.1.0 left it.
  expect(
    await page.evaluate((key) => localStorage.getItem(key), `monotio_agi.autosave.${TUTORIAL_1_1}`),
  ).toBe(autosave);
});
