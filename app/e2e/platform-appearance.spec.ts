import { expect, test } from "./test.ts";
import type { Locator } from "@playwright/test";
import { isolateStorage, savedGameCard, textHook, waitForAutosaveAfter } from "./engineProbe.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/archive/zip.ts";
import { iigsFontFixture } from "../test/iigsFontFixture.ts";

async function imagePixels(image: Locator): Promise<number[][]> {
  return image.evaluate(async (element) => {
    const source = element as HTMLImageElement;
    await source.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(source, 0, 0);
    return [
      [0, 8],
      [16, 24],
      [17, 24],
      [18, 24],
      [19, 24],
    ].map(([x, y]) => Array.from(ctx.getImageData(x!, y!, 1, 1).data));
  });
}

test("switching PC, Amiga and IIgs games keeps the look from the first picture through inspection and autosave", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.evaluate(() => {
    const paints: number[][][] = [];
    (window as typeof window & { lookPaints: number[][][] }).lookPaints = paints;
    const put = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (
      image: ImageData,
      x: number,
      y: number,
    ) {
      if (
        this.canvas.dataset["testid"] === "game-canvas" &&
        image.data[(24 * 320 + 16) * 4 + 3] === 255
      ) {
        paints.push(
          [
            [0, 8],
            [16, 24],
            [17, 24],
            [18, 24],
            [19, 24],
          ].map(([px, py]) => {
            const at = (py! * 320 + px!) * 4;
            return Array.from(image.data.subarray(at, at + 4));
          }),
        );
      }
      Reflect.apply(put, this, [image, x, y]);
    };
  });
  for (const [profile, title, blue, green, glyph] of [
    ["2.936", "PC look", 170, 170, [false, true, true]],
    ["amiga-2.202", "Amiga look", 255, 136, [false, false, true]],
    ["iigs-1.014", "IIgs look", 255, 136, [true, false, false]],
    ["2.936", "PC look", 170, 170, [false, true, true]],
  ] as const) {
    const expected = [
      [0, 0, blue, 255],
      [0, green, 0, 255],
      ...glyph.map((on) => (on ? [0, 0, blue, 255] : [0, green, 0, 255])),
    ];
    const card = savedGameCard(page, title);
    if (!(await card.count())) {
      const game = createContainer();
      game.putResource("picture", 0, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
      game.putResource(
        "logic",
        0,
        assembleLogic(
          'if (!isset(f200)) { set(f200); load.pic(v0); draw.pic(v0); show.pic(); set.text.attribute(1,2); display(3,2,"A"); } return;',
          { dictionary: new Map() },
        ).payload,
      );
      game.putFile("WORDS.TOK", new Uint8Array(52));
      const files = new Map(game.files);
      files.set(
        "GAME.JSON",
        new TextEncoder().encode(
          JSON.stringify({ format: "monotio.agi", version: 1, title, profile }),
        ),
      );
      if (profile === "iigs-1.014") files.set("AGIFONT", iigsFontFixture());
      await page.getByTestId("game-zip-input").setInputFiles({
        name: `${title}.zip`,
        mimeType: "application/zip",
        buffer: Buffer.from(buildZip([...files].map(([name, data]) => ({ name, data })))),
      });
      await expect(card.getByTestId("library-thumbnail")).toHaveAttribute(
        "src",
        /^data:image\/png/,
      );
      expect(await imagePixels(card.getByTestId("library-thumbnail"))).toEqual(expected);
    }
    await page.evaluate(() => {
      (window as typeof window & { lookPaints: number[][][] }).lookPaints.length = 0;
    });
    await card.getByTestId("btn-resume-cached").click();
    await expect.poll(async () => (await textHook(page)).profile).toBe(profile);
    await expect.poll(async () => (await textHook(page)).rows[3]?.[2]).toBe("A");
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as typeof window & { lookPaints: number[][][] }).lookPaints.length,
        ),
      )
      .toBeGreaterThan(0);
    await waitForAutosaveAfter(page, -1);
    const paints = await page.evaluate(
      () => (window as typeof window & { lookPaints: number[][][] }).lookPaints,
    );
    for (const paint of paints) expect(paint).toEqual(expected);
    for (const [width, height] of [
      [1063, 815],
      [1440, 900],
      [390, 844],
    ]) {
      await page.setViewportSize({ width: width!, height: height! });
      await page.screenshot({ path: test.info().outputPath(`${profile}-${width}.png`) });
    }
    await page.getByTestId("btn-exit").click();
    await expect(card).toBeVisible();
    expect(await imagePixels(card.getByTestId("library-thumbnail"))).toEqual(expected);
  }
});
