import { test, expect } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { buildZip } from "../src/zip.ts";
import { isolateStorage, textHook, waitForAutosaveAfter } from "./engineProbe.ts";

function cartridge(shortcuts: boolean, scrollLock = false) {
  const game = createContainer();
  game.putResource("picture", 0, new Uint8Array([0xf0, 0, 0xf8, 0, 0, 0xff]));
  const dictionary = new Map([["look", 1]]);
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
  if (!isset(f200)) {set(f200);assignn(v10,1);accept.input();
   assignn(v51,0);load.pic(v51);draw.pic(v51);show.pic();
   display(2,2,"A courtyard of possibilities.");
   ${shortcuts ? 'set.key(0,61,7);set.key(0,62,9);set.key(0,66,8);set.key(0,68,10);set.menu("Adventure");set.menu.item("Inspect    F3",7);set.menu.item("Repeat command    F10",10);submit.menu();' : ""}
   ${scrollLock ? "set.key(0,70,11);set(f10);" : ""}
  }
  if(controller(7)) {display(3,2,"INSPECTED");disable.item(7);}
  if(controller(9)) {enable.item(7);}
  if(controller(8)) {display(3,2,"UNLABELLED KEY");}
  if(controller(10)) {echo.line();}
  ${scrollLock ? 'if(controller(11)) {increment(v52);display(5,2,"Scroll count %v52");}' : ""}
  if(said("look")) {increment(v50);display(4,2,"Look count %v50");}
  return;`,
      { dictionary },
    ).payload,
  );
  return Buffer.from(
    buildZip(
      [...game.files]
        .map(([name, data]) => ({ name, data }))
        .concat([{ name: "WORDS.TOK", data: buildWordsTok([{ word: "look", id: 1 }]) }]),
    ),
  );
}

test("game controls discover bindings and menu labels, track disabled items, and let game logic own F3 and repeat", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await page
    .getByTestId("game-zip-input")
    .setInputFiles({ name: "courtyard.zip", mimeType: "application/zip", buffer: cartridge(true) });
  const controls = page.getByTestId("game-controls");
  await expect(controls).toBeVisible();
  await expect(page.getByTestId("game-toolbar")).toHaveCount(0);
  await page.getByTestId("input-line").fill("look");
  await page.getByTestId("input-line").press("Enter");
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Look count 1");
  await controls.locator("summary").click();
  await expect(controls.getByRole("button")).toHaveCount(4);
  await expect(controls.getByRole("button", { name: "Inspect F3", exact: true })).toBeEnabled();
  await expect(controls.getByRole("button", { name: "F8", exact: true })).toBeVisible();
  await expect(controls).not.toContainText("Save");
  await controls.getByRole("button", { name: "Inspect F3", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("INSPECTED");
  await expect(page.getByTestId("input-line")).toHaveValue("");
  await controls.locator("summary").click();
  await expect(controls.getByRole("button", { name: "Inspect F3", exact: true })).toBeDisabled();
  await controls.getByRole("button", { name: "F4", exact: true }).click();
  await controls.locator("summary").click();
  await expect(controls.getByRole("button", { name: "Inspect F3", exact: true })).toBeEnabled();
  await page.screenshot({ path: "test-results/game-controls-desktop.png" });
  await page.keyboard.press("Escape");
  await expect(controls).not.toHaveAttribute("open");
  await expect(controls.locator("summary")).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(controls.getByRole("button", { name: "Inspect F3", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(controls.getByRole("button", { name: "Inspect F3", exact: true })).toBeInViewport();
  await page.screenshot({ path: "test-results/game-controls-mobile.png" });
  await controls.getByRole("button", { name: "Repeat command F10", exact: true }).click();
  await expect(page.getByTestId("input-line")).toHaveValue("look");
  await page.getByTestId("input-line").press("Enter");
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Look count 2");
  await page.getByTestId("btn-eject").click();
  await page
    .getByTestId("game-zip-input")
    .setInputFiles({ name: "quiet.zip", mimeType: "application/zip", buffer: cartridge(false) });
  await controls.locator("summary").click();
  await expect(controls.getByRole("button")).toHaveCount(0);
  await expect(controls).toContainText("Shortcuts appear here");
  await controls.locator("summary").click();
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("input-line")).not.toBeFocused();
});

test("mapped Scroll Lock controls advertise and invoke the script controller", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "scroll-controller.zip",
    mimeType: "application/zip",
    buffer: cartridge(false, true),
  });
  const controls = page.getByTestId("game-controls");
  for (const [count, viewport] of [
    [1, { width: 1280, height: 900 }],
    [2, { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    await controls.locator("summary").click();
    await expect(controls.getByRole("button")).toHaveCount(1);
    await expect(controls).not.toContainText("Show trace");
    await controls.getByRole("button", { name: "Scroll Lock", exact: true }).click();
    await expect
      .poll(async () => (await textHook(page)).rows.join(" "))
      .toContain(`Scroll count ${count}`);
    await page.screenshot({ path: test.info().outputPath(`mapped-scroll-${count}.png`) });
  }
});

test("browser reload restores shortcut labels and live menu enable state", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "courtyard.zip",
    mimeType: "application/zip",
    buffer: cartridge(true),
  });
  const controls = page.getByTestId("game-controls");
  await controls.locator("summary").click();
  await controls.getByRole("button", { name: "Inspect F3", exact: true }).click();
  await controls.locator("summary").click();
  await expect(controls.getByRole("button", { name: "Inspect F3", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await waitForAutosaveAfter(page, (await textHook(page)).cycle);
  await page.reload();
  await expect(page.getByTestId("resume-caption")).toBeVisible();
  await controls.locator("summary").click();
  await expect(controls.getByRole("button", { name: "Inspect F3", exact: true })).toBeDisabled();
  await expect(
    controls.getByRole("button", { name: "Repeat command F10", exact: true }),
  ).toBeEnabled();
  await controls.getByRole("button", { name: "F4", exact: true }).click();
  await controls.locator("summary").click();
  await expect(controls.getByRole("button", { name: "Inspect F3", exact: true })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("restored-game-controls.png") });
});
