/**
 * The Amiga menu strip in the browser (docs/fidelity.md "Original native
 * menu dispatch"): holding the right mouse button over the screen opens
 * Intuition's strip in place of the title bar, the pull-down follows the
 * pointer, and releasing over an item hands its controller to the game.
 * Touch has no right button, so a Menu button and a long press on the
 * title bar open a strip that stays until a tap or Esc (host access, not
 * original behavior). The save dialog is the original slot window with
 * OK and Cancel gadgets.
 */
import { test, expect } from "./test.ts";
import type { Page } from "@playwright/test";
import { isolateStorage, textHook, waitForCycles } from "./engineProbe.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/archive/zip.ts";
import { crtFramePoint } from "../src/three/crtAmount.ts";

test.use({ keepDetectedProfileOption: false });

const PROFILE = "amiga-2.202";
/** Frame pixels: the File title (LeftEdge 56..95), its Restore item, its Restart item, open space. */
const FILE_TITLE = { x: 70, y: 4 };
const RESTORE_ITEM = { x: 70, y: 25 };
const RESTART_ITEM = { x: 70, y: 44 };
const OUTSIDE = { x: 200, y: 150 };
/** The restart confirmation's Restart gadget (x 88..151, y 91..102; confirm-gadgets.spec.ts). */
const RESTART_GADGET = { x: 119, y: 96 };
/** The slot window's Cancel gadget (x 240..295, y 147..158). */
const SAVE_CANCEL = { x: 267, y: 152 };

