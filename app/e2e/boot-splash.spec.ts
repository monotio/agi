import { expect, test, type Page } from "@playwright/test";
import { testProjectId } from "../test/identity.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "../../test/fixtures.ts";
import { cacheGame, textHook } from "./engineProbe.ts";

/**
 * Opening a game passes through the loading phase. That splash once showed
 * the Create panel's draft title ("Untitled adventure") for every boot, so
 * each game flashed it before its own first frame. A boot names the game it
 * opens; a MutationObserver installed before the app loads records any text
 * the page ever shows, so a one-frame flash still fails the check.
 */
async function recordPageText(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __seenText: string[] }).__seenText = seen;
    new MutationObserver(() => {
      const text = document.body?.innerText ?? "";
      if (text.includes("Untitled adventure")) seen.push(text);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
}

const sawDraftTitle = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as unknown as { __seenText: string[] }).__seenText.length > 0);

test("resuming a library game never shows the draft title", async ({ page }) => {
  await recordPageText(page);
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic('display(5, 4, "Splash probe"); accept.input(); return;', {
      dictionary: new Map(),
    }).payload,
  );
  await page.goto("/");
  await cacheGame(page, {
    projectId: testProjectId("boot-splash"),
    title: "Splash probe",
    provider: "stub",
    model: "stub",
    imported: true,
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).frame).toBeGreaterThan(0);
  expect(await sawDraftTitle(page)).toBe(false);
});

const kq1Missing = fixtureSkip(KNOWN_GAME_HASH.KQ1, ["AGIDATA.OVL"]);

test("opening a gallery fixture never shows the draft title", async ({ page }) => {
  test.skip(Boolean(kq1Missing), kq1Missing || "");
  await recordPageText(page);
  await page.goto("/");
  await page
    .locator(`[data-hash="${KNOWN_GAME_HASH.KQ1}"], [data-alias="kq1"], [data-testid="boot-kq1"]`)
    .first()
    .click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });
  expect(await sawDraftTitle(page)).toBe(false);
});
