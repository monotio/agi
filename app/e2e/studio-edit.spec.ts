import { readFile } from "node:fs/promises";
import { expect, test } from "./test.ts";
import type { Locator, Page } from "@playwright/test";
import { testProjectId } from "../test/identity.ts";
import { readGameZip } from "../src/gameZip.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { createPictureSurface } from "../../src/types.ts";
import {
  cacheGame,
  enterCreateMode,
  openGameOptions,
  textHook,
  waitForCycles,
} from "./engineProbe.ts";

/**
 * Room Studio editing, end to end on the real app: a stored project whose
 * room 1 draws PIC 5 (never the room's own number). Expected planes are
 * decoded here with the engine's renderer from bytes read out of the page,
 * storage and the exported ZIP; cell values are hand-placed in SOURCE.
 */
test.use({ viewport: { width: 1440, height: 900 } });

const PROJECT = testProjectId("studio-edit");
/** Wall and floor, a bench frame, and a priority-10 occluder polygon filled inside. */
const SOURCE = [
  '# @item wall "Wall" art',
  "vis 7",
  "rect 0,0 159,111",
  "fill 80,40",
  "# @end",
  '# @item floor "Floor" art',
  "vis 8",
  "rect 0,112 159,167",
  "fill 80,140",
  "# @end",
  '# @item bench "Bench" art',
  "vis 6",
  "rect 44,92 116,104",
  "# @end",
  '# @item occluder "Bench occluder" depth',
  "vis off",
  "pri 10",
  "polygon 40,90 119,90 126,98 119,105 40,105",
  "fill 80,97",
  "# @end",
  "end",
].join("\n");
const POLYGON_LINE = SOURCE.split("\n").findIndex((line) => line.startsWith("polygon")) + 1;
const PIC_5 = compilePictureSource(SOURCE).bytes;

function studioGame() {
  const game = createContainer();
  const dictionary = new Map<string, number>();
  const logic = (source: string) => assembleLogic(source, { dictionary }).payload;
  game.putFile("WORDS.TOK", buildWordsTok([{ word: "look", id: 1 }]));
  game.putResource("picture", 5, PIC_5);
  game.putResource(
    "logic",
    0,
    logic("if(!isset(f200)){set(f200);accept.input();new.room(1);}call.v(v0);return;"),
  );
  game.putResource(
    "logic",
    1,
    logic(
      "if(isset(f5)){assignn(v30,5);load.pic(v30);draw.pic(v30);discard.pic(v30);show.pic();}return;",
    ),
  );
  return game;
}

async function bootStudioGame(page: Page): Promise<void> {
  await page.goto("/");
  await cacheGame(page, {
    projectId: PROJECT,
    title: "Studio edit fixture",
    provider: "stub",
    model: "stub",
    imported: false,
    roomGeneration: true,
    authoringState: {
      authoring: {
        version: 1,
        bindings: {},
        world: {
          rooms: { "1": { title: "Bench Hall", description: "A bench.", exits: {} } },
          facts: {},
          quests: {},
        },
      },
      sources: { logics: [], pictures: [[5, SOURCE]] },
    },
    files: Object.fromEntries(studioGame().files),
    words: [["look", 1]],
  });
  await page.reload();
  await resumeInRoom(page);
}

/** Resume the stored game, unless the page's route already reopened it. */
async function resumeInRoom(page: Page): Promise<void> {
  const resume = page.getByTestId("btn-resume-cached");
  await expect
    .poll(async () => (await resume.isVisible()) || (await textHook(page)).room === 1)
    .toBe(true);
  if (await resume.isVisible()) await resume.click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 2);
}

async function openStudio(page: Page): Promise<Locator> {
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId("map-room-1").click();
  await panel.getByTestId("world-open-studio").click();
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  return studio;
}

const draftBytes = async (page: Page): Promise<Uint8Array> =>
  Uint8Array.from(await page.evaluate(() => [...window.__AGI_STUDIO__!.bytes()]));

function planes(bytes: Uint8Array) {
  const surface = createPictureSurface();
  renderPicture(bytes, surface);
  return surface;
}
const at = (x: number, y: number) => y * 160 + x;

/** The latest presented frame's priority value at x,y (the engine's own plane). */
const framePriority = (page: Page, x: number, y: number): Promise<number | undefined> =>
  page.evaluate(([cx, cy]) => window.__AGI_FRAME__?.()?.priority[cy! * 160 + cx!], [x, y]);

