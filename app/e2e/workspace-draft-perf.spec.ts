import { expect, test } from "./test.ts";
import { fixtureSkip } from "../../test/fixtures.ts";
import { loadGame } from "../../test/game-fixture.ts";
import { cacheGame, enterCreateMode, isolateStorage, workspaceSaved } from "./engineProbe.ts";
import { testProjectId } from "../test/identity.ts";
import { focusWorkspaceLogic, workspaceDocumentEnd } from "./workspaceShared.ts";
import type { CDPSession } from "@playwright/test";

async function mainTime(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return (
    (metrics.find((entry: { name: string }) => entry.name === "TaskDuration")?.value ?? 0) * 1000
  );
}

test(
  "SQ1 Amiga draft keystrokes and strokes stay proportional to the edited part",
  { tag: "@perf" },
  async ({ page, browserName }) => {
    const missing = fixtureSkip("sq1-amiga", ["Sierra"]);
    test.skip(Boolean(missing), missing || "");
    expect(browserName).toBe("chromium");
    await page.setViewportSize({ width: 1440, height: 900 });
    await isolateStorage(page);
    const { files } = loadGame("sq1-amiga", { interpreterFiles: true });
    await page.goto("/");
    await cacheGame(page, {
      projectId: testProjectId("sq1-draft-perf"),
      title: "SQ1 draft timing",
      imported: true,
      files: Object.fromEntries(files),
      words: [],
    });
    await page.reload();
    await page.getByTestId("btn-resume-cached").click();
    await expect(page.getByTestId("input-line")).toBeVisible();
    await enterCreateMode(page);
    await expect(page.getByTestId("parts-list")).toBeVisible();
    await expect(page.getByTestId("parts-list")).toHaveAttribute("data-analysis", "resolved");
    await page.getByTestId("part-logic:0").click();
    await expect(
      page.getByTestId("workspace-logic-editor").locator(".monaco-editor"),
    ).toBeVisible();
    await focusWorkspaceLogic(page);
    await workspaceDocumentEnd(page);
    await page.keyboard.insertText("\n// ");
    await workspaceSaved(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const before = await mainTime(cdp);
    const keys = "An unfinished draft waits for the creator";
    for (const key of keys) {
      await page.keyboard.type(key);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await workspaceSaved(page);
    const keyMs = ((await mainTime(cdp)) - before) / keys.length;
    // Imported art can be edited without entering its room or changing interpreter state.
    const show = page.getByTestId("workspace-show-game");
    if (await show.isVisible()) await show.click();
    await page
      .locator('[data-testid^="part-"]')
      .filter({ hasText: /^PICTURE/ })
      .first()
      .click();
    const studio = page.getByTestId("room-studio");
    await expect(studio).toBeVisible();
    await studio.locator('[data-tool="brush"]').click();
    await studio.locator('.workspace-palette [data-colour="4"]').click();
    const box = (await studio.locator(".studio-pane").boundingBox())!;
    const start = await mainTime(cdp);
    const strokes = 12;
    for (let stroke = 0; stroke < strokes; stroke++) {
      await page.mouse.click(box.x + box.width * (0.2 + stroke / 100), box.y + box.height * 0.6);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await workspaceSaved(page);
    const strokeMs = ((await mainTime(cdp)) - start) / strokes;
    console.log(`[draft-perf] keystroke=${keyMs.toFixed(2)}ms stroke=${strokeMs.toFixed(2)}ms`);
    await test.info().attach("main-thread-per-edit", {
      body: JSON.stringify({ keyMs, strokeMs }),
      contentType: "application/json",
    });
    // Includes rendering and background saves; three times the measured headroom.
    expect(keyMs).toBeLessThan(100);
    expect(strokeMs).toBeLessThan(180);
  },
);
