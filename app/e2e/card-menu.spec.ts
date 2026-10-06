import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { testProjectId } from "../test/identity.ts";
import {
  cacheGame,
  isolateStorage,
  openGameDownload,
  openGameOptions,
  openLibraryActions,
  openPlayMore,
  openSavedGameDetails,
  savedGameCard,
  textHook,
  waitForAutosaveAfter,
} from "./engineProbe.ts";

/**
 * The game card's play split button and ⋯ menu (S6). The primary button
 * plays or resumes; a ▾ "More ways to play" menu appears only when the game
 * offers another way to play (Start over with a saved game, Watch
 * walkthrough with a recording). The ⋯ menu is flat: Edit in Create,
 * Rename…, Make a copy, then Download… and Details…, then Remove game….
 */

const ACTION_ITEMS = [
  "Edit in Create",
  "Rename…",
  "Make a copy",
  "Download…",
  "Details…",
  "Remove game…",
];

/** A minimal owned game: no walkthrough recording, no catalog identity. */
async function seedOwnedGame(page: Page, key: string, title: string): Promise<void> {
  const game = createContainer();
  game.putResource("picture", 1, new Uint8Array([0xf0, 1, 0xf8, 0, 0, 0xff]));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {set(f200);assignn(v0,1);assignn(v51,1);
        load.pic(v51);draw.pic(v51);show.pic();display(2,2,"A quiet start.");}
      accept.input();
      return;`,
      { dictionary: new Map() },
    ).payload,
  );
  await cacheGame(page, {
    projectId: testProjectId(key),
    title,
    provider: "stub",
    model: "offline-stub",
    imported: true,
    files: { ...Object.fromEntries(game.files), "WORDS.TOK": new Uint8Array(52) },
    words: [],
  });
  await page.reload();
}

/** Play the tutorial far enough to own a saved game, then leave it. */
async function playTutorialOnce(page: Page): Promise<void> {
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("btn-exit").click();
}

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
});

test("an owned game without progress has one Play button and the flat ⋯ menu", async ({ page }) => {
  await seedOwnedGame(page, "menu-owned", "Menu owned");
  const card = savedGameCard(page, "Menu owned");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("btn-resume-cached")).toHaveText("Play");
  // Nothing else to do with this game: the split button has no ▾ half.
  await expect(card.getByRole("button", { name: "More ways to play" })).toHaveCount(0);

  await openLibraryActions(page, card);
  const menu = page.getByRole("menu", { name: "Game actions", exact: true });
  await expect(menu.getByRole("menuitem").first()).toBeVisible();
  await expect(menu.getByRole("separator")).toHaveCount(2);
  expect(await menu.getByRole("menuitem").allInnerTexts()).toEqual(ACTION_ITEMS);
  // Retired entries: the SOUND twin, the walkthrough, Start over and the two
  // controls that moved into Details….
  await expect(menu.getByTestId("edit-library-game-sound")).toHaveCount(0);
  await expect(menu.getByTestId("run-walkthrough")).toHaveCount(0);
  await expect(menu.getByTestId("start-library-game-over")).toHaveCount(0);
  await expect(menu.getByTestId("interpreter-profile-menu-item")).toHaveCount(0);
  await expect(menu.getByTestId("check-library-game")).toHaveCount(0);

  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Remove game…", exact: true })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(menu.getByRole("menuitem", { name: "Edit in Create", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(card.getByRole("button", { name: "Game actions", exact: true })).toBeFocused();

  // Edit in Create opens the game in Create.
  await openLibraryActions(page, card);
  await menu.getByTestId("edit-library-game").click();
  await expect(page.getByRole("radio", { name: "Create", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const parts = page.getByTestId("parts-list");
  if (page.viewportSize()!.width <= 600 && !(await parts.isVisible()))
    await page.getByTestId("workspace-parts").click();
  await expect(parts).toBeVisible();
});

test("a game with saved progress offers Start over under More ways to play", async ({ page }) => {
  await seedOwnedGame(page, "menu-progress", "Menu progress");
  const card = savedGameCard(page, "Menu progress");
  await card.getByTestId("btn-resume-cached").click();
  await expect(page.getByTestId("input-line")).toBeVisible();
  // The room draws on the first cycle; the autosave lands on the next tick.
  await waitForAutosaveAfter(page, 0);
  await page.getByTestId("btn-exit").click();

  await expect(card.getByTestId("btn-resume-cached")).toHaveText("Resume");
  const more = await openPlayMore(page, card);
  await expect(more.getByRole("menuitem").first()).toBeVisible();
  expect(await more.getByRole("menuitem").allInnerTexts()).toEqual(["Resume", "Start over"]);
  await page.keyboard.press("Escape");
  await expect(card.getByRole("button", { name: "More ways to play", exact: true })).toBeFocused();

  await openPlayMore(page, card);
  await more.getByTestId("start-library-game-over").click();
  await expect(page.getByTestId("input-line")).toBeVisible();
});

test("the tutorial's saved card offers Resume, Start over and Watch walkthrough", async ({
  page,
}) => {
  await playTutorialOnce(page);
  const card = savedGameCard(page, "Adventure Department");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("catalog-play-adventure-department")).toHaveText("Resume");

  const more = await openPlayMore(page, card);
  await expect(more.getByRole("menuitem").first()).toBeVisible();
  expect(await more.getByRole("menuitem").allInnerTexts()).toEqual([
    "Resume",
    "Start over",
    "Watch walkthrough",
  ]);
  await page.keyboard.press("Escape");

  await openLibraryActions(page, card);
  const menu = page.getByRole("menu", { name: "Game actions", exact: true });
  await expect(menu.getByRole("menuitem").first()).toBeVisible();
  expect(await menu.getByRole("menuitem").allInnerTexts()).toEqual(ACTION_ITEMS);
  await page.keyboard.press("Escape");
});

test("a remix keeps the walkthrough offer and the flat ⋯ menu", async ({ page }) => {
  await playTutorialOnce(page);
  const card = savedGameCard(page, "Adventure Department");
  await openLibraryActions(page, card);
  await page.getByTestId("copy-library-game").click();
  const remix = savedGameCard(page, "Adventure Department Remix");
  await expect(remix).toBeVisible();
  await expect(remix.getByTestId("btn-resume-cached")).toHaveText("Play");

  // The copy was never played here, so the ▾ offers Play and the recording.
  const more = await openPlayMore(page, remix);
  await expect(more.getByRole("menuitem").first()).toBeVisible();
  expect(await more.getByRole("menuitem").allInnerTexts()).toEqual(["Play", "Watch walkthrough"]);
  await page.keyboard.press("Escape");

  await openLibraryActions(page, remix);
  const menu = page.getByRole("menu", { name: "Game actions", exact: true });
  await expect(menu.getByRole("menuitem").first()).toBeVisible();
  expect(await menu.getByRole("menuitem").allInnerTexts()).toEqual(ACTION_ITEMS);
  await page.keyboard.press("Escape");
});

test("Details checks an opening and changes the interpreter", async ({ page }) => {
  await seedOwnedGame(page, "menu-details", "Menu details");
  const owned = savedGameCard(page, "Menu details");
  await expect(owned).toBeVisible();
  // A copy of a game that was never checked needs its opening checked.
  await openLibraryActions(page, owned);
  await page.getByTestId("copy-library-game").click();
  const remix = savedGameCard(page, "Menu details Remix");
  await expect(remix).toBeVisible();

  // Details holds the rare controls: the interpreter with Change…, and the
  // opening check the copy still needs.
  const details = await openSavedGameDetails(remix);
  await expect(details).toBeVisible();
  await expect(details).toContainText("Interpreter");
  await expect(details).toContainText("Not checked yet");
  const change = details.getByTestId("interpreter-profile-menu-item");
  await expect(change).toBeVisible();
  await change.click();
  const picker = page.getByTestId("profile-picker-dialog");
  await expect(picker).toBeVisible();
  await expect(details).toBeHidden();
  await page.getByTestId("profile-picker-keep").click();
  await expect(picker).toBeHidden();
  await expect(remix.getByRole("button", { name: "Game actions", exact: true })).toBeFocused();

  const reopened = await openSavedGameDetails(remix);
  const check = reopened.getByTestId("check-library-game");
  await expect(check).toBeVisible();
  await check.click();
  await expect(check).toBeHidden();
  await expect(reopened).not.toContainText("Not checked yet");
  await page.keyboard.press("Escape");
});

test("Download… offers the project file and the playable game", async ({ page }) => {
  await seedOwnedGame(page, "menu-download", "Menu download");
  const card = savedGameCard(page, "Menu download");
  await expect(card).toBeVisible();

  const dialog = await openGameDownload(page, card);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-label", "Menu download");
  const projectButton = dialog.getByTestId("download-library-game");
  const gameButton = dialog.getByTestId("export-library-game");
  await expect(projectButton).toBeVisible();
  await expect(projectButton).toContainText("Project file");
  await expect(projectButton).toContainText(
    "Your edits, saves and history. Open it here to carry on.",
  );
  await expect(gameButton).toBeVisible();
  await expect(gameButton).toContainText("Playable game");
  await expect(gameButton).toContainText("The game files, ready to share and play.");

  const projectPending = page.waitForEvent("download");
  await projectButton.click();
  const projectDownload = await projectPending;
  expect(projectDownload.suggestedFilename()).toMatch(/-project\.zip$/);
  await expect(dialog).toBeHidden();
  const projectPath = test.info().outputPath("menu-download-project.zip");
  await projectDownload.saveAs(projectPath);
  const projectArchive = await readGameZip(new Uint8Array(await readFile(projectPath)));
  expect(projectArchive.project).toBeDefined();

  const reopened = await openGameDownload(page, card);
  const gamePending = page.waitForEvent("download");
  await reopened.getByTestId("export-library-game").click();
  const gameDownload = await gamePending;
  expect(gameDownload.suggestedFilename()).toMatch(/\.zip$/);
  expect(gameDownload.suggestedFilename()).not.toMatch(/-project\.zip$/);
  const gamePath = test.info().outputPath("menu-download-game.zip");
  await gameDownload.saveAs(gamePath);
  const gameArchive = await readGameZip(new Uint8Array(await readFile(gamePath)));
  expect(gameArchive.project).toBeUndefined();

  const third = await openGameDownload(page, card);
  await page.keyboard.press("Escape");
  await expect(third).toBeHidden();
  await expect(card.getByRole("button", { name: "Game actions", exact: true })).toBeFocused();
});

test("the in-game Settings sheet has one Download… opening the same dialog", async ({ page }) => {
  await playTutorialOnce(page);
  await savedGameCard(page, "Adventure Department")
    .getByTestId("catalog-play-adventure-department")
    .click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);

  await openGameOptions(page, "settings-menu");
  const section = page
    .getByTestId("settings-menu-menu")
    .getByRole("region", { name: "This game", exact: true });
  await expect(section.getByTestId("btn-edit-game")).toBeVisible();
  await expect(section.getByTestId("btn-download-game")).toBeVisible();
  await expect(section.getByTestId("btn-start-over")).toBeVisible();
  await expect(section.getByTestId("btn-export-game")).toHaveCount(0);
  await expect(section.getByRole("button")).toHaveCount(3);

  await section.getByTestId("btn-download-game").click();
  const dialog = page.getByTestId("settings-download-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("download-library-game")).toBeVisible();
  await expect(dialog.getByTestId("export-library-game")).toBeVisible();

  const pending = page.waitForEvent("download");
  await dialog.getByTestId("export-library-game").click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  await expect(dialog).toBeHidden();
});
