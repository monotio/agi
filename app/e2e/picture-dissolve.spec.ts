import { expect, test } from "./test.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { buildZip } from "../src/archive/zip.ts";
import { isolateStorage, savedGameCard, textHook } from "./engineProbe.ts";

/**
 * docs/fidelity.md "Original picture dissolve": on the Amiga a picture shown
 * after draw.pic comes in two pixels at a time over about 0.8 s while the
 * game waits; the text the game writes after show.pic follows it.
 */
function dissolvingGameZip(): Buffer {
  const game = createContainer();
  game.putResource("picture", 1, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
  game.putResource("picture", 2, Uint8Array.of(0xf0, 2, 0xf8, 0, 0, 0xff));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
  if (!isset(f200)) {set(f200);assignn(v10,1);accept.input();
   assignn(v51,1);load.pic(v51);draw.pic(v51);show.pic();
   display(20,2,"Type GO.");
  }
  if(said("go")) {assignn(v51,2);load.pic(v51);draw.pic(v51);show.pic();display(20,2,"Here.   ");}
  return;`,
      { dictionary: new Map([["go", 1]]) },
    ).payload,
  );
  const files = new Map([
    ...game.files,
    ["WORDS.TOK", buildWordsTok([{ word: "go", id: 1 }])],
    [
      "GAME.JSON",
      new TextEncoder().encode(
        JSON.stringify({
          format: "monotio.agi",
          version: 1,
          title: "Dissolver",
          profile: "amiga-2.202",
        }),
      ),
    ],
  ]);
  return Buffer.from(buildZip([...files].map(([name, data]) => ({ name, data }))));
}

test("an Amiga picture dissolves in over the old one, then the game goes on", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "dissolver.zip",
    mimeType: "application/zip",
    buffer: dissolvingGameZip(),
  });
  await savedGameCard(page, "Dissolver").getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Type GO");

  // Count picture 2's green (Amiga colour 2, $080) above the text on row 20 in
  // every frame painted from here on, and note whether the screen asks for Enter.
  await page.evaluate(() => {
    const record = window as typeof window & { greens: number[]; askedForEnter: boolean };
    record.greens = [];
    record.askedForEnter = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="modal-hint"]')) record.askedForEnter = true;
    }).observe(document.body, { childList: true, subtree: true });
    const put = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (
      image: ImageData,
      x: number,
      y: number,
    ) {
      if (this.canvas.dataset["testid"] === "game-canvas" && image.width === 320) {
        let greens = 0;
        for (let at = 0; at < 320 * 152 * 4; at += 4)
          if (image.data[at] === 0 && image.data[at + 1] === 136 && image.data[at + 2] === 0)
            greens++;
        record.greens.push(greens);
      }
      Reflect.apply(put, this, [image, x, y]);
    };
  });
  // The key help names what the game waits for; nothing during a dissolve.
  await page.getByTestId("game-keys").click();
  await expect(page.getByTestId("game-key-help")).toBeVisible();
  await page.getByTestId("input-line").fill("go");
  await page.getByTestId("input-line").press("Enter");
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Here.");
  // The text can land a frame before the canvas paints the finished picture.
  const full = 320 * 152;
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { greens: number[] }).greens.at(-1)))
    .toBe(full);

  const { greens, askedForEnter } = await page.evaluate(() => {
    const record = window as typeof window & { greens: number[]; askedForEnter: boolean };
    return { greens: record.greens, askedForEnter: record.askedForEnter };
  });
  const partial = greens.filter((n) => n > 0 && n < full);
  expect(partial.length, `frames part-way through: ${greens.join(",")}`).toBeGreaterThan(0);
  expect(greens.filter((n) => n > 0)).toEqual(
    [...greens.filter((n) => n > 0)].sort((a, b) => a - b),
  );
  expect(greens.at(-1)).toBe(full);
  expect(askedForEnter, "the dissolve asks nothing of the player").toBe(false);
});
