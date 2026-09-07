import { expect, test } from "@playwright/test";
import {
  isolateStorage,
  storedAutosave,
  textHook,
  waitForAutosaveAfter,
  waitForCycles,
} from "./engineProbe.ts";

const TUTORIAL_SLUG = "catalog-adventure-department-1.0.0";

test("the tutorial shelf offers Resume and restores the checkpoint exactly", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
  const spawnX = (await textHook(page)).egoX;

  // Walk east, then stop, so the checkpoint holds a position that differs from the spawn.
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(spawnX + 12);
  await page.keyboard.press("ArrowRight");
  await waitForCycles(page, 4);
  const stopped = await textHook(page);
  expect(stopped.room).toBe(1);
  await waitForCycles(page, 2);
  expect((await textHook(page)).egoX, "ego must stand still before the checkpoint").toBe(
    stopped.egoX,
  );

  // The host must have STORED a checkpoint taken after the walk before it is relied on.
  await waitForAutosaveAfter(page, stopped.cycle);
  const checkpoint = await storedAutosave(page, TUTORIAL_SLUG);
  expect(checkpoint?.room).toBe(1);

  await page.getByTestId("btn-eject").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  const tutorial = page.getByTestId("tutorial-disclosure");
  if ((await tutorial.getAttribute("open")) === null)
    await page.getByTestId("tutorial-toggle").click();
  const play = page.getByTestId("catalog-play-adventure-department");
  await expect
    .soft(play, "the shelf must offer the checkpoint, not a fresh start")
    .toHaveText("Resume");

  await play.click();
  await expect.poll(async () => (await textHook(page)).room).toBe(stopped.room);
  await expect
    .poll(async () => (await textHook(page)).egoX, {
      message: "the checkpoint must be restored, not overwritten by a boot from room 1",
    })
    .toBe(stopped.egoX);
  await waitForCycles(page, 2);
  expect((await textHook(page)).egoX).toBe(stopped.egoX);
});
