/**
 * The right mouse button has one owner at a time on an Amiga game: Create
 * owns it for the room's actions while its mode is on stage, and Play hands
 * it back — to Intuition's menu strip while the game offers one, or to the
 * game's own double-click word once the strip is withdrawn. Ownership
 * follows the mode itself: the workspace's chunk loads lazily and its
 * retained editor tabs keep it mounted in Play, so the owner can never be
 * the component's lifetime.
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

/**
 * A mode switch refits .screen through the stage's ResizeObserver a frame or
 * two after the shell's class lands (stageBox → --game-width, PlayArea.vue),
 * so a framePoint read in between still gets the previous mode's box.
 * Settled means the box held still across two animation frames.
 */
async function screenBoxSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const screen = document.querySelector(".screen");
    if (!screen) throw new Error("no visible game surface");
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let last = screen.getBoundingClientRect();
    let held = 0;
    for (let frames = 0; held < 2; frames++) {
      if (frames >= 120) throw new Error("the .screen box never settled");
      await frame();
      const now = screen.getBoundingClientRect();
      held =
        now.x === last.x &&
        now.y === last.y &&
        now.width === last.width &&
        now.height === last.height
          ? held + 1
          : 0;
      last = now;
    }
  });
}

/**
 * PointerEvent init for a synthetic right press on .screen: the browser's own
 * contextmenu — fired at the press on macOS and Linux — never runs, so the
 * owner the press records stays waiting for one.
 */
function rightPointerInit(at: { x: number; y: number }): PointerEventInit {
  return {
    button: 2,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    clientX: at.x,
    clientY: at.y,
    bubbles: true,
  };
}

const modal = async (page: Page) => (await textHook(page)).modal;
const row = async (page: Page, r: number) => (await textHook(page)).rows[r] ?? "";

/** Every contextmenu the page saw, in order — true means the game surface kept the browser's menu off. */
const contextMenus = (page: Page) =>
  page.evaluate(() => (window as unknown as { __contextMenus?: boolean[] }).__contextMenus ?? []);

/** The workspace's own mount: its game bar lands once Create is on stage. */
async function createMounted(page: Page): Promise<void> {
  await enterCreateMode(page);
  await expect(page.getByTestId("workspace-game-bar")).toBeVisible({
    timeout: FIRST_LOAD_BUDGET_MS,
  });
}

/** Keep an editor tab open so the retained workspace stays mounted through Play. */
async function retainPictureEditor(page: Page): Promise<void> {
  const show = page.getByTestId("workspace-show-game");
  if (await show.isVisible()) await show.click();
  await page.getByRole("button", { name: "PICTURE 0", exact: true }).click();
  await expect(page.getByTestId("picture-studio")).toBeVisible({ timeout: FIRST_LOAD_BUDGET_MS });
}

/** The room menu's open state, read live from the app's own module. */
async function roomMenuState(page: Page): Promise<{ open: boolean }> {
  return page.evaluate(async () => {
    const menu = await import("/src/play/roomActionMenu.ts");
    return { open: menu.gameRoomMenu.value !== undefined };
  });
}

/**
 * A real MouseEvent contextmenu on a selector: locator.dispatchEvent builds
 * a plain Event for this type, so the button would never reach the handler.
 */
async function contextMenuOn(
  page: Page,
  selector: string,
  at: { x: number; y: number },
  button: number,
): Promise<void> {
  await page.evaluate(
    ({ selector, at, button }) => {
      const target = document.querySelector(selector);
      if (!target) throw new Error(`no element for ${selector}`);
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          button,
          clientX: at.x,
          clientY: at.y,
          bubbles: true,
          // A real contextmenu is cancelable; without this preventDefault()
          // is a no-op and the recording would read defaultPrevented false.
          cancelable: true,
        }),
      );
    },
    { selector, at, button },
  );
}

