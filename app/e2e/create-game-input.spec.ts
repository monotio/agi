import { expect, test } from "./test.ts";
import {
  enterCreateMode,
  isolateStorage,
  textHook,
  waitForCycles,
  waitForRoom,
} from "./engineProbe.ts";

test("creation takes focus and Escape works while its form loads", async ({ page }) => {
  await isolateStorage(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/src/home/LocalProjectForm.vue", async (route) => {
    await held;
    await route.continue();
  });
  try {
    await page.goto("/");
    const create = page.getByTestId("create-adventure-toggle");
    const panel = page.getByTestId("create-adventure-disclosure");
    await create.focus();
    await page.keyboard.press("Enter");
    await expect(panel).toHaveAttribute("open");
    await expect(panel).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).not.toHaveAttribute("open");
    await expect(create).toBeFocused();
    release();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("local-create-title")).toBeFocused();
  } finally {
    release();
  }
});

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
