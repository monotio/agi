import { expect, test } from "./test.ts";
import {
  enterCreateMode,
  isolateStorage,
  textHook,
  waitForCycles,
  waitForRoom,
} from "./engineProbe.ts";

test("the game command input keeps its keys while Create commands load", async ({ page }) => {
  await isolateStorage(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route("**/src/shell/commands/CreateKeyboard.vue", async (route) => {
    requests++;
    await held;
    await route.continue();
  });
  try {
    await page.goto("/");
    await page.getByTestId("catalog-play-adventure-department").click();
    await waitForRoom(page, 1, { coldBoot: true });
    await enterCreateMode(page);
    await expect.poll(() => requests).toBe(1);
    await waitForCycles(page, 2);
    const from = (await textHook(page)).egoX;
    await page.getByTestId("input-line").focus();
    await page.keyboard.down("ArrowRight");
    await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(from + 4);
    await page.keyboard.up("ArrowRight");
  } finally {
    release();
  }
});
