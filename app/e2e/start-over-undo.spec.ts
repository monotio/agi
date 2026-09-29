import type { Page } from "@playwright/test";
import { expect, reviewShot, test } from "./test.ts";
import {
  isolateStorage,
  openGameOptions,
  openLibraryActions,
  savedGameCard,
  textHook,
  waitForCycles,
} from "./engineProbe.ts";

/**
 * Start over keeps the earlier sessions on the timeline. Right after it, a
 * note offers Undo start over; the timeline marks where the fresh session
 * began, and that mark stays once the note has gone.
 */

const note = (page: Page) => page.getByTestId("start-over-note");
const startedOverMarks = (page: Page) =>
  page.locator('.history-marker--restart[title="Started over"]');

/** Exit to Home and use Start over on the tutorial's saved card. */
async function startOverFromHome(page: Page): Promise<void> {
  await page.getByTestId("btn-exit").click();
  const card = savedGameCard(page, "Adventure Department");
  await expect(card).toBeVisible();
  await openLibraryActions(page, card);
  await page.getByTestId("start-library-game-over").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
}

test("Undo start over returns to the earlier session, and the timeline marks the start over @webkit-desktop", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
  const spawnX = (await textHook(page)).egoX;
  // No note on a first run: there is no earlier session to go back to.
  await expect(note(page)).toHaveCount(0);

  // Walk east, then stop, so the earlier session ends away from the spawn.
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(spawnX + 12);
  await page.keyboard.press("ArrowRight");
  await waitForCycles(page, 4);
  const stopped = await textHook(page);
  expect(stopped.room).toBe(1);

  await startOverFromHome(page);
  await expect.poll(async () => (await textHook(page)).egoX).toBe(spawnX);
  await expect(note(page)).toContainText("Started over.");
  const undo = note(page).getByRole("button", { name: "Undo start over", exact: true });
  await expect(undo).toBeVisible();
  await expect(undo, "the note never takes focus").not.toBeFocused();
  await expect(startedOverMarks(page)).toHaveCount(1);
  // The note sits clear of the command line: the engine's input row (22 of 25).
  const noteBox = (await note(page).boundingBox())!;
  const screen = (await page.locator(".game-surface:visible").boundingBox())!;
  const inputRowTop = screen.y + (screen.height * 22) / 25;
  // Fractional layout can land the note's edge a hair past the row (590.005
  // against 590 on CI): half a pixel covers no pixel of the input line.
  expect(noteBox.y + noteBox.height, "the note does not cover the input line").toBeLessThanOrEqual(
    inputRowTop + 0.5,
  );
  await reviewShot(page, "start-over-note");

  // The note waits for the player: well past its countdown with no input, it stays.
  await waitForCycles(page, 260, 30_000);
  await expect(note(page)).toBeVisible();

  await undo.click();
  await expect(note(page)).toHaveCount(0);
  await expect.poll(async () => (await textHook(page)).egoX).toBe(stopped.egoX);
  expect((await textHook(page)).room).toBe(stopped.room);
  // It was playing when Undo was pressed, so it plays on.
  await expect(page.getByTestId("btn-transport-pause")).toBeVisible();
  await waitForCycles(page, 4);
  // The short fresh session stays on the timeline but is not kept as a
  // branch: no Undo rewind or redo follows, as before the start over.
  await expect(page.getByTestId("btn-undo-rewind")).toHaveCount(0);
  expect(await page.evaluate(() => window.__AGI_STATE__?.historyView.branches)).toBe(0);
  await expect(page.getByTestId("history-error")).toHaveCount(0);
  await expect(startedOverMarks(page)).toHaveCount(1);
  await reviewShot(page, "after-undo-start-over");

  // Start over again. After the first input the note counts ten seconds of
  // game time, then goes; the mark stays.
  await startOverFromHome(page);
  await expect(note(page)).toBeVisible();
  await page.getByTestId("input-line").focus();
  await page.keyboard.type("l");
  await expect(note(page)).toBeHidden({ timeout: 20_000 });
  await expect(startedOverMarks(page)).toHaveCount(2);
  await reviewShot(page, "start-over-mark-stays");

  // Once more, from the game's own settings: walking into another room closes it.
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("btn-start-over").click();
  await expect(note(page)).toBeVisible();
  await page.getByTestId("input-line").fill("east");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await expect(note(page)).toHaveCount(0);
});

