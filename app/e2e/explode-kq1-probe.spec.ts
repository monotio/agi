import { expect, test } from "./test.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "../../test/fixtures.ts";
import { gameHint, isolateStorage, textHook, waitForCycles, openInspector } from "./engineProbe.ts";

const missingFixture = fixtureSkip(KNOWN_GAME_HASH.KQ1, ["AGIDATA.OVL"]);
test.skip(Boolean(missingFixture), missingFixture || "");

test("KQ1 courtyard exploded", async ({ page }) => {
  await page.clock.install();
  await isolateStorage(page);
  await page.goto("/");
  await page
    .locator(`[data-hash="${KNOWN_GAME_HASH.KQ1}"], [data-alias="kq1"], [data-testid="boot-kq1"]`)
    .first()
    .click();
  await expect(await gameHint(page, "title-prompt-hint")).toBeVisible({ timeout: 15_000 });
  await page.mouse.move(0, 0);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await textHook(page)).rows[0] ?? "", { timeout: 20_000 })
    .toContain("Score:");
  await waitForCycles(page, 6);

  await openInspector(page);
  await page.getByTestId("dbg-mode-explode").click();
  await expect(page.getByTestId("dbg-mode-explode")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("dbg-collapse").click();
  await waitForCycles(page, 4);
  await page
    .getByTestId("gpu-canvas")
    .screenshot({ path: test.info().outputPath("kq1-explode-rest.png") });

  // Parallax: pointer to the right edge swings the camera.
  const gpu = page.getByTestId("gpu-canvas");
  const box = (await gpu.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.5);
  await page.clock.runFor(600);
  await gpu.screenshot({ path: test.info().outputPath("kq1-explode-parallax.png") });
});