test("in Create a right-click on the game offers only the room's actions @webkit-desktop", async ({
  page,
}) => {
  await bootMenuGame(page, "right-owner-create");
  await createMounted(page);
  await screenBoxSettled(page);
  const at = await framePoint(page, 160, 100);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const menu = page.getByTestId("game-room-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Door", exact: true })).toBeVisible();
  // The native strip never opened: the engine shows no menu modal and the
  // room menu is the gesture's only answer.
  await waitForCycles(page, 2);
  expect(await modal(page)).toBeNull();
  const menus = await contextMenus(page);
  expect(menus.length).toBeGreaterThan(0);
  expect(menus.every((prevented) => prevented)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("Create owns the right button from the mode switch, before its workspace mounts @webkit-desktop", async ({
  page,
}) => {
  await bootMenuGame(page, "right-owner-early");
  // Hold the workspace's module back so the press lands while the chunk is
  // still loading: the mode itself must own the button, not the mounted
  // component.
  let releaseWorkspace!: () => void;
  const workspaceGate = new Promise<void>((resolve) => (releaseWorkspace = resolve));
  await page.route("**/src/studio/workspace/CreateWorkspace.vue*", async (route) => {
    await workspaceGate;
    await route.continue();
  });
  await enterCreateMode(page);
  await expect(page.getByTestId("workspace-game-bar")).toHaveCount(0);
  // The press lands only once Create's layout has refit .screen: until the
  // stage's ResizeObserver answer arrives its box still shows Play's stage.
  await screenBoxSettled(page);

  const at = await framePoint(page, 160, 100);
  await page.mouse.click(at.x, at.y, { button: "right" });
  // Create already owns the press: its room menu answers, the native strip
  // never opens, and the browser's own menu stays off the game.
  await expect.poll(async () => (await roomMenuState(page)).open).toBe(true);
  expect(await modal(page)).toBeNull();
  const menus = await contextMenus(page);
  expect(menus.length).toBeGreaterThan(0);
  expect(menus.every((prevented) => prevented)).toBe(true);

  releaseWorkspace();
  await expect(page.getByTestId("workspace-game-bar")).toBeVisible({
    timeout: FIRST_LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId("game-room-menu")).toBeVisible();
});

test("with an editor tab retained Play's right-drag picks a native menu item @webkit-desktop", async ({
  page,
}) => {
  await bootMenuGame(page, "right-owner-play");
  await createMounted(page);
  await retainPictureEditor(page);
  await playFromCreate(page);
  await waitForCycles(page, 2);
  await screenBoxSettled(page);

  const title = await framePoint(page, FILE_TITLE.x, FILE_TITLE.y);
  await page.mouse.move(title.x, title.y);
  await page.mouse.down({ button: "right" });
  await expect.poll(() => modal(page)).toBe("menu");
  const item = await framePoint(page, RESTORE_ITEM.x, RESTORE_ITEM.y);
  await page.mouse.move(item.x, item.y, { steps: 4 });
  await page.mouse.up({ button: "right" });
  await expect.poll(() => modal(page)).toBeNull();
  await expect.poll(() => row(page, 3)).toContain("RESTORE PICKED");
  // "RESTORE PICKED" proves the strip answered the drag; it does not prove
  // the gesture never touched Create. The room menu has no visible surface
  // in Play, so that narrower guarantee comes from the module state: no
  // room menu was ever opened.
  expect(await roomMenuState(page)).toEqual({ open: false });
});

test("a mode switch mid right-drag keeps the gesture's first owner @webkit-desktop", async ({
  page,
}) => {
  await bootMenuGame(page, "right-owner-mid-gesture");
  await createMounted(page);
  await playFromCreate(page);
  await waitForCycles(page, 2);

  const title = await framePoint(page, FILE_TITLE.x, FILE_TITLE.y);
  // A synthetic press keeps the browser's own contextmenu — fired at the
  // press on macOS and Linux — out of the gesture, so the one dispatched
  // after the release is the gesture's own, as on Windows.
  const screen = page.locator(".screen");
  await screen.dispatchEvent("pointerdown", rightPointerInit(title));
  await expect.poll(() => modal(page)).toBe("menu");
  // Escape closes the strip so the switch can land — Create refuses a game
  // mid-question — while the button stays down.
  await page.keyboard.press("Escape");
  await expect.poll(() => modal(page)).toBeNull();
  // Back lands on the Create entry mid-gesture; the drag is still held.
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/#create\//);
  await expect(page.getByTestId("workspace-game-bar")).toBeVisible();
  await screenBoxSettled(page);
  const at = await framePoint(page, 160, 100);
  await screen.dispatchEvent("pointerup", rightPointerInit(at));
  // Where contextmenu follows the release (Windows), it still honours the
  // press's owner — never re-aimed at Create's room menu.
  await contextMenuOn(page, ".screen", at, 2);
  await expect(page.getByTestId("game-room-menu")).toBeHidden();
  expect(await roomMenuState(page)).toEqual({ open: false });
});

test("a Create right press loses its room action when Play begins before contextmenu @webkit-desktop", async ({
  page,
}) => {
  await bootMenuGame(page, "right-owner-create-to-play");
  await createMounted(page);
  await retainPictureEditor(page);
  await screenBoxSettled(page);
  const screen = page.locator(".screen");
  const at = await framePoint(page, 160, 100);
  // Delay the Windows contextmenu until after the Create owner has left.
  await screen.dispatchEvent("pointerdown", rightPointerInit(at));
  await playFromCreate(page);
  await screen.dispatchEvent("pointerup", rightPointerInit(at));
  await contextMenuOn(page, ".screen", at, 2);
  expect((await contextMenus(page)).at(-1)).toBe(true);
  expect(await roomMenuState(page)).toEqual({ open: false });
  expect(await modal(page)).toBeNull();

  await createMounted(page);
  await expect(page.getByTestId("game-room-menu")).toBeHidden();
  expect(await roomMenuState(page)).toEqual({ open: false });
  // Retiring the old action leaves a fresh right-click available in Create.
  await screenBoxSettled(page);
  const fresh = await framePoint(page, 160, 100);
  await page.mouse.click(fresh.x, fresh.y, { button: "right" });
  await expect(page.getByTestId("game-room-menu")).toBeVisible();
});

test("a keyboard context menu asks the mode on stage, not a stale press's owner @webkit-desktop", async ({
  page,
}) => {
  await bootMenuGame(page, "right-owner-keyboard");
  const screen = page.locator(".screen");
  const at = await framePoint(page, 160, 100);
  // A right press in Play records the strip's owner for its gesture. The
  // synthetic pointer events keep the browser's own contextmenu — fired at
  // the press on macOS and Linux — out of the gesture, so the recorded
  // owner is still waiting when the keyboard event arrives.
  await screen.dispatchEvent("pointerdown", rightPointerInit(at));
  await expect.poll(() => modal(page)).toBe("menu");
  // The release over no item closes the strip; on Windows its contextmenu
  // would land here, which this gesture never sends.
  await screen.dispatchEvent("pointerup", rightPointerInit(at));
  await expect.poll(() => modal(page)).toBeNull();
  await createMounted(page);
  // Shift+F10 on the input line fires contextmenu (button 0) with no press
  // behind it: the mode on stage answers, so Create's room menu opens rather
  // than the silence the Play press recorded.
  await contextMenuOn(page, "#game-command", at, 0);
  const menu = page.getByTestId("game-room-menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // The other direction: a right press in Create records the room menu's
  // owner, then a keyboard contextmenu in Play must not reopen the room
  // menu while Create is off stage — the Amiga strip owns the answer and
  // swallows the browser menu.
  await screen.dispatchEvent("pointerdown", rightPointerInit(at));
  await screen.dispatchEvent("pointerup", rightPointerInit(at));
  await playFromCreate(page);
  await waitForCycles(page, 2);
  await contextMenuOn(page, "#game-command", at, 0);
  expect(await roomMenuState(page)).toEqual({ open: false });
  expect((await contextMenus(page)).at(-1)).toBe(true);
});

test("a room menu asked for before the workspace mounts does not outlive Create @webkit-desktop", async ({
  page,
}) => {
  await bootMenuGame(page, "right-owner-early-leave");
  // Hold the workspace's module back so the request lands while the chunk is
  // still loading.
  let releaseWorkspace!: () => void;
  const workspaceGate = new Promise<void>((resolve) => (releaseWorkspace = resolve));
  await page.route("**/src/studio/workspace/CreateWorkspace.vue*", async (route) => {
    await workspaceGate;
    await route.continue();
  });
  await enterCreateMode(page);
  await expect(page.getByTestId("workspace-game-bar")).toHaveCount(0);
  // The press lands only once Create's layout has refit .screen: until the
  // stage's ResizeObserver answer arrives its box still shows Play's stage.
  await screenBoxSettled(page);

  const at = await framePoint(page, 160, 100);
  await page.mouse.click(at.x, at.y, { button: "right" });
  // The room map chunk loads lazily too; its first load gets the full budget.
  await expect
    .poll(async () => (await roomMenuState(page)).open, { timeout: FIRST_LOAD_BUDGET_MS })
    .toBe(true);

  // Leaving Create before its workspace mounts takes the request with it.
  await playFromCreate(page);
  releaseWorkspace();
  await expect.poll(async () => (await roomMenuState(page)).open).toBe(false);

  // The next Create entry opens clean — no menu at the old spot.
  await createMounted(page);
  expect(await roomMenuState(page)).toEqual({ open: false });
  await expect(page.getByTestId("game-room-menu")).toBeHidden();
});

test("with the strip withdrawn Play's right double-click still reaches the game @webkit-desktop", async ({
  page,
}) => {
  await bootMenuGame(page, "right-owner-fallback");
  await createMounted(page);
  await retainPictureEditor(page);
  await playFromCreate(page);
  await screenBoxSettled(page);
  // The game withdraws its menu: Intuition's strip can no longer open, so
  // the right double-click belongs to the game again.
  await page.locator(".screen").click();
  await page.keyboard.press("F2");
  await expect.poll(() => row(page, 4)).toContain("MENU OFF");
  const at = await framePoint(page, 160, 100);
  await page.mouse.dblclick(at.x, at.y, { button: "right" });
  await expect.poll(() => modal(page)).toBe("print");
});
