import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { readGameZip } from "../src/gameZip.ts";
import { isolateStorage, openGameOptions, textHook, waitForAutosaveAfter } from "./engineProbe.ts";

test("malformed play hashes recover to the picker without a startup exception", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await isolateStorage(page);
  await page.goto("/#play/%");
  await expect(page.getByTestId("catalog-play-adventure-department")).toBeVisible();
  expect(errors).toEqual([]);
  expect(new URL(page.url()).hash).toBe("");
});

for (const failure of ["unsafe", "timeout", "storage"] as const) {
  test(`project export discloses ${failure} checkpoint failure before downloading saved progress`, async ({
    page,
  }, testInfo) => {
    await isolateStorage(page);
    await page.goto("/");
    await page.getByTestId("catalog-play-adventure-department").click();
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await waitForAutosaveAfter(page, (await textHook(page)).cycle);
    const savedCycle = (await textHook(page)).autosave;
    if (failure === "unsafe") {
      await page.getByTestId("input-line").fill("look");
      await page.getByTestId("input-line").press("Enter");
      await expect.poll(async () => (await textHook(page)).modal).toBe("print");
    } else if (failure === "timeout") {
      await page.evaluate(() => {
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message, transfer) {
          if (message.type === "flush") return;
          return post.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
        };
      });
    } else {
      await page.evaluate(() => {
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith("monotio_agi.autosave."))
            throw new DOMException("No space", "QuotaExceededError");
          return set.call(this, key, value);
        };
      });
    }
    let downloads = 0;
    page.on("download", () => downloads++);
    await openGameOptions(page, "game-actions-menu");
    await page.getByTestId("btn-save-live-project").click();
    await expect(page.getByTestId("export-refusal")).toContainText(
      "Current progress could not be saved",
    );
    expect(downloads).toBe(0);
    if (failure === "unsafe")
      await page.screenshot({ path: testInfo.outputPath("checkpoint-refusal.png") });
    const download = page.waitForEvent("download");
    await page.getByTestId("export-saved-progress").click();
    const path = (await (await download).path())!;
    const archive = await readGameZip(new Uint8Array(await readFile(path)));
    // A periodic checkpoint may succeed while the explicit flush times out.
    if (failure === "timeout")
      expect(archive.progress?.autosave?.cycle).toBeGreaterThanOrEqual(savedCycle!);
    else expect(archive.progress?.autosave?.cycle).toBe(savedCycle);
    expect(downloads).toBe(1);
  });
}
