import { expect, test } from "@playwright/test";
import { fixtureSkip } from "../../test/fixtures.ts";
import { isolateStorage } from "./engineProbe.ts";

const missing = fixtureSkip("kq1", ["AGIDATA.OVL"]);

test.describe("Walkthrough UI", () => {
  test("runs real-time walkthrough from game actions menu with speed controls, take control, and stop", async ({
    page,
  }) => {
    test.skip(Boolean(missing), missing || "");
    await isolateStorage(page);
    await page.goto("/");

    // Open ActionMenu next to Play for KQ1
    const menuBtn = page.getByTestId("game-actions-kq1");
    await expect(menuBtn).toBeVisible({ timeout: 10_000 });
    await menuBtn.click();

    // Verify "Run walkthrough" item is visible
    const runBtn = page.getByTestId("run-walkthrough");
    await expect(runBtn).toBeVisible();
    await expect(runBtn).toContainText("Run walkthrough");
    await runBtn.click();

    // Verify walkthrough HUD bar appears
    const bar = page.getByTestId("walkthrough-bar");
    await expect(bar).toBeVisible({ timeout: 15_000 });
    await expect(bar).toContainText("Walkthrough");

    // Verify speed controls and toggle to 4x
    const speed4 = page.getByTestId("walkthrough-speed-4");
    await expect(speed4).toBeVisible();
    await speed4.click();
    await expect(speed4).toHaveClass(/walkthrough-speed-btn--active/);

    // Verify checkpoint badge updates and room advances past title screen
    const label = page.getByTestId("walkthrough-label");
    await expect(label).toBeVisible();

    // Verify room leaves title screen (room 83) and score increases
    await expect
      .poll(
        async () => {
          const obs = await page.evaluate(() => window.__AGI_REPLAY__?.latest);
          return obs?.state.room;
        },
        { timeout: 30_000 },
      )
      .not.toBe(83);

    await expect
      .poll(
        async () => {
          const obs = await page.evaluate(() => window.__AGI_REPLAY__?.latest);
          return obs?.state.vars[3] ?? 0;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(1);

    await expect(page.getByTestId("walkthrough-score")).toContainText(/Score: [1-9]/);

    // Test Take Control
    const takeControlBtn = page.getByTestId("btn-walkthrough-take-control");
    await expect(takeControlBtn).toBeVisible();
    await takeControlBtn.click();

    // Walkthrough bar should hide, leaving game running interactively
    await expect(bar).toBeHidden();
    await expect(page.locator(".game-surface:visible")).toHaveCount(1);
    await expect(page.getByTestId("input-line")).toBeEnabled();

    // Verify engine timers are running and cycles continue advancing
    const cycleAtTakeover = await page.evaluate(() => window.__AGI_TEXT__?.cycle ?? 0);
    await expect
      .poll(
        async () => {
          const cycle = await page.evaluate(() => window.__AGI_TEXT__?.cycle ?? 0);
          return cycle;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(cycleAtTakeover);

    // Verify interactive keyboard input moves ego
    const egoXBefore = await page.evaluate(() => window.__AGI_TEXT__?.egoX ?? 0);
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(
        async () => {
          const egoX = await page.evaluate(() => window.__AGI_TEXT__?.egoX ?? 0);
          return egoX;
        },
        { timeout: 10_000 },
      )
      .not.toBe(egoXBefore);

    // Now test running walkthrough from in-game Game actions menu
    const gameActions = page.getByTestId("game-actions-menu");
    await expect(gameActions).toBeVisible();
    await gameActions.click();

    const inGameRun = page.getByTestId("btn-run-walkthrough");
    await expect(inGameRun).toBeVisible();
    await inGameRun.click();

    // Walkthrough bar appears again
    await expect(bar).toBeVisible({ timeout: 15_000 });

    // Test Stop button
    const stopBtn = page.getByTestId("btn-walkthrough-stop");
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();

    // Should return to adventure picker
    await expect(bar).toBeHidden();
    await expect(page.getByTestId("boot-kq1")).toBeVisible({ timeout: 10_000 });
  });
});
