import { expect, reviewShot, test } from "./test.ts";
import { openLibraryActions, savedGameCard } from "./engineProbe.ts";
import { blockProviders, createProjectViaUi, prepareIsolatedPage } from "./logicDebugShared.ts";

test("gallery Edit opens the project overview and its resource workspace @webkit-desktop", async ({
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
  const overview = page.getByTestId("project-studio-overview");
  await expect(overview).toBeVisible();
  await expect(overview).toContainText(title);
  const explorer = page.getByTestId("project-studio-explorer");
  await expect(explorer).toBeVisible();
  for (const family of ["Logic", "Pictures", "Views", "Sounds", "Words", "Inventory"]) {
    await expect(explorer.getByText(family, { exact: true })).toBeVisible();
  }
  await reviewShot(page, "studio-project-overview");
  expect(providers.count()).toBe(0);
});
