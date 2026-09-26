import { expect, test } from "./test.ts";
import {
  isolateStorage,
  openGameOptions,
  textHook,
  waitForAutosaveAfter,
  waitForCycles,
} from "./engineProbe.ts";

/**
 * The 1.1 shell: a loaded game is shown in Play or Create, the URL names the
 * mode, Back and Forward move between them, and the Play stage gives the game
 * the largest whole multiple of its 320×200 frame.
 */
test.use({ viewport: { width: 1440, height: 900 } });

async function bootTutorial(page: Parameters<typeof textHook>[0]): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
}

const surfaceBox = async (page: Parameters<typeof textHook>[0]) =>
  (await page.locator(".game-surface:visible").boundingBox())!;

test("Play fits the game to a whole multiple of the frame and the Ask drawer resizes it", async ({
  page,
}) => {
  await bootTutorial(page);
  // 900 rows less the 52 px bar and the 48 px strip leave exactly 800: 4×.
  expect(await surfaceBox(page)).toMatchObject({ width: 1280, height: 800 });
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("toggle-original-aspect").click();
  // 4:3 needs 240 rows per step: 800 rows hold 3× (960×720).
  await expect.poll(async () => (await surfaceBox(page)).width).toBe(960);
  expect((await surfaceBox(page)).height).toBe(720);
  await page.getByTestId("toggle-original-aspect").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("input-line")).toBeFocused();

  // Ask is a non-modal drawer: the game stays visible beside it at 3×, and
  // Play offers no Remix.
  const ask = page.getByTestId("menu-assistant");
  await ask.click();
  const drawer = page.getByTestId("agent-bubble");
  await expect(drawer).toBeVisible();
  await expect(ask).toHaveAttribute("aria-expanded", "true");
  await expect(drawer.getByTestId("agent-mode-remix")).toHaveCount(0);
  await expect(drawer.getByTestId("btn-record-test")).toHaveCount(0);
  await expect.poll(async () => (await surfaceBox(page)).width).toBe(960);
  const game = await surfaceBox(page);
  const side = (await drawer.boundingBox())!;
  expect(game.x + game.width).toBeLessThanOrEqual(side.x);
  await drawer.getByTestId("agent-bubble-close").click();
  await expect(drawer).toBeHidden();
  await expect(page.getByTestId("input-line")).toBeFocused();
  await expect.poll(async () => (await surfaceBox(page)).width).toBe(1280);
});

test("Create is a route: Back and Forward switch modes and a reload keeps Create", async ({
  page,
}) => {
  await bootTutorial(page);
  const play = page.getByRole("radio", { name: "Play", exact: true });
  const create = page.getByRole("radio", { name: "Create", exact: true });
  await expect(page).toHaveURL(/#play\/[^/]+$/);
  const target = new URL(page.url()).hash.slice("#play/".length);

  await create.click();
  await expect(page).toHaveURL(new RegExp(`#create/${target}$`));
  await expect(page.getByTestId("create-dock-left")).toBeVisible();
  await expect(page.getByTestId("dock-tab-world")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("dock-tab-assistant")).toHaveAttribute("aria-selected", "true");
  // The catalog tutorial is read-only: the first edit forks a remix.
  await expect(page.getByTestId("create-read-only")).toBeVisible();
  await expect(page.getByTestId("power-up")).toBeVisible();
  await expect(page.getByTestId("menu-assistant")).toHaveCount(0);
  // The same live stage sits in the centre: the game keeps running.
  const cycle = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#play/${target}$`));
  await expect(play).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("create-dock-left")).toHaveCount(0);
  await expect(page.getByTestId("input-line")).toBeFocused();
  await page.goForward();
  await expect(create).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("create-dock-left")).toBeVisible();

  await waitForAutosaveAfter(page, (await textHook(page)).cycle);
  await page.reload();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 20_000 }).toBe(1);
  await expect(page).toHaveURL(new RegExp(`#create/${target}$`));
  await expect(page.getByRole("radio", { name: "Create", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("keys typed on the shell chrome never reach the game's parser", async ({ page }) => {
  await bootTutorial(page);
  const input = page.getByTestId("input-line");
  await page.getByRole("radio", { name: "Play", exact: true }).focus();
  await page.keyboard.type("look");
  await expect(input).toHaveValue("");
  expect((await textHook(page)).rows.join(" ")).not.toContain("look");
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  await page.getByTestId("dock-tab-world").focus();
  await page.keyboard.type("look");
  await expect(input).toHaveValue("");
  // Back in Play, the keyboard belongs to the game again.
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect(input).toBeFocused();
  await page.keyboard.type("look");
  await expect(input).toHaveValue("look");
});
