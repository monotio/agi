import { expect, test } from "@playwright/test";
import { fixtureSkip, KNOWN_GAME_HASH } from "../../test/fixtures.ts";
import { isolateStorage, textHook, waitForCycles } from "./engineProbe.ts";

const missingFixture = fixtureSkip(KNOWN_GAME_HASH.KQ1, ["AGIDATA.OVL"]);
test.skip(Boolean(missingFixture), missingFixture || "");

test.use({ headless: process.platform !== "darwin" });

test("KQ1 courtyard exploded", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await page
    .locator(`[data-hash="${KNOWN_GAME_HASH.KQ1}"], [data-alias="kq1"], [data-testid="boot-kq1"]`)
    .first()
    .click();
  await expect(page.getByTestId("title-prompt-hint")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await textHook(page)).rows[0] ?? "", { timeout: 20_000 })
    .toContain("Score:");
  await waitForCycles(page, 6);

  await page.getByTestId("power-up").click();
  await page.getByTestId("inspect-toggle").click();
  await page.keyboard.press("Escape");
  await page.getByTestId("dbg-mode-explode").click();
  await page.getByTestId("dbg-collapse").click();
  await waitForCycles(page, 4);
  await page.getByTestId("gpu-canvas").screenshot({ path: "test-results/kq1-explode-rest.png" });

  // Parallax: pointer to the right edge swings the camera.
  const gpu = page.getByTestId("gpu-canvas");
  const box = (await gpu.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.5);
  await page.waitForTimeout(600);
  await gpu.screenshot({ path: "test-results/kq1-explode-parallax.png" });
});
