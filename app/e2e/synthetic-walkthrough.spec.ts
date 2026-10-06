import { expect, test } from "@playwright/test";
import { clickTimelineMark, isolateStorage, openCardMenu } from "./engineProbe.ts";

test.describe("Synthetic Walkthrough", () => {
  test("runs synthetic walkthrough from game actions menu with speed, seek, and take-control", async ({
    page,
  }) => {
    await isolateStorage(page);
    await page.goto("/");

    // Open ActionMenu next to Play for synthetic
    await openCardMenu(page, "game-actions-synthetic");

    // Verify the walkthrough item is visible
    const runBtn = page.getByTestId("run-walkthrough");
    await expect(runBtn).toBeVisible();
    await expect(runBtn).toContainText("Watch walkthrough");
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
    const speedBox = (await speed4.boundingBox())!;
    await page.mouse.move(speedBox.x + speedBox.width / 2, speedBox.y + speedBox.height / 2);
    await page.mouse.down();
    await expect(speed4).toBeFocused();
    expect(await speed4.boundingBox()).toEqual(speedBox);
    await page.mouse.up();
    await expect(speed4).toHaveClass(/walkthrough-speed-btn--active/);
    await page.screenshot({ path: test.info().outputPath("walkthrough-speed-4.png") });

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

    // Observe the score and pause in the same browser turn. The tape has only
    // 48 ticks left at score 50; a host-side poll followed by a click can arrive
    // after completion at 4x.
    await page.waitForFunction(() => {
      if (window.__AGI_REPLAY__?.latest?.state.vars[3] !== 50) return false;
      const pause = document.querySelector<HTMLButtonElement>(
        '[data-testid="btn-walkthrough-pause"]',
      );
      if (!pause || pause.disabled) return false;
      pause.click();
      return true;
    });

    // A paused seek holds at Start while we inspect its position.
    await expect
      .poll(() => page.evaluate(() => window.__AGI_STATE__?.walkthrough.status))
      .toBe("paused");
    const marker0 = page.getByTestId("walkthrough-marker-0");
    await expect(marker0).toBeVisible();
    await clickTimelineMark(page, marker0);

    await expect
      .poll(
        async () => {
          const tick = await page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0);
          return tick;
        },
        { timeout: 10_000 },
      )
      .toBeLessThan(50);
    expect(await page.evaluate(() => window.__AGI_STATE__?.walkthrough.status)).toBe("paused");

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
