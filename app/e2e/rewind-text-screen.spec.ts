import { test, expect } from "./test.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import {
  isolateStorage,
  openGameOptions,
  textHook,
  waitForCycles,
  waitForGameInput,
} from "./engineProbe.ts";

test("Undo rewind on a text title screen names the screen and keeps Undo available @phone", async ({
  page,
}) => {
  const game = createContainer();
  game.putResource("picture", 1, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
      if (!isset(f200)) {
        set(f200); v50 = 1; load.pic(v50); draw.pic(v50); show.pic(); accept.input();
      }
      if (said("title")) {
        text.screen(); display(5, 5, "A text title screen");
        wait: if (!have.key()) { goto wait; }
        graphics();
      }
      return;`,
      { dictionary: new Map([["title", 1]]) },
    ).payload,
  );
  const files = new Map([...game.files, ["WORDS.TOK", buildWordsTok([{ word: "title", id: 1 }])]]);
  await page.route("**/fixtures/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/fixtures/") return route.fulfill({ json: ["text-title"] });
    if (path === "/fixtures/text-title/") return route.fulfill({ json: [...files.keys()] });
    const bytes = files.get(path.split("/").at(-1)!);
    return route.fulfill(bytes ? { body: Buffer.from(bytes) } : { status: 404 });
  });
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("boot-text-title").click();
  await waitForGameInput(page);
  await waitForCycles(page, 12);
  await page.getByTestId("btn-transport-pause").click();
  const timeline = page.getByTestId("history-timeline");
  await expect(timeline).toHaveAttribute("aria-valuenow", "100");
  const box = (await timeline.boundingBox())!;
  await timeline.click({ position: { x: box.width * 0.5, y: box.height / 2 } });
  await expect(page.getByTestId("btn-history-resume")).toBeEnabled();
  await page.getByTestId("btn-history-resume").click();
  const undo = page.getByTestId("btn-undo-rewind");
  await expect(undo).toBeVisible();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  await page.getByTestId("input-line").fill("title");
  await page.getByTestId("input-line").press("Enter");
  await expect.poll(async () => (await textHook(page)).textMode).toBe(true);
  await undo.click();
  const notice = page.getByTestId("history-error");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(
    "The game is showing a text screen. Continue past it and try Undo rewind again.",
  );
  await expect(undo).toBeEnabled();
  expect((await textHook(page)).textMode).toBe(true);
  await page.locator("canvas.game-surface:visible").click();
  await page.keyboard.press("Space");
  await expect.poll(async () => (await textHook(page)).textMode).toBe(false);
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(notice).toBeInViewport();
    await page.screenshot({ path: test.info().outputPath(`rewind-text-screen-${width}.png`) });
  }
});

for (const refuse of [false, true]) {
  test(`Undo start over restores play from the fresh title screen${refuse ? " after a refused attempt" : ""}`, async ({
    page,
  }) => {
    const game = createContainer();
    game.putResource("picture", 1, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
    game.putResource(
      "logic",
      0,
      assembleLogic(
        `
      if (!isset(f200)) {
        set(f200); v50 = 1; load.pic(v50); draw.pic(v50); show.pic();
        text.screen(); display(5, 5, "Press a key to play");
        wait: if (!have.key()) { goto wait; }
        graphics(); accept.input();
      }
      return;
    `,
        { dictionary: new Map() },
      ).payload,
    );
    game.putFile("WORDS.TOK", buildWordsTok([]));
    await page.route("**/fixtures/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/fixtures/") return route.fulfill({ json: ["fresh-title"] });
      if (path === "/fixtures/fresh-title/") return route.fulfill({ json: [...game.files.keys()] });
      const bytes = game.files.get(path.split("/").at(-1)!);
      return route.fulfill(bytes ? { body: Buffer.from(bytes) } : { status: 404 });
    });
    await isolateStorage(page);
    await page.goto("/");
    await page.getByTestId("boot-fresh-title").click();
    await expect.poll(async () => (await textHook(page)).textMode).toBe(true);
    await page.locator("canvas.game-surface:visible").click();
    await page.keyboard.press("Space");
    await expect.poll(async () => (await textHook(page)).textMode).toBe(false);
    await waitForCycles(page, 12);
    await openGameOptions(page, "settings-menu");
    await page.getByTestId("btn-start-over").click();
    await expect.poll(async () => (await textHook(page)).textMode).toBe(true);
    const undo = page.getByTestId("btn-undo-start-over");
    await expect(undo).toBeVisible();
    if (refuse) {
      await page.evaluate(() => {
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message, options) {
          if (message.type === "historyViewTake") {
            Worker.prototype.postMessage = post;
            message = { ...message, generation: message.generation + 1 };
          }
          post.call(this, message, options as StructuredSerializeOptions);
        };
      });
      await undo.click();
      await expect(page.getByTestId("history-error")).toBeVisible();
      await expect(undo).toBeVisible();
      await expect.poll(async () => (await textHook(page)).textMode).toBe(true);
    }
    await undo.click();
    await expect.poll(async () => (await textHook(page)).textMode).toBe(false);
    await expect(undo).toBeHidden();
    await expect(page.getByTestId("history-error")).toBeHidden();
    await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  });
}
