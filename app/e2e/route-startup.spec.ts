import { test, expect } from "./test.ts";
import { isolateStorage } from "./engineProbe.ts";

test("a game route resolves before Home starts its card previews", async ({ page }) => {
  await isolateStorage(page);
  let release!: () => void;
  let requested!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const discovery = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/fixtures/", async (route) => {
    requested();
    await held;
    await route.fulfill({ json: [] });
  });
  try {
    await page.goto("/#play/unavailable-game");
    await discovery;
    await expect(page.getByTestId("game-zip-drop")).toBeHidden();
    release();
    await expect(page.getByTestId("game-zip-drop")).toBeVisible();
    await expect(page.getByTestId("route-note")).toHaveText("That game isn't in this browser.");
  } finally {
    release();
  }
});
