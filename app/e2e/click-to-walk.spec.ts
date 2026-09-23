/**
 * Click-to-walk: a mouse click on the screen is pointer input for the
 * Amiga/IIgs profiles (it walks ego to the click) and ignored on PC profiles.
 * The game mirrors test/click-move.test.ts: ego is a 4-wide block parked at
 * (20, 100) with step size and time 1, so a click at frame (161, 108) walks
 * ego to x = 161/2 - 2 = 78.
 */
import { test, expect, type Page } from "@playwright/test";
import { isolateStorage, observe, textHook, waitForCycles } from "./engineProbe.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/zip.ts";

/** 1 loop, 1 cel: a solid width x height block of color 5. */
function solidView(width: number, height: number): Uint8Array {
  const rows = Array.from({ length: height }, () => [0x50 | width, 0]).flat();
  return new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, width, height, 0, ...rows]);
}

function clickGame(): Buffer {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
         set(f200);
         load.pic(v250); draw.pic(v250); show.pic();
         animate.obj(o0); load.view(0); set.view(o0, 0); position(o0, 20, 100);
         assignn(v251, 1); step.size(o0, v251); step.time(o0, v251); draw(o0);
       }
       return;`,
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource("picture", 0, Uint8Array.of(0xff));
  game.putResource("view", 0, solidView(4, 10));
  game.putFile("WORDS.TOK", new Uint8Array(52));
  const files = [...game.files].map(([name, data]) => ({ name, data }));
  return Buffer.from(buildZip(files));
}

async function importClickGame(page: Page, name: string): Promise<void> {
  await page.getByTestId("game-zip-input").setInputFiles({
    name: `${name}.zip`,
    mimeType: "application/zip",
    buffer: clickGame(),
  });
}

/** Boot the imported game under `profile` and wait for ego at (20, 100). */
async function bootClickGame(page: Page, name: string, profile: string): Promise<void> {
  await importClickGame(page, name);
  const picker = page.getByTestId("profile-picker-dialog");
  await expect(picker).toBeVisible();
  await page.getByTestId("profile-picker-select").selectOption(profile);
  await page.getByTestId("profile-picker-confirm").click();
  await expect(picker).toBeHidden();
  await page
    .locator(".saved-game-card", { hasText: name })
    .getByTestId("btn-resume-cached")
    .click();
  await expect.poll(async () => (await textHook(page)).profile).toBe(profile);
  await expect.poll(async () => (await textHook(page)).egoX).toBe(20);
  await waitForCycles(page, 2);
}

/** A mouse click at frame pixel (x, y) — offset by half a pixel so the floor lands on it exactly. */
async function clickFramePixel(page: Page, x: number, y: number): Promise<void> {
  const surface = page.locator(".game-surface:visible");
  const box = await surface.boundingBox();
  if (!box) throw new Error("no visible game surface");
  await page.mouse.click(
    box.x + ((x + 0.5) * box.width) / 320,
    box.y + ((y + 0.5) * box.height) / 200,
  );
}

test("a mouse click walks ego on the Amiga profile", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await bootClickGame(page, "click-walk-amiga", "amiga-2.316");

  await clickFramePixel(page, 161, 108);
  await expect.poll(async () => (await textHook(page)).egoX, { timeout: 20_000 }).toBe(78);
  expect((await textHook(page)).egoY).toBe(100);
});

test("the same click leaves ego still on a PC profile", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await bootClickGame(page, "click-walk-pc", "2.936");

  await clickFramePixel(page, 161, 108);
  await observe(page);
  expect((await textHook(page)).egoX).toBe(20);
});
