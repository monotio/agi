import { expect, test } from "./test.ts";
import { readFile } from "node:fs/promises";
import { readGameZip } from "../src/gameZip.ts";
import { buildZip } from "../src/zip.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import {
  isolateStorage,
  openGameOptions,
  savedGameCard,
  textHook,
  waitForAutosaveAfter,
} from "./engineProbe.ts";

test("malformed play hashes recover to the picker without a startup exception", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await isolateStorage(page);
  await page.goto("/#play/%");
  await expect(page.getByTestId("catalog-play-adventure-department")).toBeVisible();
  expect(errors).toEqual([]);
  expect(new URL(page.url()).hash).toBe("");
});

for (const failure of ["unsafe", "timeout", "storage"] as const) {
  test(`project export discloses ${failure} checkpoint failure while downloading available progress`, async ({
    page,
  }, testInfo) => {
    await isolateStorage(page);
    await page.goto("/");
    if (failure === "unsafe") {
      // Only a live host request stays non-checkpointable: the pending answer
      // belongs to the player, not the image. A get.num prompt is one; a print
      // window no longer is (it serializes into the continuation).
      const game = createContainer();
      game.putResource("picture", 1, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
      const dictionary = new Map([["look", 1]]);
      game.putResource(
        "logic",
        0,
        assembleLogic("if(!isset(f200)){set(f200);new.room(1);}call(1);return;", {
          dictionary,
        }).payload,
      );
      game.putResource(
        "logic",
        1,
        assembleLogic(
          "if(isset(f5)){assignn(v50,1);load.pic(v50);draw.pic(v50);show.pic();accept.input();}" +
            'if(said("look")){get.num("Pick a number",v60);}return;',
          { dictionary },
        ).payload,
      );
      const archive = buildZip(
        [...game.files]
          .map(([name, data]) => ({ name, data }))
          .concat([{ name: "WORDS.TOK", data: buildWordsTok([{ word: "look", id: 1 }]) }]),
      );
      await page.getByTestId("game-zip-input").setInputFiles({
        name: "prompt-checkpoint.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(archive),
      });
      await savedGameCard(page, "prompt-checkpoint").getByTestId("btn-resume-cached").click();
    } else {
      await page.getByTestId("catalog-play-adventure-department").click();
    }
    await expect.poll(async () => (await textHook(page)).room).toBe(1);
    await waitForAutosaveAfter(page, (await textHook(page)).cycle);
    const savedCycle = (await textHook(page)).autosave;
    if (failure === "unsafe") {
      await page.getByTestId("input-line").fill("look");
      await page.getByTestId("input-line").press("Enter");
      await expect(page.getByTestId("prompt-hint")).toBeVisible();
    } else if (failure === "timeout") {
      await page.evaluate(() => {
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message, transfer) {
          if (message.type === "flush") return;
          return post.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
        };
      });
    } else {
      await page.evaluate(() => {
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith("monotio_agi.autosave."))
            throw new DOMException("No space", "QuotaExceededError");
          return set.call(this, key, value);
        };
      });
    }
    let downloads = 0;
    page.on("download", () => downloads++);
    const download = page.waitForEvent("download");
    await openGameOptions(page, "game-menu");
    await page.getByTestId("btn-download-game").click();
    await expect(page.getByTestId("export-refusal")).toContainText(
      "Backup downloaded with limitations",
    );
    if (failure === "unsafe")
      await page.screenshot({ path: testInfo.outputPath("checkpoint-limitations.png") });
    const path = (await (await download).path())!;
    const archive = await readGameZip(new Uint8Array(await readFile(path)));
    // A live worker checkpoint bypasses the failed persistence path. A host
    // prompt still needs the player's answer and preserves the saved image.
    if (failure !== "unsafe")
      expect(archive.progress?.autosave?.cycle).toBeGreaterThanOrEqual(savedCycle!);
    else expect(archive.progress?.autosave?.cycle).toBe(savedCycle);
    expect(archive.backupWarning).toBeDefined();
    expect(downloads).toBe(1);
  });
}