function menuGame(): Buffer {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
         set(f200);
         configure.screen(1, 22, 0);
         load.pic(v250); draw.pic(v250); show.pic();
         set.game.id("sq2");
         if (!isset(f6)) {
           set.menu("Sierra");
           set.menu.item("About SQ2", 21);
           set.menu.item("Help     ", 2);
           set.menu("File");
           set.menu.item("Save     <F5>", 3);
           set.menu.item("Restore  <F7>", 5);
           set.menu.item("-------------", 20);
           set.menu.item("Restart  <F9>", 7);
           submit.menu();
           disable.item(20);
         }
         set(f14);
         status.line.on();
         set.key(0, 59, 3); set.key(0, 60, 9);
         if (isset(f6)) { display(2, 0, "RESTARTED"); } else { display(2, 0, "READY"); }
       }
       if (controller(c3)) { save.game(); display(3, 0, "SAVE DONE"); }
       if (controller(c5)) { display(3, 0, "RESTORE PICKED"); }
       if (controller(c7)) { restart.game(); }
       if (controller(c9)) { reset(f14); display(4, 0, "MENU OFF"); }
       return;`,
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource("picture", 0, Uint8Array.of(0xff));
  game.putFile("WORDS.TOK", new Uint8Array(52));
  const files = [...game.files].map(([name, data]) => ({ name, data }));
  return Buffer.from(buildZip(files));
}

async function bootMenuGame(page: Page, name: string, crtAmount = 0): Promise<void> {
  await isolateStorage(page);
  await page.addInitScript((crt) => {
    localStorage.setItem("monotio_agi.crtAmount", String(crt));
    // Record whether the game surface kept the browser's context menu away.
    document.addEventListener("contextmenu", (ev) => {
      (window as unknown as { __contextMenus: boolean[] }).__contextMenus ??= [];
      (window as unknown as { __contextMenus: boolean[] }).__contextMenus.push(ev.defaultPrevented);
    });
  }, crtAmount);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: `${name}.zip`,
    mimeType: "application/zip",
    buffer: menuGame(),
  });
  const picker = page.getByTestId("profile-picker-dialog");
  await expect(picker).toBeVisible();
  await page.getByTestId("profile-picker-select").selectOption(PROFILE);
  await page.getByTestId("profile-picker-confirm").click();
  await expect(picker).toBeHidden();
  await page
    .locator("[data-testid^='saved-game-card-']", { hasText: name })
    .getByTestId("btn-resume-cached")
    .click();
  await expect.poll(async () => (await textHook(page)).profile).toBe(PROFILE);
  await expect.poll(async () => (await textHook(page)).rows[2] ?? "").toContain("READY");
  await waitForCycles(page, 2);
}

/** The page position of frame pixel (x, y), offset by half a pixel so the floor lands on it. */
async function framePoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.locator(".screen").boundingBox();
  if (!box) throw new Error("no visible game surface");
  return {
    x: box.x + ((x + 0.5) * box.width) / 320,
    y: box.y + ((y + 0.5) * box.height) / 200,
  };
}

/**
 * The canvas reaches its new size a pass after a viewport change — the
 * stage's fit lands through a resize observer — so a point computed from a
 * box read mid-pass lands on the wrong frame pixel and the strip opens on
 * no title. Settled means the screen's box held still across two animation
 * frames.
 */
async function settleScreen(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const el = document.querySelector(".screen");
        if (!el) return resolve();
        let last = "";
        let stable = 0;
        const sample = () => {
          const r = el.getBoundingClientRect();
          const box = `${r.x},${r.y},${r.width},${r.height}`;
          stable = box === last ? stable + 1 : 0;
          last = box;
          if (stable >= 2) resolve();
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
}

/** A probe-canvas pixel as [r, g, b], after the presented frame count settles. */
async function framePixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    async ([px, py]) => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const c = document.querySelector<HTMLCanvasElement>("[data-testid='game-canvas']")!;
      const d = c.getContext("2d")!.getImageData(px!, py!, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!];
    },
    [x, y],
  );
}

const modal = async (page: Page) => (await textHook(page)).modal;
const row = async (page: Page, r: number) => (await textHook(page)).rows[r] ?? "";

test("holding the right mouse button opens the strip, the released item acts, and no browser menu appears @webkit-desktop", async ({
  page,
}) => {
  await bootMenuGame(page, "amiga-menu-mouse");
  const title = await framePoint(page, FILE_TITLE.x, FILE_TITLE.y);
  await page.mouse.move(title.x, title.y);
  await page.mouse.down({ button: "right" });
  await expect.poll(() => modal(page)).toBe("menu");
  // The strip replaced the title bar: the File title is complemented (pen 0
  // at its LeftEdge + 1), and the pull-down's top line crosses row 9.
  await expect.poll(() => framePixel(page, 57, 2)).toEqual([0, 0, 0]);
  await expect.poll(() => framePixel(page, 100, 9)).toEqual([0, 0, 0]);
  await expect.poll(() => framePixel(page, 300, 5)).toEqual([255, 255, 255]);
  const item = await framePoint(page, RESTORE_ITEM.x, RESTORE_ITEM.y);
  await page.mouse.move(item.x, item.y, { steps: 4 });
  // The Restore item's select box is complemented while the pointer is on it.
  await expect.poll(() => framePixel(page, 60, 23)).toEqual([0, 0, 0]);
  await page.mouse.up({ button: "right" });
  await expect.poll(() => modal(page)).toBeNull();
  await expect.poll(() => row(page, 3)).toContain("RESTORE PICKED");
  // The title bar is back and the browser never showed its own menu.
  await expect.poll(() => framePixel(page, 100, 9)).toEqual([255, 255, 255]);
  const contextMenus = await page.evaluate(
    () => (window as unknown as { __contextMenus?: boolean[] }).__contextMenus ?? [],
  );
  expect(contextMenus.length).toBeGreaterThan(0);
  expect(contextMenus.every((prevented) => prevented)).toBe(true);
});

test("restart from the strip keeps the strip", async ({ page }) => {
  // Player-visible rule: after Restart the game's menu is still there. The
  // game builds its strip only while f6 is clear; the original keeps it
  // across the accepted restart and enables every item (docs/fidelity.md
  // "Original menu across restart and restore").
  await bootMenuGame(page, "amiga-menu-restart");
  const title = await framePoint(page, FILE_TITLE.x, FILE_TITLE.y);
  await page.mouse.move(title.x, title.y);
  await page.mouse.down({ button: "right" });
  await expect.poll(() => modal(page)).toBe("menu");
  const restart = await framePoint(page, RESTART_ITEM.x, RESTART_ITEM.y);
  await page.mouse.move(restart.x, restart.y, { steps: 4 });
  await page.mouse.up({ button: "right" });
  await expect.poll(() => modal(page)).toBe("print");
  await expect.poll(() => row(page, 9)).toContain("Restart the game?");
  const gadget = await framePoint(page, RESTART_GADGET.x, RESTART_GADGET.y);
  await page.mouse.click(gadget.x, gadget.y);
  await expect.poll(() => row(page, 2)).toContain("RESTARTED");
  await expect.poll(() => modal(page)).toBeNull();
  await waitForCycles(page, 2);
  await page.mouse.move(title.x, title.y);
  await page.mouse.down({ button: "right" });
  await expect.poll(() => modal(page)).toBe("menu");
  const restore = await framePoint(page, RESTORE_ITEM.x, RESTORE_ITEM.y);
  await page.mouse.move(restore.x, restore.y, { steps: 4 });
  await page.mouse.up({ button: "right" });
  await expect.poll(() => modal(page)).toBeNull();
  await expect.poll(() => row(page, 3)).toContain("RESTORE PICKED");
});

test("releasing off the strip cancels, and the strip stays shut once the game clears f14", async ({
  page,
}) => {
  await bootMenuGame(page, "amiga-menu-gate");
  const title = await framePoint(page, FILE_TITLE.x, FILE_TITLE.y);
  const outside = await framePoint(page, OUTSIDE.x, OUTSIDE.y);
  await page.mouse.move(title.x, title.y);
  await page.mouse.down({ button: "right" });
  await expect.poll(() => modal(page)).toBe("menu");
  await page.mouse.move(outside.x, outside.y, { steps: 4 });
  await page.mouse.up({ button: "right" });
  await expect.poll(() => modal(page)).toBeNull();
  await waitForCycles(page, 2);
  expect(await row(page, 3)).not.toContain("PICKED");
  // The help names the right button only while the game offers its menu.
  await page.getByTestId("game-keys").click();
  await expect(page.getByTestId("game-key-help")).toBeVisible();
  await expect(page.getByText("Hold the right mouse button for the game menu")).toBeVisible();
  await page.locator(".screen").click();
  await page.keyboard.press("F2");
  await expect.poll(() => row(page, 4)).toContain("MENU OFF");
  await page.mouse.move(title.x, title.y);
  await page.mouse.down({ button: "right" });
  await waitForCycles(page, 2);
  expect(await modal(page)).toBeNull();
  await page.mouse.up({ button: "right" });
  await page.getByTestId("game-keys").click();
  await expect(page.getByTestId("game-key-help")).toBeVisible();
  await expect(page.getByText("Hold the right mouse button for the game menu")).toHaveCount(0);
});

test("the Amiga save dialog shows the original slot window and its Cancel gadget closes it", async ({
  page,
}) => {
  await bootMenuGame(page, "amiga-menu-save");
  await page.locator(".screen").click();
  await page.keyboard.press("F1");
  await expect.poll(() => modal(page)).toBe("save");
  await expect.poll(() => row(page, 2)).toContain("Select the slot in which you wish");
  // The text hook shows the 0xbb pointer glyph as "#".
  expect(await row(page, 5)).toContain("#-");
  // The OK gadget fill (pen 2) and the Cancel gadget fill (pen 4) sit on the gadget rows.
  await expect.poll(() => framePixel(page, 30, 150)).toEqual([0, 136, 0]);
  await expect.poll(() => framePixel(page, 267, 150)).toEqual([204, 0, 0]);
  for (const viewport of [
    { width: 1063, height: 815 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await settleScreen(page);
    await page.screenshot({ path: test.info().outputPath(`save-dialog-${viewport.width}.png`) });
  }
  const cancel = await framePoint(page, SAVE_CANCEL.x, SAVE_CANCEL.y);
  await page.mouse.click(cancel.x, cancel.y);
  await expect.poll(() => modal(page)).toBeNull();
  await expect.poll(() => row(page, 3)).toContain("SAVE DONE");
});

test("desktop screenshots of the open strip at 1063x815 and 1440x900", async ({ page }) => {
  await bootMenuGame(page, "amiga-menu-shots");
  for (const viewport of [
    { width: 1063, height: 815 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await settleScreen(page);
    const title = await framePoint(page, FILE_TITLE.x, FILE_TITLE.y);
    await page.mouse.move(title.x, title.y);
    await page.mouse.down({ button: "right" });
    await expect.poll(() => modal(page)).toBe("menu");
    const item = await framePoint(page, RESTORE_ITEM.x, RESTORE_ITEM.y);
    await page.mouse.move(item.x, item.y, { steps: 4 });
    await expect.poll(() => framePixel(page, 60, 23)).toEqual([0, 0, 0]);
    await page.screenshot({ path: test.info().outputPath(`menu-${viewport.width}.png`) });
    const outside = await framePoint(page, OUTSIDE.x, OUTSIDE.y);
    await page.mouse.move(outside.x, outside.y, { steps: 4 });
    await page.mouse.up({ button: "right" });
    await expect.poll(() => modal(page)).toBeNull();
  }
});

test.describe(() => {
  // The pointer reads the glass only when the GPU stage draws it.
  test.use({ gpuStage: true });

  /**
   * The page position whose CRT-warped sample lands on the centre of frame
   * pixel (x, y) at the given amount: the point where the player sees that
   * pixel on the curved glass.
   */
  async function glassPoint(
    page: Page,
    x: number,
    y: number,
    amount: number,
  ): Promise<{ x: number; y: number }> {
    const box = await page.getByTestId("gpu-canvas").boundingBox();
    if (!box) throw new Error("no visible GPU canvas");
    let u = 0.5 + ((x + 0.5) / 320 - 0.5) / 1.2;
    let v = 0.5 + ((y + 0.5) / 200 - 0.5) / 1.2;
    for (let i = 0; i < 100; i++) {
      const sampled = crtFramePoint(u, v, amount);
      if (!sampled) throw new Error(`glass point for ${x},${y} left the frame`);
      u += (x + 0.5 - sampled.x) / 320 / 1.2;
      v += (y + 0.5 - sampled.y) / 200 / 1.2;
    }
    return { x: box.x + u * box.width, y: box.y + v * box.height };
  }

  test("at full CRT the pull-down row under the pointer on the glass is the one chosen", async ({
    page,
  }) => {
    await bootMenuGame(page, "amiga-menu-crt", 1);
    await expect(page.getByTestId("gpu-canvas")).toBeVisible();
    await settleScreen(page);
    // Where the glass shows the Save row (frame 70,17), a straight map of the
    // pointer reads frame 81,27: the Restore row, one row and more below.
    const title = await glassPoint(page, FILE_TITLE.x, FILE_TITLE.y, 1);
    const save = await glassPoint(page, 70, 17, 1);
    await page.mouse.move(title.x, title.y);
    await page.mouse.down({ button: "right" });
    await expect.poll(() => modal(page)).toBe("menu");
    await page.mouse.move(save.x, save.y, { steps: 4 });
    await page.mouse.up({ button: "right" });
    await expect.poll(() => modal(page)).toBe("save");
    await expect.poll(() => row(page, 2)).toContain("Select the slot in which you wish");
    expect(await row(page, 3)).not.toContain("PICKED");
  });
});

test.describe(() => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("touch: the Menu button and a long press on the title bar open a held strip that taps drive @phone", async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem("monotio_agi.touchControls", "on"));
    await bootMenuGame(page, "amiga-menu-touch");
    const pad = page.getByTestId("touch-controls");
    await expect(pad.getByTestId("touch-menu")).toBeVisible();
    await pad.getByTestId("touch-menu").tap();
    await expect.poll(() => modal(page)).toBe("menu");
    // A tap on a title switches to it; the strip stays open without a button.
    const title = await framePoint(page, FILE_TITLE.x, FILE_TITLE.y);
    await page.touchscreen.tap(title.x, title.y);
    await expect.poll(() => framePixel(page, 57, 2)).toEqual([0, 0, 0]);
    await page.screenshot({ path: test.info().outputPath("menu-390.png") });
    // No second Menu button while the strip is open.
    await expect(pad.getByTestId("touch-menu")).toHaveCount(0);
    const item = await framePoint(page, RESTORE_ITEM.x, RESTORE_ITEM.y);
    await page.touchscreen.tap(item.x, item.y);
    await expect.poll(() => modal(page)).toBeNull();
    await expect.poll(() => row(page, 3)).toContain("RESTORE PICKED");
    // A tap beside the strip cancels; Esc on the pad cancels too.
    await pad.getByTestId("touch-menu").tap();
    await expect.poll(() => modal(page)).toBe("menu");
    const outside = await framePoint(page, OUTSIDE.x, OUTSIDE.y);
    await page.touchscreen.tap(outside.x, outside.y);
    await expect.poll(() => modal(page)).toBeNull();
    // A long press on the title bar (host access) opens the strip as well.
    const bar = await framePoint(page, 150, 4);
    const init = {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 7,
      clientX: bar.x,
      clientY: bar.y,
      button: 0,
      bubbles: true,
    };
    await page.locator(".screen").dispatchEvent("pointerdown", init);
    await expect.poll(() => modal(page), { timeout: 5000 }).toBe("menu");
    await page.locator(".screen").dispatchEvent("pointerup", init);
    await pad.getByRole("button", { name: "Esc", exact: true }).tap();
    await expect.poll(() => modal(page)).toBeNull();
    // Once the game withdraws its menu, the button goes with it.
    await pad.getByText("Keys", { exact: true }).tap();
    await pad.getByRole("button", { name: "F2", exact: true }).tap();
    await expect.poll(() => row(page, 4)).toContain("MENU OFF");
    await expect(pad.getByTestId("touch-menu")).toHaveCount(0);
  });

  test("touch: the save dialog's slot lines and gadgets answer taps @phone", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("monotio_agi.touchControls", "on"));
    await bootMenuGame(page, "amiga-save-touch");
    const pad = page.getByTestId("touch-controls");
    await pad.getByText("Keys", { exact: true }).tap();
    await pad.getByRole("button", { name: "F1", exact: true }).tap();
    await expect.poll(() => modal(page)).toBe("save");
    await page.screenshot({ path: test.info().outputPath("save-dialog-390.png") });
    // Tapping a slot line selects it, like the original's line gadgets: the
    // describe window opens; its Cancel gadget (x 224..279, y 107..118) closes
    // the dialog without a write.
    const slot3 = await framePoint(page, 100, 7 * 8 + 4);
    await page.touchscreen.tap(slot3.x, slot3.y);
    await expect.poll(() => row(page, 8)).toContain("How would you like to describe");
    const cancel = await framePoint(page, 250, 112);
    await page.touchscreen.tap(cancel.x, cancel.y);
    await expect.poll(() => modal(page)).toBeNull();
    await expect.poll(() => row(page, 3)).toContain("SAVE DONE");
  });
});
