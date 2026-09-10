import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { configureAi, isolateStorage, openCreateAdventure, textHook } from "./engineProbe.ts";

test("templates expose editable Markdown and genesis receives the edited brief", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  const brief = page.getByTestId("custom-adventure-input");
  await expect(brief).toBeHidden();
  await expect(page.getByTestId("create-adventure-disclosure")).toHaveAttribute("open", "");
  await expect(page.locator('.template-card[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.getByTestId("boot-game")).toBeDisabled();
  await openCreateAdventure(page);
  for (const templateId of [
    "knights-trial",
    "badge-of-millhaven",
    "mop-jockey",
    "polyester-nights",
  ]) {
    await page.getByTestId(`template-${templateId}`).click();
    const source = await readFile(
      new URL(`../../games/${templateId}/SKILL.md`, import.meta.url),
      "utf8",
    );
    await expect(brief).toHaveValue(source.slice(source.indexOf("\n---", 4) + 4).trimStart());
    await expect(brief).not.toHaveValue(/^---/);
  }
  await page.getByTestId("template-mop-jockey").click();
  const edited =
    (await brief.inputValue()) +
    "\n\n## Player direction\nThe station is run by a talking otter.\n";
  await brief.fill(edited);
  await page.getByLabel("Adventure name").fill("Otter Station");
  await page.getByTestId("template-custom").click();
  await expect(brief).toHaveValue("");
  await expect(page.getByTestId("boot-game")).toBeDisabled();
  await page.getByTestId("template-mop-jockey").click();
  await expect(brief).toHaveValue(edited);
  await expect(page.getByLabel("Adventure name")).toHaveValue("Otter Station");
  await brief.fill("");
  await expect(page.getByTestId("boot-game")).toBeDisabled();
  await brief.fill(edited);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await brief.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("template-editor-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: test.info().outputPath("template-editor-desktop.png"),
    fullPage: true,
  });
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await page.route("**/api/openai/v1/responses", (route) =>
    route.fulfill({
      status: 400,
      json: { error: { message: "End of request inspection", type: "invalid_request_error" } },
    }),
  );
  const request = page.waitForRequest("**/api/openai/v1/responses");
  await page.getByTestId("boot-game").click();
  const sent = JSON.stringify((await request).postDataJSON());
  expect(sent).toContain("name: mop-jockey");
  expect(sent).toContain(JSON.stringify(edited.trim()).slice(1, -1));
});

test("the menu accommodates a large library and gives custom adventures room to write", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) =>
    route.fulfill({ json: Array.from({ length: 40 }, (_, i) => `game-${i + 1}`) }),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await configureAi(page, { provider: "stub" });
  await expect(page.getByRole("heading", { name: "AGI IS HERE." })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("menu-first-visit.png") });
  const gallery = page.getByTestId("saved-game-gallery");
  await expect(gallery.locator('[data-testid^="local-game-card-"]')).toHaveCount(40);
  await expect(page.getByTestId("installed-game-select")).toHaveCount(0);
  await expect(page.getByTestId("boot-game-40")).toHaveText("Play");
  await openCreateAdventure(page);
  await expect(page.getByTestId("create-adventure-disclosure")).toHaveAttribute("open", "");
  await page.getByTestId("template-custom").click();
  await expect(page.getByTestId("boot-game")).toBeDisabled();
  await page.getByLabel("Adventure name").fill("Midnight at the Museum");
  const brief = page.getByTestId("custom-adventure-input");
  await brief.fill(
    "I am the night guard at a museum where the exhibits come alive. A tiny dinosaur has stolen my keys.",
  );
  expect((await brief.boundingBox())!.height).toBeGreaterThanOrEqual(200);
  await page.screenshot({ path: test.info().outputPath("menu-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(brief).toHaveValue(/night guard/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("menu-mobile.png"), fullPage: true });
  await expect(page.getByTestId("catalog-play-adventure-department")).toHaveText("Play now");
  const openGame = page.getByRole("button", { name: "Add game", exact: true });
  await openGame.scrollIntoViewIfNeeded();
  await expect(openGame).toBeInViewport();
  await configureAi(page, { provider: "stub" });
  await page.getByTestId("boot-game").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("btn-eject").click();
  await expect(page.getByTestId("saved-game-gallery")).toContainText("Midnight at the Museum");
  await openCreateAdventure(page);
  await page.getByTestId("template-mop-jockey").click();
  await expect(page.getByTestId("saved-game-gallery")).toContainText("Midnight at the Museum");
  await page.screenshot({ path: test.info().outputPath("menu-mobile-saved.png"), fullPage: true });
});
