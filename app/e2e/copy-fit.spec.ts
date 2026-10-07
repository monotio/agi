import { expect, test, type Page } from "@playwright/test";
import { testProjectId } from "../test/identity.ts";
import {
  cacheGame,
  isolateStorage,
  openGameDownload,
  openGameOptions,
  openLibraryActions,
  savedGameCard,
  textHook,
} from "./engineProbe.ts";
import { buildTutorial } from "../../games/adventure-department/game.ts";

/**
 * Text that carries meaning shows in full at desktop widths: card titles,
 * the card menu and Settings rows, the history transport's labels, and the
 * notices and toasts over the game. An element may wrap; an element that
 * clips (an ellipsis, or a line clamp that runs out of lines) fails. The
 * Studios keep their own layout specs.
 */

const WIDTHS = [1440, 1280, 1024] as const;
const LONG_TITLE = "King's Quest I: Quest for the Crown";

const MEANINGFUL = [
  "[data-testid='saved-game-title']",
  "[role='menu'] [role='menuitem']",
  ".settings-row",
  "[data-testid='history-transport'] button",
  "[data-testid='history-pos']",
  "[data-testid='history-dropped']",
  ".ui-toast",
  "[role='status']",
  "[role='alert']",
].join(", ");

/** Each visible meaningful element, or a descendant, whose text is clipped. */
async function clipped(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const found: string[] = [];
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    for (const root of document.querySelectorAll(selector)) {
      if (!visible(root)) continue;
      for (const element of [root, ...root.querySelectorAll("*")]) {
        if (!(element instanceof HTMLElement) || !visible(element)) continue;
        const style = getComputedStyle(element);
        const clips = style.overflowX !== "visible" || style.textOverflow === "ellipsis";
        const wide = element.scrollWidth > element.clientWidth + 1;
        const clamped =
          style.getPropertyValue("-webkit-line-clamp") !== "none" &&
          element.scrollHeight > element.clientHeight + 1;
        if ((clips && wide) || clamped)
          found.push(`${element.tagName.toLowerCase()} "${element.textContent?.trim()}"`);
      }
    }
    return found;
  }, MEANINGFUL);
}

async function expectFits(page: Page, where: string): Promise<void> {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    expect(await clipped(page), `${where} at ${width}px`).toEqual([]);
  }
}

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
});

test("a long card title and the card menu show in full", async ({ page }) => {
  const game = buildTutorial();
  await page.goto("/");
  await cacheGame(page, {
    projectId: testProjectId("long-title"),
    title: LONG_TITLE,
    provider: "stub",
    model: "offline-stub",
    imported: true,
    files: game.files,
    words: game.words,
  });
  await page.reload();
  const card = savedGameCard(page, LONG_TITLE);
  await expect(card).toBeVisible();
  await expectFits(page, "the shelf");
  await page.setViewportSize({ width: 1440, height: 900 });
  await card.screenshot({ path: test.info().outputPath("long-title-card-1440.png") });
  await openLibraryActions(page, card);
  await expect(
    page.getByRole("menu", { name: "Game actions", exact: true }).getByRole("menuitem").first(),
  ).toBeVisible();
  await expectFits(page, "the card menu");
  // Menus close on viewport resize; the download dialog rides the sweep out.
  const download = await openGameDownload(page, card);
  await expect(download.getByTestId("export-library-game")).toBeVisible();
  await expectFits(page, "the download dialog");
  await page.keyboard.press("Escape");
});

test("Settings rows and the history transport show in full", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect(page.getByTestId("history-transport")).toBeVisible();
  await expectFits(page, "live play");

  await openGameOptions(page, "settings-menu");
  await expect(page.getByTestId("btn-download-game")).toBeVisible();
  await expectFits(page, "the Settings sheet");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("btn-download-game")).toBeHidden();

  // A timeline click opens the history: Resume from here, Watch from here and the readout.
  await page.setViewportSize({ width: 1440, height: 900 });
  const timeline = page.getByTestId("history-timeline");
  await expect(timeline).toHaveAttribute("aria-valuenow", "100", { timeout: 20_000 });
  const box = (await timeline.boundingBox())!;
  await timeline.click({ position: { x: box.width * 0.1, y: box.height / 2 } });
  await expect(page.getByTestId("btn-history-resume")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("btn-history-watch")).toBeVisible();
  await expect(page.getByTestId("history-pos")).toContainText("Room");
  await expectFits(page, "the history view");
});
