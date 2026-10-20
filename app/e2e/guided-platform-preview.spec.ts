import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import {
  FIRST_LOAD_BUDGET_MS,
  isolateStorage,
  openLibraryActions,
  savedGameCard,
} from "./engineProbe.ts";
import { clickContextAction } from "./workspaceShared.ts";
import { decodePng } from "../../scripts/png.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { buildZip } from "../src/archive/zip.ts";

test.use({ keepDetectedProfileOption: false });

const BOOT_SCRIPT =
  "if (!isset(f200)) { set(f200); load.pic(v0); draw.pic(v0); show.pic(); new.room(1); } return;";

// A synthetic Amiga 2.082 game: its palette's colour 13 is orange
// (255, 119, 0), not the PC table's magenta. The hero cel is one index-13
// pixel block so the placement standIn exposes its palette choice. Logic 0
// draws the picture and enters room 1 so the workspace's room actions show.
async function startAmiga(page: Page, logic0 = BOOT_SCRIPT): Promise<void> {
  await isolateStorage(page);
  await page.goto("/");
  const game = createContainer();
  game.putResource("picture", 0, Uint8Array.of(0xf0, 13, 0xf8, 0, 0, 0xff));
  game.putResource("logic", 0, assembleLogic(logic0, { dictionary: new Map() }).payload);
  game.putResource(
    "logic",
    1,
    assembleLogic("set.view(o0, 0); position(o0, 80, 140); draw(o0); return;", {
      dictionary: new Map(),
    }).payload,
  );
  const cel = {
    width: 4,
    height: 4,
    transparentColor: 0,
    pixels: Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 0 : 13)),
  };
  game.putResource("view", 0, buildView({ loops: [{ cels: [cel] }] }, PROFILES["amiga-2.082"]));
  game.putFile("WORDS.TOK", new Uint8Array(52));
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "amiga-guided.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(buildZip([...game.files].map(([name, data]) => ({ name, data })))),
  });
  const picker = page.getByTestId("profile-picker-dialog");
  await expect(picker).toBeVisible();
  await page.getByTestId("profile-picker-select").selectOption("amiga-2.082");
  await page.getByTestId("profile-picker-confirm").click();
  const card = savedGameCard(page, "amiga-guided");
  await expect(card.getByTestId("btn-resume-cached")).toBeVisible();
  await openLibraryActions(page, card);
  await page.getByTestId("edit-library-game").click();
  await expect(page.getByTestId("workspace-context")).toBeVisible({
    timeout: FIRST_LOAD_BUDGET_MS,
  });
  const show = page.getByTestId("workspace-show-game");
  if (await show.isVisible()) await show.click();
}

async function openMessagePreview(page: Page): Promise<Locator> {
  await clickContextAction(page, "room-action-response");
  const sentence = page.getByTestId("workspace-guided-form");
  await expect(sentence).toBeVisible();
  await sentence.getByLabel("When the player types…", { exact: true }).fill("look at sun");
  await sentence
    .getByLabel("The game says…", { exact: true })
    .fill("The sun shines above the clearing.");
  const preview = sentence.getByRole("img", { name: "Game message preview" });
  await expect(preview).toBeVisible();
  await preview.scrollIntoViewIfNeeded();
  await expect(preview).toHaveAttribute("data-ready", "true");
  return preview;
}

// First bright pixel row of the preview's letterboxed 320x200 frame, scaled
// back to frame pixels.
async function messageFillTop(preview: Locator): Promise<number> {
  const shot = await preview.screenshot();
  const { rgba, width: w, height: h } = decodePng(shot);
  const scale = h / 200;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (rgba[i]! > 200 && rgba[i + 1]! > 200 && rgba[i + 2]! > 200) return Math.round(y / scale);
    }
  return -1;
}

test("Amiga standIn and message preview use the game's own look", async ({ page }) => {
  const desktop = { width: 1063, height: 815 };
  await page.setViewportSize(desktop);
  await startAmiga(page);
  await clickContextAction(page, "room-action-place-hero");
  const form = page.getByTestId("workspace-guided-form");
  await expect(form).toBeVisible();
  await form.getByRole("button", { name: "Drag to place", exact: true }).click();
  const overlay = page.getByTestId("guided-placement");
  await expect(overlay).toBeVisible();
  const standIn = overlay.locator("canvas.placement-standIn");
  await expect(standIn).toBeVisible();
  // The standIn canvas paints the cel's index-13 pixels in the Amiga table.
  await expect
    .poll(() =>
      standIn.evaluate((el) =>
        Array.from((el as HTMLCanvasElement).getContext("2d")!.getImageData(1, 0, 1, 1).data),
      ),
    )
    .toEqual([255, 119, 0, 255]);
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({
      path: test.info().outputPath(`${width}-amiga-standIn.png`),
      animations: "disabled",
    });
  }
  await page.setViewportSize(desktop);
  await overlay.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(form).toBeVisible();
  await form.getByRole("button", { name: "Cancel", exact: true }).click();

  const preview = await openMessagePreview(page);
  // Amiga boot layout: the message window opens with the picture at row 0.
  // The message wraps to 2 lines at width 30: textTop = ((20-1-2)>>1)+1 = 9,
  // so the Amiga frame's inclusive fill top is 8*9 - 6 = 66 of 200 — a PC
  // build's would be 8*10 - 5 = 75.
  expect(await messageFillTop(preview)).toBe(66);
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({
      path: test.info().outputPath(`${width}-amiga-message.png`),
      animations: "disabled",
    });
  }
});

test("the message preview places the window at the game's configured picture row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  await startAmiga(
    page,
    "if (!isset(f200)) { set(f200); configure.screen(1, 22, 0); load.pic(v0); draw.pic(v0); show.pic(); new.room(1); } return;",
  );
  const preview = await openMessagePreview(page);
  // With the picture at row 1 the 2-line Amiga window centres at textTop 10,
  // so the inclusive fill top is 8*10 - 6 = 74.
  expect(await messageFillTop(preview)).toBe(74);
});
