import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { isolateStorage, openLibraryActions, savedGameCard } from "./engineProbe.ts";

async function openStudioSound(card: Locator): Promise<Locator> {
  const page = card.page();
  await openLibraryActions(page, card);
  await page
    .getByRole("menu", { name: "Game actions", exact: true })
    .getByTestId("edit-library-game")
    .click();
  await expect(page.getByTestId("logic-studio")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("logic-open-sound").click();
  const studio = page.getByTestId("sound-studio");
  await expect(studio).toBeVisible({ timeout: 15_000 });
  return studio;
}

async function openCues(page: Page) {
  await isolateStorage(page);
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => route.abort());
  await page.goto("/");
  await page.evaluate(async () => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    await prepareLocalProject({ title: "Retained cues", kind: "starter" }).save();
  });
  await page.reload();
  const studio = await openStudioSound(savedGameCard(page, "Retained cues"));
  await studio.getByTestId("sound-item-1").click();
  return studio;
}

test("switching sound cues retains each cue's event selection @webkit-desktop", async ({
  page,
}) => {
  const studio = await openCues(page);
  const first = studio.locator('[data-testid^="sound-event-"]').first();
  const id = await first.getAttribute("data-testid");
  expect(id).not.toBeNull();
  await first.click();
  await expect(first).toHaveClass(/sound-event--selected/);
  await studio.getByTestId("sound-item-255").click();
  await studio.locator('[data-testid^="sound-event-"]').last().click();
  await studio.getByTestId("sound-item-1").click();
  await expect(studio.getByTestId(id!)).toHaveClass(/sound-event--selected/);
});

test("sound timeline zoom belongs to its cue @webkit-desktop", async ({ page }) => {
  const studio = await openCues(page);
  const zoom = studio.locator(".sound-timeline__zoom span");
  await expect(zoom).toHaveText("100%");
  await studio.getByTestId("sound-zoom-in").click();
  await studio.getByTestId("sound-zoom-in").click();
  await expect(zoom).toHaveText("400%");
  await studio.getByTestId("sound-item-255").click();
  await expect(zoom).toHaveText("100%");
  await studio.getByTestId("sound-zoom-out").click();
  await expect(zoom).toHaveText("50%");
  await studio.getByTestId("sound-item-1").click();
  await expect(zoom).toHaveText("400%");
});