test("Undo after the game's own Start over returns to the exact moment it was used", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
  const spawnX = (await textHook(page)).egoX;

  // Walk east and stop inside room 1: the walk lives only in the session's
  // open recording, which no room entry, autosave or Exit has closed yet.
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(spawnX + 12);
  await page.keyboard.press("ArrowRight");
  await waitForCycles(page, 4);
  const stopped = await textHook(page);
  expect(stopped.room).toBe(1);

  await page.getByTestId("settings-menu").click();
  await page.getByTestId("btn-start-over").click();
  await expect.poll(async () => (await textHook(page)).egoX).toBe(spawnX);
  await note(page).getByRole("button", { name: "Undo start over", exact: true }).click();
  await expect(note(page)).toHaveCount(0);
  await expect(page.getByTestId("history-error")).toHaveCount(0);
  await expect.poll(async () => (await textHook(page)).egoX).toBe(stopped.egoX);
  const back = await textHook(page);
  expect([back.room, back.egoX, back.egoY]).toEqual([stopped.room, stopped.egoX, stopped.egoY]);
});

/** Storage refuses (true) or takes (false) this game's timeline writes. */
async function refuseTimeline(page: Page, refuse: boolean): Promise<void> {
  await page.evaluate((on) => {
    const w = window as unknown as { refuseHistory?: boolean };
    if (w.refuseHistory === undefined) {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        if (w.refuseHistory && (value as { projectId?: string }).projectId?.startsWith("history/"))
          throw new Error("Injected history write refusal");
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
    }
    w.refuseHistory = on;
  }, refuse);
}

test("the game's Start over waits for an unsaved timeline, and Start over anyway goes without it @webkit-desktop", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
  const spawnX = (await textHook(page)).egoX;
  const walkEastAndStop = async () => {
    await page.getByTestId("input-line").focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(spawnX + 12);
    await page.keyboard.press("ArrowRight");
    await waitForCycles(page, 4);
    const stopped = await textHook(page);
    expect(stopped.room).toBe(1);
    return stopped;
  };
  const startOver = async () => {
    await openGameOptions(page, "settings-menu");
    await page.getByTestId("btn-start-over").click();
  };
  const notice = page.getByTestId("start-over-history");
  const refused = async (stopped: { room: number; egoX: number; egoY: number }) => {
    await expect(notice.locator("p")).toHaveText(
      "This session's rewind timeline is not saved yet, so Start over stopped. Your game is as you left it.",
      { timeout: 15_000 },
    );
    // The game plays on where it was.
    await waitForCycles(page, 2);
    const here = await textHook(page);
    expect([here.room, here.egoX, here.egoY]).toEqual([stopped.room, stopped.egoX, stopped.egoY]);
  };

  const stopped = await walkEastAndStop();
  await refuseTimeline(page, true);
  await startOver();
  await refused(stopped);
  await expect(page.getByTestId("start-over-note")).toHaveCount(0);
  expect(
    await notice.evaluate((el) => el.contains(document.activeElement)),
    "the notice never takes focus",
  ).toBe(false);
  await reviewShot(page, "start-over-refused");

  // Try again while storage still refuses: refused again.
  await page.getByTestId("start-over-retry").click();
  await expect(notice).toBeHidden();
  await refused(stopped);
  // Stay, from the keyboard.
  await page.getByTestId("start-over-stay").focus();
  await page.keyboard.press("Enter");
  await expect(notice).toBeHidden();

  // Start over anyway goes without the unsaved timeline.
  await startOver();
  await refused(stopped);
  await page.getByTestId("start-over-anyway").click();
  await expect.poll(async () => (await textHook(page)).egoX).toBe(spawnX);
  await expect(notice).toBeHidden();

  // Once storage takes the timeline again, Start over goes ahead.
  const again = await walkEastAndStop();
  expect(again.egoX).not.toBe(spawnX);
  await refuseTimeline(page, false);
  await startOver();
  await expect.poll(async () => (await textHook(page)).egoX, { timeout: 20_000 }).toBe(spawnX);
  await expect(notice).toBeHidden();
});
