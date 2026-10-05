import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";
import { buildPublicGameZip } from "../src/archive/projectArchive.ts";
import { gameHint, isolateStorage, textHook, waitForCycles } from "./engineProbe.ts";

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
        load.view(0);animate.obj(0);set.view(0,0);position(0,80,120);draw(0);assignn(v99,1);step.size(0,v99);accept.input();
        set.key(0,59,1);
        ${hold ? "hold.key();" : ""}
      }
      if(controller(1)) {get.num("Number?",v61);display(4,0,"Number: %v61");}
      get.dir(0,v62);display(5,0,"Direction: %v62");
      get.posn(0,v63,v64);
      if(lessn(v63,20) || greatern(v63,140) || lessn(v64,60) || greatern(v64,150)) {
        position(0,80,120);
      }
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
    for (const [digit, navigation, direction] of [
      ["7", "Home", 8],
      ["9", "PageUp", 2],
      ["1", "End", 6],
      ["3", "PageDown", 4],
      ["8", "ArrowUp", 1],
      ["2", "ArrowDown", 5],
      ["4", "ArrowLeft", 7],
      ["6", "ArrowRight", 3],
    ] as const) {
      const event = { key: digit, code: `Numpad${digit}`, location: 3 };
      // Num Lock on and Mac keyboards report digits, unlike the navigation-key aliases.
      await input.dispatchEvent("keydown", event);
      // The game reads its actual heading. Position deltas can lose a component
      // at the horizon, or hit an edge during a slow browser observation.
      await expect
        .poll(() => egoDirection(page), {
          message: `Numpad${digit} starts the requested direction`,
        })
        .toBe(direction);
      const moving = (await textHook(page)).cycle;
      await input.dispatchEvent("keydown", { ...event, repeat: true });
      await expect
        .poll(
          async () => {
            const hook = await textHook(page);
            return hook.cycle > moving ? directionFrom(hook.rows) : null;
          },
          { message: `Numpad${digit} repeat does not stop movement` },
        )
        .toBe(direction);
      const repeated = (await textHook(page)).cycle;
      // Releasing the same physical key must work even if Num Lock changed while held.
      await input.dispatchEvent("keyup", { ...event, key: navigation });
      if (!hold) {
        await expect
          .poll(
            async () => {
              const hook = await textHook(page);
              return hook.cycle > repeated ? directionFrom(hook.rows) : null;
            },
            { message: `Numpad${digit} release preserves toggle movement` },
          )
          .toBe(direction);
        await input.dispatchEvent("keydown", event);
        await input.dispatchEvent("keyup", event);
      }
      await expect.poll(() => egoDirection(page)).toBe(0);
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
    await expect(await gameHint(page, "prompt-hint")).toBeVisible();
    await page.mouse.move(0, 0);
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

function directionFrom(rows: readonly string[]): number {
  const value = /^Direction:\s*(\d+)/.exec(rows[5] ?? "");
  return value ? Number(value[1]) : -1;
}

async function egoDirection(page: Page): Promise<number> {
  const hook = await textHook(page);
  return directionFrom(hook.rows);
}

/**
 * Ego's x once a key has taken effect. A key reaches the worker a cycle or two
 * after the browser event, later on a loaded runner, so this waits until two
 * readings two cycles apart agree instead of assuming a fixed delay.
 */
async function settledEgoX(page: Page): Promise<number> {
  let settled = -1;
  await expect
    .poll(async () => {
      const before = (await textHook(page)).egoX;
      await waitForCycles(page, 2);
      settled = (await textHook(page)).egoX;
      return settled === before;
    })
    .toBe(true);
  return settled;
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
        load.view(0);animate.obj(0);set.view(0,0);position(0,60,120);draw(0);assignn(v99,1);step.size(0,v99);accept.input();
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
    if (hold) {
      const released = await settledEgoX(page);
      await waitForCycles(page, 4);
      expect((await textHook(page)).egoX).toBe(released);
    } else {
      const released = (await textHook(page)).egoX;
      await waitForCycles(page, 4);
      expect((await textHook(page)).egoX).toBeGreaterThan(released);
      await page.keyboard.press("ArrowRight");
      const stopped = await settledEgoX(page);
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
      load.view(0);animate.obj(0);set.view(0,0);position(0,60,120);draw(0);assignn(v99,1);step.size(0,v99);accept.input();hold.key();
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
