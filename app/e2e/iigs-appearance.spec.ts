import { iigsFontFixture } from "../test/iigsFontFixture.ts";
import { expect, test } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/archive/zip.ts";

// Original synthetic game and optional font; no commercial resources are needed.
for (const supplied of [false, true]) {
  test(`IIgs imports ${supplied ? "with a player font" : "without a font"} and presents exact platform pixels at desktop and phone sizes @phone`, async ({
    page,
  }) => {
    const game = createContainer();
    game.putResource("picture", 0, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
    game.putResource(
      "logic",
      0,
      assembleLogic(
        `
    if (!isset(f200)) {
      set(f200); load.pic(v0); draw.pic(v0); show.pic();
      set.text.attribute(1, 2); display(3, 2, "A");
    }
    return;
  `,
        { dictionary: new Map() },
      ).payload,
    );
    game.putFile("WORDS.TOK", new Uint8Array(52));
    const files = new Map(game.files);
    if (supplied) files.set("AGIFONT", iigsFontFixture());
    files.set("TEST.SYS16", new TextEncoder().encode("Adventure Game Interpreter\nVersion 1.014"));
    await isolateStorage(page);
    await page.goto("/");
    await page.getByTestId("game-zip-input").setInputFiles({
      name: "IIgs pixels.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(buildZip([...files].map(([name, data]) => ({ name, data })))),
    });
    await page.getByTestId("btn-resume-cached").click();
    await expect.poll(async () => (await textHook(page)).profile).toBe("iigs-1.014");
    await expect.poll(async () => (await textHook(page)).rows[3]?.[2]).toBe("A");
    for (const [width, height] of [
      [1063, 815],
      [1440, 900],
      [390, 844],
    ]) {
      await page.setViewportSize({ width: width!, height: height! });
      await expect
        .poll(() =>
          page.getByTestId("game-canvas").evaluate((canvas, supplied) => {
            const ctx = (canvas as HTMLCanvasElement).getContext("2d")!;
            return [
              [0, 8],
              [supplied ? 17 : 18, 24],
              [16, 24],
            ].map(([x, y]) => Array.from(ctx.getImageData(x!, y!, 1, 1).data));
          }, supplied),
        )
        .toEqual([
          [0, 0, 255, 255],
          [0, 0, 255, 255],
          [0, 136, 0, 255],
        ]);
      await page.screenshot({ path: test.info().outputPath(`iigs-${width}.png`), fullPage: false });
    }
  });
}
