import { test, expect } from "./test.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import {
  enterCreateMode,
  isolateStorage,
  textHook,
  waitForAutosaveAfter,
  waitForCycles,
  waitForGameInput,
} from "./engineProbe.ts";

test("Play explains refused progress entry storage and clears the notice when progress saves @phone", async ({
  page,
}) => {
  const files = createStarterProject("starter").files();
  await page.route("**/fixtures/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/fixtures/") return route.fulfill({ json: ["checkpoint-proof"] });
    if (path === "/fixtures/checkpoint-proof/") return route.fulfill({ json: [...files.keys()] });
    const bytes = files.get(path.split("/").at(-1)!);
    return route.fulfill(bytes ? { body: Buffer.from(bytes) } : { status: 404 });
  });
  await isolateStorage(page);
  await page.goto("/");
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    const fault = window as unknown as { checkpointWritesRefused: boolean };
    fault.checkpointWritesRefused = true;
    Storage.prototype.setItem = function (key, value) {
      if (fault.checkpointWritesRefused && key.startsWith("monotio_agi.autosave."))
        throw new DOMException("Injected full storage", "QuotaExceededError");
      write.call(this, key, value);
    };
    (window as unknown as { restoreCheckpointStorage: () => void }).restoreCheckpointStorage =
      () => {
        fault.checkpointWritesRefused = false;
      };
  });
  await page.getByTestId("boot-checkpoint-proof").click();
  await waitForGameInput(page);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  const notice = page.getByTestId("checkpoint-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(
    "Browser storage refused your progress. Free some space, then keep playing to try again.",
  );
  expect((await textHook(page)).autosave).toBe(-1);
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(notice).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`checkpoint-notice-${width}.png`) });
  }
  await page.evaluate(() =>
    (window as unknown as { restoreCheckpointStorage: () => void }).restoreCheckpointStorage(),
  );
  // The pagehide handler asks the live worker for a fresh checkpoint.
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await waitForAutosaveAfter(page, -1);
  await expect(notice).toBeHidden();
  await waitForCycles(page, 2);
  await page.evaluate(() => {
    (window as unknown as { checkpointWritesRefused: boolean }).checkpointWritesRefused = true;
    window.dispatchEvent(new Event("pagehide"));
  });
  await expect(notice).toBeVisible();
  await enterCreateMode(page);
  await expect(notice).toBeHidden();
  expect(await page.evaluate(() => window.__AGI_STATE__?.checkpointProblem)).toBe("");
});
