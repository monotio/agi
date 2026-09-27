import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { buildZip } from "../src/archive/zip.ts";
import { isolateStorage, savedGameCard, textHook, waitForAutosaveAfter } from "./engineProbe.ts";

/**
 * A game that answers QUIT the way a copy-protection or age check does: it
 * blanks the screen, then runs quit(1).
 */
function quittingGameZip(): Buffer {
  const game = createContainer();
  // Picture 1 is a blue field; picture 2 is black from edge to edge.
  game.putResource("picture", 1, new Uint8Array([0xf0, 1, 0xf8, 0, 0, 0xff]));
  game.putResource("picture", 2, new Uint8Array([0xf0, 0, 0xf8, 0, 0, 0xff]));
  const dictionary = new Map([["quit", 1]]);
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
  if (!isset(f200)) {set(f200);assignn(v10,1);accept.input();
   assignn(v51,1);load.pic(v51);draw.pic(v51);show.pic();
   display(2,2,"Type QUIT to end the game.");
  }
  if(said("quit")) {assignn(v51,2);load.pic(v51);draw.pic(v51);show.pic();quit(1);}
  return;`,
      { dictionary },
    ).payload,
  );
  return Buffer.from(
    buildZip(
      [...game.files]
        .map(([name, data]) => ({ name, data }))
        .concat([{ name: "WORDS.TOK", data: buildWordsTok([{ word: "quit", id: 1 }]) }]),
    ),
  );
}

async function autosavePreview(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith("monotio_agi.autosave.")) continue;
      const record = JSON.parse(localStorage.getItem(key) ?? "{}") as { preview?: string };
      return record.preview ?? null;
    }
    return null;
  });
}

test("a game that quits lands Home saying so, keeps its last picture and can be played again", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "quitter.zip",
    mimeType: "application/zip",
    buffer: quittingGameZip(),
  });
  await savedGameCard(page, "quitter").getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Type QUIT");
  await waitForAutosaveAfter(page, 0);
  const before = await autosavePreview(page);
  expect(before).not.toBeNull();

  await page.getByTestId("input-line").fill("quit");
  await page.getByTestId("input-line").press("Enter");

  const ended = page.getByTestId("game-ended");
  await expect(ended).toBeVisible();
  await expect(ended).toContainText("The game ended (it quit).");
  await expect(ended).toContainText("quitter");
  await page.screenshot({ path: test.info().outputPath("game-ended.png") });
  // The black screen before the quit is not the card's picture.
  expect(await autosavePreview(page)).toBe(before);
  // Its progress from before the quit is what the primary action continues.
  await expect(page.getByTestId("hero-primary")).toHaveText("Continue quitter");
  await expect(page.getByTestId("game-ended-continue")).toHaveCount(0);

  await page.getByTestId("game-ended-play-again").click();
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Type QUIT");
  await expect(ended).toHaveCount(0);
});
