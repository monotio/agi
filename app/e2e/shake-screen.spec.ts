import { expect, test } from "./test.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { buildZip } from "../src/archive/zip.ts";
import { isolateStorage, savedGameCard, textHook } from "./engineProbe.ts";

/**
 * docs/fidelity.md "Original shake.screen and picture reveal": on PC EGA the whole display
 * alternates with a copy 8 px right and 4 lines down (2.5% and 2% of the
 * 320x200 frame), black where uncovered, and the game waits until it ends.
 */
function shakingGameZip(): Buffer {
  const game = createContainer();
  game.putResource("picture", 1, new Uint8Array([0xf0, 1, 0xf8, 0, 0, 0xff]));
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
  if (!isset(f200)) {set(f200);assignn(v10,1);accept.input();
   assignn(v51,1);load.pic(v51);draw.pic(v51);show.pic();
   display(2,2,"Type SHAKE.");
  }
  if(said("shake")) {shake.screen(3);display(4,2,"Still standing.");}
  return;`,
      { dictionary: new Map([["shake", 1]]) },
    ).payload,
  );
  const files = new Map([...game.files, ["WORDS.TOK", buildWordsTok([{ word: "shake", id: 1 }])]]);
  return Buffer.from(buildZip([...files].map(([name, data]) => ({ name, data }))));
}

test("shake.screen moves the whole picture in the original's steps, then the game goes on", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "shaker.zip",
    mimeType: "application/zip",
    buffer: shakingGameZip(),
  });
  await savedGameCard(page, "shaker").getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Type SHAKE");

  const surface = page.getByTestId("game-canvas");
  await page.getByTestId("input-line").fill("shake");
  await page.getByTestId("input-line").press("Enter");
  await expect(surface).toHaveAttribute("style", /translate\(2\.5%, 2%\)/);
  await expect(page.locator(".screen.shaking")).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("shake-step.png") });
  expect((await textHook(page)).rows.join(" ")).not.toContain("Still standing");

  // Three units of eight 66.7 ms steps end after 1.6 s; the waiting line follows.
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Still standing");
  await expect(page.locator(".screen.shaking")).toHaveCount(0);
  expect((await surface.getAttribute("style")) ?? "").not.toContain("translate");
});
