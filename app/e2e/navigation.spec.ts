import { test, expect } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/zip.ts";
import { isolateStorage, textHook, waitForAutosaveAfter } from "./engineProbe.ts";

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
  const gameMenu = nav.getByTestId("game-menu");
  const exit = nav.getByTestId("btn-exit");
  await expect(nav).toBeVisible();
  await expect(exit).toHaveAccessibleName("Exit to game selection");

  // Help owns movement/input help, the map, read-only assistance and the
  // walkthrough; the ordinary Game menu has no Look back or record toggle.
  await help.click();
  const helpItems = page.getByTestId("help-menu-menu");
  await expect(helpItems.getByTestId("btn-game-controls")).toBeVisible();
  await expect(helpItems.getByTestId("btn-world-map")).toBeVisible();
  await expect(helpItems.getByTestId("menu-assistant")).toBeVisible();
  await expect(helpItems.getByTestId("btn-look-back")).toBeHidden();
  await expect(helpItems.getByTestId("btn-record-test")).toBeHidden();

  // Game controls opens the shortcut dialog; the game's own key still works.
  await helpItems.getByTestId("btn-game-controls").click();
  const controlsDialog = page.getByTestId("game-controls");
  await expect(controlsDialog).toBeVisible();
  await controlsDialog.getByRole("button", { name: /Sound On\/Off/ }).click();
  await expect(controlsDialog).toBeHidden();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("GAME SOUND OFF");

  await settings.click();
  const sound = page.getByTestId("toggle-mute");
  const soundValue = sound.locator(".setting-value");
  await expect(sound).toHaveAttribute("aria-checked", "false");
  await expect(soundValue).toHaveText("Off");
  await sound.click();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("GAME SOUND ON");
  await expect(sound).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("F2");
  await settings.click();
  await expect(soundValue).toHaveText("Off");
  await page.keyboard.press("Escape");
  await waitForAutosaveAfter(page, (await textHook(page)).cycle);
  await page.reload();
  await expect(page.getByTestId("resume-caption")).toBeVisible();
  await settings.click();
  await expect(soundValue).toHaveText("Off");
  await expect(page.getByTestId("btn-start-over")).toBeHidden();
  await page.keyboard.press("Escape");

  // The Game menu is creator/export actions plus Start over — no history or
  // recording entries.
  await gameMenu.click();
  const gameItems = page.getByTestId("game-menu-menu");
  await expect(gameItems.getByTestId("btn-edit-game")).toBeVisible();
  await expect(gameItems.getByTestId("btn-download-game")).toBeVisible();
  await expect(gameItems.getByTestId("btn-export-game")).toBeVisible();
  await expect(gameItems.getByTestId("btn-start-over")).toBeVisible();
  await expect(gameItems.getByTestId("btn-look-back")).toBeHidden();
  await expect(gameItems.getByTestId("btn-record-test")).toBeHidden();
  await expect(gameItems.getByRole("menuitem")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(settings).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({ path: test.info().outputPath("navigation-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [trigger, popup] of [
    [help, page.getByTestId("help-menu-menu")],
    [settings, page.getByTestId("settings-menu-menu")],
    [gameMenu, page.getByTestId("game-menu-menu")],
  ]) {
    await trigger!.click();
    await expect(popup!).toBeInViewport();
    const box = (await popup!.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.keyboard.press("Escape");
    await expect(trigger!).toBeFocused();
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
  await page.getByRole("heading", { name: "AGI IS HERE", exact: true }).click();
  await expect(settings).toHaveAttribute("aria-expanded", "false");
});
