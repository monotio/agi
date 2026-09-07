import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { readGameZip } from "../src/gameZip.ts";
import {
  isolateStorage,
  openGameOptions,
  storedAutosave,
  textHook,
  waitForAutosaveAfter,
  waitForCycles,
} from "./engineProbe.ts";

const TUTORIAL_SLUG = "catalog-adventure-department-1.0.0";

/**
 * A project archive carries the player's progress; a game export never does.
 * Imported on another browser, the project's card offers Resume and lands
 * where the walk stopped.
 */
test("the project archive moves the autosave to another browser; the game export carries none", async ({
  page,
  browser,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
  const spawnX = (await textHook(page)).egoX;
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(spawnX + 12);
  await page.keyboard.press("ArrowRight");
  await waitForCycles(page, 4);
  const stopped = await textHook(page);
  await waitForCycles(page, 2);
  expect((await textHook(page)).egoX, "ego stands still before the checkpoint").toBe(stopped.egoX);
  await waitForAutosaveAfter(page, stopped.cycle);
  expect((await storedAutosave(page, TUTORIAL_SLUG))?.room).toBe(1);

  // The project download from the running game carries the checkpoint.
  const projectDownload = page.waitForEvent("download");
  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-save-live-project").click();
  const saved = await projectDownload;
  const savedPath = (await saved.path())!;
  const project = await readGameZip(new Uint8Array(await readFile(savedPath)));
  expect(project.progress?.autosave?.room).toBe(1);
  expect(project.progress?.autosave?.game.slug).toBe(TUTORIAL_SLUG);
  expect(Object.keys(project.progress?.saves ?? {})).toEqual([]);

  // The game export is for publishing: no progress in it.
  const publicDownload = page.waitForEvent("download");
  await openGameOptions(page, "game-actions-menu");
  await page.getByTestId("btn-export-live-zip").click();
  const published = await publicDownload;
  const publicGame = await readGameZip(new Uint8Array(await readFile((await published.path())!)));
  // Publication safety: tests, saves and authoring context each excluded on their own.
  expect(
    publicGame.files["TESTS.JSON"],
    "tests travel with the project archive only",
  ).toBeUndefined();
  expect(publicGame.progress, "saves travel with the project archive only").toBeUndefined();
  expect(
    publicGame.project,
    "authoring context travels with the project archive only",
  ).toBeUndefined();
  expect(project.files["TESTS.JSON"]).toBeDefined();

  const fresh = await browser.newContext();
  try {
    const other = await fresh.newPage();
    await other.goto(page.url());
    await other.getByTestId("game-zip-input").setInputFiles(savedPath);
    await expect(other.getByText(/added to your library with your last autosave/)).toBeVisible();
    const resume = other.getByTestId("btn-resume-cached");
    await expect(resume).toHaveText("Resume");
    const slug = await other.evaluate(async () => {
      const path = "/src/cartridgeStorage.ts";
      const store = await import(path);
      return store.listCachedCartridges()[0].slug as string;
    });
    expect(slug).not.toBe(TUTORIAL_SLUG);
    expect((await storedAutosave(other, slug))?.room).toBe(1);
    await resume.click();
    await expect.poll(async () => (await textHook(other)).room).toBe(1);
    await expect
      .poll(async () => (await textHook(other)).egoX, {
        message: "the imported checkpoint is restored, not a boot from room 1",
      })
      .toBe(stopped.egoX);
    await expect(other.getByTestId("resume-caption")).toBeVisible();
  } finally {
    await fresh.close();
  }
});
