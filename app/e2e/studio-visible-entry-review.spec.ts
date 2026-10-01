import { openLibraryActions, savedGameCard } from "./engineProbe.ts";
import { blockProviders, createProjectViaUi, prepareIsolatedPage } from "./logicDebugShared.ts";
import { expect, reviewShot, test } from "./test.ts";

test("a manually created game has a Edit action in its game menu @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  await page.goto("/");
  const title = "Visible creation route";
  await createProjectViaUi(page, title);
  const card = savedGameCard(page, title);
  await openLibraryActions(page, card);
  const edit = page.getByTestId("edit-library-game");
  await expect(edit).toBeVisible();
  await expect(edit).toBeEnabled();
  await expect(card.getByTestId("btn-resume-cached")).toBeVisible();
  await reviewShot(page, "studio-visible-entry");
  await edit.click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  expect(providers.count()).toBe(0);
});
