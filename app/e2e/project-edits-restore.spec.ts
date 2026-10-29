import { readFile } from "node:fs/promises";
import { test, expect } from "./test.ts";
import { isolateStorage, workspaceSaved } from "./engineProbe.ts";
import { openStoredWorkspace } from "./workspaceShared.ts";
import type { Page } from "@playwright/test";

async function downloadedEdits(page: Page) {
  const viewports =
    test.info().project.name === "iphone-webkit"
      ? [{ width: 390, height: 844 }]
      : test.info().project.name === "desktop-webkit"
        ? [{ width: 1440, height: 900 }]
        : [
            { width: 1063, height: 815 },
            { width: 1440, height: 900 },
            { width: 390, height: 844 },
          ];
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Recovered adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await workspaceSaved(page);
  await page.getByRole("button", { name: "Back to library", exact: true }).click();
  const original = await page.evaluate(async () => {
    const { listCachedGames, loadAuthoredGameWithHistoryLifetime } =
      await import("/src/project/gameStorage.ts");
    const { openProjectSession } = await import("/src/project/projectSession.ts");
    const { markProjectSaveRecovery } = await import("/src/project/projectSaveJournal.ts");
    const id = listCachedGames().find((game) => game.title === "Recovered adventure")!.projectId;
    const opened = (await loadAuthoredGameWithHistoryLifetime(id))!;
    const session = openProjectSession({
      data: opened.data,
      lifetime: opened.lifetime!,
      admission: {
        runToken: "downloaded-edits",
        admit: async () => ({
          status: "committed",
          expected: null,
          current: null,
          patchGeneration: 0,
        }),
      },
    });
    await session.submit({
      proposal: session.model.propose(session.model.capture(), "Notes", [
        { key: "notes", content: "A secret door behind the waterfall" },
      ]),
      label: "Notes",
      origin: "logic",
      author: "creator",
    });
    session.dispose();
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith(`monotio_agi.project-writes.${id}.`),
    )!;
    markProjectSaveRecovery(localStorage, key, "Temporary recovery failure");
    return { id, key, raw: localStorage.getItem(key)! };
  });
  const card = page.getByTestId(`saved-game-card-${original.id}`);
  const notice = card.getByTestId("pending-edit-recovery");
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Discard edits", exact: true }).click();
  const dialog = page.getByTestId("discard-edits-dialog");
  await expect(dialog).toBeVisible();
  for (const { width, height } of viewports) {
    await page.setViewportSize({ width, height });
    const buttons = dialog.locator("footer button");
    for (const button of await buttons.all()) await expect(button).toBeInViewport();
    const boxes = await buttons.evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().top),
    );
    if (width > 520) expect(new Set(boxes).size, "desktop choice actions share one row").toBe(1);
    else expect(new Set(boxes).size, "phone choice actions stack").toBe(3);
    await page.screenshot({ path: test.info().outputPath(`discard-edits-${width}.png`) });
  }
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download pending edits first", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("agi-unsaved-edits.zip");
  const path = test.info().outputPath("agi-unsaved-edits.zip");
  await download.saveAs(path);
  expect((await readFile(path)).toString()).toContain("A secret door behind the waterfall");
  await dialog.getByRole("button", { name: "Discard edits", exact: true }).click();
  await expect(notice).toBeHidden();
  expect(await page.evaluate((key) => localStorage.getItem(key), original.key)).toBeNull();
  return { ...original, path, viewports };
}

test("download, discard and restore pending edits to the same project @phone @webkit-desktop", async ({
  page,
}) => {
  const original = await downloadedEdits(page);
  const bytes = await readFile(original.path);
  await page.getByTestId("game-zip-input").setInputFiles(original.path);
  const notice = page.getByTestId("game-import-ready");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Pending edits restored to Recovered adventure.");
  const card = page.getByTestId(`saved-game-card-${original.id}`);
  await expect(card).toHaveCount(1);
  // Restoring is also safe while the exact downloaded recovery is still in this browser.
  await page.evaluate(async ({ key, raw }) => {
    const { markProjectSaveRecovery } = await import("/src/project/projectSaveJournal.ts");
    localStorage.setItem(key, raw);
    markProjectSaveRecovery(localStorage, key, "Temporary recovery failure");
  }, original);
  await expect(card.getByTestId("pending-edit-recovery")).toBeVisible();
  await page.getByTestId("game-zip-input").setInputFiles(original.path);
  await expect(card.getByTestId("pending-edit-recovery")).toBeHidden();
  for (const { width, height } of original.viewports) {
    await page.setViewportSize({ width, height });
    await notice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`restored-edits-${width}.png`) });
  }
  await openStoredWorkspace(page, "Recovered adventure");
  await page.getByTestId("part-notes").click();
  await expect(page.getByLabel("Game notes", { exact: true })).toHaveValue(
    "A secret door behind the waterfall",
  );
  await page.screenshot({ path: test.info().outputPath("restored-notes.png") });
  expect(await readFile(original.path)).toEqual(bytes);
});

test("a reimported project keeps its own edits when a pending-edits download is added @phone @webkit-desktop", async ({
  page,
  context,
}) => {
  const original = await downloadedEdits(page);
  const bytes = await readFile(original.path);
  const other = await context.newPage();
  await other.goto("/");
  await other.evaluate(async (id) => {
    const { clearCachedGame, loadAuthoredGame, saveAuthoredGame } =
      await import("/src/project/gameStorage.ts");
    const data = (await loadAuthoredGame(id as never))!;
    await clearCachedGame(id as never);
    await saveAuthoredGame(id as never, data);
  }, original.id);
  await page.getByTestId("game-zip-input").setInputFiles(original.path);
  const error = page.getByTestId("game-zip-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("The original project is missing or was reimported.");
  await expect(error).toContainText("Keep this file");
  expect(await readFile(original.path)).toEqual(bytes);
  for (const { width, height } of original.viewports) {
    await page.setViewportSize({ width, height });
    await error.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`restore-mismatch-${width}.png`) });
  }
  await openStoredWorkspace(page, "Recovered adventure");
  await page.getByTestId("part-notes").click();
  await expect(page.getByLabel("Game notes", { exact: true })).not.toHaveValue(
    "A secret door behind the waterfall",
  );
});
