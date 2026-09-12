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
  const controls = nav.getByTestId("game-controls");
  const settings = nav.getByTestId("settings-menu");
  const actions = nav.getByTestId("game-actions-menu");
  await expect(nav).toBeVisible();
  await controls.locator("summary").click();
  await controls.getByRole("button", { name: /Sound On\/Off/ }).click();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("GAME SOUND OFF");
  await settings.click();
  const sound = page.getByTestId("toggle-mute");
  await expect(sound).toHaveAttribute("aria-checked", "false");
  await expect(sound).toContainText("Sound off");
  await sound.click();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("GAME SOUND ON");
  await expect(sound).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("F2");
  await settings.click();
  await expect(sound).toContainText("Sound off");
  await page.keyboard.press("Escape");
  await waitForAutosaveAfter(page, (await textHook(page)).cycle);
  await page.reload();
  await expect(page.getByTestId("resume-caption")).toBeVisible();
  await settings.click();
  await expect(sound).toContainText("Sound off");
  await expect(page.getByTestId("btn-start-over")).toBeHidden();
  await actions.click();
  await expect(settings).toHaveAttribute("aria-expanded", "false");
  const gameActions = page.getByTestId("game-actions-menu-menu");
  await expect(gameActions.getByTestId("btn-start-over")).toBeVisible();
  await expect(gameActions.getByTestId("btn-record-test")).toBeVisible();
  await expect(gameActions.getByTestId("btn-export-live-zip")).toBeVisible();
  await expect(gameActions.getByTestId("btn-save-live-project")).toBeVisible();
  await expect(gameActions.getByTestId("menu-assistant")).toBeVisible();
  await expect(gameActions.getByRole("menuitem")).toHaveCount(5);
  await page.screenshot({ path: test.info().outputPath("navigation-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [trigger, popup] of [
    [controls.locator("summary"), controls.locator(".game-controls-panel")],
    [settings, page.getByTestId("settings-menu-menu")],
    [actions, gameActions],
  ]) {
    await trigger!.click();
    await expect(popup!).toBeInViewport();
    const box = (await popup!.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.keyboard.press("Escape");
    await expect(trigger!).toBeFocused();
  }
  await settings.click();
  await page.screenshot({ path: test.info().outputPath("navigation-mobile.png") });
  await page.getByRole("heading", { name: "AGI IS HERE", exact: true }).click();
  await expect(settings).toHaveAttribute("aria-expanded", "false");
});
