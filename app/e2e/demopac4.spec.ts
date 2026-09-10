import { fixtureSkip, KNOWN_GAME_HASH } from "../../test/fixtures.ts";
import { expect, test } from "@playwright/test";
import { isolateStorage, textHook } from "./engineProbe.ts";

/**
 * The authentic v3 fixture in the REAL app: a local, gitignored Sierra
 * demonstration installation (games/demopac4, combined DMDIR/DMVOL container,
 * AGIDATA.OVL "Version 3.002.102"). Every logic record is dictionary
 * compressed, so its text is the browser-visible proof that compressed v3
 * records decode. Skips when the fixture is absent. Every wait polls state the
 * app publishes through the text hook; there are no wall-clock sleeps.
 */
const missingFixture = fixtureSkip(KNOWN_GAME_HASH.DEMOPAC4, ["AGIDATA.OVL"]);
test.skip(Boolean(missingFixture), missingFixture || "");
if (missingFixture) console.warn(`[fixture skipped] ${missingFixture}`);

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
});

test("boots the v3 demo pack, shows its intro text and starts a demonstration", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator(
      `[data-hash="${KNOWN_GAME_HASH.DEMOPAC4}"], [data-alias="demopac4"], [data-testid="boot-demopac4"]`,
    )
    .first()
    .click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });
  // The loader ships AGIDATA.OVL, whose ASCII version string selects 3.002.102.
  await expect
    .poll(async () => (await textHook(page)).profile, { timeout: 15_000 })
    .toBe("3.002.102");
  // Room 1's logo animation display()s message 40 at (24,22) and polls
  // have.key once per cycle (hand-checked in logic 1).
  await expect
    .poll(async () => (await textHook(page)).rows[24] ?? "", { timeout: 20_000 })
    .toContain("Press any key...");
  await page.screenshot({ path: "test-results/demopac4-intro.png" });

  // A letter with the input line unfocused (input is prevented in this game).
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("x");
  await expect
    .poll(async () => (await textHook(page)).rows[7] ?? "", { timeout: 20_000 })
    .toContain("Hi.  Which of our games");
  const menu = await textHook(page);
  expect(menu.rows[0]).toContain("Press number of demo to select/deselect");
  expect(menu.rows[3]).toContain("Need help? Press H");
  await page.screenshot({ path: "test-results/demopac4-menu.png" });

  // '1' toggles the first demonstration (controller 1); Enter runs the selection.
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(61);
  // Its first window is logic 61's message 1, kept open by f15.
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "), { timeout: 60_000 })
    .toContain("GOLD RUSH!");
  await page.screenshot({ path: "test-results/demopac4-gold-rush.png" });
});
