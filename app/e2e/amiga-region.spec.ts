import { test, expect, type Page } from "@playwright/test";
import { isolateStorage, openGameOptions, textHook } from "./engineProbe.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildSound } from "../../src/agent/tools.ts";
import { buildZip } from "../src/archive/zip.ts";

async function bootSoundGame(page: Page, profile = "amiga-2.310"): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic(
      "if (!isset(f200)) { set(f200); set(f9); load.sound(0); sound(0, f201); } return;",
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource(
    "sound",
    0,
    buildSound([{ notes: [{ note: "A4", duration: 6000, attenuation: 1 }] }]),
  );
  game.putFile("WORDS.TOK", new Uint8Array(52));
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "region-sound.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(buildZip([...game.files].map(([name, data]) => ({ name, data })))),
  });
  const picker = page.getByTestId("profile-picker-dialog");
  await expect(picker).toBeVisible();
  await page.getByTestId("profile-picker-select").selectOption(profile);
  await page.getByTestId("profile-picker-confirm").click();
  await page
    .locator("[data-testid^='saved-game-card-']", { hasText: "region-sound" })
    .getByTestId("btn-resume-cached")
    .click();
  await expect.poll(async () => (await textHook(page)).profile).toBe(profile);
}

async function openAdvanced(page: Page): Promise<void> {
  await openGameOptions(page, "settings-menu");
  const advanced = page.getByTestId("settings-advanced");
  await expect(advanced).toBeVisible();
  await advanced.click();
}

for (const viewport of [
  { width: 1063, height: 815 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`Amiga region persists and switches the playing voice live at ${viewport.width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await bootSoundGame(page);
    await openAdvanced(page);
    const chip = page.getByTestId("toggle-sound-mode");
    await expect(chip).toBeVisible();
    await expect(chip.locator("small")).toHaveText("Amiga Paula");
    await chip.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("amiga-settings.png") });
    const region = page.getByRole("combobox", { name: "Amiga sound" });
    await expect(region).toBeVisible();
    await expect(region).toHaveValue("ntsc");
    await region.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("amiga-ntsc.png") });
    await expect(region.getByRole("option")).toHaveText(["NTSC (US)", "PAL (Europe)"]);
    const before = await page.evaluate(() => {
      const audio = (
        window as unknown as {
          __AGI_AUDIO__: { paulaSources: AudioBufferSourceNode[]; paulaPeriods: (number | null)[] };
        }
      ).__AGI_AUDIO__;
      const source = audio.paulaSources[0]!;
      (window as unknown as { regionSource: AudioBufferSourceNode }).regionSource = source;
      return { rate: source.playbackRate.value, period: audio.paulaPeriods[0] };
    });
    expect(before.period).toBeGreaterThan(0);
    await region.selectOption("pal");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("monotio_agi.amigaRegion")))
      .toBe("pal");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { regionSource: AudioBufferSourceNode }).regionSource.playbackRate
              .value,
        ),
      )
      .toBeCloseTo((before.rate * 3546895) / 3579545, 5);
    expect(
      await page.evaluate(() => {
        const w = window as unknown as {
          __AGI_AUDIO__: { paulaSources: AudioBufferSourceNode[] };
          regionSource: AudioBufferSourceNode;
        };
        return w.__AGI_AUDIO__.paulaSources[0] === w.regionSource;
      }),
    ).toBe(true);
    await region.selectOption("ntsc");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { regionSource: AudioBufferSourceNode }).regionSource.playbackRate
              .value,
        ),
      )
      .toBeCloseTo(before.rate, 5);
    await region.selectOption("pal");
    await page.reload();
    await page
      .locator("[data-testid^='saved-game-card-']", { hasText: "region-sound" })
      .getByTestId("btn-resume-cached")
      .click();
    await expect.poll(async () => (await textHook(page)).profile).toBe("amiga-2.310");
    await openAdvanced(page);
    await expect(region).toBeVisible();
    await expect(region).toHaveValue("pal");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const audio = (
            window as unknown as { __AGI_AUDIO__: { paulaSources: AudioBufferSourceNode[] } }
          ).__AGI_AUDIO__;
          return audio.paulaSources[0]!.playbackRate.value;
        }),
      )
      .toBeCloseTo((before.rate * 3546895) / 3579545, 5);
    await region.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("amiga-pal.png") });
  });
}

test("PC profiles keep the Amiga region choice hidden", async ({ page }) => {
  await bootSoundGame(page, "2.936");
  await openAdvanced(page);
  await expect(page.getByTestId("toggle-sound-mode")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Amiga sound" })).toHaveCount(0);
});
