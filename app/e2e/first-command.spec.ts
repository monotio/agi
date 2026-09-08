import { expect, test } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { buildZip } from "../src/zip.ts";
import { isolateStorage, savedGameCard, textHook } from "./engineProbe.ts";
import { BRIDGE_PAUSE_SLOT } from "../src/agent/sabBridge.ts";

test("the first parser command waits for the worker's initial input mode", async ({ page }) => {
  const game = createContainer();
  game.putResource("picture", 0, Uint8Array.of(0xf0, 0, 0xf8, 0, 0, 0xff));
  const dictionary = new Map([["look", 1]]);
  game.putResource(
    "logic",
    0,
    assembleLogic(
      'if(!isset(f200)){set(f200);accept.input();load.pic(v0);draw.pic(v0);show.pic();}if(said("look")){display(4,2,"Look accepted");}return;',
      { dictionary },
    ).payload,
  );
  const archive = buildZip(
    [...game.files]
      .map(([name, data]) => ({ name, data }))
      .concat([{ name: "WORDS.TOK", data: buildWordsTok([{ word: "look", id: 1 }]) }]),
  );
  await isolateStorage(page);
  await page.addInitScript((slot) => {
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      if (message.type === "boot") {
        const buffer = new Int32Array(message.sab, 0, 4);
        Atomics.store(buffer, slot, 1);
        Object.assign(window, { __firstCommandGate: () => Atomics.store(buffer, slot, 0) });
      }
      return original.call(this, message, transfer as Transferable[]);
    };
  }, BRIDGE_PAUSE_SLOT);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "first-command.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive),
  });
  await savedGameCard(page, "first-command").getByTestId("btn-resume-cached").click();
  const input = page.getByTestId("input-line");
  await expect(input).toBeVisible();
  await expect(input).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as { __firstCommandGate: () => void }).__firstCommandGate(),
  );
  await expect(input).toBeEnabled();
  await input.fill("look");
  await input.press("Enter");
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Look accepted");
});
