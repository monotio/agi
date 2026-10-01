import { test, expect } from "./test.ts";
import { isolateStorage, openLibraryActions, savedGameCard } from "./engineProbe.ts";

test("Sound Studio shows the opened project's name @webkit-desktop", async ({ page }) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  let providerCalls = 0;
  await page.route(/api\.openai\.com|api\.anthropic\.com/, (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    await prepareLocalProject({ title: "Cue identity", kind: "blank" }).save();
  });
  await page.reload();
  const card = savedGameCard(page, "Cue identity");
  await expect(card).toBeVisible();
  await openLibraryActions(page, card);
  await page.getByTestId("edit-library-game-sound").click();
  const studio = page.getByTestId("sound-studio");
  await expect(studio).toBeVisible();
  await expect(studio.locator(".sound-studio__title p")).toHaveText("Cue identity");
  expect(providerCalls).toBe(0);
});
