import type { Locator, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { createPictureSurface } from "../../src/types.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { parseGameHash } from "../src/shell/shellRoute.ts";
import { testProjectId } from "../test/identity.ts";
import {
  cacheGame,
  closeWorkspaceEditor,
  downloadFromSettings,
  enterCreateMode,
  openWorkspacePicture,
  textHook,
  waitForCycles,
  workspaceUpdated,
  waitForAutosaveAfter,
} from "./engineProbe.ts";
import { expect, test } from "./test.ts";

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
const BENCH_LINE = SOURCE.split("\n").indexOf("rect 44,92 116,104") + 1;
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

/**
 * Resume the stored game and wait until it runs in room 1. A `#play/` or
 * `#create/` route resumes on its own — its Resume card can detach mid-click
 * — so only a page without one takes the card.
 */
async function resumeInRoom(page: Page): Promise<void> {
  if (!parseGameHash(new URL(page.url()).hash)) await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  await waitForCycles(page, 2);
}

async function openStudio(page: Page): Promise<Locator> {
  await enterCreateMode(page);
  await openWorkspacePicture(page, 1);
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
    const path = "/src/project/gameStorage.ts";
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
  const paneBox = (await pane.boundingBox())!;
  const zoom = paneBox.height / 168;
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

test("a depth drag changes only the priority plane, undoes, keeps, reloads, exports and plays @webkit-desktop", async ({
  page,
}) => {
  await bootStudioGame(page);
  const studio = await openStudio(page);
  await workspaceUpdated(page);
  const original = await draftBytes(page);
  expect(original).toEqual(PIC_5);

  // Depth lens, the occluder selected: Select moves it whole and shows no
  // handles; the Point tool shows its polygon's and fill seed's.
  await page.keyboard.press("2");
  await studio.locator('[data-row="occluder"]').click();
  await expect(studio.locator("[data-handle]")).toHaveCount(0);
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("a");
  await expect(studio.locator("[data-handle]")).toHaveCount(6);
  await dragHandle(page, POLYGON_LINE, 2, 10, 0);
  await workspaceUpdated(page);
  const dragged = await draftBytes(page);
  const before = planes(original);
  const after = planes(dragged);
  expect(after.visual).toEqual(before.visual);
  expect(after.priority).not.toEqual(before.priority);
  // The tip moved from 126,98 to 136,98: the fill now reaches 130,98.
  expect([before.priority[at(130, 98)], after.priority[at(130, 98)]]).toEqual([4, 10]);

  // One drag, one undo step: back to the stored bytes exactly.
  await page.keyboard.press("ControlOrMeta+z");
  await workspaceUpdated(page);
  await expect.poll(() => draftBytes(page)).toEqual(original);

  // Another edit from the keyboard: the occluder one row down.
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("ArrowDown");
  await workspaceUpdated(page);
  const kept = await draftBytes(page);
  expect(planes(kept).priority[at(80, 106)]).toBe(10);
  expect(planes(kept).visual).toEqual(before.visual);
  await workspaceUpdated(page);
  await expect(page.getByTestId("workspace-saved")).toBeVisible();
  await expect(page.getByTestId("workspace-saved")).toHaveText(/^(?:Saved|Draft saved)$/);
  expect(await storedPicture(page, 5)).toEqual(kept);

  // Room 1 draws PIC 5, so the live room re-enters and shows the new depth.
  await closeWorkspaceEditor(page);
  await expect(studio).toBeHidden();
  await expect.poll(() => framePriority(page, 80, 106)).toBe(10);

  // Return to Play on the kept files before recording progress for reload.
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect.poll(() => framePriority(page, 80, 106)).toBe(10);
  await waitForAutosaveAfter(page, (await textHook(page)).cycle);

  // A reload boots the stored project: Studio opens on the kept bytes.
  await page.reload();
  await resumeInRoom(page);
  await openStudio(page);
  expect(await draftBytes(page)).toEqual(kept);
  expect(await storedPicture(page, 5)).toEqual(kept);
  await closeWorkspaceEditor(page);

  const downloading = page.waitForEvent("download");
  await downloadFromSettings(page);
  const exported = await readGameZip(await readFile((await (await downloading).path())!));
  expect(openContainer(new Map(Object.entries(exported.files))).getResource("picture", 5)).toEqual(
    kept,
  );
  await page.keyboard.press("Escape");

  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect.poll(() => framePriority(page, 80, 106)).toBe(10);
  expect(await framePriority(page, 80, 90)).toBe(4);
});

test("Alt shows where a point goes on the selected line; Alt+click adds it and Insert adds one at the cursor", async ({
  page,
}) => {
  await bootStudioGame(page);
  const studio = await openStudio(page);
  await page.keyboard.press("2");
  await studio.locator('[data-row="occluder"]').click();
  // Select shows no handles, yet an Alt+click still adds a point.
  await expect(studio.locator("[data-handle]")).toHaveCount(0);
  const pane = page.locator(".studio-pane").last();
  const box = (await pane.boundingBox())!;
  const zoom = box.height / 168;
  const cell = (x: number, y: number) =>
    [box.x + (x + 0.5) * 2 * zoom, box.y + (y + 0.5) * zoom] as const;
  const polygon = (points: string) =>
    SOURCE.replace("polygon 40,90 119,90 126,98 119,105 40,105", `polygon ${points}`);

  // One row above the top edge 40,90-119,90, halfway along it: the "+" sits on
  // the edge at 80,90, and only while Alt is held.
  await page.mouse.move(...cell(80, 89));
  const ghost = pane.locator('[data-role="insert-ghost"]');
  await expect(ghost).toHaveCount(0);
  await page.keyboard.down("Alt");
  await page.mouse.move(...cell(80, 89));
  await expect(ghost).toHaveAttribute("data-point", "80,90");
  await page.screenshot({ path: test.info().outputPath("studio-insert-point-hover.png") });

  // Alt+press adds it; the same drag carries it 6 rows up. One step.
  await page.mouse.down();
  for (let k = 1; k <= 3; k++) await page.mouse.move(...cell(80, 89 - 2 * k));
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect(ghost).toHaveCount(0);
  await workspaceUpdated(page);
  // The Point tool shows the new point's handle.
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("a");
  await expect(studio.locator("[data-handle]")).toHaveCount(7);
  await expect(pane.locator('[data-point="' + POLYGON_LINE + ':1"]')).toBeVisible();
  await page.keyboard.press("v");
  expect(await page.evaluate(() => window.__AGI_STUDIO__!.source())).toBe(
    polygon("40,90 80,84 119,90 126,98 119,105 40,105"),
  );
  await page.screenshot({ path: test.info().outputPath("studio-insert-point-result.png") });
  await page.keyboard.press("ControlOrMeta+z");
  await workspaceUpdated(page);
  expect(await draftBytes(page)).toEqual(PIC_5);

  // Insert: the cursor stands where the pointer last hovered, 80,89.
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("Insert");
  await workspaceUpdated(page);
  expect(await page.evaluate(() => window.__AGI_STUDIO__!.source())).toBe(
    polygon("40,90 80,90 119,90 126,98 119,105 40,105"),
  );
  expect(await draftBytes(page)).toEqual(
    compilePictureSource(polygon("40,90 80,90 119,90 126,98 119,105 40,105")).bytes,
  );
});

test("a lock refusal, keyboard nudges, Delete with undo, and draw-order keys stay in Studio", async ({
  page,
}) => {
  await bootStudioGame(page);
  const studio = await openStudio(page);
  // Pixel-exact handle drags need the taller side-by-side pane.
  await page.getByTestId("workspace-layout").click();
  const canvas = studio.getByRole("group", { name: /^Canvas/ });
  // The layout click takes DOM focus; return it before tool keys.
  await canvas.focus();
  const original = await draftBytes(page);

  // A whole item moves whole in any lens: the bench frame nudged in the Depth
  // lens takes its art along, and the notice says so.
  await page.keyboard.press("2");
  await studio.locator('[data-row="bench"]').click();
  await canvas.focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".workspace-status").getByTestId("studio-notice")).toHaveText(
    "Moved Bench with its visual.",
  );
  await workspaceUpdated(page);
  await page.keyboard.press("ControlOrMeta+z");
  await workspaceUpdated(page);
  // Art is locked in the Depth lens for editing within it: with the Point
  // tool, a corner of the frame dragged up a row is refused, with the count and box of the art
  // cells it would change (row 91 gains 44..116, row 92 loses 45..115), and
  // nothing changes.
  await page.keyboard.press("a");
  await dragHandle(page, BENCH_LINE, 0, 0, -1);
  await expect(page.locator(".workspace-status").getByTestId("studio-notice")).toHaveText(
    "Visual is locked in the Priority lens.",
  );
  await expect(page.locator(".workspace-status").getByTestId("studio-notice-detail")).toContainText(
    "Visual is locked in the Priority lens: 144 cells at 44,91..116,92 would change.",
  );
  await expect(studio.locator('[data-role="refused"]')).toHaveCount(1);
  await workspaceUpdated(page);
  // The refusal offers the way out: unlocked for the session, the same drag goes through.
  await page.locator(".workspace-status").getByTestId("studio-notice-action").click();
  await expect(page.locator(".workspace-status").getByTestId("studio-notice")).toHaveText(
    "Unlocked until you close Studio. Try it again.",
  );
  await dragHandle(page, BENCH_LINE, 0, 0, -1);
  await workspaceUpdated(page);
  await canvas.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("v");
  // Nudges: 1 px, and 8 with Shift, each one undo step.
  await studio.locator('[data-row="occluder"]').click();
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await workspaceUpdated(page);
  expect(await page.evaluate(() => window.__AGI_STUDIO__!.source())).toContain(
    "polygon 41,98 120,98 127,106 120,113 41,113",
  );
  await page.keyboard.press("ControlOrMeta+z");
  await workspaceUpdated(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => draftBytes(page)).toEqual(original);

  // Delete takes the item out; undo brings it back byte for byte.
  await page.keyboard.press("Delete");
  await expect(studio.locator('[data-row="occluder"]')).toHaveCount(0);
  expect(planes(await draftBytes(page)).priority.every((value) => value === 4)).toBe(true);
  await workspaceUpdated(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(studio.locator('[data-row="occluder"]')).toHaveCount(1);
  await expect.poll(() => draftBytes(page)).toEqual(original);

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
  await closeWorkspaceEditor(page);
  await expect(studio).toBeHidden();
  await expect(page.getByTestId("input-line")).toHaveValue("");
});

test("the first autosaved edit on a catalog game forks a remix", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room, { timeout: 30_000 }).toBe(1);
  const catalog = new URL(page.url()).hash;
  await enterCreateMode(page);
  await openWorkspacePicture(page, 1);
  const studio = page.getByTestId("room-studio");
  // An untitled room's Studio is named by the picture it edits.
  await expect(studio).toHaveAttribute("aria-label", "PICTURE: PICTURE 1");
  // The tutorial's own picture text: named objects, not disassembled elements.
  const galleryRows = [
    "Corners & floor line",
    "Mural frame",
    "Blank canvas",
    "Pencil sketch",
    "Picture light",
    "Restoration cart",
    "Upper walls",
    "Floor",
    "Marble bust",
    "Velvet rope",
  ];
  const rowLabels = () =>
    studio.locator('[role="treeitem"][data-row] .scene-list__label').allTextContents();
  await expect.poll(rowLabels).toEqual(expect.arrayContaining(galleryRows));
  expect((await rowLabels()).filter((label) => /^Element \d/.test(label))).toEqual([]);
  // The picture's own source: nothing says Rebuilt.
  await expect(page.locator(".workspace-status").getByTestId("studio-source-kind")).toHaveCount(0);
  // A barrier nudged up one row: a Walk-kind edit the Depth lens allows.
  await page.keyboard.press("2");
  await studio.getByRole("searchbox", { name: "Filter items" }).fill("barrier");
  await studio.locator('[role="treeitem"][data-row]').first().click();
  await studio.getByRole("group", { name: /^Canvas/ }).focus();
  await page.keyboard.press("ArrowUp");
  await workspaceUpdated(page);
  const copyNote = page.getByTestId("copy-created-note");
  await expect(copyNote).toBeVisible();
  await expect(copyNote).toContainText(
    "Saved as your own copy of Adventure Department. The original stays unchanged.",
  );
  await copyNote.getByRole("button", { name: "Close", exact: true }).click();
  await expect(copyNote).toHaveCount(0);
  const remix = await page.evaluate(
    () => localStorage.getItem("monotio_agi.resumeTarget")?.split(":")[1],
  );
  expect(remix).toMatch(/^remix-/);
  // The game runs on as the remix; the URL names it once Studio lets it run.
  await closeWorkspaceEditor(page);
  await expect(page).toHaveURL(new RegExp(`#create/${remix}$`));
  expect(new URL(page.url()).hash).not.toBe(catalog);
  // The remix keeps the named objects with the kept edit.
  await openWorkspacePicture(page, 1);
  await page.keyboard.press("1");
  await studio.getByRole("searchbox", { name: "Filter items" }).fill("");
  await expect.poll(rowLabels).toEqual(expect.arrayContaining(galleryRows));
  // The picture's own source: nothing says Rebuilt.
  await expect(page.locator(".workspace-status").getByTestId("studio-source-kind")).toHaveCount(0);
});
