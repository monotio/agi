import { expect, test, type Page } from "@playwright/test";
import {
  isolateStorage,
  openDeveloperActivity,
  probe,
  screenText,
  textHook,
  waitForCycles,
} from "./engineProbe.ts";

/**
 * Proof of the base template's Sierra chrome in the real browser: the menu
 * bar, the save/restore selectors and the shared death box all live on the
 * engine's text surface, driven by the fixed logic 0 / logic 255 the harness
 * installs at genesis. No fixture needed — the stub agent authors the game.
 */

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
});

async function bootAgentGame(page: Page): Promise<void> {
  await page.goto("/");
  await openDeveloperActivity(page);
  await page.getByTestId("boot-agent").click();
  await expect(page.getByTestId("input-line")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("agent-panel")).toContainText("assembled room 1", {
    timeout: 30_000,
  });
  await expect.poll(async () => (await probe(page)).frame, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect
    .poll(async () => (await textHook(page)).cycle, { timeout: 20_000 })
    .toBeGreaterThan(0);
  // Room 1's entry description is a print window; acknowledge it.
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).modal, { timeout: 5_000 }).toBe(null);
}

async function expectModal(page: Page, kind: string | null, timeout = 10_000): Promise<void> {
  await expect.poll(async () => (await textHook(page)).modal, { timeout }).toBe(kind);
}

async function typeCommand(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("input-line");
  await input.focus();
  await input.fill(text);
  await input.press("Enter");
}

test("the template menu bar drives save and restore on the text surface", async ({ page }) => {
  await bootAgentGame(page);

  // ESC is bound to the menu controller: the bar and the open File column
  // render as engine text, not DOM.
  await page.keyboard.press("Escape");
  await expectModal(page, "menu");
  const bar = await screenText(page);
  for (const word of ["File", "Speed", "Sound", "Help"]) expect(bar).toContain(word);
  for (const item of ["Save Game", "Restore Game", "Restart Game", "Quit"])
    expect(bar).toContain(item);

  // Save Game is the File column's first item: ENTER fires its controller.
  await page.keyboard.press("Enter");
  await expectModal(page, "save");

  // Pick the first slot, name it, confirm the engine's "Save in slot?" line.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("prompt-hint")).toBeVisible();
  await page.getByTestId("input-line").fill("Checkpoint");
  await page.keyboard.press("Enter");
  await expect.poll(() => screenText(page)).toContain("Save in slot 1?");
  await expect.poll(() => screenText(page)).toContain("Checkpoint");
  await page.keyboard.press("Enter");
  await expectModal(page, null);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            Object.keys(JSON.parse(localStorage.getItem("monotio_agi.saves.custom") ?? "{}").slots)
              .length,
        ),
      { timeout: 15_000 },
    )
    .toBe(1);

  // Restore through the same menu: File column, second item.
  await page.keyboard.press("Escape");
  await expectModal(page, "menu");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expectModal(page, "restore");
  await expect.poll(() => screenText(page)).toContain("Checkpoint");
  await page.keyboard.press("Enter");
  await expectModal(page, null);
  await expect(page.getByTestId("agent-panel")).toContainText(
    "Restoring saved game from local storage",
  );
  // The world is alive after the restore: cycles advance again.
  await waitForCycles(page, 2);
});

test("the death box offers restore, restart and quit on the text surface", async ({ page }) => {
  await bootAgentGame(page);

  // The stub room wires said("die") to call(255): the shared death logic
  // stops movement, plays the sting and redraws its box every cycle while
  // the dead flag is set — no modal, the interpreter keeps running.
  await typeCommand(page, "die");
  await expect.poll(() => screenText(page), { timeout: 10_000 }).toContain("You have died.");
  await expect.poll(() => screenText(page)).toContain("1-3, SPACE, ENTER");
  for (const choice of ["Restore", "Restart", "Quit"])
    expect(await screenText(page)).toContain(choice);
  await expectModal(page, null);

  // Choice 3 is Quit: the engine's own confirmation window opens over the
  // box, and ESC declines back to the still-dead world.
  await page.keyboard.press("3");
  await expect.poll(() => screenText(page)).toContain("Quit the game?");
  await page.keyboard.press("Escape");
  await expect.poll(() => screenText(page)).toContain("You have died.");

  // Choice 1 is Restore: the real selector opens and ESC cancels it; the box
  // redraws, still dead — a cancelled selector never strands the player.
  await page.keyboard.press("1");
  await expectModal(page, "restore");
  await page.keyboard.press("Escape");
  await expectModal(page, null);
  await expect.poll(() => screenText(page)).toContain("You have died.");

  // Choice 2 is Restart: f16 bypasses the prompt, the world reboots into
  // room 1 and its entry description prints again.
  await page.keyboard.press("2");
  await expectModal(page, "print");
  await expect.poll(() => screenText(page)).toContain("generated room 1");
  await page.keyboard.press("Enter");
  await expectModal(page, null);
  await waitForCycles(page, 2);
});
