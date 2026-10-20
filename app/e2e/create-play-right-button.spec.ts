/**
 * The right mouse button has one owner at a time on an Amiga game (review
 * F7): Create owns it for the room's actions while its workspace is on
 * stage, and Play hands it back — to Intuition's menu strip while the game
 * offers one, or to the game's own double-click word once the strip is
 * withdrawn. The workspace's retained editor tabs keep it mounted in Play,
 * so ownership follows the mode, never the component's lifetime.
 */
import { test, expect } from "./test.ts";
import type { Page } from "@playwright/test";
import {
  FIRST_LOAD_BUDGET_MS,
  enterCreateMode,
  isolateStorage,
  playFromCreate,
  textHook,
  waitForCycles,
} from "./engineProbe.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/archive/zip.ts";

test.use({ keepDetectedProfileOption: false });

const PROFILE = "amiga-2.202";
/** Frame pixels: the File title (LeftEdge 56..95) and its Restore item. */
const FILE_TITLE = { x: 70, y: 4 };
const RESTORE_ITEM = { x: 70, y: 25 };

/**
 * An Amiga game with a submitted strip (File → Restore), F2 withdrawing it,
 * and the right double-click word 0x0401 bound to a print, so each owner
 * leaves a different player-visible trace.
 */
function menuGame(title: string): Buffer {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
         set(f200);
         configure.screen(1, 22, 0);
         load.pic(v250); draw.pic(v250); show.pic();
         set.game.id("${title}");
         set.menu("Sierra");
         set.menu.item("About", 21);
         set.menu("File");
         set.menu.item("Save     <F5>", 3);
         set.menu.item("Restore  <F7>", 5);
         set.menu.item("-------------", 20);
         set.menu.item("Restart  <F9>", 7);
         submit.menu();
         disable.item(20);
         set(f14);
         status.line.on();
         set.key(0, 59, 3); set.key(0, 60, 9);
         set.key(1, 4, 8);
         display(2, 0, "READY");
       }
       if (controller(c5)) { display(3, 0, "RESTORE PICKED"); }
       if (controller(c7)) { display(3, 0, "RESTART PICKED"); }
       if (controller(c8)) { print("RIGHT DOUBLE"); }
       if (controller(c9)) { reset(f14); display(4, 0, "MENU OFF"); }
       return;`,
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource("picture", 0, Uint8Array.of(0xff));
  game.putFile("WORDS.TOK", new Uint8Array(52));
  const files = new Map(game.files);
  files.set(
    "GAME.JSON",
    new TextEncoder().encode(
      JSON.stringify({ format: "monotio.agi", version: 1, title, profile: PROFILE }),
    ),
  );
  return Buffer.from(buildZip([...files].map(([name, data]) => ({ name, data }))));
}

async function bootMenuGame(page: Page, name: string): Promise<void> {
  await isolateStorage(page);
  await page.addInitScript(() => {
    localStorage.setItem("monotio_agi.crtAmount", "0");
    // Record whether the game surface kept the browser's context menu away.
    document.addEventListener("contextmenu", (ev) => {
      (window as unknown as { __contextMenus: boolean[] }).__contextMenus ??= [];
      (window as unknown as { __contextMenus: boolean[] }).__contextMenus.push(ev.defaultPrevented);
    });
  });
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: `${name}.zip`,
    mimeType: "application/zip",
    buffer: menuGame(name),
  });
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

const modal = async (page: Page) => (await textHook(page)).modal;
const row = async (page: Page, r: number) => (await textHook(page)).rows[r] ?? "";

/** Keep an editor tab open so the retained workspace stays mounted through Play. */
async function retainPictureEditor(page: Page): Promise<void> {
  const show = page.getByTestId("workspace-show-game");
  if (await show.isVisible()) await show.click();
  await page.getByRole("button", { name: "PICTURE 0", exact: true }).click();
  await expect(page.getByTestId("room-studio")).toBeVisible({ timeout: FIRST_LOAD_BUDGET_MS });
}

/** The module the gesture's owner lives in, read live from the app's own state. */
async function roomMenuState(page: Page): Promise<{ armed: boolean; open: boolean }> {
  return page.evaluate(async () => {
    const menu = await import("/src/play/roomActionMenu.ts");
    return { armed: menu.roomMenuArmed.value, open: menu.gameRoomMenu.value !== undefined };
  });
}

test("in Create a right-click on the game offers only the room's actions @webkit-desktop", async ({
  page,
}) => {
  await bootMenuGame(page, "right-owner-create");
  await enterCreateMode(page);
  const at = await framePoint(page, 160, 100);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const menu = page.getByTestId("game-room-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Door", exact: true })).toBeVisible();
  // The native strip never opened: the engine shows no menu modal and the
  // room menu is the gesture's only answer.
  await waitForCycles(page, 2);
  expect(await modal(page)).toBeNull();
  const contextMenus = await page.evaluate(
    () => (window as unknown as { __contextMenus?: boolean[] }).__contextMenus ?? [],
  );
  expect(contextMenus.length).toBeGreaterThan(0);
  expect(contextMenus.every((prevented) => prevented)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("with an editor tab retained Play's right-drag picks a native menu item @webkit-desktop", async ({
  page,
}) => {
  await bootMenuGame(page, "right-owner-play");
  await enterCreateMode(page);
  await retainPictureEditor(page);
  await playFromCreate(page);
  await waitForCycles(page, 2);

  const title = await framePoint(page, FILE_TITLE.x, FILE_TITLE.y);
  await page.mouse.move(title.x, title.y);
  await page.mouse.down({ button: "right" });
  await expect.poll(() => modal(page)).toBe("menu");
  const item = await framePoint(page, RESTORE_ITEM.x, RESTORE_ITEM.y);
  await page.mouse.move(item.x, item.y, { steps: 4 });
  await page.mouse.up({ button: "right" });
  await expect.poll(() => modal(page)).toBeNull();
  await expect.poll(() => row(page, 3)).toContain("RESTORE PICKED");
  // The retained workspace never claimed the gesture: no room menu armed or opened.
  expect(await roomMenuState(page)).toEqual({ armed: false, open: false });
});

test("with the strip withdrawn Play's right double-click still reaches the game @webkit-desktop", async ({
  page,
}) => {
  await bootMenuGame(page, "right-owner-fallback");
  await enterCreateMode(page);
  await retainPictureEditor(page);
  await playFromCreate(page);
  // The game withdraws its menu: Intuition's strip can no longer open, so
  // the right double-click belongs to the game again.
  await page.locator(".screen").click();
  await page.keyboard.press("F2");
  await expect.poll(() => row(page, 4)).toContain("MENU OFF");
  const at = await framePoint(page, 160, 100);
  await page.mouse.dblclick(at.x, at.y, { button: "right" });
  await expect.poll(() => modal(page)).toBe("print");
});
