/**
 * Amiga restart/quit confirmations offer two gadgets (Restart / Cancel,
 * Quit / Continue; docs/fidelity.md F-persistence-05). A mouse click or a
 * touch tap on a gadget performs its choice through the real screen mapping
 * (canvas rectangle and CRT geometry). The game maps F1 to restart.game and
 * F2 to quit(0) and writes a word on the text surface for each outcome.
 * Gadget pixels, from the engine's layout with display base 1: the gadget
 * rows are y 91..102; Restart spans x 88..151, Cancel x 168..223, Quit
 * x 48..87 and Continue x 192..263.
 */
import { test, expect } from "./test.ts";
import type { Page } from "@playwright/test";
import { isolateStorage, textHook, waitForCycles } from "./engineProbe.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/archive/zip.ts";

test.use({ keepDetectedProfileOption: false });

const PROFILE = "amiga-2.316";
const RESTART = { x: 119, y: 96 };
const CANCEL = { x: 195, y: 96 };
const QUIT = { x: 67, y: 96 };
const CONTINUE = { x: 227, y: 96 };

function confirmGame(): Buffer {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
         set(f200);
         configure.screen(1, 22, 0);
         load.pic(v250); draw.pic(v250); show.pic();
         set.key(0, 59, 1); set.key(0, 60, 2);
         if (isset(f6)) { display(2, 0, "RESTARTED"); display(3, 0, "         "); } else { display(2, 0, "READY"); }
       }
       if (controller(c1)) { restart.game(); display(3, 0, "CANCELLED"); }
       if (controller(c2)) { quit(0); display(3, 0, "CONTINUED"); }
       return;`,
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource("picture", 0, Uint8Array.of(0xff));
  game.putFile("WORDS.TOK", new Uint8Array(52));
  const files = [...game.files].map(([name, data]) => ({ name, data }));
  return Buffer.from(buildZip(files));
}

async function bootConfirmGame(page: Page, name: string): Promise<void> {
  await isolateStorage(page);
  await page.addInitScript(() => localStorage.setItem("monotio_agi.crtAmount", "0"));
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: `${name}.zip`,
    mimeType: "application/zip",
    buffer: confirmGame(),
  });
  const picker = page.getByTestId("profile-picker-dialog");
  await expect(picker).toBeVisible();
  await page.getByTestId("profile-picker-select").selectOption(PROFILE);
  await page.getByTestId("profile-picker-confirm").click();
  await expect(picker).toBeHidden();
  await page
    .locator("[data-testid^='saved-game-card-']", { hasText: name })
    .getByTestId("btn-resume-cached")
    .click();
  await expect.poll(async () => (await textHook(page)).profile).toBe(PROFILE);
  await expect.poll(async () => (await textHook(page)).rows[2] ?? "").toContain("READY");
  await waitForCycles(page, 2);
}

/** The page position of frame pixel (x, y), offset by half a pixel so the floor lands on it. */
async function framePoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.locator(".screen").boundingBox();
  if (!box) throw new Error("no visible game surface");
  return {
    x: box.x + ((x + 0.5) * box.width) / 320,
    y: box.y + ((y + 0.5) * box.height) / 200,
  };
}

async function openConfirmation(page: Page, key: "F1" | "F2", prompt: string): Promise<void> {
  await page.locator(".screen").click();
  await page.keyboard.press(key);
  await expect.poll(async () => (await textHook(page)).modal).toBe("print");
  await expect.poll(async () => (await textHook(page)).rows[9] ?? "").toContain(prompt);
}

async function expectRow(page: Page, row: number, word: string): Promise<void> {
  await expect.poll(async () => (await textHook(page)).rows[row] ?? "").toContain(word);
}

for (const pointer of ["mouse", "touch"] as const) {
  test.describe(pointer === "touch" ? "by touch" : "by mouse", () => {
    if (pointer === "touch") test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

    async function select(page: Page, at: { x: number; y: number }): Promise<void> {
      const point = await framePoint(page, at.x, at.y);
      if (pointer === "touch") await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
    }
    const tag = pointer === "touch" ? " @phone" : "";

    test(`Restart restarts and Cancel keeps the game${tag}`, async ({ page }) => {
      if (pointer === "touch")
        await page.addInitScript(() => localStorage.setItem("monotio_agi.touchControls", "on"));
      await bootConfirmGame(page, `confirm-restart-${pointer}`);

      await openConfirmation(page, "F1", "Restart the game?");
      await select(page, CANCEL);
      await expect.poll(async () => (await textHook(page)).modal).toBe(null);
      await expectRow(page, 3, "CANCELLED");

      await openConfirmation(page, "F1", "Restart the game?");
      await select(page, RESTART);
      await expectRow(page, 2, "RESTARTED");
      expect((await textHook(page)).rows[3] ?? "").not.toContain("CANCELLED");
    });

    test(`Quit leaves the game and Continue keeps it${tag}`, async ({ page }) => {
      if (pointer === "touch")
        await page.addInitScript(() => localStorage.setItem("monotio_agi.touchControls", "on"));
      await bootConfirmGame(page, `confirm-quit-${pointer}`);

      await openConfirmation(page, "F2", "Quit the game, or continue?");
      await select(page, CONTINUE);
      await expect.poll(async () => (await textHook(page)).modal).toBe(null);
      await expectRow(page, 3, "CONTINUED");

      await openConfirmation(page, "F2", "Quit the game, or continue?");
      await select(page, QUIT);
      // An accepted quit sends the player Home: the library shows the game again.
      await expect(
        page.locator("[data-testid^='saved-game-card-']", { hasText: `confirm-quit-${pointer}` }),
      ).toBeVisible();
    });
  });
}
