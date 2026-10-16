import { expect, test } from "./test.ts";
import type { Page } from "@playwright/test";
import {
  isolateStorage,
  openGameOptions,
  surfaceBox,
  textHook,
  waitForRoom,
} from "./engineProbe.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/archive/zip.ts";

// Player-visible rules (docs/fidelity.md "PC fonts and display adapters" and
// "Display geometry"): a PC game offers EGA and CGA where its build starts
// CGA in RGB; the choice applies at the next start, a resumed game included;
// CGA draws only the driver's four colours; builds without a verified CGA
// start and other platforms show no choice; the screen keeps the monitor's
// shape, PAL Amiga included.

test.use({ keepDetectedProfileOption: false });

/** The driver's four CGA colours: blue, green, red, brown. */
const CGA = ["0,0,170", "0,170,0", "170,0,0", "170,85,0"];

async function canvasColours(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-testid='game-canvas']")!;
    const data = canvas.getContext("2d")!.getImageData(0, 0, 320, 200).data;
    const seen = new Set<string>();
    for (let i = 0; i < data.length; i += 4) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return [...seen].sort();
  });
}

async function openAdvanced(page: Page): Promise<void> {
  await openGameOptions(page, "settings-menu");
  const advanced = page.getByTestId("settings-advanced");
  await expect(advanced).toBeVisible();
  if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
}

async function playCatalogGame(page: Page): Promise<void> {
  const play = page.getByTestId("catalog-play-adventure-department");
  const canvas = page.getByTestId("game-canvas");
  await expect(canvas.or(play).filter({ visible: true })).toBeVisible();
  if (await play.isVisible()) await play.click();
  await waitForRoom(page, 1, { coldBoot: true });
}

for (const viewport of [
  { width: 1063, height: 815 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  const phone = viewport.width === 390;
  test(`${viewport.width}: the Screen choice starts the game on CGA next time${phone ? " @phone" : ""}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await isolateStorage(page);
    if (phone)
      await page.addInitScript(() => localStorage.setItem("monotio_agi.touchControls", "on"));
    await page.goto("/");
    await playCatalogGame(page);
    // EGA draws colours outside the CGA four, such as the white status bar.
    await expect
      .poll(async () => (await canvasColours(page)).some((c) => !CGA.includes(c)))
      .toBe(true);

    await openAdvanced(page);
    const screen = page.getByRole("combobox", { name: "Screen" });
    await screen.scrollIntoViewIfNeeded();
    await expect(screen).toHaveValue("ega");
    await expect(screen.getByRole("option")).toHaveText(["EGA (16 colours)", "CGA (4 colours)"]);
    await screen.selectOption("cga-rgb");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("monotio_agi.pcDisplay")))
      .toBe("cga-rgb");
    await expect(
      page.locator(".settings-row", { has: screen }).getByText("Applies on the next start"),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`pc-display-settings-${viewport.width}.png`),
    });
    expect((await textHook(page)).pcDisplay).toBe("ega");
    await page.keyboard.press("Escape");

    // A reload resumes the game: a new start, so it runs on CGA.
    await page.reload();
    await playCatalogGame(page);
    await expect.poll(async () => (await textHook(page)).pcDisplay).toBe("cga-rgb");
    await expect
      .poll(async () => (await canvasColours(page)).filter((c) => !CGA.includes(c)))
      .toEqual([]);
    expect((await canvasColours(page)).length).toBeGreaterThan(1);

    await openGameOptions(page, "settings-menu");
    const shape = page.getByTestId("toggle-original-aspect");
    await shape.scrollIntoViewIfNeeded();
    const square = (await shape.getAttribute("aria-checked")) !== "true";
    await page.keyboard.press("Escape");
    await expect
      .poll(async () => {
        const b = await surfaceBox(page);
        return b.width / b.height;
      })
      .toBeCloseTo(square ? 8 / 5 : 4 / 3, 2);
    await openGameOptions(page, "settings-menu");
    await shape.click();
    await page.keyboard.press("Escape");
    await expect
      .poll(async () => {
        const b = await surfaceBox(page);
        return b.width / b.height;
      })
      .toBeCloseTo(square ? 4 / 3 : 8 / 5, 2);

    if (phone) {
      const pad = page.getByTestId("touch-controls");
      await expect(pad).toBeVisible();
      for (const name of ["Walk north", "Walk south", "Enter", "Esc", "Space"]) {
        const button = pad.getByRole("button", { name, exact: true });
        await expect(button).toBeInViewport({ ratio: 1 });
        const box = (await button.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }
    await page.screenshot({
      path: test.info().outputPath(`pc-display-cga-${viewport.width}.png`),
      fullPage: true,
    });
  });
}

async function uploadGame(page: Page, profile: string): Promise<void> {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic(
      "if (!isset(f200)) { set(f200); assignn(v1, 1); load.pic(v1); draw.pic(v1); show.pic(); } return;",
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource("picture", 1, Uint8Array.of(0xf0, 0x02, 0xf8, 0, 0, 0xff));
  game.putFile("WORDS.TOK", new Uint8Array(52));
  await page.getByTestId("game-zip-input").setInputFiles({
    name: `screen-${profile}.zip`,
    mimeType: "application/zip",
    buffer: Buffer.from(buildZip([...game.files].map(([name, data]) => ({ name, data })))),
  });
  await expect(page.getByTestId("profile-picker-dialog")).toBeVisible();
  await page.getByTestId("profile-picker-select").selectOption(profile);
  await page.getByTestId("profile-picker-confirm").click();
  await page
    .locator("[data-testid^='saved-game-card-']", { hasText: `screen-${profile}` })
    .getByTestId("btn-resume-cached")
    .click();
  await expect.poll(async () => (await textHook(page)).profile).toBe(profile);
}

for (const profile of ["2.089", "amiga-2.310"]) {
  test(`${profile} shows no Screen choice and keeps its monitor shape`, async ({ page }) => {
    await isolateStorage(page);
    await page.addInitScript(() => {
      localStorage.setItem("monotio_agi.pcDisplay", "cga-rgb");
      localStorage.setItem("monotio_agi.amigaRegion", "pal");
      localStorage.setItem("monotio_agi.originalAspect", "on");
    });
    await page.goto("/");
    await uploadGame(page, profile);
    expect((await textHook(page)).pcDisplay).toBe("ega");
    await openAdvanced(page);
    await expect(page.getByTestId("toggle-sound-mode")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Screen" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // A PAL Amiga opens a 200-line window on 16:15 pixels; the PC monitor is 4:3.
    await expect
      .poll(async () => {
        const b = await surfaceBox(page);
        return b.width / b.height;
      })
      .toBeCloseTo(profile === "amiga-2.310" ? 128 / 75 : 4 / 3, 2);
  });
}
