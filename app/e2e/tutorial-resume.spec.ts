import { expect, test } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import {
  cacheGame,
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

test("a caption drawn only on room entry survives a browser reload", async ({ page }) => {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic("if(equaln(v0,0)){new.room(1);}call(1);return;", { dictionary: new Map() })
      .payload,
  );
  game.putResource(
    "logic",
    1,
    assembleLogic(
      `
    if (isset(f5)) {
      assignn(v60,1); load.pic(v60); draw.pic(v60); show.pic();
      display(5,2,"Only drawn on room entry."); accept.input();
    } return;`,
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource("picture", 1, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
  await isolateStorage(page);
  await page.goto("/");
  await cacheGame(page, {
    slug: "caption-resume",
    title: "Caption resume",
    provider: "stub",
    model: "local-playback",
    imported: true,
    roomGeneration: false,
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect
    .poll(async () => (await textHook(page)).rows[5])
    .toContain("Only drawn on room entry.");
  await waitForAutosaveAfter(page, (await textHook(page)).cycle);
  await page.reload();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect
    .poll(async () => (await textHook(page)).rows[5])
    .toContain("Only drawn on room entry.");
  await page.screenshot({ path: test.info().outputPath("resumed-caption.png") });
});
