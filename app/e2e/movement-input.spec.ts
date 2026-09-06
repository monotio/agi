import { expect, test } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";
import { buildPublicGameZip } from "../src/projectArchive.ts";
import { isolateStorage, textHook, waitForCycles } from "./engineProbe.ts";

for (const hold of [false, true]) {
  test(`keyboard movement respects ${hold ? "hold.key" : "AGI toggle controls"}`, async ({
    page,
  }) => {
    const game = createContainer();
    game.putResource("picture", 0, Uint8Array.of(255));
    game.putResource(
      "view",
      0,
      buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
    );
    game.putResource(
      "logic",
      0,
      assembleLogic(
        `
      if(!isset(f200)) {
        set(f200);assignn(v10,1);assignn(v60,0);load.pic(v60);draw.pic(v60);show.pic();
        load.view(0);animate.obj(0);set.view(0,0);position(0,60,120);draw(0);accept.input();
        ${hold ? "hold.key();" : ""}
      } return;`,
        { dictionary: new Map() },
      ).payload,
    );
    const zip = buildPublicGameZip({
      title: "Movement",
      files: { ...Object.fromEntries(game.files), "WORDS.TOK": new Uint8Array(52) },
    });
    await page.goto("/");
    await page.getByTestId("game-zip-input").setInputFiles({
      name: "movement.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(zip),
    });
    await expect.poll(async () => (await textHook(page)).egoX).toBe(60);
    await page.getByTestId("input-line").focus();
    await page.keyboard.down("ArrowRight");
    await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(60);
    // A repeated keydown must not toggle movement while the physical key is held.
    await page.keyboard.down("ArrowRight");
    const held = (await textHook(page)).egoX;
    await waitForCycles(page, 4);
    expect((await textHook(page)).egoX).toBeGreaterThan(held);
    await page.keyboard.up("ArrowRight");
    await waitForCycles(page, 2);
    const released = (await textHook(page)).egoX;
    await waitForCycles(page, 4);
    if (hold) expect((await textHook(page)).egoX).toBe(released);
    else {
      expect((await textHook(page)).egoX).toBeGreaterThan(released);
      await page.keyboard.press("ArrowRight");
      await waitForCycles(page, 2);
      const stopped = (await textHook(page)).egoX;
      await waitForCycles(page, 4);
      expect((await textHook(page)).egoX).toBe(stopped);
    }
  });
}

test("keyboard release during a game-triggered print stops hold.key motion after dismissal", async ({
  page,
}) => {
  const game = createContainer();
  game.putResource("picture", 0, Uint8Array.of(255));
  game.putResource(
    "view",
    0,
    buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
  );
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `
    if(!isset(f200)) {
      set(f200);assignn(v10,1);assignn(v60,0);load.pic(v60);draw.pic(v60);show.pic();
      load.view(0);animate.obj(0);set.view(0,0);position(0,60,120);draw(0);accept.input();hold.key();
    }
    get.posn(0,v63,v64);
    if(!isset(f201) && greatern(v63,64)) {set(f201);print("Movement interruption");}
    return;`,
      { dictionary: new Map() },
    ).payload,
  );
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "modal-movement.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(
      buildPublicGameZip({
        title: "Modal movement",
        files: { ...Object.fromEntries(game.files), "WORDS.TOK": new Uint8Array(52) },
      }),
    ),
  });
  await expect.poll(async () => (await textHook(page)).egoX).toBe(60);
  await page.getByTestId("input-line").focus();
  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => (await textHook(page)).modal).toBe("print");
  await page.keyboard.up("ArrowRight");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await textHook(page)).modal).toBeNull();
  await waitForCycles(page, 2);
  const released = (await textHook(page)).egoX;
  await waitForCycles(page, 3);
  expect((await textHook(page)).egoX).toBe(released);
});
