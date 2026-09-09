import { expect, test } from "@playwright/test";
import { fixtureSkip } from "../../test/fixtures.ts";
import { isolateStorage } from "./engineProbe.ts";

const missing = fixtureSkip("kq1", ["AGIDATA.OVL"]);

test.describe("Walkthrough UI", () => {
  test("runs real-time walkthrough from game actions menu with speed controls, take control, and pause/resume", async ({
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

    // Verify walkthrough HUD bar and bottom transport bar appear
    const bar = page.getByTestId("walkthrough-bar");
    await expect(bar).toBeVisible({ timeout: 15_000 });
    await expect(bar).toContainText("Walkthrough");

    const transport = page.getByTestId("walkthrough-transport");
    await expect(transport).toBeVisible();

    // Verify speed controls (including 4x and 8x)
    const speed4 = page.getByTestId("walkthrough-speed-4");
    await expect(speed4).toBeVisible();
    await speed4.click();
    await expect(speed4).toHaveClass(/walkthrough-speed-btn--active/);

    const speed8 = page.getByTestId("walkthrough-speed-8");
    await expect(speed8).toBeVisible();
    await speed8.click();
    await expect(speed8).toHaveClass(/walkthrough-speed-btn--active/);

    // Verify story pause toggle button
    const storyPauseBtn = page.getByTestId("btn-walkthrough-pause-on-dialog");
    await expect(storyPauseBtn).toBeVisible();
    await expect(storyPauseBtn).not.toHaveClass(/walkthrough-speed-btn--active/);
    await storyPauseBtn.click();
    await expect(storyPauseBtn).toHaveClass(/walkthrough-speed-btn--active/);
    await storyPauseBtn.click();
    await expect(storyPauseBtn).not.toHaveClass(/walkthrough-speed-btn--active/);

    // Verify timeline scrubber, fill, thumb, and checkpoint markers
    const timeline = page.getByTestId("walkthrough-timeline");
    await expect(timeline).toBeVisible();
    await expect(page.getByTestId("walkthrough-progress-fill")).toBeVisible();
    await expect(page.getByTestId("walkthrough-thumb")).toBeVisible();
    const marker1 = page.getByTestId("walkthrough-marker-1");
    await expect(marker1).toBeVisible();

    // Verify checkpoint label updates and room advances past title screen
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

    // Walkthrough bar and transport should hide, leaving game running interactively
    await expect(bar).toBeHidden();
    await expect(transport).toBeHidden();
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

    // Walkthrough bar and transport bar appear again
    await expect(bar).toBeVisible({ timeout: 15_000 });
    await expect(transport).toBeVisible();

    // Wait until playback is active
    await expect
      .poll(async () => page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0), {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(1);

    // Test Pause button toggle
    const pauseBtn = page.getByTestId("btn-walkthrough-pause");
    await expect(pauseBtn).toBeVisible();
    await expect(pauseBtn).toHaveAttribute("aria-label", "Pause");
    await pauseBtn.click();
    await expect(pauseBtn).toHaveAttribute("aria-label", "Play");

    // While paused, verify virtual ticks do not advance
    await page.waitForTimeout(100);
    const tickPaused = await page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0);
    await page.waitForTimeout(500);
    const tickStillPaused = await page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0);
    expect(tickStillPaused).toBe(tickPaused);

    // Resume playback using Spacebar shortcut
    await page.keyboard.press("Space");
    await expect(pauseBtn).toHaveAttribute("aria-label", "Pause");

    // Verify ticks resume advancing
    await expect
      .poll(
        async () => {
          const tick = await page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0);
          return tick;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(tickPaused);

    // Test hover tooltip on timeline
    const box = await timeline.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
      await expect(page.locator(".walkthrough-tooltip")).toBeVisible();
      await page.mouse.move(0, 0);
      await expect(page.locator(".walkthrough-tooltip")).toBeHidden();
    }

    // Test seeking via timeline marker click
    const marker3 = page.getByTestId("walkthrough-marker-3");
    if (await marker3.isVisible()) {
      await marker3.click();
      // Verify seek jumps forward
      await expect
        .poll(
          async () => {
            const tick = await page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0);
            return tick;
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThan(tickPaused + 100);
    }

    // Test backward seek (rewind) by clicking an earlier marker
    const marker1Early = page.getByTestId("walkthrough-marker-1");
    if (await marker1Early.isVisible()) {
      const tickBeforeRewind = await page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0);
      await marker1Early.click({ force: true });
      await expect
        .poll(
          async () => {
            const tick = await page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0);
            return tick;
          },
          { timeout: 10_000 },
        )
        .toBeLessThan(tickBeforeRewind);
    }

    // Test live drag scrubbing (drag forward, then backward)
    const dragBox = await timeline.boundingBox();
    if (dragBox) {
      // Pause first to observe live position changes
      await pauseBtn.click();
      await expect(pauseBtn).toHaveAttribute("aria-label", "Play");

      // Drag forward to 30% width
      await page.mouse.move(dragBox.x + dragBox.width * 0.1, dragBox.y + dragBox.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(dragBox.x + dragBox.width * 0.3, dragBox.y + dragBox.height * 0.5, {
        steps: 5,
      });

      await expect
        .poll(
          async () => {
            const tick = await page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0);
            return tick;
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThanOrEqual(100);

      const tickAfterForwardDrag = await page.evaluate(
        () => window.__AGI_REPLAY__?.latest?.tick ?? 0,
      );

      // Now drag backward to beginning of track (0% width) while still holding pointer down
      await page.mouse.move(dragBox.x, dragBox.y + dragBox.height * 0.5, { steps: 5 });

      await expect
        .poll(
          async () => {
            const tick = await page.evaluate(() => window.__AGI_REPLAY__?.latest?.tick ?? 0);
            return tick;
          },
          { timeout: 10_000 },
        )
        .toBeLessThan(tickAfterForwardDrag);

      await page.mouse.up();
    }

    // Verify Developer activity panel has single heading, no inner h2, and logs submitted inputs
    const activitySummary = page.getByTestId("developer-activity-summary");
    await expect(activitySummary).toBeVisible();
    await expect(activitySummary).toHaveText("Developer activity");
    await activitySummary.click();
    await expect(page.getByTestId("agent-panel").locator("h2")).toHaveCount(0);
    await expect(page.getByTestId("gpu-backend")).toBeVisible();

    const trace = await page.evaluate(() => window.__AGI_TRACE__ ?? []);
    const inputEntries = trace.filter((e) => e.kind === "input");
    expect(inputEntries.length).toBeGreaterThan(0);

    // Test returning to adventure picker via the header Menu button
    const headerMenuBtn = page.getByTestId("btn-eject");
    await expect(headerMenuBtn).toBeVisible();
    await headerMenuBtn.click();

    // Should return to adventure picker
    await expect(bar).toBeHidden();
    await expect(transport).toBeHidden();
    await expect(page.getByTestId("boot-kq1")).toBeVisible({ timeout: 10_000 });
  });

  test("story pause auto-pauses when encountering a dialogue and unpauses via Enter", async ({
    page,
  }) => {
    test.skip(Boolean(missing), missing || "");
    await isolateStorage(page);
    await page.goto("/");

    const menuBtn = page.getByTestId("game-actions-kq1");
    await expect(menuBtn).toBeVisible({ timeout: 10_000 });
    await menuBtn.click();

    const runBtn = page.getByTestId("run-walkthrough");
    await expect(runBtn).toBeVisible();
    await runBtn.click();

    const transport = page.getByTestId("walkthrough-transport");
    await expect(transport).toBeVisible();

    // Enable story pause
    const storyPauseBtn = page.getByTestId("btn-walkthrough-pause-on-dialog");
    await expect(storyPauseBtn).toBeVisible();
    await storyPauseBtn.click();
    await expect(storyPauseBtn).toHaveClass(/walkthrough-speed-btn--active/);

    // Fast-forward at 8x so it quickly reaches the first dialogue
    const speed8 = page.getByTestId("walkthrough-speed-8");
    await speed8.click();

    // Verify it auto-pauses when reaching a dialogue modal or waitkey
    const playBtn = page.getByTestId("btn-walkthrough-pause");
    await expect
      .poll(
        async () => {
          const isPaused = await page.evaluate(
            () => window.__AGI_STATE__?.walkthrough.status === "paused",
          );
          return isPaused;
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    await expect(playBtn).toHaveAttribute("aria-label", "Play");

    // Press Enter to unpause and advance dialogue
    await page.keyboard.press("Enter");

    await expect
      .poll(
        async () => {
          const isPlaying = await page.evaluate(
            () => window.__AGI_STATE__?.walkthrough.status === "playing",
          );
          return isPlaying;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  });

  test("seeks past King Edward to Dagger checkpoint", async ({ page }) => {
    test.skip(Boolean(missing), missing || "");
    await isolateStorage(page);
    await page.goto("/");

    const menuBtn = page.getByTestId("game-actions-kq1");
    await expect(menuBtn).toBeVisible({ timeout: 10_000 });
    await menuBtn.click();

    const runBtn = page.getByTestId("run-walkthrough");
    await expect(runBtn).toBeVisible();
    await runBtn.click();

    const timeline = page.getByTestId("walkthrough-timeline");
    const box = await timeline.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.5);
    }

    await expect
      .poll(
        async () => {
          const res = await page.evaluate(() => ({
            tick: window.__AGI_STATE__?.walkthrough.tick ?? 0,
            status: window.__AGI_STATE__?.walkthrough.status,
            error: window.__AGI_STATE__?.walkthrough.error,
          }));
          if (res.error) throw new Error(`Walkthrough failed: ${res.error}`);
          return res.tick;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(3600);
  });

  test("scrubs mh1 walkthrough rapidly and reaches Bellevue Hospital checkpoint cleanly", async ({
    page,
  }) => {
    const mh1Missing = fixtureSkip("mh1", ["AGIDATA.OVL"]);
    test.skip(Boolean(mh1Missing), mh1Missing || "");
    await isolateStorage(page);
    await page.goto("/");

    const menuBtn = page.getByTestId("game-actions-mh1");
    await expect(menuBtn).toBeVisible({ timeout: 10_000 });
    await menuBtn.click();

    const runBtn = page.getByTestId("run-walkthrough");
    await expect(runBtn).toBeVisible();
    await runBtn.click();

    const timeline = page.getByTestId("walkthrough-timeline");
    await expect(timeline).toBeVisible({ timeout: 15_000 });

    const box = await timeline.boundingBox();
    if (box) {
      // Rapid scrubbing back and forth across multiple checkpoints
      await page.mouse.move(box.x + box.width * 0.08, box.y + box.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.5);
      await page.mouse.move(box.x + box.width * 0.04, box.y + box.height * 0.5);
      // Land right around ~11% (Bellevue Hospital is tick 10110 out of ~90000 total virtual ticks)
      await page.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.5);
      await page.mouse.up();
    }

    // Verify seeking or fast-forward reaches room 130 (Bellevue Hospital) without error
    await expect
      .poll(
        async () => {
          const res = await page.evaluate(() => ({
            room: window.__AGI_STATE__?.walkthrough.room,
            tick: window.__AGI_STATE__?.walkthrough.tick ?? 0,
            status: window.__AGI_STATE__?.walkthrough.status,
            error: window.__AGI_STATE__?.walkthrough.error,
          }));
          if (res.error) throw new Error(`Walkthrough failed: ${res.error}`);
          return res.room;
        },
        { timeout: 45_000 },
      )
      .toBe(130);
  });

  test("dragging timeline thumb to the end of kq1 silences audio and stops playback cleanly", async ({
    page,
  }) => {
    test.skip(Boolean(missing), missing || "");
    await isolateStorage(page);
    await page.goto("/");

    const menuBtn = page.getByTestId("game-actions-kq1");
    await expect(menuBtn).toBeVisible({ timeout: 10_000 });
    await menuBtn.click();

    const runBtn = page.getByTestId("run-walkthrough");
    await expect(runBtn).toBeVisible();
    await runBtn.click();

    const timeline = page.getByTestId("walkthrough-timeline");
    await expect(timeline).toBeVisible({ timeout: 15_000 });

    const box = await timeline.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width, box.y + box.height * 0.5, { steps: 5 });
      await page.mouse.up();
    }

    await expect
      .poll(
        async () => {
          return page.evaluate(() => ({
            status: window.__AGI_STATE__?.walkthrough.status,
            percent: window.__AGI_STATE__?.walkthrough.percent,
            audioPlaying: window.__AGI_AUDIO__?.isPlaying ?? false,
            soundPlaying: window.__AGI_STATE__?.soundPlaying ?? false,
          }));
        },
        { timeout: 30_000 },
      )
      .toEqual({
        status: "completed",
        percent: 100,
        audioPlaying: false,
        soundPlaying: false,
      });
  });
});