async function storedFiles(page: Page): Promise<Map<string, Uint8Array>> {
  const files = await page.evaluate(async (id) => {
    const path = "/src/gameStorage.ts";
    const { loadAuthoredGame } = await import(path);
    const game = await loadAuthoredGame(id);
    return Object.fromEntries(
      Object.entries(game.files as Record<string, Uint8Array>).map(([name, bytes]) => [
        name,
        [...bytes],
      ]),
    );
  }, PROJECT);
  return new Map(Object.entries(files).map(([name, bytes]) => [name, Uint8Array.from(bytes)]));
}

async function storedPicture(page: Page, num: number): Promise<Uint8Array> {
  return openContainer(await storedFiles(page)).getResource("picture", num)!;
}

/** Drag the handle of point `index` on source `line` by dx,dy logical pixels. */
async function dragHandle(page: Page, line: number, index: number, dx: number, dy: number) {
  const pane = page.locator(".studio-pane").last();
  const zoom = (await pane.boundingBox())!.height / 168;
  const box = (await pane.locator(`[data-point="${line}:${index}"]`).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const steps = 6;
  for (let k = 1; k <= steps; k++)
    await page.mouse.move(x + (dx * 2 * zoom * k) / steps, y + (dy * zoom * k) / steps);
  await page.mouse.up();
}

test("a depth drag changes only the priority plane, undoes, keeps, reloads, exports and plays", async ({
  page,
}) => {
  await bootStudioGame(page);
  const studio = await openStudio(page);
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("No changes");
  const original = await draftBytes(page);
  expect(original).toEqual(PIC_5);

  // Depth lens, the occluder selected: its polygon and fill seed show handles.
  await page.keyboard.press("2");
  await studio.locator('[data-row="occluder"]').click();
  await expect(studio.locator("[data-handle]")).toHaveCount(6);
  await dragHandle(page, POLYGON_LINE, 2, 10, 0);
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  const dragged = await draftBytes(page);
  const before = planes(original);
  const after = planes(dragged);
  expect(after.visual).toEqual(before.visual);
  expect(after.priority).not.toEqual(before.priority);
  // The tip moved from 126,98 to 136,98: the fill now reaches 130,98.
  expect([before.priority[at(130, 98)], after.priority[at(130, 98)]]).toEqual([4, 10]);

  // One drag, one undo step: back to the stored bytes exactly.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("No changes");
  expect(await draftBytes(page)).toEqual(original);

  // Another edit from the keyboard: the occluder one row down.
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  const kept = await draftBytes(page);
  expect(planes(kept).priority[at(80, 106)]).toBe(10);
  expect(planes(kept).visual).toEqual(before.visual);
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
  await expect(studio.getByTestId("studio-notice")).toContainText("Kept PIC 5");
  expect(await storedPicture(page, 5)).toEqual(kept);

  // Room 1 draws PIC 5, so the live room re-enters and shows the new depth.
  await studio.getByTestId("studio-close").click();
  await expect(studio).toHaveCount(0);
  await expect.poll(() => framePriority(page, 80, 106)).toBe(10);

  // A reload boots the stored project: Studio opens on the kept bytes.
  await page.reload();
  await resumeInRoom(page);
  const reopened = await openStudio(page);
  expect(await draftBytes(page)).toEqual(kept);
  expect(await storedPicture(page, 5)).toEqual(kept);
  await reopened.getByTestId("studio-close").click();

  const downloading = page.waitForEvent("download");
  await openGameOptions(page, "settings-menu");
  await page.getByTestId("btn-export-game").click();
  const exported = await readGameZip(await readFile((await (await downloading).path())!));
  expect(openContainer(new Map(Object.entries(exported.files))).getResource("picture", 5)).toEqual(
    kept,
  );
  await page.keyboard.press("Escape");

  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect.poll(() => framePriority(page, 80, 106)).toBe(10);
  expect(await framePriority(page, 80, 90)).toBe(4);
});

test("a lock refusal, keyboard nudges, Delete with undo, and draw-order keys stay in Studio", async ({
  page,
}) => {
  await bootStudioGame(page);
  const studio = await openStudio(page);
  const canvas = studio.getByRole("group", { name: /^Canvas/ });
  const status = studio.getByTestId("studio-draft-status");
  const original = await draftBytes(page);

  // Art is locked in the Depth lens: moving the bench frame is refused, with
  // the count and box of the art cells it would change, and nothing changes.
  await page.keyboard.press("2");
  await studio.locator('[data-row="bench"]').click();
  await canvas.focus();
  await page.keyboard.press("ArrowUp");
  await expect(studio.getByTestId("studio-notice")).toHaveText(
    "Not changed: Art is locked in the Depth lens: 288 cells at 44,91..116,104 would change.",
  );
  await expect(studio.locator('[data-role="refused"]')).toHaveCount(1);
  await expect(status).toHaveText("No changes");
  // Unlocked for the session, the same nudge goes through.
  await studio.getByTestId("studio-unlock").click();
  await canvas.focus();
  await page.keyboard.press("ArrowUp");
  await expect(status).toHaveText("1 change");
  await page.keyboard.press("ControlOrMeta+z");
  await studio.getByTestId("studio-unlock").click();

  // Nudges: 1 px, and 8 with Shift, each one undo step.
  await studio.locator('[data-row="occluder"]').click();
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(status).toHaveText("2 changes");
  expect(await page.evaluate(() => window.__AGI_STUDIO__!.source())).toContain(
    "polygon 41,98 120,98 127,106 120,113 41,113",
  );
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  expect(await draftBytes(page)).toEqual(original);

  // Delete takes the item out; undo brings it back byte for byte.
  await page.keyboard.press("Delete");
  await expect(studio.locator('[data-row="occluder"]')).toHaveCount(0);
  expect(planes(await draftBytes(page)).priority.every((value) => value === 4)).toBe(true);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(studio.locator('[data-row="occluder"]')).toHaveCount(1);
  expect(await draftBytes(page)).toEqual(original);

  // [ moves the occluder back in draw order, ] forward again; neither is typed.
  await studio.locator('[data-row="occluder"]').click();
  const order = () =>
    studio
      .locator('[role="treeitem"][data-row]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row")));
  await page.keyboard.press("[");
  expect(await order()).toEqual(["wall", "floor", "occluder", "bench"]);
  await page.keyboard.press("]");
  expect(await order()).toEqual(["wall", "floor", "bench", "occluder"]);
  await page.keyboard.press("[");
  await studio.getByTestId("studio-close").click();
  // Closing with a change asks first; Esc cancels the question, not Studio.
  await expect(page.getByTestId("studio-dialog-keep")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("studio-dialog-keep")).toBeHidden();
  await expect(studio).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("studio-dialog-discard").click();
  await expect(studio).toHaveCount(0);
  await expect(page.getByTestId("input-line")).toHaveValue("");
  expect(await storedPicture(page, 5)).toEqual(original);
});

test("Keep refuses as stale when the game changed underneath, and Reopen starts over", async ({
  page,
}) => {
  await bootStudioGame(page);
  const studio = await openStudio(page);
  await page.keyboard.press("2");
  await studio.locator('[data-row="occluder"]').click();
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("ArrowDown");
  // Another tab keeps an edit to the same project: a new PIC 9.
  const elsewhere = openContainer(await storedFiles(page));
  elsewhere.putResource("picture", 9, PIC_5);
  const moved = await page.evaluate(
    async ([id, files]) => {
      const path = "/src/gameStorage.ts";
      const { updateAuthoredGameFiles } = await import(path);
      return updateAuthoredGameFiles(
        id,
        Object.fromEntries(files!.map(([name, bytes]) => [name, Uint8Array.from(bytes)])),
      );
    },
    [PROJECT, [...elsewhere.files].map(([name, bytes]) => [name, [...bytes]] as const)] as const,
  );
  expect(moved).toBe(true);
  await studio.getByTestId("studio-keep").click();
  const banner = studio.getByTestId("studio-keep-error");
  await expect(banner).toContainText(
    "The game changed since you opened Studio. Reopen to continue.",
  );
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("1 change");
  await studio.getByTestId("studio-recover").click();
  await expect(banner).toHaveCount(0);
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("No changes");
  expect(await draftBytes(page)).toEqual(PIC_5);
});

test("the first Keep on a catalog game forks a remix", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const catalog = new URL(page.url()).hash;
  await enterCreateMode(page);
  const panel = page.getByTestId("world-panel");
  await panel.getByTestId("map-room-1").click();
  await panel.getByTestId("world-open-studio").click();
  const studio = page.getByTestId("room-studio");
  // An untitled room's Studio is named by the picture it edits.
  await expect(studio).toHaveAttribute("aria-label", "Room Studio: PIC 1");
  // A barrier nudged up one row: a Walk-kind edit the Depth lens allows.
  await page.keyboard.press("2");
  await studio.getByRole("searchbox", { name: "Filter items" }).fill("barrier");
  await studio.locator('[role="treeitem"][data-row]').first().click();
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("ArrowUp");
  await studio.getByTestId("studio-keep").click();
  await expect(studio.getByTestId("studio-draft-status")).toHaveText("Kept");
  const remix = await page.evaluate(() => localStorage.getItem("monotio_agi.lastGame"));
  expect(remix).toMatch(/^remix-/);
  // The game runs on as the remix; the URL names it once Studio lets it run.
  await studio.getByTestId("studio-close").click();
  await expect(page).toHaveURL(new RegExp(`#create/${remix}$`));
  expect(new URL(page.url()).hash).not.toBe(catalog);
});
