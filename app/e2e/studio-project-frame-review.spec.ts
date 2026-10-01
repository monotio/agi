import { openLibraryActions, savedGameCard } from "./engineProbe.ts";
import { blockProviders, createProjectViaUi, prepareIsolatedPage } from "./logicDebugShared.ts";
import { expect, reviewShot, test } from "./test.ts";

test("gallery Edit opens the running workspace and its resource parts @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  await page.goto("/");
  const title = "One project workspace";
  await createProjectViaUi(page, title);
  const createDialog = page
    .getByRole("dialog")
    .filter({ has: page.getByTestId("local-create-title") });
  if (await createDialog.isVisible())
    await createDialog.getByRole("button", { name: "Close", exact: true }).click();
  await openLibraryActions(page, savedGameCard(page, title));
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  const overview = page.getByTestId("parts-list");
  await expect(overview).toBeVisible();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  const explorer = page.getByTestId("parts-list");
  await expect(explorer).toBeVisible();
  for (const family of ["SHARED LOGIC", "PICTURES", "VIEWS", "SOUNDS", "WORDS", "OBJECTS"]) {
    await expect(explorer.getByRole("heading", { name: family, exact: true })).toBeVisible();
  }
  await reviewShot(page, "studio-project-overview");
  expect(providers.count()).toBe(0);
});
