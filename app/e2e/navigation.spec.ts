import type { Page } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/archive/zip.ts";
import { gameHint, isolateStorage, textHook, waitForAutosaveAfter } from "./engineProbe.ts";
import { expect, test } from "./test.ts";

test("top navigation groups controls and follows game sound through shortcuts, app toggles and restore", async ({
  page,
}) => {
  const game = createContainer();
  game.putFile("WORDS.TOK", new Uint8Array(52));
  game.putResource("picture", 0, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
    if(!isset(f200)) {
      set(f200); assignn(v10,1); accept.input();
      assignn(v50,0); load.pic(v50); draw.pic(v50); show.pic();
      set.key(0,60,7); set.menu("Options"); set.menu.item("Sound On/Off <F2>",7); submit.menu();
    }
    if(controller(7)){toggle(f9);}
    if(isset(f9)){display(2,2,"GAME SOUND ON ");}else{display(2,2,"GAME SOUND OFF");}
    return;
  `,
      { dictionary: new Map() },
    ).payload,
  );
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "sound-check.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(buildZip([...game.files].map(([name, data]) => ({ name, data })))),
  });
  await page.getByTestId("btn-resume-cached").click();
  const nav = page.getByRole("navigation", { name: "App options" });
  const help = nav.getByTestId("help-menu");
  const settings = nav.getByTestId("settings-menu");
  const exit = nav.getByTestId("btn-exit");
  await expect(nav).toBeVisible();
  await expect(exit).toHaveAccessibleName("Back to library");

  // The map is a top-bar button and read-only assistance the stage's Ask
  // button; Help owns the guide, movement/input help and the walkthrough, with
  // no Look back or record toggle.
  await expect(nav.getByTestId("btn-world-map")).toBeVisible();
  await expect(page.getByTestId("menu-assistant")).toBeVisible();
  await help.click();
  const helpItems = page.getByTestId("help-menu-menu");
  await expect(helpItems.getByTestId("btn-game-controls")).toBeVisible();
  await expect(helpItems.getByTestId("btn-look-back")).toBeHidden();
  await expect(helpItems.getByTestId("btn-record-test")).toBeHidden();

  // Game controls opens the shortcut dialog; the game's own key still works.
  await helpItems.getByTestId("btn-game-controls").click();
  const controlsDialog = page.getByTestId("game-controls");
  await expect(controlsDialog).toBeVisible();
  await controlsDialog.getByRole("button", { name: /Sound On\/Off/ }).click();
  await expect(controlsDialog).toBeHidden();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("GAME SOUND OFF");
  // Its Close button hands the keyboard back to the game, not to the page body.
  await help.click();
  await helpItems.getByTestId("btn-game-controls").click();
  await controlsDialog.getByTestId("controls-close").click();
  await expect(controlsDialog).toBeHidden();
  await expect(page.getByTestId("input-line")).toBeFocused();

  await settings.click();
  // A drawn switch: its state is aria-checked, never "On"/"Off" text.
  const sound = page.getByTestId("toggle-mute");
  await expect(sound).toHaveRole("switch");
  await expect(sound).toHaveAttribute("aria-checked", "false");
  await sound.click();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("GAME SOUND ON");
  await expect(sound).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  // Escape closes the sheet back to its Settings button, as any popover does.
  await expect(settings).toBeFocused();
  await expect(settings).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("F2");
  await settings.click();
  await expect(sound).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await waitForAutosaveAfter(page, (await textHook(page)).cycle);
  await page.reload();
  await expect(await gameHint(page, "resume-caption")).toBeVisible();
  await page.mouse.move(0, 0);
  await settings.click();
  await expect(sound).toHaveAttribute("aria-checked", "false");

  // The sheet's game section is the creator action, the one Download… and
  // Start over — no history or recording entries.
  const gameItems = page
    .getByTestId("settings-menu-menu")
    .getByRole("region", { name: "This game", exact: true });
  await expect(gameItems.getByTestId("btn-edit-game")).toBeVisible();
  await expect(gameItems.getByTestId("btn-download-game")).toBeVisible();
  await expect(gameItems.getByTestId("btn-start-over")).toBeVisible();
  await expect(page.getByTestId("btn-look-back")).toBeHidden();
  await expect(page.getByTestId("btn-record-test")).toBeHidden();
  await expect(gameItems.getByRole("button")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(settings).toHaveAttribute("aria-expanded", "false");

  // The sheet is modal: Tab and Shift+Tab cycle inside it, however far, and
  // never reach the page behind it.
  const sheet = page.getByTestId("settings-menu-menu");
  await settings.click();
  await expect(sheet).toHaveAttribute("aria-modal", "true");
  const focusInSheet = () => sheet.evaluate((element) => element.contains(document.activeElement));
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    expect(await focusInSheet(), `Tab ${i + 1} stays in the sheet`).toBe(true);
  }
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await focusInSheet(), `Shift+Tab ${i + 1} stays in the sheet`).toBe(true);
  }
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(settings).toBeFocused();
  // Escape closes it from anywhere while it is open, and returns focus to the
  // Settings button — here with focus dropped to the page body.
  await settings.click();
  await expect(sheet).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(settings).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("navigation-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  // A menu and the sheet return focus to their trigger.
  for (const [trigger, popup, focus] of [
    [help, page.getByTestId("help-menu-menu"), help],
    [settings, page.getByTestId("settings-menu-menu"), settings],
  ]) {
    await trigger!.click();
    await expect(popup!).toBeInViewport();
    const box = (await popup!.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.keyboard.press("Escape");
    await expect(focus!).toBeFocused();
  }
  await help.click();
  await page.getByTestId("help-menu-menu").getByTestId("btn-game-controls").click();
  await expect(page.getByTestId("game-controls")).toBeInViewport();
  const dialogBox = (await page.getByTestId("game-controls").boundingBox())!;
  expect(dialogBox.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("game-controls")).toBeHidden();
  await settings.click();
  await page.screenshot({ path: test.info().outputPath("navigation-mobile.png") });
  // An outside click on the game command closes the sheet.
  await nav.getByRole("heading").click();
  await expect(settings).toHaveAttribute("aria-expanded", "false");
});

/** A one-room game with the given boot lines, imported as a ZIP and started. */
async function bootZipGame(page: Page, boot: string): Promise<void> {
  const game = createContainer();
  game.putFile("WORDS.TOK", new Uint8Array(52));
  game.putResource("picture", 0, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `if(!isset(f200)) { set(f200); assignn(v10,1); accept.input();
        assignn(v50,0); load.pic(v50); draw.pic(v50); show.pic(); ${boot} }
      if(controller(1)){menu.input();}
      return;`,
      { dictionary: new Map() },
    ).payload,
  );
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "hint-check.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(buildZip([...game.files].map(([name, data]) => ({ name, data })))),
  });
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(2);
}

test("the strip does not offer Esc for a menu Escape does not open", async ({ page }) => {
  await bootZipGame(
    page,
    `set.key(0,60,2); set.menu("Game"); set.menu.item("Sound <F2>",2); submit.menu();`,
  );
  await page.getByTestId("game-keys").hover();
  const help = page.getByTestId("game-key-help");
  await expect(help).toBeVisible();
  await expect(help).toContainText("Arrows or numpad to walk");
  await expect(help).not.toContainText("game menu");
});

test("the strip names Esc as the game menu when Esc opens a submitted menu", async ({ page }) => {
  await bootZipGame(
    page,
    `set.key(27,0,1); set.key(0,60,2); set.menu("Game"); set.menu.item("Sound <F2>",2); submit.menu();`,
  );
  await page.getByTestId("game-keys").hover();
  const help = page.getByTestId("game-key-help");
  await expect(help).toBeVisible();
  await expect(help).toContainText("Esc for the game menu");
});
