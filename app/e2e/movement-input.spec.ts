import { expect, test } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";
import { buildPublicGameZip } from "../src/projectArchive.ts";
import { isolateStorage, textHook, waitForCycles } from "./engineProbe.ts";

for (const hold of [false, true]) {
  test(`numpad directions preserve ${hold ? "held" : "toggle"} movement with numeric key values`, async ({
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
        load.view(0);animate.obj(0);set.view(0,0);position(0,80,120);draw(0);accept.input();
        set.key(0,59,1);
        ${hold ? "hold.key();" : ""}
      }
      if(controller(1)) {get.num("Number?",v61);display(4,0,"Number: %v61");}
      return;`,
        { dictionary: new Map() },
      ).payload,
    );
    await isolateStorage(page);
    await page.goto("/");
    await page.getByTestId("game-zip-input").setInputFiles({
      name: "numpad.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(
        buildPublicGameZip({
          title: "Numpad",
          files: { ...Object.fromEntries(game.files), "WORDS.TOK": new Uint8Array(52) },
        }),
      ),
    });
    await page.getByTestId("btn-resume-cached").click();
    await expect.poll(async () => (await textHook(page)).egoX).toBe(80);
    const input = page.getByTestId("input-line");
    await input.focus();
    for (const [digit, navigation, dx, dy] of [
      ["7", "Home", -1, -1],
      ["9", "PageUp", 1, -1],
      ["1", "End", -1, 1],
      ["3", "PageDown", 1, 1],
      ["8", "ArrowUp", 0, -1],
      ["2", "ArrowDown", 0, 1],
      ["4", "ArrowLeft", -1, 0],
      ["6", "ArrowRight", 1, 0],
    ] as const) {
      const before = await textHook(page);
      const event = { key: digit, code: `Numpad${digit}`, location: 3 };
      // Num Lock on and Mac keyboards report digits, unlike the navigation-key aliases.
      await input.dispatchEvent("keydown", event);
      // A batched cycle heartbeat may precede the worker receiving the key.
      // Wait for the requested movement, not a fixed number of reported cycles.
      await expect
        .poll(
          async () => {
            const position = await textHook(page);
            return [Math.sign(position.egoX - before.egoX), Math.sign(position.egoY - before.egoY)];
          },
          { message: `Numpad${digit} starts the requested direction` },
        )
        .toEqual([dx, dy]);
      const moving = await textHook(page);
      await input.dispatchEvent("keydown", { ...event, repeat: true });
      await expect
        .poll(
          async () => {
            const position = await textHook(page);
            return [Math.sign(position.egoX - moving.egoX), Math.sign(position.egoY - moving.egoY)];
          },
          { message: `Numpad${digit} repeat does not stop movement` },
        )
        .toEqual([dx, dy]);
      const repeated = await textHook(page);
      // Releasing the same physical key must work even if Num Lock changed while held.
      await input.dispatchEvent("keyup", { ...event, key: navigation });
      if (!hold) {
        await expect
          .poll(
            async () => {
              const position = await textHook(page);
              return [
                Math.sign(position.egoX - repeated.egoX),
                Math.sign(position.egoY - repeated.egoY),
              ];
            },
            { message: `Numpad${digit} release preserves toggle movement` },
          )
          .toEqual([dx, dy]);
        await input.dispatchEvent("keydown", event);
        await input.dispatchEvent("keyup", event);
      }
      await waitForCycles(page, 2);
      const stopped = await textHook(page);
      await waitForCycles(page, 2);
      const later = await textHook(page);
      expect([later.egoX, later.egoY]).toEqual([stopped.egoX, stopped.egoY]);
      await expect(input).toHaveValue("");
    }
    await page.keyboard.type("123");
    await expect(input).toHaveValue("123");
    await input.fill("");
    await page.keyboard.press("F1");
    await expect(page.getByTestId("prompt-hint")).toBeVisible();
    const permitsNumber = await input.evaluate((element) =>
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "1",
          code: "Numpad1",
          location: 3,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(permitsNumber, "numeric prompts retain native numpad text entry").toBe(true);
    await page.keyboard.insertText("19");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("Number: 19");
  });
}

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
    await page.getByTestId("btn-resume-cached").click();
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
  await page.getByTestId("btn-resume-cached").click();
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
