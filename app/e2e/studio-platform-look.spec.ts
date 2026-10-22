import { expect, test } from "./test.ts";
import {
  FIRST_LOAD_BUDGET_MS,
  enterCreateMode,
  enterPlayMode,
  isolateStorage,
  textHook,
} from "./engineProbe.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/archive/zip.ts";

// A player editing an Amiga game sees the colours Play shows: Amiga colour 13
// is nibbles d,0,f, so (221, 0, 255); the PC table's 13 is (255, 85, 255).
// The game is an original synthetic one: a picture filled with colour 13.
test("Studio previews an Amiga game in the colours Play draws", async ({ page }) => {
  const game = createContainer();
  game.putResource("picture", 0, Uint8Array.of(0xf0, 13, 0xf8, 0, 0, 0xff));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      "if (!isset(f200)) { set(f200); load.pic(v0); draw.pic(v0); show.pic(); } return;",
      { dictionary: new Map() },
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
        title: "Amiga Studio",
        profile: "amiga-2.202",
      }),
    ),
  );
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "Amiga Studio.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(buildZip([...files].map(([name, data]) => ({ name, data })))),
  });
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).profile).toBe("amiga-2.202");
  const playPixel = () =>
    page
      .getByTestId("game-canvas")
      .evaluate((canvas) =>
        Array.from(
          (canvas as HTMLCanvasElement).getContext("2d")!.getImageData(160, 100, 1, 1).data,
        ),
      );
  await expect.poll(playPixel).toEqual([221, 0, 255, 255]);

  await enterCreateMode(page);
  const show = page.getByTestId("workspace-show-game");
  if (await show.isVisible()) await show.click();
  await page.getByRole("button", { name: "PICTURE 0", exact: true }).click();
  const studio = page.getByTestId("picture-studio").filter({ visible: true });
  await expect(studio).toBeVisible({ timeout: FIRST_LOAD_BUDGET_MS });
  const pane = studio.locator('.studio-pane[data-layer="visual"] canvas').first();
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(() =>
        pane.evaluate((canvas) => {
          const element = canvas as HTMLCanvasElement;
          return Array.from(
            element.getContext("2d")!.getImageData(element.width >> 1, element.height >> 1, 1, 1)
              .data,
          );
        }),
      )
      .toEqual([221, 0, 255, 255]);
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--agi-13").trim(),
      ),
    ).toBe("rgb(221 0 255)");
    await page.screenshot({ path: test.info().outputPath(`studio-amiga-${width}.png`) });
  }
  // Leaving Create keeps the editor retained, but Play's chrome gets the default tokens back.
  await enterPlayMode(page);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--agi-13")))
    .toBe("");
});
