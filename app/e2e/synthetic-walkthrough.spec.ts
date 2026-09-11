import { expect, test } from "@playwright/test";
import { isolateStorage } from "./engineProbe.ts";

test.describe("Synthetic Walkthrough", () => {
  test("runs synthetic walkthrough from game actions menu with speed, seek, and take-control", async ({
    page,
  }) => {
    await isolateStorage(page);
    await page.goto("/");

    // Open ActionMenu next to Play for synthetic
    const menuBtn = page.getByTestId("game-actions-synthetic");
    await expect(menuBtn).toBeVisible({ timeout: 10_000 });
    await menuBtn.click();

    // Verify "Run walkthrough" item is visible
    const runBtn = page.getByTestId("run-walkthrough");
    await expect(runBtn).toBeVisible();
    await expect(runBtn).toContainText("Run walkthrough");
    await runBtn.click();

    // Verify walkthrough HUD bar and bottom transport bar appear
    const bar = page.getByTestId("walkthrough-bar");
    await expect(bar).toBeVisible({ timeout: 15_000 });
    await expect(bar).toContainText("Walkthrough");

    const transport = page.getByTestId("walkthrough-transport");
    await expect(transport).toBeVisible();

    // Verify speed controls
    const speed4 = page.getByTestId("walkthrough-speed-4");
    await expect(speed4).toBeVisible();
    await speed4.click();
    await expect(speed4).toHaveClass(/walkthrough-speed-btn--active/);

    // Timeline and markers
    const timeline = page.getByTestId("walkthrough-timeline");
    await expect(timeline).toBeVisible();
    await expect(page.getByTestId("walkthrough-progress-fill")).toBeVisible();
    await expect(page.getByTestId("walkthrough-thumb")).toBeVisible();

    // Checkpoint markers (5 checkpoints: Start, Corridor, Chamber, Solved, Complete)
    const marker1 = page.getByTestId("walkthrough-marker-1");
    await expect(marker1).toBeVisible();

    // Verify walkthrough room advances to room 2
    await expect
      .poll(
        async () => {
          const obs = await page.evaluate(() => window.__AGI_REPLAY__?.latest);
          return obs?.state.room;
        },
        { timeout: 15_000 },
      )
      .toBe(2);

    // Verify score reaches 50
    await expect
      .poll(
        async () => {
          const obs = await page.evaluate(() => window.__AGI_REPLAY__?.latest);
          return obs?.state.vars[3] ?? 0;
        },
        { timeout: 15_000 },
      )
      .toBe(50);

    // Test marker click seek back to Start (marker 0)
    const marker0 = page.getByTestId("walkthrough-marker-0");
    await expect(marker0).toBeVisible();
    await marker0.click();

    await expect
      .poll(
        async () => {
          const tick = await page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0);
          return tick;
        },
        { timeout: 10_000 },
      )
      .toBeLessThan(50);

    // Test Take Control
    const takeControlBtn = page.getByTestId("btn-walkthrough-take-control");
    await expect(takeControlBtn).toBeVisible();
    await takeControlBtn.click();

    // Walkthrough HUD bar should disappear
    await expect(page.getByTestId("walkthrough-bar")).toBeHidden({ timeout: 5_000 });
    await expect(page.getByTestId("walkthrough-transport")).toBeHidden();

    // Game remains running under player control
    await expect.poll(async () => page.evaluate(() => window.__AGI_STATE__?.phase)).toBe("running");
  });
});
