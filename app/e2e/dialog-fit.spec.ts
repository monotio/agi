import { expect, test, type Page } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { buildZip } from "../src/archive/zip.ts";
import {
  isolateStorage,
  openDeveloperActivity,
  openGameControls,
  openGameOptions,
  openLibraryActions,
  savedGameCard,
  textHook,
} from "./engineProbe.ts";

/**
 * On a phone every dialog keeps each of its buttons whole on screen: a footer
 * too narrow for its row of buttons stacks them full width instead of pushing
 * Cancel, the safe choice, off the dialog's edge. A button may sit below the
 * fold of a scrolling body, never past a dialog's side or the viewport's.
 * Runs in both phone projects (playwright.phone.config.ts).
 */
test.use({ hasTouch: true });

function gameZip(): Buffer {
  const game = createContainer();
  game.putResource("picture", 1, new Uint8Array([0xf0, 1, 0xf8, 0, 0, 0xff]));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {set(f200);assignn(v10,1);accept.input();
        assignn(v51,1);load.pic(v51);draw.pic(v51);show.pic();
        display(2,2,"A phone-sized game.");}
      return;`,
      { dictionary: new Map() },
    ).payload,
  );
  return Buffer.from(
    buildZip(
      [...game.files]
        .map(([name, data]) => ({ name, data }))
        .concat([{ name: "WORDS.TOK", data: buildWordsTok([{ word: "look", id: 1 }]) }]),
    ),
  );
}

/** Every visible button of the open dialogs that is cut off, with its box. */
async function clippedButtons(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const clipped: string[] = [];
    const scrolls = (el: Element) => {
      const { overflowY } = getComputedStyle(el);
      return (overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight;
    };
    for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) {
      const frame = dialog.getBoundingClientRect();
      const left = Math.max(0, frame.left) - 0.5;
      const right = Math.min(window.innerWidth, frame.right) + 0.5;
      for (const button of dialog.querySelectorAll<HTMLElement>("button, a[href]")) {
        const box = button.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        // Below the fold of a scrolling region, or of the page under an
        // in-flow (non-modal) dialog, is reachable; past a side is not.
        let scroller: Element | null = button.parentElement;
        while (scroller && scroller !== dialog && !scrolls(scroller))
          scroller = scroller.parentElement;
        const inScroller = (scroller !== null && scrolls(scroller)) || !dialog.matches(":modal");
        const across = box.left >= left && box.right <= right;
        const down = inScroller || (box.top >= -0.5 && box.bottom <= window.innerHeight + 0.5);
        if (!across || !down)
          clipped.push(
            `${dialog.dataset["testid"] ?? dialog.getAttribute("aria-label")}: ` +
              `"${(button.getAttribute("aria-label") ?? button.textContent ?? "").trim()}" ` +
              `${Math.round(box.left)}..${Math.round(box.right)} × ${Math.round(box.top)}..${Math.round(box.bottom)}`,
          );
      }
    }
    return clipped;
  });
}

async function expectButtonsOnScreen(page: Page, dialog: string): Promise<void> {
  await expect(page.getByTestId(dialog)).toBeVisible();
  // The entrance animation scales the dialog in; measure the settled box.
  await page
    .getByTestId(dialog)
    .evaluate((el) =>
      Promise.allSettled(el.getAnimations({ subtree: true }).map((a) => a.finished)),
    );
  await page.screenshot({ path: test.info().outputPath(`${dialog}.png`) });
  expect.soft(await clippedButtons(page), dialog).toEqual([]);
}

for (const [width, height] of [
  [390, 844],
  [360, 740],
] as const) {
  test(`every dialog keeps its buttons on screen at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
    await isolateStorage(page);
    await page.goto("/");
    await page.getByTestId("create-adventure-toggle").click();
    await expectButtonsOnScreen(page, "create-adventure-disclosure");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("create-adventure-disclosure")).toBeHidden();
    await page.getByTestId("game-zip-input").setInputFiles({
      name: "pocket.zip",
      mimeType: "application/zip",
      buffer: gameZip(),
    });
    await expectButtonsOnScreen(page, "profile-picker-dialog");
    await page.getByTestId("profile-picker-keep").click();
    await expect(page.getByTestId("profile-picker-dialog")).toBeHidden();

    const card = savedGameCard(page, "pocket");
    await openLibraryActions(page, card);
    await page.getByTestId("remove-library-game").click();
    await expectButtonsOnScreen(page, "remove-game-dialog");
    // The safe choice is whole and works.
    await page.getByTestId("remove-game-cancel").click();
    await expect(page.getByTestId("remove-game-dialog")).toBeHidden();

    await openLibraryActions(page, card);
    await page.getByTestId("interpreter-profile-menu-item").click();
    await expectButtonsOnScreen(page, "profile-picker-dialog");
    await page.getByTestId("profile-picker-keep").click();

    await openLibraryActions(page, card);
    await page.getByTestId("game-details-item").click();
    const details = page.locator("dialog[data-testid^='game-details-']");
    await expectButtonsOnScreen(page, (await details.getAttribute("data-testid"))!);
    await page.keyboard.press("Escape");

    await page.getByTestId("btn-help").click();
    await expectButtonsOnScreen(page, "help-guide");
    await page.keyboard.press("Escape");

    await page.getByTestId("settings-menu").click();
    await expectButtonsOnScreen(page, "settings-menu-menu");
    await page.getByTestId("open-ai-settings").click();
    await expectButtonsOnScreen(page, "ai-settings-dialog");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ai-settings-dialog")).toBeHidden();
    if (await page.getByTestId("settings-menu-menu").isVisible())
      await page.keyboard.press("Escape");

    await card.getByTestId("btn-resume-cached").click();
    await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("phone-sized");
    await openGameControls(page);
    await expectButtonsOnScreen(page, "game-controls");
    await page.keyboard.press("Escape");
    await page.getByTestId("btn-world-map").click();
    await expectButtonsOnScreen(page, "world-map");
    await page.keyboard.press("Escape");
    await openGameOptions(page, "settings-menu");
    await expectButtonsOnScreen(page, "settings-menu-menu");
    await page.keyboard.press("Escape");
    await openDeveloperActivity(page);
    await expectButtonsOnScreen(page, "developer-activity-sheet");
  });
}
