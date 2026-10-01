import { expect, reviewShot, test } from "./test.ts";
import { savedGameCard } from "./engineProbe.ts";
import { blockProviders, createProjectViaUi, prepareIsolatedPage } from "./logicDebugShared.ts";

test("a manually created game has a visible Edit action beside Play @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  await page.goto("/");
  const title = "Visible creation route";
  await createProjectViaUi(page, title);
  const card = savedGameCard(page, title);
  const edit = card.getByRole("button", { name: "Edit", exact: true });
  await expect(edit).toBeVisible();
  await expect(edit).toBeEnabled();
  await expect(card.getByTestId("btn-resume-cached")).toBeVisible();
  await reviewShot(page, "studio-visible-entry");
  await edit.click();
  await expect(page.getByTestId("logic-studio")).toBeVisible();
  await expect(page.getByTestId("logic-studio")).toContainText(title);
  expect(providers.count()).toBe(0);
});
