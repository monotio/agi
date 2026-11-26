/**
 * Player-visible original .SAV import/export dialog under Settings -> This game:
 * pause/resume lifecycle, real download bytes, DOS-style filename import,
 * reload durability via flushed autosave, failure alerts, Create-mode guard,
 * 2.001 booter refusal, and narrow phone layout.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "./test.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { PROFILES, type ProfileId } from "../../src/runtime/profile.ts";
import { decodeOriginalSav } from "../../src/runtime/savFile.ts";
import { buildZip } from "../src/archive/zip.ts";
import {
  enterCreateMode,
  isolateStorage,
  openGameOptions,
  savedGameCard,
  textHook,
} from "./engineProbe.ts";

test.use({ keepDetectedProfileOption: false });

function buildSyntheticZip(profileId: ProfileId = "2.936"): Buffer {
  const profile = PROFILES[profileId];
  const game = createContainer();
  game.putResource("picture", 0, Uint8Array.of(0xf0, 1, 0xff));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
      if (!isset(f200)) {
        set(f200);
        set.game.id("DEMO");
        load.pic(v0);
        draw.pic(v0);
        show.pic();
        set.key(0, 59, 1);
        assignn(v100, 11);
        display(8, 0, "READY");
      }
      if (isset(f12)) {
        display(10, 0, "RESTORED");
        if (equaln(v100, 11)) { display(11, 0, "STATE 11"); }
        if (equaln(v100, 99)) { display(11, 0, "STATE 99"); }
        return;
      }
      if (controller(c1)) {
        assignn(v100, 99);
        display(10, 0, "CHANGED");
      }
      return;`,
      { dictionary: new Map(), profile },
    ).payload,
  );
  game.putFile("WORDS.TOK", new Uint8Array(52));
  return Buffer.from(buildZip([...game.files].map(([name, data]) => ({ name, data }))));
}

async function importAndLaunch(
  page: Parameters<typeof textHook>[0],
  name: string,
  profile: ProfileId = "2.936",
) {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: `${name}.zip`,
    mimeType: "application/zip",
    buffer: buildSyntheticZip(profile),
  });
  await expect(page.getByTestId("profile-picker-dialog")).toBeVisible();
  if (profile === "2.936") {
    await page.getByTestId("profile-picker-keep").click();
  } else {
    await page.getByTestId("profile-picker-select").selectOption(profile);
    await page.getByTestId("profile-picker-confirm").click();
  }
  await savedGameCard(page, name).getByTestId("btn-resume-cached").click();
  const rows = async () => (await textHook(page)).rows.join("\n");
  await expect.poll(rows).toContain("READY");
  return { rows };
}

test("export .SAV, import DOS-named save, persist across reload, and surface errors @webkit-desktop", async ({
  page,
}) => {
  const { rows } = await importAndLaunch(page, "sav-roundtrip");

  // Opening Save files… pauses the running game; Done resumes it and returns focus to Settings.
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-save-files").click();
  const dialog = page.getByTestId("save-files-dialog");
  await expect(dialog).toBeVisible();
  await expect.poll(async () => (await textHook(page)).paused).toBe(true);

  await page.getByTestId("sav-description").fill("Courtyard");
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("sav-export-btn").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("sav-roundtrip.sav");
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const exportedBytes = new Uint8Array(readFileSync(downloadPath!));
  const decoded = decodeOriginalSav(exportedBytes, PROFILES["2.936"]);
  expect(decoded.description).toBe("Courtyard");
  await expect(page.getByTestId("sav-status")).toContainText("Downloaded sav-roundtrip.sav.");
  await page.screenshot({ path: test.info().outputPath("save-files-dialog.png") });

  await page.getByTestId("sav-done").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("settings-menu")).toBeFocused();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);

  // Advance game state so v100 becomes 99 and screen shows CHANGED.
  await page.locator(".screen").click();
  await page.keyboard.press("F1");
  await expect.poll(rows).toContain("CHANGED");

  // Reopen Save files…: importing a corrupt or oversized file shows an inline alert and leaves game untouched.
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-save-files").click();
  await expect(dialog).toBeVisible();
  await page.getByTestId("sav-import-input").setInputFiles({
    name: "TOO_BIG.sav",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(300 * 1024),
  });
  await expect(page.getByTestId("sav-error")).toContainText("256 KB");
  await page.getByTestId("sav-import-input").setInputFiles({
    name: "BROKENSG.1",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
  });
  await expect(page.getByTestId("sav-error")).toBeVisible();
  expect(await rows()).toContain("CHANGED");

  // Import the valid exported bytes using a classic DOS Sierra filename (no .sav extension).
  await page.getByTestId("sav-import-input").setInputFiles({
    name: "DEMOSG.1",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(exportedBytes),
  });
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await textHook(page)).paused).toBe(false);
  await expect.poll(rows).toContain("RESTORED");
  await expect.poll(rows).toContain("STATE 11");
  expect(await rows()).not.toContain("CHANGED");

  // Reload and resume from the library: the flushed autosave preserves the imported save.
  await page.goto("/");
  await savedGameCard(page, "sav-roundtrip").getByTestId("btn-resume-cached").click();
  await expect.poll(rows).toContain("RESTORED");
  await expect.poll(rows).toContain("STATE 11");
  expect(await rows()).not.toContain("CHANGED");
});

test("Create mode disables .SAV import while keeping export available", async ({ page }) => {
  await importAndLaunch(page, "sav-create-mode");
  await enterCreateMode(page);
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-save-files").click();
  await expect(page.getByTestId("save-files-dialog")).toBeVisible();
  await expect(page.getByTestId("sav-export-btn")).toBeEnabled();
  await expect(page.getByTestId("sav-import-btn")).toBeDisabled();
  await expect(page.getByTestId("sav-import-btn")).toHaveAttribute(
    "title",
    /Switch to Play before importing/,
  );
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("save-files-dialog")).toBeHidden();
});

test("storage refusal during .SAV import keeps dialog open with an alert while loading into this tab", async ({
  page,
}) => {
  const { rows } = await importAndLaunch(page, "sav-storage-fail");

  // Export a valid save first.
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-save-files").click();
  const dialog = page.getByTestId("save-files-dialog");
  await expect(dialog).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("sav-export-btn").click();
  const download = await downloadPromise;
  const exportedBytes = new Uint8Array(readFileSync((await download.path())!));
  await page.getByTestId("sav-done").click();
  await expect(dialog).toBeHidden();

  // Advance state so we can confirm the import still takes effect in this tab.
  await page.locator(".screen").click();
  await page.keyboard.press("F1");
  await expect.poll(rows).toContain("CHANGED");

  // Simulate browser storage refusal (QuotaExceededError) on autosave writes.
  await page.evaluate(() => {
    const origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("monotio_agi.autosave.")) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return origSetItem.call(this, key, value);
    };
  });

  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-save-files").click();
  await expect(dialog).toBeVisible();
  await page.getByTestId("sav-import-input").setInputFiles({
    name: "DEMOSG.1",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(exportedBytes),
  });
  await expect(page.getByTestId("sav-error")).toContainText("browser storage could not save it");
  await expect(dialog).toBeVisible();

  await page.getByTestId("sav-done").click();
  await expect(dialog).toBeHidden();
  await expect.poll(rows).toContain("RESTORED");
  await expect.poll(rows).toContain("STATE 11");
});

test("PC booter 2.001 disables Save files in Settings with an explanation", async ({ page }) => {
  const profile = PROFILES["2.001"];
  const game = createContainer();
  game.putResource("picture", 0, Uint8Array.of(0xf0, 1, 0xff));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      'if (!isset(f200)) { set(f200); load.pic(v0); draw.pic(v0); show.pic(); display(8, 0, "BOOTER"); } return;',
      { dictionary: new Map(), profile },
    ).payload,
  );
  game.putFile("WORDS.TOK", new Uint8Array(52));
  const files = new Map(game.files);
  files.set(
    "GAME.JSON",
    new TextEncoder().encode(
      JSON.stringify({
        format: "monotio.agi",
        version: 1,
        title: "Booter save check",
        profile: "2.001",
      }),
    ),
  );
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "Booter save check.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(buildZip([...files].map(([name, data]) => ({ name, data })))),
  });
  await savedGameCard(page, "Booter save check").getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).profile).toBe("2.001");
  await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("BOOTER");
  await openGameOptions(page, "settings-menu");
  const saveFilesBtn = page.getByTestId("btn-save-files");
  await expect(saveFilesBtn).toBeDisabled();
  await expect(saveFilesBtn).toHaveAttribute("title", /floppy disk sectors/);
});

test("Save files dialog fits cleanly on a phone viewport @phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await importAndLaunch(page, "sav-phone");
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-save-files").click();
  const dialog = page.getByTestId("save-files-dialog");
  await expect(dialog).toBeVisible();
  const clipped = await dialog.evaluate((el) => {
    const frame = el.getBoundingClientRect();
    const out: string[] = [];
    for (const btn of el.querySelectorAll<HTMLElement>("button")) {
      const box = btn.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (
        box.left < Math.max(0, frame.left) - 1 ||
        box.right > Math.min(window.innerWidth, frame.right) + 1
      ) {
        out.push(btn.textContent?.trim() ?? "");
      }
    }
    return out;
  });
  expect(clipped).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("save-files-phone.png") });
  await page.getByTestId("sav-done").click();
  await expect(dialog).toBeHidden();
});
