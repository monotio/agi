import { test, expect } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test.describe(`viewport ${width}`, () => {
    test.use({ hasTouch: width === 390 });
    test(`play strip stays still at ${width} @webkit-desktop`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await isolateStorage(page);
      await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
      await page.addInitScript(() => {
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message, transfer) {
          post.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
          if (message.type === "boot") {
            this.postMessage({ type: "pause", paused: true });
            Object.assign(window, {
              releasePlaybarBoot: () => this.postMessage({ type: "pause", paused: false }),
            });
          }
        };
      });
      await page.goto("/");
      await page.getByRole("button", { name: "Play the tutorial" }).click();
      await page.waitForURL(/#play\//);
      const input = page.locator("#game-command");
      await expect(input).toBeVisible();
      await expect(input).toBeDisabled();
      await input.focus();
      await page.evaluate(() =>
        (window as unknown as { releasePlaybarBoot: () => void }).releasePlaybarBoot(),
      );
      await expect(input).toBeEnabled();
      await input.focus();
      await expect(input).toBeFocused();
      await expect.poll(async () => (await textHook(page)).room).toBe(1);
      await expect.poll(async () => (await textHook(page)).frame).toBeGreaterThan(0);
      await page.screenshot({ path: test.info().outputPath(`${width}-walking.png`) });
      const keys = page.getByTestId("game-keys");
      await expect(keys).toBeVisible();
      await expect(keys).toHaveText("Keys go to the game");
      const geometry = async () => ({
        bar: await page.locator(".play-strip").boundingBox(),
        dot: await keys.locator(".led").boundingBox(),
        surface: await page.locator(".screen").boundingBox(),
      });
      const walking = await geometry();
      await page.keyboard.press("F1");
      await expect.poll(async () => (await textHook(page)).modal).not.toBeNull();
      await page.screenshot({ path: test.info().outputPath(`${width}-message.png`) });
      await expect(input).toBeFocused();
      await expect(keys).toHaveText("Keys go to the game");
      expect(await geometry()).toEqual(walking);
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await textHook(page)).modal).toBeNull();
      await page.keyboard.press("Escape");
      await expect.poll(async () => (await textHook(page)).modal).toBe("menu");
      await page.screenshot({ path: test.info().outputPath(`${width}-menu.png`) });
      await expect(input).toBeFocused();
      await expect(keys).toHaveText("Keys go to the game");
      expect(await geometry()).toEqual(walking);
      await keys.hover();
      const help = page.getByTestId("game-key-help");
      await expect(help).toBeVisible();
      await expect(help.locator("p").first()).toHaveText(
        "Game menu: arrows to move, Enter to choose, Esc to close",
      );
      await expect(help).toContainText("Type to talk");
      await expect(help).toContainText("Arrows or numpad to walk");
      await expect(help).toContainText("Enter answers a message");
      await expect(help).toContainText("Esc for the game menu");
      await expect(help).toContainText("Shift+Tab leaves the game");
      await page.screenshot({ path: test.info().outputPath(`${width}-help.png`) });
      expect(await geometry()).toEqual(walking);
      await page.mouse.move(0, 0);
      await expect(help).toBeHidden();
      await keys.click();
      await expect(help).toBeVisible();
      await help.getByRole("button", { name: "Close", exact: true }).click();
      await expect(help).toBeHidden();
      await input.focus();
      await page.keyboard.press("Escape");
      await expect.poll(async () => (await textHook(page)).modal).toBeNull();
      await page.keyboard.press("F1");
      await expect.poll(async () => (await textHook(page)).modal).not.toBeNull();
      await page.getByTestId("menu-assistant").focus();
      await page.keyboard.press("Shift+Tab");
      await expect(keys).toBeFocused();
      await expect(keys).toHaveText("Click the game to play");
      expect(await geometry()).toEqual(walking);
      await page.keyboard.press("Enter");
      await expect(help).toBeVisible();
      await expect(help.locator("p").first()).toHaveText(
        "A message is open: press Enter to continue",
      );
      await page.screenshot({ path: test.info().outputPath(`${width}-message-help.png`) });
      await page.keyboard.press("Escape");
      await expect(help).toBeHidden();
      await expect.poll(async () => (await textHook(page)).modal).not.toBeNull();
      await page.screenshot({ path: test.info().outputPath(`${width}-unfocused.png`) });
      await input.focus();
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await textHook(page)).modal).toBeNull();
      const x = (await textHook(page)).egoX;
      await page.keyboard.press("ArrowRight");
      await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(x);
      expect(await geometry()).toEqual(walking);
      for (const state of ["walking", "message", "menu", "help", "message-help", "unfocused"]) {
        await test.info().attach(`${width}-${state}-after.png`, {
          path: test.info().outputPath(`${width}-${state}.png`),
          contentType: "image/png",
        });
      }
    });
  });
}
