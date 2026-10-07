import { test, expect } from "./test.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { testProjectId } from "../test/identity.ts";
import { cacheGame, isolateStorage, textHook } from "./engineProbe.ts";

test("message key help describes the open window before words inside it", async ({ page }) => {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic(
      'if (!isset(f200)) { set(f200); accept.input(); print("Press any key to continue."); } return;',
      { dictionary: new Map() },
    ).payload,
  );
  await isolateStorage(page);
  await page.goto("/");
  await cacheGame(page, {
    projectId: testProjectId("message-key-help"),
    title: "Waiting message",
    provider: "stub",
    model: "local-playback",
    imported: true,
    roomGeneration: false,
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).modal).toBe("print");
  await page.locator("#game-command").focus();
  const keys = page.getByTestId("game-keys");
  await expect(keys).toBeVisible();
  await expect(keys).toHaveText("Keys go to the game");
  await keys.hover();
  const help = page.getByTestId("game-key-help");
  await expect(help).toBeVisible();
  await expect(help.locator("p").first()).toHaveText("A message is open: press Enter to continue");
});

test("key help closes when keyboard focus moves to a page control", async ({ page }) => {
  await isolateStorage(page);
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "Play the tutorial" }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("game-keys").hover();
  const help = page.getByTestId("game-key-help");
  await expect(help).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).focus();
  await expect(help).toBeHidden();
  await page.keyboard.press("Enter");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
});
