import { expect, test } from "./test.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { buildZip } from "../src/archive/zip.ts";
import { enterCreateMode, isolateStorage, savedGameCard, textHook } from "./engineProbe.ts";

test.use({ keepDetectedProfileOption: false });

for (const mode of ["Play", "Create"] as const) {
  test(`IIgs ${mode} lists and restores a native numbered save`, async ({ page }) => {
    const game = createContainer();
    game.putResource("picture", 0, Uint8Array.of(0xff));
    game.putResource(
      "logic",
      0,
      assembleLogic(
        `
      if (!isset(f200)) {
        set(f200); set.game.id("DEMO");
        load.pic(v0); draw.pic(v0); show.pic();
        set.key(0, 63, 1); set.key(0, 65, 2); set.key(0, 59, 3);
        display(8, 0, "READY");
      }
      if (isset(f12)) { display(10, 0, "RESTORED"); return; }
      if (controller(c1)) { save.game(); display(9, 0, "SAVE DONE"); }
      if (controller(c2)) { restore.game(); }
      if (controller(c3)) { display(10, 0, "CHANGED"); }
      return;`,
        { dictionary: new Map(), profile: PROFILES["iigs-1.014"] },
      ).payload,
    );
    game.putFile("WORDS.TOK", new Uint8Array(52));
    await isolateStorage(page);
    await page.goto("/");
    await page.getByTestId("game-zip-input").setInputFiles({
      name: "native-save.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(buildZip([...game.files].map(([name, data]) => ({ name, data })))),
    });
    await expect(page.getByTestId("profile-picker-dialog")).toBeVisible();
    await page.getByTestId("profile-picker-select").selectOption("iigs-1.014");
    await page.getByTestId("profile-picker-confirm").click();
    await savedGameCard(page, "native-save").getByTestId("btn-resume-cached").click();
    const rows = async () => (await textHook(page)).rows.join("\n");
    await expect.poll(rows).toContain("READY");
    if (mode === "Create") await enterCreateMode(page);
    await page.locator(".screen").click();
    await page.keyboard.press("F5");
    await expect.poll(async () => (await textHook(page)).modal).toBe("save");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.__AGI_STATE__?.prompt?.kind))
      .toBe("saveDescription");
    await page.getByTestId("input-line").fill("Courtyard");
    await page.getByTestId("input-line").press("Enter");
    await expect.poll(rows).toContain("Save in slot 1?");
    await page.keyboard.press("Enter");
    await expect.poll(rows).toContain("SAVE DONE");
    const slots = await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith("monotio_agi.saves.")),
    );
    expect(slots.length).toBe(mode === "Play" ? 1 : 0);
    await page.keyboard.press("F1");
    await expect.poll(rows).toContain("CHANGED");
    await page.keyboard.press("F7");
    await expect.poll(async () => (await textHook(page)).modal).toBe("restore");
    await expect.poll(rows).toContain("Courtyard");
    await page.screenshot({ path: test.info().outputPath(`iigs-${mode}-restore.png`) });
    await page.keyboard.press("Enter");
    await expect.poll(rows).toContain("RESTORED");
    expect(await rows()).not.toContain("CHANGED");
  });
}
